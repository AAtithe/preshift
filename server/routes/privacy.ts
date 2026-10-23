import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  applyRetention,
  DEFAULT_RETENTION,
  erasureRefusal,
  policyDocumentChecks,
  type PolicyDocument,
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
import { deleteCopiesAfterSave, deleteCopiesOnSave, droppedCopies, recordCopies } from './documents';

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
const welfareHeld = (org: OrgData) => ({
  pulses: org.welfare?.pulses.length ?? 0,
  recognitions: org.welfare?.recognitions.length ?? 0,
  chats: org.welfare?.chats.length ?? 0,
  members: org.welfare?.rewardsEnrolled.length ?? 0,
});

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
        rewards: org.welfare?.rewards?.environment === 'production',
      },
      policyOf(org),
      org.support?.tickets.length ?? 0,
      welfareHeld(org),
    );
  });

  app.get(
    '/v1/privacy/policy-documents',
    {
      ...read,
      schema: {
        tags: ['Privacy'],
        description:
          "Each employing company's appropriate policy document for sickness and other health data: who reviewed it, the director who " +
          'signed it, when it is next reviewed, and where each company stands. Names no member of staff.',
      },
    },
    async (req) => {
      const org = orgOf(req);
      const docs = org.privacy?.policyDocuments ?? [];
      const holdsHealthData = org.state.employees.some((e) => (e.absences ?? []).some((a) => a.type === 'sickness'));
      return { documents: docs, checks: policyDocumentChecks(org.state.entities, docs, holdsHealthData, today()) };
    },
  );

  app.put<{ Params: { entityId: string }; Body: Omit<PolicyDocument, 'entityId' | 'updatedBy' | 'updatedAt'> }>(
    '/v1/privacy/policy-documents/:entityId',
    {
      ...admin,
      schema: {
        tags: ['Privacy'],
        description: "Records a company's appropriate policy document: its title and link, the legal review, and the director's signature and date.",
        params: { type: 'object', required: ['entityId'], properties: { entityId: { type: 'string' } } },
        body: {
          type: 'object',
          required: ['title'],
          additionalProperties: false,
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 200 },
            url: { type: 'string', pattern: '^https://', maxLength: 500 },
            reviewedBy: { type: 'string', maxLength: 120 },
            reviewedOn: isoDate,
            signedBy: { type: 'string', maxLength: 120 },
            signedOn: isoDate,
            reviewDue: isoDate,
          },
        },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const entity = org.state.entities.find((e) => e.id === req.params.entityId);
      if (!entity) throw notFound(`Entity ${req.params.entityId}`);
      const b = req.body;
      if ((b.signedBy && !b.signedOn) || (b.signedOn && !b.signedBy)) throw new HttpError(422, 'signature', 'A signature needs both the director and the date.');
      if (b.signedOn && b.signedOn > today()) throw new HttpError(422, 'invalid_dates', 'It cannot be signed on a day still to come.');
      if (b.reviewedOn && b.signedOn && b.signedOn < b.reviewedOn) throw new HttpError(422, 'invalid_dates', 'Counsel reviews it before a director signs it.');
      const doc: PolicyDocument = { ...b, entityId: entity.id, updatedBy: actor(req), updatedAt: new Date().toISOString() };
      const privacy = privacyOf(org);
      privacy.policyDocuments = [...(privacy.policyDocuments ?? []).filter((d) => d.entityId !== entity.id), doc];
      audit(org, actor(req), 'privacy.policy_document_set', { entityId: entity.id, signed: Boolean(doc.signedOn) });
      return doc;
    },
  );

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
      deleteCopiesAfterSave(req, recordCopies(org.hrRecords.filter((r) => anonymised.has(r.employeeId))));
      org.hrRecords = org.hrRecords.filter((r) => !anonymised.has(r.employeeId));
      // Recognition messages and chat requests are about the person, and go with them.
      if (org.welfare) {
        org.welfare.recognitions = org.welfare.recognitions.filter((r) => !anonymised.has(r.employeeId));
        org.welfare.chats = org.welfare.chats.filter((c) => !anonymised.has(c.employeeId));
        org.welfare.rewardsOptOut = org.welfare.rewardsOptOut.filter((id) => !anonymised.has(id));
      }
      // And what they wrote in the staff app and were told there: requests keep only what the rota needs.
      for (const r of org.requests ?? []) if (anonymised.has(r.employeeId)) delete r.note;
      org.notifications = (org.notifications ?? []).filter((n) => !anonymised.has(n.employeeId));
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
      const g = guard(ctx, req, org);
      // Someone else answers a request about you: it may cover an investigation you are not yet told
      // of, and what may be withheld from you, such as a witness's statement, is theirs to decide.
      if (g.behind?.employeeId === e.id) throw new HttpError(403, 'forbidden', 'Somebody else answers a request for your own data.');
      // Cases go only to those who handle them, as everywhere else.
      const records = org.hrRecords.filter((r) => r.employeeId === e.id && (r.kind !== 'case' || g.can('hr.cases')));
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
          rewards: org.welfare?.rewards?.environment === 'production',
        },
        policyOf(org),
        org.support?.tickets.length ?? 0,
        welfareHeld(org),
      );
      const about = (detail?: Record<string, unknown>) => detail?.id === e.id || detail?.employeeId === e.id;
      audit(org, actor(req), 'privacy.subject_exported', { employeeId: e.id });
      return {
        generatedAt: new Date().toISOString(),
        controller: employer ? { name: employer.name, companyNumber: employer.companyNumber } : null,
        person: e,
        shifts: org.state.shifts.filter((s) => s.employeeId === e.id),
        timeEntries: org.timeEntries.filter((t) => t.employeeId === e.id),
        hrRecords: records,
        // What they asked for and were told in the staff app.
        staffRequests: (org.requests ?? []).filter((r) => r.employeeId === e.id),
        notifications: (org.notifications ?? []).filter((n) => n.employeeId === e.id),
        payroll: {
          hoursSent: org.submissions
            .filter((s) => s.accrued[e.id] !== undefined)
            .map((s) => ({ periodStart: s.periodStart, periodEnd: s.periodEnd, status: s.status, accruedCost: s.accrued[e.id] })),
          payRuns: org.payRuns.flatMap((r) =>
            r.variance.lines.filter((l) => l.employeeId === e.id).map((l) => ({ periodStart: r.periodStart, periodEnd: r.periodEnd, ...l })),
          ),
        },
        wellbeing: {
          recognitions: (org.welfare?.recognitions ?? []).filter((r) => r.employeeId === e.id),
          chatRequests: (org.welfare?.chats ?? []).filter((c) => c.employeeId === e.id),
          hospitalityRewards: {
            member: (org.welfare?.rewardsEnrolled ?? []).includes(e.id),
            optedOut: (org.welfare?.rewardsOptOut ?? []).includes(e.id),
          },
          pulse: 'Weekly pulse answers are stored without your id, so they cannot be found or returned as yours.',
        },
        staffLogin: login
          ? { email: login.email ?? null, createdAt: login.createdAt, activatedAt: login.activatedAt ?? null, lastSignInAt: login.lastSignInAt ?? null }
          : null,
        changes: org.audit.filter((a) => about(a.detail) && (a.detail?.kind !== 'case' || g.can('hr.cases'))),
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
