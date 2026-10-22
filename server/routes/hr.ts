import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { employeeStatus } from '../../src/engine/employees';
import { hrChecks, hrSummary } from '../../src/engine/hr';
import type { Absence, Employee, HrProfile, HrRecord } from '../../src/engine/types';
import { requireScope } from '../auth';
import { HttpError, notFound, orgOf, type AppContext } from '../context';
import { actorName, guard, type Guard } from '../guard';
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

type RecordInput = Omit<HrRecord, 'id' | 'createdBy' | 'createdAt'>;

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
 * authenticator. Others see that a case exists only through the checks, never its notes. Nobody
 * sees or handles a case about themselves, whatever they hold: someone else runs it.
 */
function seesCases(req: FastifyRequest, g: Guard, employeeId?: string): boolean {
  return hrScoped(req) && g.can('hr.cases') && (!employeeId || g.user?.employeeId !== employeeId);
}

/**
 * An employee as the caller may see it. Without the personnel file a reader gets no file, and
 * absence reduced to the dates the rota needs: health reasons are special category data under
 * UK GDPR. Pay is withheld separately (forReader).
 */
export function employeeView(req: FastifyRequest, e: Employee, g: Guard): Employee {
  if (readsHr(req, g, e)) return e;
  const { hr: _hr, absences, ...rest } = e;
  return absences ? { ...rest, absences: absences.map(({ id, type, from, to }) => ({ id, type, from, to })) } : rest;
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
    if (g.user?.employeeId === e.id) throw new HttpError(403, 'forbidden', 'Somebody else keeps your own personnel file.');
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
      return {
        summary: hrSummary(people, today),
        checks: people
          .filter((e) => employeeStatus(e, today) !== 'left')
          .map((e) => ({ employeeId: e.id, checks: hrChecks(e, org.hrRecords, org.state.roles, today) }))
          .filter((x) => x.checks.length > 0),
      };
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
      const cases = seesCases(req, g);
      const readable = new Set(org.state.employees.filter((e) => readsHr(req, g, e)).map((e) => e.id));
      return org.hrRecords.filter(
        (r) =>
          readable.has(r.employeeId) &&
          (!req.query.employeeId || r.employeeId === req.query.employeeId) &&
          (!req.query.kind || r.kind === req.query.kind) &&
          (r.kind !== 'case' || (cases && r.employeeId !== g.user?.employeeId)),
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
      if (req.body.kind === 'case') g.allow('hr.cases');
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
      if (req.body.employeeId && req.body.employeeId !== before.employeeId) mayManage(g, findEmployee(org, req.body.employeeId));
      if (req.body.kind && req.body.kind !== before.kind) throw new HttpError(422, 'kind_fixed', 'A record cannot change kind; add a new one');
      const after: HrRecord = { ...before, ...req.body, id: before.id, createdBy: before.createdBy, createdAt: before.createdAt };
      validateRecord(org, after);
      org.hrRecords[i] = after;
      audit(org, actorName(g), 'hr.record.updated', { id: after.id, employeeId: after.employeeId, fields: Object.keys(req.body) });
      return after;
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/hr/records/:id',
    { ...write, schema: { tags, params: idParam } },
    async (req, reply) => {
      const org = orgOf(req);
      const record = org.hrRecords.find((r) => r.id === req.params.id);
      const g = guardOf(req);
      if (!record || (record.kind === 'case' && !seesCases(req, g, record.employeeId))) throw notFound(`Record ${req.params.id}`);
      mayManage(g, findEmployee(org, record.employeeId));
      org.hrRecords = org.hrRecords.filter((r) => r.id !== record.id);
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
    { ...write, schema: { tags, params: absenceParams } },
    async (req) => {
      const org = orgOf(req);
      const e = findEmployee(org, req.params.id);
      const g = guardOf(req);
      mayManage(g, e);
      if (!e.absences?.some((a) => a.id === req.params.absenceId)) throw notFound(`Absence ${req.params.absenceId}`);
      e.absences = e.absences.filter((a) => a.id !== req.params.absenceId);
      audit(org, actorName(g), 'hr.absence.deleted', { id: e.id, absenceId: req.params.absenceId });
      return shown(req, g, e);
    },
  );
}
