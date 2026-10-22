import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  applyRetention,
  DEFAULT_RETENTION,
  erasureRefusal,
  processingRegister,
  REQUEST_KINDS,
  requestDueOn,
  retentionPolicyProblem,
  retentionSchedule,
  stripContact,
  stripLocation,
  type RetentionPolicy,
  type SubjectRequest,
  type SubjectRequestKind,
} from '../../src/engine/gdpr';
import { requireScope } from '../auth';
import { guard } from '../guard';
import { HttpError, londonParts, notFound, orgOf, type AppContext } from '../context';
import { emailSetting } from '../mail';
import { idParam, isoDate } from '../schemas';
import { audit, type OrgData } from '../store';
import { claudeKeySetting } from './access';
import { deleteCopiesAfterSave, deleteCopiesOnSave, droppedCopies } from './documents';

const today = () => londonParts(new Date()).date;
const actor = (req: FastifyRequest) => req.principal.user?.email ?? req.principal.name;
const policyOf = (org: OrgData): RetentionPolicy => ({ ...DEFAULT_RETENTION, ...org.privacy?.policy });

function privacyOf(org: OrgData) {
  org.privacy ??= { requests: [] };
  return org.privacy;
}

const requestView = (r: SubjectRequest) => ({ ...r, dueOn: requestDueOn(r) });

const policyBody = {
  type: 'object',
  additionalProperties: false,
  required: ['locationMonths', 'contactMonthsAfterLeaving', 'rightToWorkYearsAfterLeaving', 'payrollYearsAfterTaxYear'],
  properties: {
    locationMonths: { type: 'integer', minimum: 0 },
    contactMonthsAfterLeaving: { type: 'integer', minimum: 0 },
    rightToWorkYearsAfterLeaving: { type: 'integer', minimum: 0 },
    payrollYearsAfterTaxYear: { type: 'integer', minimum: 0 },
  },
} as const;

/**
 * UK GDPR for staff data: the record of processing, the retention schedule, and the log and
 * tools for requests people make about their data. Reading the register is open to anyone who
 * can read the rota. Everything that names a person or acts on their data (the schedule, exports,
 * erasure, retention, the request log) is privacy.manage, which needs the authenticator, and is
 * done by a person, never an integration key: a subject access export is everything held on someone.
 */
export function privacyRoutes(app: FastifyInstance, ctx: AppContext) {
  const read = { preHandler: requireScope('rota:read') };
  const admin = {
    preHandler: async (req: FastifyRequest) => {
      if (!req.principal.userId && !req.principal.email) throw new HttpError(403, 'forbidden', 'Staff data requests are handled by a person, not an API key.');
      guard(ctx, req, orgOf(req)).allow('privacy.manage');
    },
  };

  app.get('/v1/privacy/register', { ...read, schema: { tags: ['Privacy'], description: 'The Article 30 record of processing for staff data, with what is held now.' } }, async (req) => {
    const org = orgOf(req);
    const logins = await ctx.store.listStaffLogins(org.orgId);
    return processingRegister(
      org.state,
      org.timeEntries,
      logins.length,
      {
        assistant: Boolean(await ctx.store.getSetting(claudeKeySetting(org.orgId))),
        email: Boolean(await ctx.store.getSetting(emailSetting(org.orgId))),
        payrollLive: !ctx.simulatorFor(org.orgId),
      },
      policyOf(org),
    );
  });

  app.get('/v1/privacy/retention', { ...admin, schema: { tags: ['Privacy'], description: 'Personal data at or near the end of its retention period.' } }, async (req) => {
    const org = orgOf(req);
    const policy = policyOf(org);
    return { policy, items: retentionSchedule(org.state, org.timeEntries, today(), policy) };
  });

  app.put<{ Body: RetentionPolicy }>('/v1/privacy/policy', { ...admin, schema: { tags: ['Privacy'], body: policyBody } }, async (req) => {
    const problem = retentionPolicyProblem(req.body);
    if (problem) throw new HttpError(400, 'retention_too_short', problem);
    const org = orgOf(req);
    privacyOf(org).policy = { ...req.body };
    audit(org, actor(req), 'privacy.policy_set', { ...req.body });
    return { policy: policyOf(org) };
  });

  app.post(
    '/v1/privacy/retention/apply',
    {
      ...admin,
      schema: { tags: ['Privacy'], description: 'Removes everything whose retention period has ended, stored right to work copies included. Cannot be undone.' },
      onResponse: deleteCopiesOnSave(ctx),
    },
    async (req) => {
      const org = orgOf(req);
      const day = today();
      const items = retentionSchedule(org.state, org.timeEntries, day, policyOf(org));
      const result = applyRetention(org.state.employees, org.timeEntries, items, day);
      // The encrypted files go too, once the records no longer name them.
      deleteCopiesAfterSave(req, droppedCopies(org.state.employees, result.employees));
      org.state.employees = result.employees;
      org.timeEntries = result.timeEntries;
      // Anonymising someone removes their personnel file entries: training, reviews, cases and notes.
      const anonymised = new Set(result.applied.filter((a) => a.code === 'anonymise').map((a) => a.employeeId));
      org.hrRecords = org.hrRecords.filter((r) => !anonymised.has(r.employeeId));
      for (const id of result.closeLoginsFor) await ctx.store.deleteStaffLogin(org.orgId, id);
      // The audit keeps ids and counts only, never the data that was removed.
      audit(org, actor(req), 'privacy.retention_applied', { applied: result.applied });
      return { applied: result.applied };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/privacy/subjects/:id/export',
    {
      ...admin,
      schema: {
        tags: ['Privacy'],
        description: 'Everything held on one person, with how it is used, for a subject access or portability request.',
        params: idParam,
      },
    },
    async (req) => {
      const org = orgOf(req);
      const e = org.state.employees.find((x) => x.id === req.params.id);
      if (!e) throw notFound(`Employee ${req.params.id}`);
      const login = await ctx.store.getStaffLogin(org.orgId, e.id);
      const employer = org.state.entities.find((x) => x.id === e.entityId);
      const register = processingRegister(
        org.state,
        org.timeEntries,
        0,
        {
          assistant: Boolean(await ctx.store.getSetting(claudeKeySetting(org.orgId))),
          email: Boolean(await ctx.store.getSetting(emailSetting(org.orgId))),
          payrollLive: !ctx.simulatorFor(org.orgId),
        },
        policyOf(org),
      );
      const about = (detail?: Record<string, unknown>) => detail?.id === e.id || detail?.employeeId === e.id;
      audit(org, actor(req), 'privacy.subject_exported', { employeeId: e.id });
      return {
        generatedAt: new Date().toISOString(),
        controller: employer ? { name: employer.name, companyNumber: employer.companyNumber } : null,
        person: e,
        shifts: org.state.shifts.filter((s) => s.employeeId === e.id),
        timeEntries: org.timeEntries.filter((t) => t.employeeId === e.id),
        hrRecords: org.hrRecords.filter((r) => r.employeeId === e.id),
        payroll: {
          hoursSent: org.submissions
            .filter((s) => s.accrued[e.id] !== undefined)
            .map((s) => ({ periodStart: s.periodStart, periodEnd: s.periodEnd, status: s.status, accruedCost: s.accrued[e.id] })),
          payRuns: org.payRuns.flatMap((r) =>
            r.variance.lines.filter((l) => l.employeeId === e.id).map((l) => ({ periodStart: r.periodStart, periodEnd: r.periodEnd, ...l })),
          ),
        },
        staffLogin: login
          ? { email: login.email ?? null, createdAt: login.createdAt, activatedAt: login.activatedAt ?? null, lastSignInAt: login.lastSignInAt ?? null }
          : null,
        changes: org.audit.filter((a) => about(a.detail)),
        requests: (org.privacy?.requests ?? []).filter((r) => r.employeeId === e.id).map(requestView),
        howWeUseIt: register,
        yourRights:
          'You can ask for a copy of your data, for it to be corrected, erased or restricted, to object to its use, and to receive it in a ' +
          'portable form. We answer within one month. You can complain to the Information Commissioner’s Office at ico.org.uk or 0303 123 1113.',
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/privacy/subjects/:id/erase',
    {
      ...admin,
      schema: {
        tags: ['Privacy'],
        description:
          'Erases what the law does not require us to keep for a leaver: contact details, availability, RFID card, staff login and clocking locations. ' +
          'Payroll and right to work records stay until their retention period ends (Article 17(3)).',
        params: idParam,
      },
    },
    async (req) => {
      const org = orgOf(req);
      const i = org.state.employees.findIndex((x) => x.id === req.params.id);
      if (i < 0) throw notFound(`Employee ${req.params.id}`);
      const e = org.state.employees[i];
      const refusal = erasureRefusal(e, today());
      if (refusal) throw new HttpError(409, 'erasure_not_applicable', refusal);
      org.state.employees[i] = stripContact(e);
      let locations = 0;
      org.timeEntries = org.timeEntries.map((t) => {
        if (t.employeeId !== e.id || (!t.clockInLocation && !t.clockOutLocation)) return t;
        locations++;
        return stripLocation(t);
      });
      await ctx.store.deleteStaffLogin(org.orgId, e.id);
      audit(org, actor(req), 'privacy.subject_erased', { employeeId: e.id, locations });
      return { employee: org.state.employees[i], locationsRemoved: locations };
    },
  );

  app.get('/v1/privacy/requests', { ...admin, schema: { tags: ['Privacy'] } }, async (req) =>
    (orgOf(req).privacy?.requests ?? []).map(requestView).sort((a, b) => b.receivedOn.localeCompare(a.receivedOn)),
  );

  app.post<{ Body: { kind: SubjectRequestKind; subject: string; receivedOn: string; employeeId?: string; notes?: string } }>(
    '/v1/privacy/requests',
    {
      ...admin,
      schema: {
        tags: ['Privacy'],
        description: 'Logs a request from someone about their data. The clock starts the day it was received, however it arrived.',
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'subject', 'receivedOn'],
          properties: {
            kind: { type: 'string', enum: Object.keys(REQUEST_KINDS) },
            subject: { type: 'string', minLength: 1, maxLength: 200 },
            receivedOn: isoDate,
            employeeId: { type: 'string' },
            notes: { type: 'string', maxLength: 2000 },
          },
        },
      },
    },
    async (req, reply) => {
      const org = orgOf(req);
      if (req.body.employeeId && !org.state.employees.some((e) => e.id === req.body.employeeId)) throw notFound(`Employee ${req.body.employeeId}`);
      if (req.body.receivedOn > today()) throw new HttpError(400, 'future_date', 'A request cannot be received in the future.');
      const request: SubjectRequest = {
        id: `dsr_${randomUUID().slice(0, 12)}`,
        kind: req.body.kind,
        subject: req.body.subject.trim(),
        receivedOn: req.body.receivedOn,
        ...(req.body.employeeId ? { employeeId: req.body.employeeId } : {}),
        ...(req.body.notes ? { notes: req.body.notes } : {}),
        status: 'open',
        loggedBy: actor(req),
      };
      privacyOf(org).requests.push(request);
      audit(org, actor(req), 'privacy.request_logged', { id: request.id, kind: request.kind, employeeId: request.employeeId });
      return reply.code(201).send(requestView(request));
    },
  );

  app.patch<{ Params: { id: string }; Body: { status?: 'open' | 'closed'; extended?: boolean; notes?: string } }>(
    '/v1/privacy/requests/:id',
    {
      ...admin,
      schema: {
        tags: ['Privacy'],
        params: idParam,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { status: { type: 'string', enum: ['open', 'closed'] }, extended: { type: 'boolean' }, notes: { type: 'string', maxLength: 2000 } },
        },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const r = privacyOf(org).requests.find((x) => x.id === req.params.id);
      if (!r) throw notFound(`Request ${req.params.id}`);
      if (req.body.extended !== undefined && r.status === 'closed') throw new HttpError(409, 'closed', 'That request is already closed.');
      if (req.body.extended !== undefined) r.extended = req.body.extended;
      if (req.body.notes !== undefined) r.notes = req.body.notes;
      if (req.body.status && req.body.status !== r.status) {
        r.status = req.body.status;
        r.closedOn = r.status === 'closed' ? today() : undefined;
      }
      audit(org, actor(req), 'privacy.request_updated', { id: r.id, status: r.status, extended: r.extended ?? false });
      return requestView(r);
    },
  );
}
