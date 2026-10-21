import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Employee } from '../../src/engine/types';
import { requireScope } from '../auth';
import { HttpError, kick, notFound, orgOf, type AppContext } from '../context';
import { enqueue } from '../outbox';
import { employeeBody, idParam, isoDate } from '../schemas';
import { audit, type OrgData } from '../store';

// Fields payroll holds a copy of; changing any of them is synced to TeamPay.
const PAYROLL_FIELDS: (keyof Employee)[] = [
  'name', 'dateOfBirth', 'siteId', 'payBasis', 'hourlyRate', 'annualSalary',
  'contractedHours', 'irregularHours', 'pensionEnrolled',
];

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

  app.get('/v1/employees', { ...read, schema: { tags: ['Employees'] } }, async (req) => orgOf(ctx, req).state.employees);

  app.get<{ Params: { id: string } }>('/v1/employees/:id', { ...read, schema: { tags: ['Employees'], params: idParam } }, async (req) => {
    const e = orgOf(ctx, req).state.employees.find((x) => x.id === req.params.id);
    if (!e) throw notFound(`Employee ${req.params.id}`);
    return e;
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
      audit(org, req.principal.name, 'employee.created', { id: e.id });
      kick(ctx);
      return reply.code(201).send(e);
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
      const after: Employee = { ...before, ...req.body, id: before.id };
      org.state.employees[i] = after;
      if (PAYROLL_FIELDS.some((f) => before[f] !== after[f])) queueUpsert(org, after);
      audit(org, req.principal.name, 'employee.updated', { id: after.id, fields: Object.keys(req.body) });
      kick(ctx);
      return after;
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
      if (e.status === 'leaver') throw new HttpError(409, 'conflict', `${e.name} is already a leaver`);
      e.status = 'leaver';
      e.leaveDate = req.body.leaveDate;
      const removed = org.state.shifts.filter((s) => s.employeeId === e.id && s.date > req.body.leaveDate).length;
      org.state.shifts = org.state.shifts.filter((s) => !(s.employeeId === e.id && s.date > req.body.leaveDate));
      enqueue(org, { type: 'employee.leaver', payload: { employeeId: e.id }, idempotencyKey: `leaver:${e.id}:${req.body.leaveDate}` });
      audit(org, req.principal.name, 'employee.leaver', { id: e.id, leaveDate: req.body.leaveDate, shiftsRemoved: removed });
      kick(ctx);
      return { employee: e, shiftsRemoved: removed };
    },
  );
}
