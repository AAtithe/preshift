import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { readHire, type Hire, type HireSource } from '../../src/engine/hires';
import type { Employee } from '../../src/engine/types';
import { HttpError, kick, notFound, orgOf, type AppContext } from '../context';
import { actorName, guard } from '../guard';
import { audit, type OrgData } from '../store';
import { createStarter } from './employees';

/** The secret a recruitment system signs its webhooks with. Kept with the other secrets, shown once. */
const atsSecretSetting = (orgId: string) => `ats_secret:${orgId}`;

export const HIRE_SOURCES: Record<HireSource, string> = { talent_funnel: 'Talent Funnel', other: 'Applicant tracking system' };

/** What the organisation has connected, and the new hires waiting for a manager. */
export interface RecruitmentData {
  source?: HireSource;
  connectedAt?: string;
  connectedBy?: string;
  lastReceived?: { at: string; ok: boolean; message?: string };
  hires: Hire[];
}

const recruitmentOf = (org: OrgData) => (org.recruitment ??= { hires: [] });

/** HMAC-SHA256 of the exact bytes sent, as hex: what a signed webhook carries in X-Preshift-Signature. */
export const signHire = (secret: string, raw: string) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

const sameText = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function hireRoutes(app: FastifyInstance, ctx: AppContext, opts: { appUrl?: string }) {
  /** Connecting recruitment is a setting: a person with settings.manage. */
  function settingsPerson(req: FastifyRequest) {
    if (!req.principal.email) throw new HttpError(403, 'forbidden', 'Recruitment is connected by a person signed in, not an API key.');
    const g = guard(ctx, req, orgOf(req));
    g.allow('settings.manage');
    return actorName(g);
  }
  const webhookUrl = (orgId: string) => `${opts.appUrl ?? ''}/v1/integrations/ats/webhook/${orgId}`;

  app.get('/v1/integrations/ats', { schema: { hide: true } }, async (req) => {
    const org = orgOf(req);
    const g = guard(ctx, req, org);
    g.allow('team.manage');
    const r = org.recruitment;
    return {
      connection: r?.source ? { source: r.source, label: HIRE_SOURCES[r.source], connectedAt: r.connectedAt, connectedBy: r.connectedBy, lastReceived: r.lastReceived ?? null } : null,
      webhookUrl: r?.source ? webhookUrl(org.orgId) : null,
      waiting: (r?.hires ?? []).filter((h) => h.status === 'waiting').length,
    };
  });

  app.put<{ Body: { source: HireSource } }>(
    '/v1/integrations/ats',
    { schema: { hide: true, body: { type: 'object', required: ['source'], properties: { source: { type: 'string', enum: Object.keys(HIRE_SOURCES) } }, additionalProperties: false } } },
    async (req) => {
      const by = settingsPerson(req);
      const org = orgOf(req);
      // A new secret every time: whoever set up the old one is given the new.
      const secret = `pshs_${randomBytes(24).toString('base64url')}`;
      await ctx.store.setSetting(atsSecretSetting(org.orgId), secret);
      Object.assign(recruitmentOf(org), { source: req.body.source, connectedAt: ctx.now().toISOString(), connectedBy: by });
      audit(org, by, 'ats.connected', { source: req.body.source });
      return { secret, webhookUrl: webhookUrl(org.orgId) };
    },
  );

  app.delete('/v1/integrations/ats', { schema: { hide: true } }, async (req) => {
    const by = settingsPerson(req);
    const org = orgOf(req);
    await ctx.store.setSetting(atsSecretSetting(org.orgId), null);
    const r = recruitmentOf(org);
    delete r.source;
    delete r.connectedAt;
    delete r.connectedBy;
    audit(org, by, 'ats.disconnected');
    // New hires already handed over stay for managers to finish.
    return { connection: null };
  });

  // The recruitment system posts each hire here, signed with the organisation's secret.
  app.post<{ Params: { orgId: string } }>(
    '/v1/integrations/ats/webhook/:orgId',
    { schema: { tags: ['Employees'], description: 'Receives a hired candidate from a recruitment system, signed with HMAC-SHA256 of the body in X-Preshift-Signature (sha256=hex). The hire waits for a manager to check and add as a starter.' } },
    async (req, reply) => {
      const raw = (req as unknown as { rawBody?: string }).rawBody ?? '';
      const secret = req.org ? await ctx.store.getSetting(atsSecretSetting(req.org.orgId)) : null;
      const given = String(req.headers['x-preshift-signature'] ?? '');
      if (!secret || !req.org?.recruitment?.source || !given || !sameText(signHire(secret, raw), given)) return reply.code(401).send({ error: 'bad_signature' });
      const org = req.org;
      const r = recruitmentOf(org);
      const at = ctx.now().toISOString();
      const event = String((req.body as { event?: unknown } | undefined)?.event ?? 'candidate.hired');
      // Only a hire hands someone over; other events (applied, interviewed) are not Preshift's.
      if (!/hire/i.test(event)) return { received: true, ignored: event };
      const { hire, problem } = readHire(req.body, org.state.sites, org.state.roles);
      req.orgChanged = true;
      if (!hire) {
        r.lastReceived = { at, ok: false, message: problem };
        return reply.code(422).send({ error: 'invalid_hire', message: problem });
      }
      const existing = r.hires.find((h) => h.externalId === hire.externalId && h.source === r.source);
      if (existing && existing.status !== 'waiting') {
        r.lastReceived = { at, ok: true, message: `${hire.name} was already ${existing.status}.` };
        return { received: true, id: existing.id, status: existing.status };
      }
      const saved: Hire = existing ? Object.assign(existing, hire, { receivedAt: at }) : { id: `hire_${randomUUID().slice(0, 12)}`, source: r.source!, receivedAt: at, status: 'waiting', ...hire };
      if (!existing) r.hires.push(saved);
      r.lastReceived = { at, ok: true };
      audit(org, HIRE_SOURCES[r.source!], 'hire.received', { id: saved.id, siteId: saved.siteId ?? null });
      return { received: true, id: saved.id, status: saved.status, matched: { site: !!saved.siteId, role: !!saved.roleId } };
    },
  );

  // New hires waiting, at the sites where the caller manages the team.
  app.get('/v1/hires', { schema: { hide: true } }, async (req) => {
    const org = orgOf(req);
    const g = guard(ctx, req, org);
    const mine = (org.recruitment?.hires ?? []).filter((h) => (h.siteId ? g.can('team.manage', h.siteId) : g.can('team.manage')));
    if (!mine.length) g.allow('team.manage');
    return mine.filter((h) => h.status === 'waiting').sort((a, b) => (a.startDate ?? '9').localeCompare(b.startDate ?? '9'));
  });

  app.post<{ Params: { id: string }; Body: Partial<Pick<Employee, 'name' | 'siteId' | 'roleIds' | 'payBasis' | 'dateOfBirth' | 'hourlyRate' | 'annualSalary' | 'contractedHours'>> }>(
    '/v1/hires/:id/add',
    {
      schema: {
        hide: true,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1 },
            siteId: { type: 'string' },
            roleIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
            payBasis: { type: 'string', enum: ['hourly', 'salaried'] },
            dateOfBirth: { type: 'string', format: 'date' },
            hourlyRate: { type: 'number', minimum: 0 },
            annualSalary: { type: 'number', minimum: 0 },
            contractedHours: { type: 'number', minimum: 0 },
          },
        },
      },
    },
    async (req, reply) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      const hire = org.recruitment?.hires.find((h) => h.id === req.params.id);
      if (!hire) throw notFound('Hire');
      if (hire.status !== 'waiting') throw new HttpError(409, 'already_decided', `${hire.name} was already ${hire.status}.`);
      // The manager's corrections win; the recruitment system's details fill the rest.
      const body = {
        name: req.body?.name ?? hire.name,
        siteId: req.body?.siteId ?? hire.siteId,
        roleIds: req.body?.roleIds ?? (hire.roleId ? [hire.roleId] : undefined),
        payBasis: req.body?.payBasis ?? 'hourly',
        dateOfBirth: req.body?.dateOfBirth ?? hire.dateOfBirth,
        ...(req.body?.hourlyRate !== undefined ? { hourlyRate: req.body.hourlyRate } : hire.hourlyRate ? { hourlyRate: hire.hourlyRate } : {}),
        ...(req.body?.annualSalary !== undefined ? { annualSalary: req.body.annualSalary } : {}),
        ...(req.body?.contractedHours !== undefined ? { contractedHours: req.body.contractedHours } : {}),
        ...(hire.startDate ? { startDate: hire.startDate } : {}),
      } as Partial<Employee>;
      const missing = [!body.siteId && 'site', !body.roleIds?.length && 'role', !body.dateOfBirth && 'date of birth'].filter(Boolean);
      if (missing.length) throw new HttpError(422, 'hire_incomplete', `Choose the ${missing.join(', ')} before adding ${hire.name}.`);
      const e = createStarter(ctx, org, g, body);
      Object.assign(hire, { status: 'added', employeeId: e.id, decidedBy: actorName(g), decidedAt: ctx.now().toISOString() });
      audit(org, actorName(g), 'hire.added', { id: hire.id, employeeId: e.id });
      await kick(ctx, org);
      return reply.code(201).send({ hire, employeeId: e.id, email: hire.email ?? null });
    },
  );

  app.post<{ Params: { id: string } }>('/v1/hires/:id/dismiss', { schema: { hide: true } }, async (req) => {
    const org = orgOf(req);
    const g = guard(ctx, req, org);
    const hire = org.recruitment?.hires.find((h) => h.id === req.params.id);
    if (!hire) throw notFound('Hire');
    if (hire.siteId) g.allow('team.manage', hire.siteId);
    else g.allow('team.manage');
    if (hire.status !== 'waiting') throw new HttpError(409, 'already_decided', `${hire.name} was already ${hire.status}.`);
    Object.assign(hire, { status: 'dismissed', decidedBy: actorName(g), decidedAt: ctx.now().toISOString() });
    audit(org, actorName(g), 'hire.dismissed', { id: hire.id });
    return hire;
  });
}
