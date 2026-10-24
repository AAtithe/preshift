import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { employeeStatus } from '../../src/engine/employees';
import { hrChecks, hrSummary } from '../../src/engine/hr';
import { sspEstimate, sspInPeriod } from '../../src/engine/ssp';
import type { Absence, Employee, HrProfile, HrRecord } from '../../src/engine/types';
import { requireScope } from '../auth';
import { HttpError, notFound, orgOf, type AppContext } from '../context';
import { actorName, guard, type Guard } from '../guard';
import { deleteCopiesAfterSave, deleteCopiesOnSave, recordCopies } from './documents';
import { forReader } from './employees';
import { idParam, isoDate } from '../schemas';
import { audit, type OrgData } from '../store';

const hrProfileBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    jobTitle: { type: 'string', maxLength: 120 },
    contractType: { type: 'string', enum: ['permanent', 'fixed-term', 'casual', 'apprentice'] },
    fixedTermEnd: isoDate,
    probationEnd: isoDate,
    probationPassedOn: isoDate,
    noticeWeeks: { type: 'number', minimum: 0, maximum: 52 },
    contractIssuedOn: isoDate,
    contractSignedOn: isoDate,
    handbookAcknowledgedOn: isoDate,
    niNumber: { type: 'string', pattern: '^[A-Za-z]{2}\\s?\\d{2}\\s?\\d{2}\\s?\\d{2}\\s?[A-Da-d]$' },
    address: { type: 'string', maxLength: 500 },
    postcode: { type: 'string', maxLength: 10 },
    emergencyContact: {
      type: 'object',
      required: ['name', 'phone'],
      additionalProperties: false,
      properties: { name: { type: 'string', minLength: 1 }, relationship: { type: 'string' }, phone: { type: 'string', minLength: 1 } },
    },
    managerId: { type: 'string' },
  },
} as const;

const absenceBody = {
  type: 'object',
  required: ['type', 'from'],
  additionalProperties: false,
  properties: {
    type: { type: 'string', enum: ['sickness', 'unauthorised', 'compassionate', 'dependants', 'family', 'unpaid', 'other'] },
    from: isoDate,
    to: isoDate,
    reason: { type: 'string', maxLength: 500 },
    fitNote: { type: 'boolean' },
    returnToWorkOn: isoDate,
    excludeFromTriggers: { type: 'boolean' },
    notes: { type: 'string', maxLength: 4000 },
  },
} as const;

const recordBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    employeeId: { type: 'string' },
    kind: { type: 'string', enum: ['training', 'review', 'case', 'document', 'note'] },
    date: isoDate,
    title: { type: 'string', minLength: 1, maxLength: 200 },
    expiresOn: isoDate,
    reviewType: { type: 'string', enum: ['probation', 'appraisal', 'one-to-one'] },
    nextDue: isoDate,
    caseType: { type: 'string', enum: ['investigation', 'disciplinary', 'grievance', 'capability'] },
    caseStatus: { type: 'string', enum: ['open', 'closed'] },
    outcome: { type: 'string', maxLength: 200 },
    warningExpires: isoDate,
    notes: { type: 'string', maxLength: 8000 },
  },
} as const;

const absenceParams = {
  type: 'object',
  required: ['id', 'absenceId'],
  properties: { id: { type: 'string' }, absenceId: { type: 'string' } },
} as const;

type RecordInput = Omit<HrRecord, 'id' | 'createdBy' | 'createdAt' | 'history'>;

/** Whether the key's scopes reach personnel files: an HR scope, or every scope. */
function hrScoped(req: FastifyRequest): boolean {
  const scopes = req.principal?.scopes ?? [];
  return scopes.includes('*') || scopes.includes('hr:read') || scopes.includes('hr:write');
}

/**
 * Whether the caller may read this person's file. A person needs hr.view at the person's home
 * site: a manager they only cover shifts for sees the absence dates the rota needs, never the
 * file itself, with its NI number, address and emergency contact. A system key needs an HR scope.
 */
export function readsHr(req: FastifyRequest, g: Guard, e: Employee): boolean {
  if (!hrScoped(req)) return false;
  return !g.user || g.can('hr.view', e.siteId);
}

/**
 * Disciplinary, grievance and capability cases are confidential: hr.cases, which needs the
 * authenticator. Without it nobody learns that a case exists, from the records or the checks.
 * Nobody sees or handles a case about themselves, whatever they hold: someone else runs it.
 * Cases are for people, never a system: a key, however it was scoped, gets none, as webhooks do not.
 */
export function seesCases(req: FastifyRequest, g: Guard, employeeId?: string): boolean {
  return hrScoped(req) && Boolean(g.user) && g.can('hr.cases') && (!employeeId || g.behind?.employeeId !== employeeId);
}

/**
 * The records the caller may see: those on files they read, and a case only where they handle
 * cases and it is not about them. Everything built from records (the list, the overview's checks)
 * goes through here, so a check never repeats what the record itself would not show: not that a
 * case exists, not its type, title or outcome, and never to the person it is about.
 */
function visibleRecords(req: FastifyRequest, g: Guard, org: OrgData): HrRecord[] {
  const readable = new Set(org.state.employees.filter((e) => readsHr(req, g, e)).map((e) => e.id));
  return org.hrRecords.filter((r) => readable.has(r.employeeId) && (r.kind !== 'case' || seesCases(req, g, r.employeeId)));
}

/**
 * An employee as the caller may see it. Without the personnel file a reader gets no file, and
 * absence reduced to the dates the rota needs: health reasons, and whether an absence was sickness
 * at all, are special category data under UK GDPR. Pay is withheld separately (forReader).
 */
export function employeeView(req: FastifyRequest, e: Employee, g: Guard): Employee {
  if (readsHr(req, g, e)) return e;
  const { hr: _hr, absences, ...rest } = e;
  // Whether someone was off sick is health data too. Those who run pay keep the type, as sick pay
  // turns on it; the rota needs only the days.
  const runsPay = runsPayFor(g, e);
  return absences
    ? { ...rest, absences: absences.map(({ id, type, from, to }) => ({ id, ...(runsPay ? { type } : {}), from, to })) }
    : rest;
}

/** Whether the caller runs pay where the person works: they see whether absence was sickness, as sick pay turns on it. */
function runsPayFor(g: Guard, e: Employee): boolean {
  return [e.siteId, ...(e.coverSiteIds ?? [])].some((s) => g.can('payroll.view', s) || g.can('pay.edit', s) || g.can('pay.approve', s));
}

function findEmployee(org: OrgData, id: string) {
  const e = org.state.employees.find((x) => x.id === id);
  if (!e) throw notFound(`Employee ${id}`);
  return e;
}

function validateProfile(org: OrgData, e: Employee, hr: HrProfile) {
  if (hr.managerId) {
    if (hr.managerId === e.id) throw new HttpError(422, 'invalid_manager', 'Someone cannot be their own line manager');
    findEmployee(org, hr.managerId);
  }
  if (hr.contractType === 'fixed-term' && !hr.fixedTermEnd) {
    throw new HttpError(422, 'fixed_term_end', 'A fixed-term contract needs its end date');
  }
}

function validateAbsence(a: Absence) {
  if (a.to && a.to < a.from) throw new HttpError(422, 'invalid_dates', 'The last day off is before the first');
  if (a.returnToWorkOn && a.returnToWorkOn < a.from) {
    throw new HttpError(422, 'invalid_dates', 'The return to work conversation is dated before the absence began');
  }
}

/** Rostered shifts that now fall in an absence, so the caller can re-cover them. */
function clashes(org: OrgData, e: Employee, a: Absence) {
  return org.state.shifts.filter((s) => s.employeeId === e.id && s.date >= a.from && (!a.to || s.date <= a.to)).map((s) => s.id);
}

function validateRecord(org: OrgData, r: RecordInput) {
  findEmployee(org, r.employeeId);
  if (r.kind === 'training' && r.expiresOn && r.expiresOn < r.date) {
    throw new HttpError(422, 'invalid_dates', 'The certificate expires before the course date');
  }
  if (r.kind === 'case' && !r.caseType) throw new HttpError(422, 'case_type', 'Say what kind of case this is');
  if (r.kind === 'review' && !r.reviewType) throw new HttpError(422, 'review_type', 'Say what kind of review this is');
}

export function hrRoutes(app: FastifyInstance, ctx: AppContext) {
  const read = { preHandler: requireScope('hr:read') };
  const write = { preHandler: requireScope('hr:write') };
  const tags = ['HR'];
  const guardOf = (req: FastifyRequest) => guard(ctx, req, orgOf(req));
  /** Changing a file is hr.manage where the person is based, and never on your own file. */
  const mayManage = (g: Guard, e: Employee) => {
    g.allow('hr.manage', e.siteId);
    if (g.behind?.employeeId === e.id) throw new HttpError(403, 'forbidden', 'Somebody else keeps your own personnel file.');
  };
  /** What an answer carries back: the file as the caller may read it, pay as they may see it. */
  const shown = (req: FastifyRequest, g: Guard, e: Employee) => forReader(g, employeeView(req, e, g));

  app.get<{ Querystring: { siteId?: string } }>(
    '/v1/hr/overview',
    {
      ...read,
      schema: {
        tags,
        description: 'Headcount, turnover and absence, and every open personnel file check, for one site or all.',
        querystring: { type: 'object', properties: { siteId: { type: 'string' } } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const g = guardOf(req);
      const today = new Date().toISOString().slice(0, 10);
      const people = org.state.employees.filter((e) => (!req.query.siteId || e.siteId === req.query.siteId) && readsHr(req, g, e));
      const records = visibleRecords(req, g, org);
      return {
        summary: hrSummary(people, today),
        checks: people
          .filter((e) => employeeStatus(e, today) !== 'left')
          .map((e) => ({ employeeId: e.id, checks: hrChecks(e, records, org.state.roles, today, org.state.shifts) }))
          .filter((x) => x.checks.length > 0),
      };
    },
  );

  app.get<{ Querystring: { siteId?: string; from?: string; to?: string } }>(
    '/v1/hr/sick-pay',
    {
      ...read,
      schema: {
        tags,
        description:
          'Statutory Sick Pay due on the absence record, person by person: each spell with its qualifying days, average weekly ' +
          'earnings and weekly rate, under the rules from 6 April 2026. With from and to, also the SSP due in that pay period. ' +
          'An estimate to check payroll against, not a payslip. For those who read the person\'s HR file or run their pay.',
        querystring: { type: 'object', properties: { siteId: { type: 'string' }, from: isoDate, to: isoDate } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const g = guardOf(req);
      const today = ctx.store.todayISO();
      const { from, to } = req.query;
      if ((from && !to) || (to && !from)) throw new HttpError(400, 'invalid_request', 'Give both from and to for a pay period, or neither.');
      return org.state.employees
        .filter((e) => (!req.query.siteId || e.siteId === req.query.siteId) && (readsHr(req, g, e) || runsPayFor(g, e)))
        .map((e) => ({ employeeId: e.id, estimate: sspEstimate(e, org.state.shifts, today) }))
        .filter((x) => x.estimate.spells.length > 0 || x.estimate.oldRules > 0)
        .map((x) => ({ ...x, ...(from && to ? { inPeriod: sspInPeriod(x.estimate, from, to) } : {}) }));
    },
  );

  app.get<{ Querystring: { employeeId?: string; kind?: HrRecord['kind'] } }>(
    '/v1/hr/records',
    {
      ...read,
      schema: {
        tags,
        description: 'Training, reviews, cases, documents and notes, for people whose file the caller reads. Cases need hr.cases.',
        querystring: {
          type: 'object',
          properties: { employeeId: { type: 'string' }, kind: recordBody.properties.kind },
        },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const g = guardOf(req);
      return visibleRecords(req, g, org).filter(
        (r) => (!req.query.employeeId || r.employeeId === req.query.employeeId) && (!req.query.kind || r.kind === req.query.kind),
      );
    },
  );

  app.post<{ Body: RecordInput }>(
    '/v1/hr/records',
    { ...write, schema: { tags, body: { ...recordBody, required: ['employeeId', 'kind', 'date', 'title'] } } },
    async (req, reply) => {
      const org = orgOf(req);
      const g = guardOf(req);
      mayManage(g, findEmployee(org, req.body.employeeId));
      if (req.body.kind === 'case') {
        g.allow('hr.cases');
        if (!g.user) throw new HttpError(403, 'forbidden', 'Cases are recorded by a person, not an API key.');
      }
      if (req.body.kind === 'case' && !seesCases(req, g, req.body.employeeId)) throw new HttpError(403, 'forbidden', 'Somebody else records a case about you.');
      validateRecord(org, req.body);
      const record: HrRecord = {
        ...req.body,
        ...(req.body.kind === 'case' ? { caseStatus: req.body.caseStatus ?? 'open' } : {}),
        id: `hr_${randomUUID().slice(0, 12)}`,
        createdBy: actorName(g),
        createdAt: new Date().toISOString(),
      };
      org.hrRecords.push(record);
      audit(org, actorName(g), 'hr.record.created', { id: record.id, employeeId: record.employeeId, kind: record.kind });
      return reply.code(201).send(record);
    },
  );

  app.patch<{ Params: { id: string }; Body: Partial<RecordInput> }>(
    '/v1/hr/records/:id',
    { ...write, schema: { tags, params: idParam, body: recordBody } },
    async (req) => {
      const org = orgOf(req);
      const i = org.hrRecords.findIndex((r) => r.id === req.params.id);
      const before = org.hrRecords[i];
      const g = guardOf(req);
      if (!before || (before.kind === 'case' && !seesCases(req, g, before.employeeId))) throw notFound(`Record ${req.params.id}`);
      mayManage(g, findEmployee(org, before.employeeId));
      // Moving a case onto someone else would leave one person with an allegation and the other without its record.
      if (req.body.employeeId && req.body.employeeId !== before.employeeId) {
        throw new HttpError(422, 'person_fixed', 'A record stays with the person it is about. Add it to the right person instead.');
      }
      if (req.body.kind && req.body.kind !== before.kind) throw new HttpError(422, 'kind_fixed', 'A record cannot change kind; add a new one');
      const changed = (Object.keys(req.body) as (keyof RecordInput)[]).filter((f) => req.body[f] !== before[f]);
      // What each change replaced is kept with the record, so a case can be shown as it stood on any day.
      const replaced = Object.fromEntries(changed.map((f) => [f, before[f]]));
      const history = changed.length ? [...(before.history ?? []), { at: new Date().toISOString(), by: actorName(g), before: replaced }] : before.history;
      const after: HrRecord = { ...before, ...req.body, id: before.id, createdBy: before.createdBy, createdAt: before.createdAt, ...(history ? { history } : {}) };
      validateRecord(org, after);
      org.hrRecords[i] = after;
      audit(org, actorName(g), 'hr.record.updated', { id: after.id, employeeId: after.employeeId, kind: after.kind, fields: Object.keys(req.body) });
      return after;
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/hr/records/:id',
    // Copies on the record go with it, once the record is saved without it.
    { ...write, schema: { tags, params: idParam }, onResponse: deleteCopiesOnSave(ctx) },
    async (req, reply) => {
      const org = orgOf(req);
      const record = org.hrRecords.find((r) => r.id === req.params.id);
      const g = guardOf(req);
      if (!record || (record.kind === 'case' && !seesCases(req, g, record.employeeId))) throw notFound(`Record ${req.params.id}`);
      mayManage(g, findEmployee(org, record.employeeId));
      // A case is evidence of how a complaint or a warning was handled: closed, never deleted. Retention removes it with the file.
      if (record.signing?.signedAt) throw new HttpError(409, 'signed_kept', 'A signed document is evidence it was given and agreed. It is removed with the rest of the file when its retention period ends.');
      if (record.kind === 'case') throw new HttpError(409, 'case_kept', 'A case is closed, not deleted. It is removed with the rest of the file when its retention period ends.');
      org.hrRecords = org.hrRecords.filter((r) => r.id !== record.id);
      deleteCopiesAfterSave(req, recordCopies([record]));
      audit(org, actorName(g), 'hr.record.deleted', { id: record.id, employeeId: record.employeeId, kind: record.kind });
      return reply.code(204).send();
    },
  );

  app.put<{ Params: { id: string }; Body: HrProfile }>(
    '/v1/employees/:id/hr',
    { ...write, schema: { tags, description: 'Replaces the personnel file details: contract, probation, NI number, emergency contact, line manager.', params: idParam, body: hrProfileBody } },
    async (req) => {
      const org = orgOf(req);
      const e = findEmployee(org, req.params.id);
      const g = guardOf(req);
      mayManage(g, e);
      const hr = { ...req.body, ...(req.body.niNumber ? { niNumber: req.body.niNumber.replace(/\s/g, '').toUpperCase() } : {}) };
      validateProfile(org, e, hr);
      e.hr = hr;
      audit(org, actorName(g), 'hr.profile.updated', { id: e.id, fields: Object.keys(req.body) });
      return shown(req, g, e);
    },
  );

  app.post<{ Params: { id: string }; Body: Omit<Absence, 'id'> }>(
    '/v1/employees/:id/absences',
    {
      ...write,
      schema: {
        tags,
        description: 'Records sickness or other absence. Rostered shifts in it are returned as clashes and blocked by compliance until re-covered.',
        params: idParam,
        body: absenceBody,
      },
    },
    async (req, reply) => {
      const org = orgOf(req);
      const e = findEmployee(org, req.params.id);
      const g = guardOf(req);
      mayManage(g, e);
      const absence: Absence = { ...req.body, id: `abs_${randomUUID().slice(0, 12)}` };
      validateAbsence(absence);
      e.absences = [...(e.absences ?? []), absence].sort((a, b) => a.from.localeCompare(b.from));
      audit(org, actorName(g), 'hr.absence.created', { id: e.id, absenceId: absence.id, type: absence.type, from: absence.from });
      return reply.code(201).send({ employee: shown(req, g, e), absence, clashes: clashes(org, e, absence) });
    },
  );

  app.patch<{ Params: { id: string; absenceId: string }; Body: Partial<Omit<Absence, 'id'>> }>(
    '/v1/employees/:id/absences/:absenceId',
    { ...write, schema: { tags, params: absenceParams, body: { ...absenceBody, required: [] } } },
    async (req) => {
      const org = orgOf(req);
      const e = findEmployee(org, req.params.id);
      const g = guardOf(req);
      mayManage(g, e);
      const before = e.absences?.find((a) => a.id === req.params.absenceId);
      if (!before) throw notFound(`Absence ${req.params.absenceId}`);
      const after: Absence = { ...before, ...req.body, id: before.id };
      validateAbsence(after);
      e.absences = e.absences!.map((a) => (a.id === before.id ? after : a)).sort((a, b) => a.from.localeCompare(b.from));
      audit(org, actorName(g), 'hr.absence.updated', { id: e.id, absenceId: after.id, fields: Object.keys(req.body) });
      return { employee: shown(req, g, e), absence: after, clashes: clashes(org, e, after) };
    },
  );

  app.delete<{ Params: { id: string; absenceId: string } }>(
    '/v1/employees/:id/absences/:absenceId',
    { ...write, schema: { tags, params: absenceParams }, onResponse: deleteCopiesOnSave(ctx) },
    async (req) => {
      const org = orgOf(req);
      const e = findEmployee(org, req.params.id);
      const g = guardOf(req);
      mayManage(g, e);
      const gone = e.absences?.find((a) => a.id === req.params.absenceId);
      if (!gone) throw notFound(`Absence ${req.params.absenceId}`);
      e.absences = e.absences!.filter((a) => a.id !== req.params.absenceId);
      // Its fit notes go with it, once the change has saved.
      deleteCopiesAfterSave(req, (gone.fitNotes ?? []).map((d) => ({ employeeId: e.id, documentId: d.id })));
      audit(org, actorName(g), 'hr.absence.deleted', { id: e.id, absenceId: req.params.absenceId });
      return shown(req, g, e);
    },
  );
}
