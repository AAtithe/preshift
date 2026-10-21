import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { rosterVsActual } from '../../src/engine/timesheet';
import { weekDates } from '../../src/engine/time';
import { checkFence } from '../../src/engine/clocking';
import type { ClockLocation, Employee, GeoFix, TimeEntry } from '../../src/engine/types';
import { requireScope } from '../auth';
import { HttpError, londonParts, notFound, orgOf, type AppContext } from '../context';
import { geoFixBody, idParam, rangeQuery, siteWeekQuery, timeEntryBody } from '../schemas';
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

interface ClockOptions {
  method: 'card' | 'device' | 'phone';
  at?: string;
  roleId?: string;
  breakMinutes?: number;
  location?: GeoFix;
}

/**
 * Where the clock happened, checked against the site's geofence. A card tap is made on a reader
 * fixed at the site, so the card proves who and the reader proves where; any location sent with
 * it is kept but not enforced. A device clock needs a location inside the fence.
 */
function locate(org: OrgData, siteId: string, opts: ClockOptions): ClockLocation | undefined {
  const site = org.state.sites.find((s) => s.id === siteId);
  if (!site) throw notFound(`Site ${siteId}`);
  const fix = opts.location;
  if (!site.geofence) return fix && { ...fix };
  if (!fix) {
    if (opts.method === 'card') return undefined;
    throw new HttpError(422, 'location_required', `${site.name} checks location when clocking. Allow location on this device and try again.`);
  }
  const check = checkFence(site.geofence, fix);
  if (!check.ok && opts.method !== 'card') {
    throw new HttpError(
      422,
      check.reason,
      check.reason === 'too_imprecise'
        ? `This device can only place itself within ${Math.round(fix.accuracyMetres)} m. Move nearer a window or turn on precise location, then try again.`
        : `This device is ${check.distanceMetres} m from ${site.name}, outside its ${site.geofence.radiusMetres} m clocking area.`,
      { distanceMetres: check.distanceMetres, radiusMetres: site.geofence.radiusMetres },
    );
  }
  return { ...fix, distanceMetres: check.distanceMetres };
}

export function clockIn(org: OrgData, employee: Employee, siteId: string, opts: ClockOptions): TimeEntry {
  if (employee.status === 'leaver') throw new HttpError(409, 'leaver', `${employee.name} has left and cannot clock in`);
  if (org.timeEntries.some((t) => t.employeeId === employee.id && t.status === 'open')) {
    throw new HttpError(409, 'already_clocked_in', `${employee.name} is already clocked in`);
  }
  const location = locate(org, siteId, opts);
  const { date, minute } = londonParts(opts.at ? new Date(opts.at) : new Date());
  const shift = org.state.shifts.find((s) => s.employeeId === employee.id && s.date === date && s.siteId === siteId);
  const entry: TimeEntry = {
    id: `te_${randomUUID().slice(0, 12)}`,
    employeeId: employee.id,
    siteId,
    roleId: opts.roleId ?? shift?.roleId ?? employee.roleIds[0],
    shiftId: shift?.id,
    date,
    clockIn: minute,
    breakMinutes: 0,
    status: 'open',
    source: 'clock',
    method: opts.method,
    ...(location ? { clockInLocation: location } : {}),
  };
  org.timeEntries.push(entry);
  return entry;
}

export function clockOut(org: OrgData, entry: TimeEntry, opts: ClockOptions): TimeEntry {
  if (entry.status !== 'open') throw new HttpError(409, 'not_open', 'Already clocked out');
  const location = locate(org, entry.siteId, opts);
  const { date, minute } = londonParts(opts.at ? new Date(opts.at) : new Date());
  // Past midnight the clock-out minute is carried on from the shift's start date.
  const dayOffset = Math.round((Date.parse(date) - Date.parse(entry.date)) / 86_400_000);
  entry.clockOut = minute + dayOffset * 1440;
  entry.breakMinutes = opts.breakMinutes ?? entry.breakMinutes;
  entry.status = 'submitted';
  if (location) entry.clockOutLocation = location;
  return entry;
}

export function timeRoutes(app: FastifyInstance, _ctx: AppContext) {
  const read = { preHandler: requireScope('rota:read') };
  const write = { preHandler: requireScope('time:write') };
  const approve = { preHandler: requireScope('time:approve') };

  app.get<{ Querystring: Range }>('/v1/time-entries', { ...read, schema: { tags: ['Time'], querystring: rangeQuery } }, async (req) =>
    orgOf(req).timeEntries.filter(inRange(req.query)),
  );

  app.post<{ Body: { employeeId: string; siteId: string; roleId?: string; at?: string; location?: GeoFix } }>(
    '/v1/time-entries/clock-in',
    {
      ...write,
      schema: {
        tags: ['Time'],
        description:
          "Clock in on a phone or tablet. Matches today's rostered shift where there is one. When the site has a " +
          'geofence, the device location is required and must be inside it.',
        body: {
          type: 'object',
          required: ['employeeId', 'siteId'],
          properties: {
            employeeId: { type: 'string' },
            siteId: { type: 'string' },
            roleId: { type: 'string' },
            at: { type: 'string', format: 'date-time' },
            location: geoFixBody,
          },
        },
      },
    },
    async (req, reply) => {
      const org = orgOf(req);
      const employee = org.state.employees.find((e) => e.id === req.body.employeeId);
      if (!employee) throw notFound(`Employee ${req.body.employeeId}`);
      const entry = clockIn(org, employee, req.body.siteId, { method: 'device', ...req.body });
      return reply.code(201).send(entry);
    },
  );

  app.post<{ Params: { id: string }; Body: { at?: string; breakMinutes?: number; location?: GeoFix } }>(
    '/v1/time-entries/:id/clock-out',
    {
      ...write,
      schema: {
        tags: ['Time'],
        description: 'Clock out on a phone or tablet. The geofence applies as it does to clocking in.',
        params: idParam,
        body: {
          type: 'object',
          properties: { at: { type: 'string', format: 'date-time' }, breakMinutes: { type: 'integer', minimum: 0 }, location: geoFixBody },
        },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const entry = org.timeEntries.find((t) => t.id === req.params.id);
      if (!entry) throw notFound(`Time entry ${req.params.id}`);
      return clockOut(org, entry, { method: 'device', ...req.body });
    },
  );

  app.post<{ Body: Omit<TimeEntry, 'id' | 'status' | 'source'> }>(
    '/v1/time-entries',
    { ...write, schema: { tags: ['Time'], description: 'Manual entry by a manager, for a missed clock.', body: timeEntryBody } },
    async (req, reply) => {
      const org = orgOf(req);
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
      const org = orgOf(req);
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
      const org = orgOf(req);
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
      const org = orgOf(req);
      return rosterVsActual(org.state, org.timeEntries, weekDates(req.query.weekStart), req.query.siteId);
    },
  );
}
