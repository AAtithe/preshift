import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { rosterVsActual } from '../../src/engine/timesheet';
import { weekDates } from '../../src/engine/time';
import { breakShortfalls } from '../../src/engine/breaks';
import { checkFence } from '../../src/engine/clocking';
import type { ClockLocation, Employee, GeoFix, TimeEntry } from '../../src/engine/types';
import { hasScope, requireScope } from '../auth';
import { HttpError, londonParts, notFound, orgOf, type AppContext } from '../context';
import { actorName, guard } from '../guard';
import { geoFixBody, idParam, rangeQuery, siteWeekQuery, timeEntryBody } from '../schemas';
import { audit, type OrgData } from '../store';
import { inRange } from './rota';

type Range = { siteId?: string; from?: string; to?: string };

/** Who may read time: those who record it, approve it, or check it for payroll. */
const TIME_READERS = ['time.record', 'time.approve', 'payroll.view'] as const;

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
  /** Sent by a reader fixed at the site under its own key, not from a person's screen. */
  fixedReader?: boolean;
}

/** How far a time sent by a person's screen may be from the server's clock before it is refused. */
const CLOCK_DRIFT_MS = 2 * 60_000;

/**
 * A reader under its own key: an integration key made by an admin, with no person behind it.
 * Only such a reader is trusted for where a card was tapped and when.
 */
export const isFixedReader = (req: FastifyRequest) => !req.principal.email && !req.principal.userId;

/**
 * The time a clock happened. A person's clock happens now, by the server's clock: anyone who records
 * time could otherwise clock a colleague in for a shift they never started. A fixed reader may send the
 * time of a tap it held while offline, never one in the future.
 */
export function clockTime(req: FastifyRequest, at: string | undefined): string | undefined {
  if (!at) return undefined;
  const ms = Date.parse(at);
  const drift = ms - Date.now();
  if (isFixedReader(req) ? drift <= CLOCK_DRIFT_MS : Math.abs(drift) <= CLOCK_DRIFT_MS) return at;
  throw new HttpError(
    422,
    'time_set_by_server',
    'A clock is recorded at the time it happens. For a missed clock-in or out, add a manual entry for a manager to approve.',
  );
}

/**
 * Where the clock happened, checked against the site's geofence. A card tapped on a reader fixed at
 * the site needs no location: the card proves who and the reader proves where. A card read by a
 * person's phone or tablet proves only who, so it needs a location inside the fence like any device clock.
 */
function locate(org: OrgData, siteId: string, opts: ClockOptions): ClockLocation | undefined {
  const site = org.state.sites.find((s) => s.id === siteId);
  if (!site) throw notFound(`Site ${siteId}`);
  const fix = opts.location;
  const reader = opts.method === 'card' && opts.fixedReader;
  if (!site.geofence) return fix && { ...fix };
  if (!fix) {
    if (reader) return undefined;
    throw new HttpError(422, 'location_required', `${site.name} checks location when clocking. Allow location on this device and try again.`);
  }
  const check = checkFence(site.geofence, fix);
  if (!check.ok && !reader) {
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

/** The minute of `at` counted from the entry's own date, so times past midnight carry on (24:30 is 1470). */
function minuteOf(entry: TimeEntry, at?: string): number {
  const { date, minute } = londonParts(at ? new Date(at) : new Date());
  const dayOffset = Math.round((Date.parse(date) - Date.parse(entry.date)) / 86_400_000);
  return minute + dayOffset * 1440;
}

export const onBreak = (entry: TimeEntry) => entry.breaks?.some((b) => b.end === undefined) ?? false;

/** Minutes of break the person recorded, counting only finished breaks. */
export const recordedBreakMinutes = (entry: TimeEntry) =>
  (entry.breaks ?? []).reduce((sum, b) => sum + (b.end !== undefined ? b.end - b.start : 0), 0);

export function startBreak(entry: TimeEntry, at?: string): TimeEntry {
  if (entry.status !== 'open') throw new HttpError(409, 'not_open', 'You are not clocked in.');
  if (onBreak(entry)) throw new HttpError(409, 'already_on_break', 'You are already on a break.');
  const start = Math.max(minuteOf(entry, at), entry.clockIn);
  entry.breaks = [...(entry.breaks ?? []), { start }];
  return entry;
}

export function endBreak(entry: TimeEntry, at?: string): TimeEntry {
  const current = entry.breaks?.find((b) => b.end === undefined);
  if (entry.status !== 'open' || !current) throw new HttpError(409, 'not_on_break', 'You are not on a break.');
  current.end = Math.max(minuteOf(entry, at), current.start);
  return entry;
}

export function clockOut(org: OrgData, entry: TimeEntry, opts: ClockOptions): TimeEntry {
  if (entry.status !== 'open') throw new HttpError(409, 'not_open', 'Already clocked out');
  const location = locate(org, entry.siteId, opts);
  entry.clockOut = minuteOf(entry, opts.at);
  // Clocking out ends a break still running, rather than leaving it open with no end.
  if (onBreak(entry)) endBreak(entry, opts.at);
  // Breaks the person recorded set the unpaid time. A manager can still correct it before approval.
  entry.breakMinutes = opts.breakMinutes ?? (entry.breaks?.length ? recordedBreakMinutes(entry) : entry.breakMinutes);
  entry.status = 'submitted';
  if (location) entry.clockOutLocation = location;
  return entry;
}

export function timeRoutes(app: FastifyInstance, ctx: AppContext) {
  const read = { preHandler: requireScope('rota:read') };
  const write = { preHandler: requireScope('time:write') };
  const approve = { preHandler: requireScope('time:approve') };

  app.get<{ Querystring: Range }>('/v1/time-entries', { ...read, schema: { tags: ['Time'], querystring: rangeQuery } }, async (req) => {
    const org = orgOf(req);
    return org.timeEntries
      .filter(inRange(req.query))
      .filter(guard(ctx, req, org).at(...TIME_READERS))
      // Where someone was when they clocked is personal data; hours are not.
      .map((t) => (hasScope(req, 'employees:read') ? t : { ...t, clockInLocation: undefined, clockOutLocation: undefined }));
  });

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
      guard(ctx, req, org).allow('time.record', req.body.siteId);
      const entry = clockIn(org, employee, req.body.siteId, { method: 'device', ...req.body, at: clockTime(req, req.body.at) });
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
      guard(ctx, req, org).allow('time.record', entry.siteId);
      return clockOut(org, entry, { method: 'device', ...req.body, at: clockTime(req, req.body.at) });
    },
  );

  app.post<{ Body: Omit<TimeEntry, 'id' | 'status' | 'source'> }>(
    '/v1/time-entries',
    { ...write, schema: { tags: ['Time'], description: 'Manual entry by a manager, for a missed clock.', body: timeEntryBody } },
    async (req, reply) => {
      const org = orgOf(req);
      if (!org.state.employees.some((e) => e.id === req.body.employeeId)) throw notFound(`Employee ${req.body.employeeId}`);
      const g = guard(ctx, req, org);
      g.allow('time.record', req.body.siteId);
      if ((req.body.clockOut ?? 0) <= req.body.clockIn) throw new HttpError(422, 'invalid_time', 'Clock out must be after clock in');
      const entry: TimeEntry = { ...req.body, id: `te_${randomUUID().slice(0, 12)}`, status: 'submitted', source: 'manual' };
      org.timeEntries.push(entry);
      audit(org, actorName(g), 'time.manual_entry', { id: entry.id });
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
      const g = guard(ctx, req, org);
      g.allow('time.record', entry.siteId);
      assertEditable(org, entry);
      Object.assign(entry, req.body, { status: entry.status === 'open' ? 'open' : 'submitted', approvedBy: undefined, approvedAt: undefined });
      audit(org, actorName(g), 'time.edited', { id: entry.id, fields: Object.keys(req.body) });
      return entry;
    },
  );

  app.post<{ Body: { siteId: string; from: string; to: string } | { ids: string[] } }>(
    '/v1/time-entries/approve',
    {
      ...approve,
      schema: {
        tags: ['Time'],
        description:
          'Manager sign-off. Only approved time is ever sent to payroll. A person never approves their own hours: ' +
          'by range they are skipped and counted in ownSkipped, by id they are refused.',
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
      const g = guard(ctx, req, org);
      if (body.siteId) g.allow('time.approve', body.siteId);
      const match = body.ids ? (t: TimeEntry) => body.ids!.includes(t.id) : inRange(body);
      const own = (t: TimeEntry) => !!g.behind?.employeeId && t.employeeId === g.behind.employeeId;
      const candidates = org.timeEntries.filter((t) => t.status === 'submitted' && match(t));
      if (body.ids) {
        for (const t of candidates) {
          g.allow('time.approve', t.siteId);
          if (own(t)) throw new HttpError(403, 'forbidden', 'Somebody else approves your own hours.', { id: t.id });
        }
      }
      // By range, only what this person may approve: their sites, never their own hours.
      const approvable = candidates.filter(g.at('time.approve')).filter((t) => !own(t));
      const now = new Date().toISOString();
      for (const t of approvable) {
        t.status = 'approved';
        t.approvedBy = actorName(g);
        t.approvedAt = now;
      }
      const ownSkipped = candidates.filter(own).length;
      const stillOpen = org.timeEntries.filter((t) => t.status === 'open' && match(t)).length;
      // Approving is never blocked: the hours were worked and are owed. The shortfall is recorded with the approval.
      const short = breakShortfalls(approvable, org.state.employees);
      audit(org, actorName(g), 'time.approved', {
        approved: approvable.length,
        ownSkipped,
        ...(short.length ? { belowBreakMinimum: short.map((b) => b.entryId) } : {}),
      });
      return { approved: approvable.length, ownSkipped, stillOpen, belowBreakMinimum: short.length };
    },
  );

  app.get<{ Querystring: Range }>(
    '/v1/time-entries/break-check',
    {
      ...read,
      schema: {
        tags: ['Time'],
        description:
          'Finished shifts with less rest break than the Working Time Regulations give: 20 minutes in one block when working time ' +
          'is over 6 hours, 30 minutes over 4.5 hours for under 18s. "short" is too little in total; "split" is enough in total ' +
          'but no single break long enough.',
        querystring: rangeQuery,
      },
    },
    async (req) => {
      const org = orgOf(req);
      // Who may see the hours sees their breaks: the same sites as the time entries themselves.
      return breakShortfalls(org.timeEntries.filter(inRange(req.query)).filter(guard(ctx, req, org).at(...TIME_READERS)), org.state.employees);
    },
  );

  app.get<{ Querystring: { siteId: string; weekStart: string } }>(
    '/v1/time-entries/compare',
    { ...read, schema: { tags: ['Time'], description: 'Rostered against clocked hours per person.', querystring: siteWeekQuery } },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      if (!g.at(...TIME_READERS)({ siteId: req.query.siteId })) g.allow('time.approve', req.query.siteId);
      return rosterVsActual(org.state, org.timeEntries, weekDates(req.query.weekStart), req.query.siteId);
    },
  );
}
