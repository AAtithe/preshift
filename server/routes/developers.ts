import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { canOrgWide, PERMISSIONS, type Permission } from '../../src/engine/access';
import { hashKey, hasScope, KEY_PREFIX, SCOPES, type Scope } from '../auth';
import { HttpError, notFound, orgOf, type AppContext } from '../context';
import { actorName, guard, type Guard } from '../guard';
import { audit, type ApiKeyRecord } from '../store';
import { checkWebhookUrl, deliverWebhooks, isHrEvent, MAX_ENDPOINTS, newWebhookSecret, WEBHOOK_EVENTS, type Fetch, type WebhookDelivery, type WebhookEndpoint } from '../webhooks';

const MAX_KEYS = 25;

/** What anyone sees about a key after it is made: never the key or its hash. */
const keyView = (k: ApiKeyRecord) => ({
  id: k.id,
  name: k.name,
  scopes: k.scopes,
  endsWith: k.endsWith,
  createdAt: k.createdAt,
  createdBy: k.createdBy,
  lastUsedAt: k.lastUsedAt ?? null,
  revokedAt: k.revokedAt ?? null,
  revokedBy: k.revokedBy ?? null,
});

const MAX_CALLS = 1000;
const csvCell = (v: unknown) => {
  const t = v === undefined || v === null ? '' : String(v);
  // A leading = + - or @ would run as a formula when the file is opened in a spreadsheet.
  const safe = /^[=+\-@]/.test(t) ? `'${t}` : t;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

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

/**
 * HR events go only where someone who reads personnel files across the organisation sends them:
 * a person with hr.view everywhere, or a key with hr:read (a personal key needs both). The same
 * holds for moving or re-keying an endpoint that already carries them, or it could be redirected.
 */
function requireHrReader(ctx: AppContext, req: FastifyRequest) {
  const p = req.principal;
  if (!p.email && !hasScope(req, 'hr:read')) {
    throw new HttpError(403, 'forbidden', 'HR events need a key with the hr:read scope.');
  }
  const g = guard(ctx, req, orgOf(req));
  if (g.user && !canOrgWide(g.user, 'hr.view', ctx.store.todayISO())) {
    throw new HttpError(403, 'forbidden', `${g.user.name} cannot read personnel files across the organisation, so cannot send HR events anywhere.`);
  }
}

const carriesHr = (events: string[]) => events.some(isHrEvent);

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
    const existing = (await store.listApiKeys(req.principal.orgId)).filter((k) => !k.revokedAt);
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
      ...(g.user ? { createdById: g.user.id } : {}),
    };
    await store.putApiKey(record);
    audit(orgOf(req), actorName(g), 'access.api_key_created', { id: record.id, name, scopes });
    // The only time the key itself leaves the server.
    return reply.code(201).send({ ...keyView(record), key });
  });

  // Revoking keeps the key's record, so any later attempt to use it is refused and logged against it.
  app.delete<{ Params: { id: string } }>('/v1/api-keys/:id', hidden, async (req, reply) => {
    const g = keyManager(ctx, req);
    if (!(await store.revokeApiKey(req.principal.orgId, req.params.id, actorName(g)))) throw notFound(`API key ${req.params.id}`);
    audit(orgOf(req), actorName(g), 'access.api_key_revoked', { id: req.params.id });
    return reply.code(204).send();
  });

  // Every call a key made, newest first: for checking a partner's use and for breach investigation.
  // Works for revoked keys and for deployment keys (env:<name>). Downloading the log is itself audited.
  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string; limit?: number; format?: 'json' | 'csv' } }>(
    '/v1/api-keys/:id/calls',
    {
      schema: {
        hide: true,
        querystring: {
          type: 'object',
          properties: {
            from: { type: 'string', format: 'date-time' },
            to: { type: 'string', format: 'date-time' },
            limit: { type: 'integer', minimum: 1, maximum: MAX_CALLS, default: 200 },
            format: { type: 'string', enum: ['json', 'csv'], default: 'json' },
          },
        },
      },
    },
    async (req, reply) => {
      const g = keyManager(ctx, req);
      const orgId = req.principal.orgId;
      const { id } = req.params;
      if (!id.startsWith('env:') && !(await store.listApiKeys(orgId)).some((k) => k.id === id)) throw notFound(`API key ${id}`);
      const calls = await store.listApiCalls(orgId, id, { from: req.query.from, to: req.query.to, limit: req.query.limit ?? 200 });
      if (req.query.format !== 'csv') return { keyId: id, calls: calls.map(({ orgId: _o, keyId: _k, ...c }) => c) };
      audit(orgOf(req), actorName(g), 'access.api_calls_exported', { id, count: calls.length, from: req.query.from, to: req.query.to });
      req.orgChanged = true;
      const rows = [['at', 'method', 'path', 'status', 'refused', 'ip', 'ms'], ...calls.map((c) => [c.at, c.method, c.path, c.status, c.refused, c.ip, c.ms])];
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="api-calls-${id.replace(/[^\w-]/g, '_')}.csv"`)
        .send(rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n');
    },
  );

  app.get('/v1/webhooks/events', { schema: { tags: ['Webhooks'], description: "Every event a webhook endpoint can subscribe to, with what its data holds. HR events are never part of '*' and need hr:read to subscribe." } }, async () =>
    Object.entries(WEBHOOK_EVENTS).map(([type, description]) => ({ type, description, hr: isHrEvent(type) })),
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
      const events = checkEvents(req.body?.events);
      if (carriesHr(events)) requireHrReader(ctx, req);
      const endpoint: WebhookEndpoint = {
        id: `wh_${randomUUID()}`,
        url: checkWebhookUrl(req.body?.url, options.production),
        events,
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
      const events = req.body?.events !== undefined ? checkEvents(req.body.events) : endpoint.events;
      if (carriesHr(events) || (carriesHr(endpoint.events) && req.body?.url !== undefined)) requireHrReader(ctx, req);
      if (req.body?.url !== undefined) endpoint.url = checkWebhookUrl(req.body.url, options.production);
      endpoint.events = events;
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
    if (carriesHr(endpoint.events)) requireHrReader(ctx, req);
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
