import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Employee } from '../../src/engine/types';
import { requireScope } from '../auth';
import { addDays, ageOn } from '../../src/engine/time';
import { HttpError, kick, notFound, orgOf, type AppContext } from '../context';
import { actorName, guard, type Guard } from '../guard';
import { enqueue } from '../outbox';
import { employeeBody, idParam, isoDate } from '../schemas';
import { audit, type OrgData } from '../store';
import { payTermsOf } from '../../src/engine/payChanges';
import { employeeView } from './hr';
import { changesRate, pendingFor, proposedTerms, proposePayChange, proposes } from './pay';

// Fields payroll holds a copy of; changing any of them is synced to TeamPay.
export const PAYROLL_FIELDS: (keyof Employee)[] = [
  'name', 'dateOfBirth', 'siteId', 'payBasis', 'hourlyRate', 'annualSalary',
  'contractedHours', 'irregularHours', 'pensionEnrolled',
];

// Fields that are pay: changing them is pay.edit, which stays apart from sending payroll.
// The employing company is one: moving someone to another entity moves them to another PAYE scheme.
const PAY_FIELDS: (keyof Employee)[] = ['hourlyRate', 'annualSalary', 'payBasis', 'entityId'];

/** Home site and every site they cover: their hours can land in any of them. */
const sitesOfPerson = (e: Employee) => [e.siteId, ...(e.coverSiteIds ?? [])];

/** Seen by those who see the rota or manage the team at any site the person works. */
function visible(g: Guard, e: Employee) {
  const at = g.at('rota.view', 'team.manage');
  return sitesOfPerson(e).some((siteId) => at({ siteId }));
}

/** How far ahead the rota reaches: a right to work expiry inside it is shown so those shifts are blocked. */
const ROTA_REACH_DAYS = 56;

/**
 * What a reader receives. Pay is withheld unless they see labour cost or set pay where the person
 * works. Personal details are withheld unless they manage the team or read HR there: a supervisor
 * running a shift needs who is on and who is under 18, not an adult's date of birth, the evidence of
 * someone's immigration status, their holiday record or the number of the card that clocks them in.
 */
export function forReader(g: Guard, e: Employee): Employee {
  const sites = sitesOfPerson(e);
  // Pay follows the work: a site they cover for costs their shifts there, so its rate is needed there.
  const seesPay = sites.some((s) => g.can('costs.view', s) || g.can('pay.edit', s));
  // Personal details stay with the home site, as the HR file does (readsHr): covering a shift for
  // another site does not open a person's date of birth, right to work or holiday record to it.
  const seesPersonal = g.can('team.manage', e.siteId) || g.can('hr.view', e.siteId);
  // The holiday record is what the Holiday tab works from, offered to those who see cost.
  const seesHoliday = seesPersonal || seesPay;
  const out: Employee = seesPay ? { ...e } : { ...e, hourlyRate: 0, annualSalary: 0, payHidden: true };
  if (!seesHoliday) delete out.holiday;
  if (!seesPersonal) {
    const rtw = e.rightToWork;
    // An expiry the rota can reach stays, so a shift after it is still blocked; others say only checked or not.
    const expiry = rtw?.expiry && rtw.expiry <= addDays(g.today, ROTA_REACH_DAYS) ? rtw.expiry : undefined;
    out.under18 = Boolean(e.dateOfBirth) && ageOn(e.dateOfBirth, g.today) < 18;
    // Someone under 18 is held to limits that turn on their exact age and school leaving date.
    if (!out.under18) out.dateOfBirth = '';
    out.personalHidden = true;
    out.rightToWork = rtw && { checked: rtw.checked, ...(expiry ? { expiry } : {}) };
    delete out.badgeId;
  }
  return out;
}

function payChanged(before: Partial<Employee>, after: Partial<Employee>) {
  return PAY_FIELDS.some((f) => after[f] !== undefined && after[f] !== before[f]);
}

/** Pay is never set by the person paid, whatever their roles. */
export function allowPay(g: Guard, e: Pick<Employee, 'id' | 'siteId'>) {
  g.allow('pay.edit', e.siteId);
  if (g.user?.employeeId === e.id) throw new HttpError(403, 'forbidden', 'Somebody else changes your own pay.');
}

/**
 * Nobody changes their own staff record, whatever their roles: holiday carried over is paid out at
 * leaving, contracted hours set what they are owed, and a right to work check signed off by the
 * person it is about is no check at all.
 */
function notOwnRecord(g: Guard, e: Pick<Employee, 'id'>) {
  if (g.user?.employeeId === e.id) throw new HttpError(403, 'forbidden', 'Somebody else keeps your own staff record.');
}

export function queueUpsert(org: OrgData, e: Employee) {
  enqueue(org, {
    type: 'employee.upsert',
    payload: { employeeId: e.id },
    // A new key per distinct version of the record: replays of the same change are no-ops in payroll.
    idempotencyKey: `emp:${e.id}:${PAYROLL_FIELDS.map((f) => String(e[f])).join('|')}`,
  });
}

/** The employer must exist, and the home and cover sites must be real sites. */
function validateEmployment(org: OrgData, e: Employee) {
  if (!org.state.sites.some((s) => s.id === e.siteId)) throw notFound(`Site ${e.siteId}`);
  if (!org.state.entities.some((x) => x.id === e.entityId)) throw notFound(`Entity ${e.entityId}`);
  const unknown = e.coverSiteIds.filter((id) => !org.state.sites.some((s) => s.id === id));
  if (unknown.length) throw notFound(`Site ${unknown.join(', ')}`);
}

/** A person as the caller may see them, with any pay change waiting for finance if they set or approve pay there. */
function shown(req: Parameters<typeof employeeView>[0], g: Guard, org: OrgData, e: Employee): Employee {
  const view = forReader(g, employeeView(req, e, g));
  if (view.payHidden || !(g.can('pay.edit', e.siteId) || g.can('pay.approve', e.siteId))) return view;
  const pending = pendingFor(org, e.id);
  return pending ? { ...view, pendingPay: pending } : view;
}

export function employeeRoutes(app: FastifyInstance, ctx: AppContext) {
  // Staff records hold dates of birth, pay and right to work: a scope of their own, not rota:read.
  const read = { preHandler: requireScope('employees:read') };
  const write = { preHandler: requireScope('rota:write') };

  app.get('/v1/employees', { ...read, schema: { tags: ['Employees'] } }, async (req) => {
    const org = orgOf(req);
    const g = guard(ctx, req, org);
    return org.state.employees.filter((e) => visible(g, e)).map((e) => shown(req, g, org, e));
  });

  app.get<{ Params: { id: string } }>('/v1/employees/:id', { ...read, schema: { tags: ['Employees'], params: idParam } }, async (req) => {
    const org = orgOf(req);
    const g = guard(ctx, req, org);
    const e = org.state.employees.find((x) => x.id === req.params.id);
    if (!e || !visible(g, e)) throw notFound(`Employee ${req.params.id}`);
    return shown(req, g, org, e);
  });

  app.post<{ Body: Partial<Employee> }>(
    '/v1/employees',
    {
      ...write,
      schema: {
        tags: ['Employees'],
        description: 'Adds a starter. They are set up in TeamPay automatically.',
        body: { ...employeeBody, required: ['name', 'siteId', 'roleIds', 'payBasis', 'dateOfBirth'] },
      },
    },
    async (req, reply) => {
      const org = orgOf(req);
      const home = org.state.sites.find((s) => s.id === req.body.siteId);
      if (!home) throw notFound(`Site ${req.body.siteId}`);
      const g = guard(ctx, req, org);
      g.allow('team.manage', home.id);
      // A starter's rate is pay like any other: without pay.edit they start at nought for someone who sets pay to fix.
      if (req.body.hourlyRate || req.body.annualSalary) g.allow('pay.edit', home.id);
      // A person's starter begins at nought, with their rate proposed to finance like any other change.
      const proposal = (req.body.hourlyRate || req.body.annualSalary) && proposes(g, org, ctx.store.todayISO())
        ? { payBasis: req.body.payBasis!, hourlyRate: req.body.hourlyRate ?? 0, annualSalary: req.body.annualSalary ?? 0 }
        : null;
      const defaults: Omit<Employee, 'id' | 'name' | 'siteId' | 'roleIds' | 'payBasis' | 'dateOfBirth'> = {
        entityId: home.entityId,
        coverSiteIds: [],
        hourlyRate: 0,
        annualSalary: 0,
        contractedHours: 0,
        maxWeeklyHours: 48,
        optedOutOf48: false,
        irregularHours: true,
        pensionEnrolled: true,
        availability: [],
        leave: [],
      };
      const e: Employee = {
        ...defaults,
        ...(req.body as Pick<Employee, 'name' | 'siteId' | 'roleIds' | 'payBasis' | 'dateOfBirth'>),
        id: `emp_${randomUUID().slice(0, 12)}`,
        status: 'active',
      };
      // Copies are added through their own route once the record exists.
      if (e.rightToWork) e.rightToWork = { ...e.rightToWork, documents: [] };
      if (proposal) Object.assign(e, { hourlyRate: 0, annualSalary: 0 });
      validateEmployment(org, e);
      if (proposal) proposePayChange(org, g, e, proposal, undefined, ctx.store.todayISO());
      org.state.employees.push(e);
      queueUpsert(org, e);
      audit(org, actorName(g), 'employee.created', { id: e.id });
      await kick(ctx, org);
      return reply.code(201).send(shown(req, g, org, e));
    },
  );

  app.patch<{ Params: { id: string }; Body: Partial<Employee> }>(
    '/v1/employees/:id',
    { ...write, schema: { tags: ['Employees'], params: idParam, body: employeeBody } },
    async (req) => {
      const org = orgOf(req);
      const i = org.state.employees.findIndex((x) => x.id === req.params.id);
      if (i < 0) throw notFound(`Employee ${req.params.id}`);
      const before = org.state.employees[i];
      const g = guard(ctx, req, org);
      // A person changing the rate proposes it: the pay in force stays until finance approves.
      const proposal = changesRate(before, req.body) && proposes(g, org, ctx.store.todayISO()) ? proposedTerms(before, req.body) : null;
      const after: Employee = { ...before, ...req.body, id: before.id, ...(proposal ? payTermsOf(before) : {}) };
      if (Object.keys(req.body).some((k) => !PAY_FIELDS.includes(k as keyof Employee))) {
        g.allow('team.manage', before.siteId);
        if (after.siteId !== before.siteId) g.allow('team.manage', after.siteId);
        notOwnRecord(g, before);
      }
      if (payChanged(before, req.body)) allowPay(g, before);
      // The list of stored copies is the server's: editing the check never adds or drops a file.
      if (req.body.rightToWork) after.rightToWork = { ...req.body.rightToWork, documents: before.rightToWork?.documents ?? [] };
      validateEmployment(org, after);
      if (before.payrollId && after.entityId !== before.entityId) {
        throw new HttpError(
          409,
          'scheme_transfer',
          `${before.name} is on ${before.entityId}'s payroll. Moving to another company's PAYE scheme is a leaver there ` +
            '(with a P45) and a new starter in the other, so mark them as a leaver and add them again under the new company.',
        );
      }
      if (proposal) proposePayChange(org, g, after, proposal, undefined, ctx.store.todayISO());
      org.state.employees[i] = after;
      if (after.startDate && after.startDate !== before.startDate) {
        org.state.shifts = org.state.shifts.filter((s) => !(s.employeeId === after.id && s.date < after.startDate!));
      }
      if (PAYROLL_FIELDS.some((f) => before[f] !== after[f])) queueUpsert(org, after);
      // A proposed rate has not changed the record: it is reported when finance approves it.
      const changed = Object.keys(req.body).filter((k) => !proposal || !(['payBasis', 'hourlyRate', 'annualSalary'] as string[]).includes(k));
      // Only the rate was asked for: the proposal is the event, and the record has not changed yet.
      if (changed.length) audit(org, actorName(g), 'employee.updated', { id: after.id, fields: changed });
      await kick(ctx, org);
      return shown(req, g, org, after);
    },
  );

  app.post<{ Params: { id: string }; Body: { leaveDate: string } }>(
    '/v1/employees/:id/leaver',
    {
      ...write,
      schema: {
        tags: ['Employees'],
        description: 'Marks a leaver. Future shifts are removed and TeamPay is told.',
        params: idParam,
        body: { type: 'object', required: ['leaveDate'], properties: { leaveDate: isoDate } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const e = org.state.employees.find((x) => x.id === req.params.id);
      if (!e) throw notFound(`Employee ${req.params.id}`);
      const g = guard(ctx, req, org);
      g.allow('team.manage', e.siteId);
      notOwnRecord(g, e);
      if (e.status === 'leaver') throw new HttpError(409, 'conflict', `${e.name} is already a leaver`);
      e.status = 'leaver';
      e.leaveDate = req.body.leaveDate;
      const removed = org.state.shifts.filter((s) => s.employeeId === e.id && s.date > req.body.leaveDate).length;
      org.state.shifts = org.state.shifts.filter((s) => !(s.employeeId === e.id && s.date > req.body.leaveDate));
      enqueue(org, { type: 'employee.leaver', payload: { employeeId: e.id }, idempotencyKey: `leaver:${e.id}:${req.body.leaveDate}` });
      audit(org, actorName(g), 'employee.leaver', { id: e.id, leaveDate: req.body.leaveDate, shiftsRemoved: removed });
      await kick(ctx, org);
      return { employee: forReader(g, employeeView(req, e, g)), shiftsRemoved: removed };
    },
  );
}
