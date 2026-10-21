import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Employee } from '../../src/engine/types';
import { requireScope } from '../auth';
import { HttpError, kick, notFound, orgOf, type AppContext } from '../context';
import { actorName, guard, type Guard } from '../guard';
import { enqueue } from '../outbox';
import { employeeBody, idParam, isoDate } from '../schemas';
import { audit, type OrgData } from '../store';

// Fields payroll holds a copy of; changing any of them is synced to TeamPay.
const PAYROLL_FIELDS: (keyof Employee)[] = [
  'name', 'dateOfBirth', 'siteId', 'payBasis', 'hourlyRate', 'annualSalary',
  'contractedHours', 'irregularHours', 'pensionEnrolled',
];

// Fields that are pay: changing them is pay.edit, which stays apart from sending payroll.
const PAY_FIELDS: (keyof Employee)[] = ['hourlyRate', 'annualSalary', 'payBasis'];

/** What a reader receives: pay withheld where they cannot see labour cost or set pay. */
function forReader(g: Guard, e: Employee): Employee {
  if (g.can('costs.view', e.siteId) || g.can('pay.edit', e.siteId)) return e;
  return { ...e, hourlyRate: 0, annualSalary: 0, payHidden: true };
}

function payChanged(before: Partial<Employee>, after: Partial<Employee>) {
  return PAY_FIELDS.some((f) => after[f] !== undefined && after[f] !== before[f]);
}

/** Pay is never set by the person paid, whatever their roles. */
function allowPay(g: Guard, e: Pick<Employee, 'id' | 'siteId'>) {
  g.allow('pay.edit', e.siteId);
  if (g.user?.employeeId === e.id) throw new HttpError(403, 'forbidden', 'Somebody else changes your own pay.');
}

function queueUpsert(org: OrgData, e: Employee) {
  enqueue(org, {
    type: 'employee.upsert',
    payload: { employeeId: e.id },
    // A new key per distinct version of the record: replays of the same change are no-ops in payroll.
    idempotencyKey: `emp:${e.id}:${PAYROLL_FIELDS.map((f) => String(e[f])).join('|')}`,
  });
}

export function employeeRoutes(app: FastifyInstance, ctx: AppContext) {
  const read = { preHandler: requireScope('rota:read') };
  const write = { preHandler: requireScope('rota:write') };

  app.get('/v1/employees', { ...read, schema: { tags: ['Employees'] } }, async (req) => {
    const org = orgOf(ctx, req);
    const g = guard(ctx, req, org);
    return org.state.employees.filter(g.at('rota.view', 'team.manage')).map((e) => forReader(g, e));
  });

  app.get<{ Params: { id: string } }>('/v1/employees/:id', { ...read, schema: { tags: ['Employees'], params: idParam } }, async (req) => {
    const org = orgOf(ctx, req);
    const g = guard(ctx, req, org);
    const e = org.state.employees.find((x) => x.id === req.params.id);
    if (!e || !g.at('rota.view', 'team.manage')(e)) throw notFound(`Employee ${req.params.id}`);
    return forReader(g, e);
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
      const org = orgOf(ctx, req);
      if (!org.state.sites.some((s) => s.id === req.body.siteId)) throw notFound(`Site ${req.body.siteId}`);
      const g = guard(ctx, req, org);
      g.allow('team.manage', req.body.siteId!);
      // A starter's rate is pay like any other: without pay.edit they start at nought for someone who sets pay to fix.
      if (req.body.hourlyRate || req.body.annualSalary) g.allow('pay.edit', req.body.siteId!);
      const defaults: Omit<Employee, 'id' | 'name' | 'siteId' | 'roleIds' | 'payBasis' | 'dateOfBirth'> = {
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
      org.state.employees.push(e);
      queueUpsert(org, e);
      audit(org, actorName(g), 'employee.created', { id: e.id });
      kick(ctx);
      return reply.code(201).send(forReader(g, e));
    },
  );

  app.patch<{ Params: { id: string }; Body: Partial<Employee> }>(
    '/v1/employees/:id',
    { ...write, schema: { tags: ['Employees'], params: idParam, body: employeeBody } },
    async (req) => {
      const org = orgOf(ctx, req);
      const i = org.state.employees.findIndex((x) => x.id === req.params.id);
      if (i < 0) throw notFound(`Employee ${req.params.id}`);
      const before = org.state.employees[i];
      const g = guard(ctx, req, org);
      const after: Employee = { ...before, ...req.body, id: before.id };
      if (Object.keys(req.body).some((k) => !PAY_FIELDS.includes(k as keyof Employee))) {
        g.allow('team.manage', before.siteId);
        if (after.siteId !== before.siteId) g.allow('team.manage', after.siteId);
      }
      if (payChanged(before, req.body)) allowPay(g, before);
      org.state.employees[i] = after;
      if (PAYROLL_FIELDS.some((f) => before[f] !== after[f])) queueUpsert(org, after);
      audit(org, actorName(g), 'employee.updated', { id: after.id, fields: Object.keys(req.body) });
      kick(ctx);
      return forReader(g, after);
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
      const org = orgOf(ctx, req);
      const e = org.state.employees.find((x) => x.id === req.params.id);
      if (!e) throw notFound(`Employee ${req.params.id}`);
      const g = guard(ctx, req, org);
      g.allow('team.manage', e.siteId);
      if (e.status === 'leaver') throw new HttpError(409, 'conflict', `${e.name} is already a leaver`);
      e.status = 'leaver';
      e.leaveDate = req.body.leaveDate;
      const removed = org.state.shifts.filter((s) => s.employeeId === e.id && s.date > req.body.leaveDate).length;
      org.state.shifts = org.state.shifts.filter((s) => !(s.employeeId === e.id && s.date > req.body.leaveDate));
      enqueue(org, { type: 'employee.leaver', payload: { employeeId: e.id }, idempotencyKey: `leaver:${e.id}:${req.body.leaveDate}` });
      audit(org, actorName(g), 'employee.leaver', { id: e.id, leaveDate: req.body.leaveDate, shiftsRemoved: removed });
      kick(ctx);
      return { employee: forReader(g, e), shiftsRemoved: removed };
    },
  );
}
