import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { rosterVsActual } from '../../src/engine/timesheet';
import { weekDates } from '../../src/engine/time';
import type { TimeEntry } from '../../src/engine/types';
import { requireScope } from '../auth';
import { HttpError, londonParts, notFound, orgOf, type AppContext } from '../context';
import { idParam, rangeQuery, siteWeekQuery, timeEntryBody } from '../schemas';
import { audit, type OrgData } from '../store';
import { inRange } from './rota';

type Range = { siteId?: string; from?: string; to?: string };

/** Approved time inside a period already sent to payroll is locked; corrections go in as a resubmission. */
function assertEditable(org: OrgData, entry: Pick<TimeEntry, 'date' | 'status'>) {
  const locked = org.submissions.some(
    (s) => s.status !== 'failed' && s.status !== 'superseded' && entry.date >= s.periodStart && entry.date <= s.periodEnd,
  );
  if (locked && entry.status === 'approved') {
    throw new HttpError(409, 'period_locked', 'This period has been sent to payroll. Reopen it by submitting a correction.');
  }
}

export function timeRoutes(app: FastifyInstance, ctx: AppContext) {
  const read = { preHandler: requireScope('rota:read') };
  const write = { preHandler: requireScope('time:write') };
  const approve = { preHandler: requireScope('time:approve') };

  app.get<{ Querystring: Range }>('/v1/time-entries', { ...read, schema: { tags: ['Time'], querystring: rangeQuery } }, async (req) =>
    orgOf(ctx, req).timeEntries.filter(inRange(req.query)),
  );

  app.post<{ Body: { employeeId: string; siteId: string; roleId?: string; at?: string } }>(
    '/v1/time-entries/clock-in',
    {
      ...write,
      schema: {
        tags: ['Time'],
        description: 'Clock in from the staff app or a site terminal. Matches today\'s rostered shift where there is one.',
        body: {
          type: 'object',
          required: ['employeeId', 'siteId'],
          properties: { employeeId: { type: 'string' }, siteId: { type: 'string' }, roleId: { type: 'string' }, at: { type: 'string', format: 'date-time' } },
        },
      },
    },
    async (req, reply) => {
      const org = orgOf(ctx, req);
      const employee = org.state.employees.find((e) => e.id === req.body.employeeId);
      if (!employee) throw notFound(`Employee ${req.body.employeeId}`);
      if (org.timeEntries.some((t) => t.employeeId === employee.id && t.status === 'open')) {
        throw new HttpError(409, 'already_clocked_in', `${employee.name} is already clocked in`);
      }
      const { date, minute } = londonParts(req.body.at ? new Date(req.body.at) : new Date());
      const shift = org.state.shifts.find((s) => s.employeeId === employee.id && s.date === date && s.siteId === req.body.siteId);
      const entry: TimeEntry = {
        id: `te_${randomUUID().slice(0, 12)}`,
        employeeId: employee.id,
        siteId: req.body.siteId,
        roleId: req.body.roleId ?? shift?.roleId ?? employee.roleIds[0],
        shiftId: shift?.id,
        date,
        clockIn: minute,
        breakMinutes: 0,
        status: 'open',
        source: 'clock',
      };
      org.timeEntries.push(entry);
      return reply.code(201).send(entry);
    },
  );

  app.post<{ Params: { id: string }; Body: { at?: string; breakMinutes?: number } }>(
    '/v1/time-entries/:id/clock-out',
    {
      ...write,
      schema: {
        tags: ['Time'],
        params: idParam,
        body: { type: 'object', properties: { at: { type: 'string', format: 'date-time' }, breakMinutes: { type: 'integer', minimum: 0 } } },
      },
    },
    async (req) => {
      const org = orgOf(ctx, req);
      const entry = org.timeEntries.find((t) => t.id === req.params.id);
      if (!entry) throw notFound(`Time entry ${req.params.id}`);
      if (entry.status !== 'open') throw new HttpError(409, 'not_open', 'Already clocked out');
      const { date, minute } = londonParts(req.body.at ? new Date(req.body.at) : new Date());
      // Past midnight the clock-out minute is carried on from the shift's start date.
      const dayOffset = Math.round((Date.parse(date) - Date.parse(entry.date)) / 86_400_000);
      entry.clockOut = minute + dayOffset * 1440;
      entry.breakMinutes = req.body.breakMinutes ?? entry.breakMinutes;
      entry.status = 'submitted';
      return entry;
    },
  );

  app.post<{ Body: Omit<TimeEntry, 'id' | 'status' | 'source'> }>(
    '/v1/time-entries',
    { ...write, schema: { tags: ['Time'], description: 'Manual entry by a manager, for a missed clock.', body: timeEntryBody } },
    async (req, reply) => {
      const org = orgOf(ctx, req);
      if (!org.state.employees.some((e) => e.id === req.body.employeeId)) throw notFound(`Employee ${req.body.employeeId}`);
      if ((req.body.clockOut ?? 0) <= req.body.clockIn) throw new HttpError(422, 'invalid_time', 'Clock out must be after clock in');
      const entry: TimeEntry = { ...req.body, id: `te_${randomUUID().slice(0, 12)}`, status: 'submitted', source: 'manual' };
      org.timeEntries.push(entry);
      audit(org, req.principal.name, 'time.manual_entry', { id: entry.id });
      return reply.code(201).send(entry);
    },
  );

  app.patch<{ Params: { id: string }; Body: Partial<TimeEntry> }>(
    '/v1/time-entries/:id',
    {
      ...write,
      schema: {
        tags: ['Time'],
        params: idParam,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { clockIn: { type: 'integer' }, clockOut: { type: 'integer' }, breakMinutes: { type: 'integer', minimum: 0 }, roleId: { type: 'string' } },
        },
      },
    },
    async (req) => {
      const org = orgOf(ctx, req);
      const entry = org.timeEntries.find((t) => t.id === req.params.id);
      if (!entry) throw notFound(`Time entry ${req.params.id}`);
      assertEditable(org, entry);
      Object.assign(entry, req.body, { status: entry.status === 'open' ? 'open' : 'submitted', approvedBy: undefined, approvedAt: undefined });
      audit(org, req.principal.name, 'time.edited', { id: entry.id, fields: Object.keys(req.body) });
      return entry;
    },
  );

  app.post<{ Body: { siteId: string; from: string; to: string } | { ids: string[] } }>(
    '/v1/time-entries/approve',
    {
      ...approve,
      schema: {
        tags: ['Time'],
        description: 'Manager sign-off. Only approved time is ever sent to payroll.',
        body: {
          type: 'object',
          properties: {
            ids: { type: 'array', items: { type: 'string' } },
            siteId: { type: 'string' },
            from: { type: 'string' },
            to: { type: 'string' },
          },
        },
      },
    },
    async (req) => {
      const org = orgOf(ctx, req);
      const body = req.body as { ids?: string[]; siteId?: string; from?: string; to?: string };
      const match = body.ids ? (t: TimeEntry) => body.ids!.includes(t.id) : inRange(body);
      const now = new Date().toISOString();
      let approved = 0;
      for (const t of org.timeEntries) {
        if (t.status === 'submitted' && match(t)) {
          t.status = 'approved';
          t.approvedBy = req.principal.name;
          t.approvedAt = now;
          approved++;
        }
      }
      const stillOpen = org.timeEntries.filter((t) => t.status === 'open' && match(t)).length;
      audit(org, req.principal.name, 'time.approved', { approved });
      return { approved, stillOpen };
    },
  );

  app.get<{ Querystring: { siteId: string; weekStart: string } }>(
    '/v1/time-entries/compare',
    { ...read, schema: { tags: ['Time'], description: 'Rostered against clocked hours per person.', querystring: siteWeekQuery } },
    async (req) => {
      const org = orgOf(ctx, req);
      return rosterVsActual(org.state, org.timeEntries, weekDates(req.query.weekStart), req.query.siteId);
    },
  );
}
