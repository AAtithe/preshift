import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { canOrgWide, PERMISSIONS, type Permission } from '../../src/engine/access';
import { hashKey, KEY_PREFIX, SCOPES, type Scope } from '../auth';
import { HttpError, notFound, orgOf, type AppContext } from '../context';
import { actorName, guard, type Guard } from '../guard';
import { audit, type ApiKeyRecord } from '../store';
import { checkWebhookUrl, deliverWebhooks, MAX_ENDPOINTS, newWebhookSecret, WEBHOOK_EVENTS, type Fetch, type WebhookDelivery, type WebhookEndpoint } from '../webhooks';

const MAX_KEYS = 25;

/** What anyone sees about a key after it is made: never the key or its hash. */
const keyView = (k: ApiKeyRecord) => ({ id: k.id, name: k.name, scopes: k.scopes, endsWith: k.endsWith, createdAt: k.createdAt, createdBy: k.createdBy, lastUsedAt: k.lastUsedAt ?? null });

/** What anyone sees about an endpoint after it is made: never the secret. */
const endpointView = (e: WebhookEndpoint) => ({ id: e.id, url: e.url, events: e.events, description: e.description ?? '', active: e.active, createdAt: e.createdAt, createdBy: e.createdBy });

/**
 * The permission a person must hold across the whole organisation to give a key each scope.
 * A key made in the app is organisation-wide, so nobody can hand a system more than they hold
 * everywhere themselves: a site GM cannot mint a key that reads every site's pay.
 */
const GRANTS: Record<keyof typeof SCOPES, Permission> = {
  'rota:read': 'rota.view',
  'employees:read': 'costs.view',
  'rota:write': 'rota.edit',
  'time:write': 'time.record',
  'time:approve': 'time.approve',
  'payroll:write': 'payroll.send',
  'hr:read': 'hr.view',
  'hr:write': 'hr.manage',
  'webhooks:write': 'settings.manage',
};

/**
 * API keys are made and revoked by a person signed in with settings.manage (which needs their
 * authenticator), never by a key: a leaked key must not be able to mint another.
 */
function keyManager(ctx: AppContext, req: FastifyRequest): Guard {
  if (!req.principal.email) throw new HttpError(403, 'forbidden', 'API keys are made by a person signed in, not by an API key.');
  const g = guard(ctx, req, orgOf(req));
  g.allow('settings.manage');
  return g;
}

/**
 * Webhooks are managed by a person with settings.manage, or by a system key with webhooks:write
 * so a partner can register its own endpoint. A personal key acts as its person, so needs both.
 */
function webhookManager(ctx: AppContext) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const p = req.principal;
    if (!p.email && !p.scopes.includes('*') && !p.scopes.includes('webhooks:write')) {
      return reply.code(403).send({ error: 'forbidden', message: 'This key lacks the webhooks:write scope' });
    }
    guard(ctx, req, orgOf(req)).allow('settings.manage');
  };
}

function checkScopes(raw: unknown, g: Guard, today: string): Scope[] {
  const scopes = Array.isArray(raw) ? [...new Set(raw.map(String))] : [];
  if (scopes.length === 0) throw new HttpError(400, 'invalid_scopes', 'Choose at least one thing this key may do.');
  const unknown = scopes.filter((s) => s !== '*' && !(s in SCOPES));
  if (unknown.length) throw new HttpError(400, 'invalid_scopes', `Unknown scope: ${unknown.join(', ')}`);
  // A system acting on its own (no person behind the session) has organisation-wide authority already.
  if (g.user) {
    const wanted = scopes.includes('*') ? (Object.keys(GRANTS) as (keyof typeof GRANTS)[]) : (scopes as (keyof typeof GRANTS)[]);
    const beyond = wanted.filter((s) => !canOrgWide(g.user!, GRANTS[s], today));
    if (beyond.length) {
      throw new HttpError(
        403,
        'beyond_own_access',
        `A key cannot do more than you can across the whole organisation. You cannot ${beyond.map((s) => PERMISSIONS[GRANTS[s]].label.toLowerCase()).join('; ')}.`,
        { scopes: beyond },
      );
    }
  }
  return scopes as Scope[];
}

function checkEvents(raw: unknown): string[] {
  const events = Array.isArray(raw) ? [...new Set(raw.map(String))] : [];
  if (events.length === 0) throw new HttpError(400, 'invalid_events', 'Choose at least one event, or * for all.');
  const unknown = events.filter((e) => e !== '*' && !WEBHOOK_EVENTS[e]);
  if (unknown.length) throw new HttpError(400, 'invalid_events', `Unknown event: ${unknown.join(', ')}`);
  return events;
}

const endpointSchema = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'https address that will receive POSTed events' },
    events: { type: 'array', items: { type: 'string' }, description: "Event types from GET /v1/webhooks/events, or ['*']" },
    description: { type: 'string', maxLength: 200 },
    active: { type: 'boolean' },
  },
} as const;

export function developerRoutes(app: FastifyInstance, ctx: AppContext, options: { production: boolean; fetcher?: Fetch }) {
  const { store } = ctx;
  const hidden = { schema: { hide: true } };
  const managesHooks = webhookManager(ctx);
  const hooks = (schema: Record<string, unknown>) => ({ preHandler: managesHooks, schema: { tags: ['Webhooks'], ...schema } });
  const actor = (req: FastifyRequest) => actorName(guard(ctx, req, orgOf(req)));

  // API keys: made, listed and revoked by a person with settings.manage. A key cannot make another key.
  app.get('/v1/api-keys', hidden, async (req) => {
    keyManager(ctx, req);
    return { scopes: SCOPES, keys: (await store.listApiKeys(req.principal.orgId)).map(keyView) };
  });

  app.post<{ Body: { name?: string; scopes?: string[] } }>('/v1/api-keys', hidden, async (req, reply) => {
    const g = keyManager(ctx, req);
    const name = req.body?.name?.trim() ?? '';
    if (!name || name.length > 80) throw new HttpError(400, 'invalid_name', 'Name the key after the system that will use it, for example "Tevalis EPOS".');
    const scopes = checkScopes(req.body?.scopes, g, store.todayISO());
    const existing = await store.listApiKeys(req.principal.orgId);
    if (existing.length >= MAX_KEYS) throw new HttpError(409, 'too_many_keys', `An organisation can have ${MAX_KEYS} keys. Revoke one you no longer use.`);
    const key = `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
    const record: ApiKeyRecord = {
      id: `key_${randomUUID()}`,
      orgId: req.principal.orgId,
      name,
      scopes,
      hash: hashKey(key),
      endsWith: key.slice(-4),
      createdAt: new Date().toISOString(),
      // An organisation-wide system key, recorded against the person who made it.
      createdBy: actorName(g),
    };
    await store.putApiKey(record);
    audit(orgOf(req), actorName(g), 'access.api_key_created', { id: record.id, name, scopes });
    // The only time the key itself leaves the server.
    return reply.code(201).send({ ...keyView(record), key });
  });

  app.delete<{ Params: { id: string } }>('/v1/api-keys/:id', hidden, async (req, reply) => {
    keyManager(ctx, req);
    if (!(await store.deleteApiKey(req.principal.orgId, req.params.id))) throw notFound(`API key ${req.params.id}`);
    audit(orgOf(req), actor(req), 'access.api_key_revoked', { id: req.params.id });
    return reply.code(204).send();
  });

  app.get('/v1/webhooks/events', { schema: { tags: ['Webhooks'], description: 'Every event a webhook endpoint can subscribe to, with what its data holds.' } }, async () =>
    Object.entries(WEBHOOK_EVENTS).map(([type, description]) => ({ type, description })),
  );

  app.get('/v1/webhooks', hooks({ description: 'Webhook endpoints for this organisation. Secrets are never returned after an endpoint is made.' }), async (req) =>
    (orgOf(req).webhooks ?? []).map(endpointView),
  );

  app.post<{ Body: { url?: string; events?: string[]; description?: string } }>(
    '/v1/webhooks',
    hooks({ description: 'Registers an endpoint. The response carries its signing secret, shown this once only.', body: { ...endpointSchema, required: ['url', 'events'] } }),
    async (req, reply) => {
      const org = orgOf(req);
      org.webhooks ??= [];
      if (org.webhooks.length >= MAX_ENDPOINTS) throw new HttpError(409, 'too_many_endpoints', `An organisation can have ${MAX_ENDPOINTS} webhook endpoints.`);
      const endpoint: WebhookEndpoint = {
        id: `wh_${randomUUID()}`,
        url: checkWebhookUrl(req.body?.url, options.production),
        events: checkEvents(req.body?.events),
        description: req.body?.description?.trim() || undefined,
        secret: newWebhookSecret(),
        active: true,
        createdAt: new Date().toISOString(),
        createdBy: actor(req),
      };
      org.webhooks.push(endpoint);
      audit(org, actor(req), 'webhook.created', { id: endpoint.id, url: endpoint.url, events: endpoint.events });
      return reply.code(201).send({ ...endpointView(endpoint), secret: endpoint.secret });
    },
  );

  app.patch<{ Params: { id: string }; Body: { url?: string; events?: string[]; description?: string; active?: boolean } }>(
    '/v1/webhooks/:id',
    hooks({ description: 'Changes the address, events or description, or turns the endpoint off and on.', body: endpointSchema }),
    async (req) => {
      const org = orgOf(req);
      const endpoint = (org.webhooks ?? []).find((e) => e.id === req.params.id);
      if (!endpoint) throw notFound(`Webhook ${req.params.id}`);
      if (req.body?.url !== undefined) endpoint.url = checkWebhookUrl(req.body.url, options.production);
      if (req.body?.events !== undefined) endpoint.events = checkEvents(req.body.events);
      if (req.body?.description !== undefined) endpoint.description = req.body.description.trim() || undefined;
      if (req.body?.active !== undefined) endpoint.active = req.body.active;
      audit(org, actor(req), 'webhook.changed', { id: endpoint.id, fields: Object.keys(req.body ?? {}) });
      return endpointView(endpoint);
    },
  );

  app.delete<{ Params: { id: string } }>('/v1/webhooks/:id', hooks({}), async (req, reply) => {
    const org = orgOf(req);
    const before = (org.webhooks ?? []).length;
    org.webhooks = (org.webhooks ?? []).filter((e) => e.id !== req.params.id);
    if (org.webhooks.length === before) throw notFound(`Webhook ${req.params.id}`);
    org.webhookDeliveries = (org.webhookDeliveries ?? []).filter((d) => d.endpointId !== req.params.id);
    audit(org, actor(req), 'webhook.removed', { id: req.params.id });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/v1/webhooks/:id/rotate-secret', hooks({ description: 'Replaces the signing secret. The old one stops working at once.' }), async (req) => {
    const org = orgOf(req);
    const endpoint = (org.webhooks ?? []).find((e) => e.id === req.params.id);
    if (!endpoint) throw notFound(`Webhook ${req.params.id}`);
    endpoint.secret = newWebhookSecret();
    audit(org, actor(req), 'webhook.secret_rotated', { id: endpoint.id });
    return { ...endpointView(endpoint), secret: endpoint.secret };
  });

  // Sends a webhook.test event now, so a partner can check their receiver and signature code.
  app.post<{ Params: { id: string } }>('/v1/webhooks/:id/test', hooks({ description: 'Sends a webhook.test event to the endpoint straight away and reports what it answered.' }), async (req) => {
    const org = orgOf(req);
    const endpoint = (org.webhooks ?? []).find((e) => e.id === req.params.id);
    if (!endpoint) throw notFound(`Webhook ${req.params.id}`);
    const delivery: WebhookDelivery = {
      id: randomUUID(),
      endpointId: endpoint.id,
      event: { id: `evt_${randomUUID()}`, type: 'webhook.test', createdAt: new Date().toISOString(), orgId: org.orgId, data: { endpointId: endpoint.id } },
      status: 'pending',
      attempts: 0,
      nextAttemptAt: 0,
    };
    // Sent on its own, outside the queue, and not retried: it is a check, not an event.
    const probe = { ...org, webhooks: [{ ...endpoint, active: true }], webhookDeliveries: [delivery] };
    await deliverWebhooks(probe, options.fetcher);
    const sent = probe.webhookDeliveries[0];
    return { delivered: sent.status === 'delivered', status: sent.lastStatus ?? null, error: sent.lastError ?? null };
  });

  app.get<{ Querystring: { endpointId?: string } }>(
    '/v1/webhooks/deliveries',
    hooks({ description: 'The most recent deliveries, newest first, with their status and the last error.', querystring: { type: 'object', properties: { endpointId: { type: 'string' } } } }),
    async (req) =>
      (orgOf(req).webhookDeliveries ?? [])
        .filter((d) => !req.query.endpointId || d.endpointId === req.query.endpointId)
        .slice(-100)
        .reverse()
        .map((d) => ({ id: d.id, endpointId: d.endpointId, eventId: d.event.id, type: d.event.type, createdAt: d.event.createdAt, status: d.status, attempts: d.attempts, lastStatus: d.lastStatus ?? null, lastError: d.lastError ?? null })),
  );

  app.post<{ Params: { id: string } }>('/v1/webhooks/deliveries/:id/retry', hooks({ description: 'Puts a failed delivery back in the queue and tries it now.' }), async (req) => {
    const org = orgOf(req);
    const d = (org.webhookDeliveries ?? []).find((x) => x.id === req.params.id);
    if (!d) throw notFound(`Delivery ${req.params.id}`);
    if (d.status === 'delivered') throw new HttpError(409, 'already_delivered', 'That event was delivered.');
    Object.assign(d, { status: 'pending', attempts: 0, nextAttemptAt: 0 });
    return { ok: true };
  });
}
