import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpError, londonParts, notFound, orgOf, type AppContext } from '../context';
import { actorName, guard } from '../guard';
import { TrustIdClient, TrustIdError, trustIdResult, type TrustIdCredentials, type TrustIdResult } from '../integrations/trustid';
import { audit, type OrgData } from '../store';

/** The organisation's own TrustID account: its checks are its statutory excuse, so never a shared one. */
const credentialsSetting = (orgId: string) => `trustid:${orgId}`;
/** The token TrustID sends back on its result callback, so only TrustID can post a result. */
const callbackSetting = (orgId: string) => `trustid_callback:${orgId}`;

export const TRUSTID_DEFAULT_BASE = 'https://cloud.trustid.co.uk';

/** One right to work check sent through TrustID, from invitation to result. */
export interface TrustIdCheck {
  id: string;
  employeeId: string;
  email: string;
  sentAt: string;
  sentBy: string;
  /** Sent: waiting for the person. Done: the record was updated. Review: TrustID flagged it, so a person decides. */
  status: 'sent' | 'done' | 'review' | 'failed';
  containerId?: string;
  result?: TrustIdResult;
  completedAt?: string;
  error?: string;
}

export interface TrustIdData {
  connectedAt: string;
  connectedBy: string;
  checks: TrustIdCheck[];
}

/**
 * Writes TrustID's outcome to the person's right to work record. A continuous right is a check done;
 * a time-limited one sets the follow-up date, so the record warns before it lapses; a rejection
 * clears the check, so the rota blocks their shifts. A result TrustID itself flagged is left for a
 * person to look at in TrustID, and the record is not changed on its say-so.
 */
export function applyTrustIdResult(org: OrgData, check: TrustIdCheck, result: TrustIdResult, today: string) {
  check.result = result;
  check.completedAt = new Date().toISOString();
  const e = org.state.employees.find((x) => x.id === check.employeeId);
  if (!e) return void Object.assign(check, { status: 'failed', error: 'The person is no longer on file.' });
  if (result.alert || result.status === 'Unknown') {
    check.status = 'review';
    audit(org, 'TrustID', 'rtw.trustid_review', { employeeId: e.id, checkId: check.id, status: result.status, alert: result.alert });
    return;
  }
  const evidence = `TrustID digital check${result.document ? `: ${result.document}` : ''}`;
  const { expiry: _old, ...rest } = e.rightToWork ?? { checked: false };
  e.rightToWork = {
    ...rest,
    checked: result.status !== 'Rejected',
    checkedOn: today,
    evidence: result.status === 'Rejected' ? `${evidence} (no right to work shown)` : evidence,
    ...(result.status === 'Time Limited' && result.followUpDate ? { expiry: result.followUpDate } : {}),
    documents: e.rightToWork?.documents ?? [],
  };
  check.status = 'done';
  audit(org, 'TrustID', 'rtw.trustid_result', { employeeId: e.id, checkId: check.id, status: result.status, followUpDate: result.followUpDate ?? null });
}

export function trustIdRoutes(app: FastifyInstance, ctx: AppContext, opts: { appUrl?: string }) {
  const today = () => londonParts(ctx.now()).date;
  const credentials = async (orgId: string) => {
    const raw = await ctx.store.getSetting(credentialsSetting(orgId));
    return raw ? (JSON.parse(raw) as TrustIdCredentials) : null;
  };
  function settingsPerson(req: FastifyRequest) {
    if (!req.principal.email) throw new HttpError(403, 'forbidden', 'TrustID is connected by a person signed in, not an API key.');
    const g = guard(ctx, req, orgOf(req));
    g.allow('settings.manage');
    return actorName(g);
  }

  app.get('/v1/integrations/trustid', { schema: { hide: true } }, async (req) => {
    const org = orgOf(req);
    guard(ctx, req, org).allow('team.manage');
    const t = org.trustId;
    return t ? { connected: true, connectedAt: t.connectedAt, connectedBy: t.connectedBy, waiting: t.checks.filter((c) => c.status === 'sent').length, review: t.checks.filter((c) => c.status === 'review').length } : { connected: false };
  });

  app.put<{ Body: { base?: string; apiKey: string; username: string; password: string } }>(
    '/v1/integrations/trustid',
    {
      schema: {
        hide: true,
        body: {
          type: 'object',
          required: ['apiKey', 'username', 'password'],
          properties: { base: { type: 'string', pattern: '^https://' }, apiKey: { type: 'string', minLength: 1 }, username: { type: 'string', minLength: 1 }, password: { type: 'string', minLength: 1 } },
          additionalProperties: false,
        },
      },
    },
    async (req) => {
      const by = settingsPerson(req);
      const org = orgOf(req);
      const creds: TrustIdCredentials = { base: req.body.base || TRUSTID_DEFAULT_BASE, apiKey: req.body.apiKey, username: req.body.username, password: req.body.password };
      // Sign in once before saving, so a typo never looks connected.
      try {
        await new TrustIdClient(creds, ctx.fetch).login();
      } catch (err) {
        throw new HttpError(422, 'trustid_error', err instanceof TrustIdError ? err.message : 'TrustID could not be reached.');
      }
      await ctx.store.setSetting(credentialsSetting(org.orgId), JSON.stringify(creds));
      if (!(await ctx.store.getSetting(callbackSetting(org.orgId)))) await ctx.store.setSetting(callbackSetting(org.orgId), randomBytes(24).toString('base64url'));
      org.trustId = { connectedAt: ctx.now().toISOString(), connectedBy: by, checks: org.trustId?.checks ?? [] };
      audit(org, by, 'trustid.connected');
      return { connected: true };
    },
  );

  app.delete('/v1/integrations/trustid', { schema: { hide: true } }, async (req) => {
    const by = settingsPerson(req);
    const org = orgOf(req);
    await ctx.store.setSetting(credentialsSetting(org.orgId), null);
    await ctx.store.setSetting(callbackSetting(org.orgId), null);
    delete org.trustId;
    audit(org, by, 'trustid.disconnected');
    return { connected: false };
  });

  // A manager sends the person TrustID's invitation; TrustID emails them the link.
  app.post<{ Params: { id: string }; Body: { email: string } }>(
    '/v1/employees/:id/right-to-work/trustid',
    { schema: { hide: true, body: { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' } }, additionalProperties: false } } },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      const e = org.state.employees.find((x) => x.id === req.params.id);
      if (!e) throw notFound(`Employee ${req.params.id}`);
      g.allow('team.manage', e.siteId);
      const creds = await credentials(org.orgId);
      const token = await ctx.store.getSetting(callbackSetting(org.orgId));
      if (!org.trustId || !creds || !token) throw new HttpError(409, 'not_connected', 'TrustID is not connected. Someone who manages settings connects it in Settings.');
      const check: TrustIdCheck = { id: `rtw_${randomUUID().slice(0, 12)}`, employeeId: e.id, email: req.body.email, sentAt: ctx.now().toISOString(), sentBy: actorName(g), status: 'sent' };
      try {
        await new TrustIdClient(creds, ctx.fetch).createGuestLink({
          email: req.body.email,
          name: e.name,
          reference: check.id,
          callbackUrl: `${opts.appUrl ?? ''}/v1/integrations/trustid/webhook/${org.orgId}`,
          callbackToken: token,
        });
      } catch (err) {
        throw new HttpError(502, 'trustid_error', err instanceof TrustIdError ? err.message : 'TrustID could not be reached.');
      }
      org.trustId.checks.push(check);
      audit(org, actorName(g), 'rtw.trustid_sent', { employeeId: e.id, checkId: check.id });
      return check;
    },
  );

  // TrustID calls back with the Authorization header Preshift gave it; the result is then read from TrustID itself.
  app.post<{ Params: { orgId: string } }>(
    '/v1/integrations/trustid/webhook/:orgId',
    { schema: { tags: ['Employees'], description: 'TrustID result callback. Authenticated by the bearer token Preshift gave TrustID with each guest link.' } },
    async (req, reply) => {
      const token = req.org ? await ctx.store.getSetting(callbackSetting(req.org.orgId)) : null;
      const given = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (!token || !given || given.length !== token.length || !timingSafeEqual(Buffer.from(given), Buffer.from(token)) || !req.org?.trustId) return reply.code(401).send({ error: 'bad_token' });
      const org = req.org;
      const trust = org.trustId!;
      const cb = (req.body as { Callback?: { WorkflowName?: string; WorkflowState?: string; WorkflowStorage?: { Key: string; Value: string | null }[] }; Response?: { ContainerId?: string } } | undefined) ?? {};
      // Only the result is Preshift's business: TrustID also calls when a container is first submitted.
      if (cb.Callback?.WorkflowName !== 'AutoReferral' || cb.Callback?.WorkflowState !== 'Stop') return { received: true, ignored: true };
      const store = (key: string) => cb.Callback?.WorkflowStorage?.find((s) => s.Key === key)?.Value ?? undefined;
      const containerId = store('ContainerId') ?? cb.Response?.ContainerId;
      const check = trust.checks.find((c) => c.id === store('ClientApplicationReference'));
      req.orgChanged = true;
      if (!check || !containerId) return { received: true, matched: false };
      check.containerId = containerId;
      const creds = await credentials(org.orgId);
      if (!creds) return reply.code(409).send({ error: 'not_connected' });
      try {
        const container = await new TrustIdClient(creds, ctx.fetch).retrieveContainer(containerId);
        applyTrustIdResult(org, check, trustIdResult(container), today());
      } catch (err) {
        // TrustID retries its callback, so a failure here is reported and tried again.
        Object.assign(check, { error: err instanceof Error ? err.message : String(err) });
        return reply.code(502).send({ error: 'trustid_error' });
      }
      return { received: true, status: check.status };
    },
  );
}
