import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { autoScheduleSites } from '../../src/engine/autoschedule';
import { checkEmployeeWeek, checkWeek } from '../../src/engine/compliance';
import { weekMetrics, type WeekMetrics } from '../../src/engine/metrics';
import { hasStarted, weekFingerprint } from '../../src/engine/rotaWeek';
import { addDays, londonParts, weekDates, weekStart } from '../../src/engine/time';
import type { HourForecast, Shift } from '../../src/engine/types';
import { requireScope } from '../auth';
import { HttpError, notFound, orgOf, type AppContext } from '../context';
import { forecastBody, idParam, rangeQuery, shiftBody, sitesWeekBody, siteWeekQuery } from '../schemas';
import { audit, type OrgData } from '../store';

type SiteWeek = { siteId: string; weekStart: string };
type SitesWeek = { siteId?: string; siteIds?: string[]; weekStart: string };
type Range = { siteId?: string; from?: string; to?: string };

export function serialiseMetrics(m: WeekMetrics) {
  const { cost, ...rest } = m;
  return {
    ...rest,
    cost: {
      total: cost.total,
      unallocated: cost.unallocated,
      employees: Object.fromEntries(cost.employees),
      shifts: Object.fromEntries(cost.shifts),
    },
  };
}

export const inRange = (q: Range) => (x: { date: string; siteId: string }) =>
  (!q.siteId || x.siteId === q.siteId) && (!q.from || x.date >= q.from) && (!q.to || x.date <= q.to);

function requireSite(org: OrgData, siteId: string) {
  if (!org.state.sites.some((s) => s.id === siteId)) throw notFound(`Site ${siteId}`);
}

/**
 * The sites a group call covers: `siteIds` if given, otherwise the single
 * `siteId`. Building needs real sites; clearing or publishing an unknown one
 * just touches nothing, as it always has.
 */
function sitesOf(org: OrgData, body: SitesWeek, mustExist: boolean): string[] {
  const ids = body.siteIds ?? (body.siteId ? [body.siteId] : []);
  if (ids.length === 0) throw new HttpError(400, 'invalid_request', 'Give siteId or siteIds');
  if (mustExist) for (const id of ids) requireSite(org, id);
  return [...new Set(ids)];
}

function sameShift(a: Shift, b: Shift) {
  return (
    a.employeeId === b.employeeId &&
    a.roleId === b.roleId &&
    a.date === b.date &&
    a.startMinute === b.startMinute &&
    a.endMinute === b.endMinute &&
    (a.breakMinutes ?? 0) === (b.breakMinutes ?? 0)
  );
}

/**
 * A shift that has started, or been clocked against, is a record of what happened: timesheets,
 * holiday and payroll hang off it. Manual edits may still extend it or change its break while it is
 * running, but nothing can reassign, move or remove it, and nothing changes once it has finished.
 */
function isWorked(org: OrgData, shift: Shift, now = londonParts(new Date())) {
  return hasStarted(shift, now) || org.timeEntries.some((t) => t.shiftId === shift.id);
}

function hasFinished(shift: Shift, now = londonParts(new Date())) {
  return hasStarted({ date: shift.date, startMinute: shift.endMinute }, now);
}

const workedError = (shift: Shift, detail: string) =>
  new HttpError(409, 'worked_shift', `This shift has started or been clocked against, so ${detail}`, [shift.id]);

function validateShift(org: OrgData, shift: Shift) {
  requireSite(org, shift.siteId);
  if (!org.state.employees.some((e) => e.id === shift.employeeId)) throw notFound(`Employee ${shift.employeeId}`);
  if (!org.state.roles.some((r) => r.id === shift.roleId)) throw notFound(`Role ${shift.roleId}`);
  if (shift.endMinute <= shift.startMinute) throw new HttpError(422, 'invalid_shift', 'Shift must end after it starts');
}

/** Compliance for the person whose week this shift sits in, so callers see consequences straight away. */
function shiftIssues(org: OrgData, shift: Shift) {
  const employee = org.state.employees.find((e) => e.id === shift.employeeId)!;
  const ws = weekStart(shift.date);
  const context = org.state.shifts.filter((s) => s.date >= addDays(ws, -1) && s.date <= addDays(ws, 7));
  return checkEmployeeWeek(employee, ws, context);
}

export function rotaRoutes(app: FastifyInstance, _ctx: AppContext) {
  const read = { preHandler: requireScope('rota:read') };
  const write = { preHandler: requireScope('rota:write') };

  app.get('/v1/entities', { ...read, schema: { tags: ['Reference'], description: 'Companies in the group: each is its own PAYE scheme and ledger.' } }, async (req) =>
    orgOf(req).state.entities,
  );
  app.get('/v1/sites', { ...read, schema: { tags: ['Reference'] } }, async (req) => orgOf(req).state.sites);
  app.get('/v1/roles', { ...read, schema: { tags: ['Reference'] } }, async (req) => orgOf(req).state.roles);
  app.get('/v1/demand-rules', { ...read, schema: { tags: ['Reference'] } }, async (req) => orgOf(req).state.demandRules);

  app.get<{ Querystring: Range }>('/v1/shifts', { ...read, schema: { tags: ['Shifts'], querystring: rangeQuery } }, async (req) =>
    orgOf(req).state.shifts.filter(inRange(req.query)),
  );

  app.post<{ Body: Shift }>('/v1/shifts', { ...write, schema: { tags: ['Shifts'], body: shiftBody } }, async (req, reply) => {
    const org = orgOf(req);
    const shift: Shift = { ...req.body, id: req.body.id ?? `s_${randomUUID()}`, published: false };
    if (org.state.shifts.some((s) => s.id === shift.id)) throw new HttpError(409, 'conflict', `Shift ${shift.id} exists`);
    validateShift(org, shift);
    org.state.shifts.push(shift);
    audit(org, req.principal.name, 'shift.created', { id: shift.id });
    return reply.code(201).send({ shift, issues: shiftIssues(org, shift) });
  });

  app.patch<{ Params: { id: string }; Body: Partial<Shift> }>(
    '/v1/shifts/:id',
    { ...write, schema: { tags: ['Shifts'], params: idParam, body: { ...shiftBody, required: [] } } },
    async (req) => {
      const org = orgOf(req);
      const i = org.state.shifts.findIndex((s) => s.id === req.params.id);
      if (i < 0) throw notFound(`Shift ${req.params.id}`);
      const old = org.state.shifts[i];
      if (isWorked(org, old)) {
        const moved = (['employeeId', 'roleId', 'siteId', 'date', 'startMinute'] as const).filter((k) => req.body[k] !== undefined && req.body[k] !== old[k]);
        if (moved.length) throw workedError(old, 'only its finish time and break can change.');
        if (hasFinished(old)) throw workedError(old, 'and it has finished, it can no longer be changed. Correct the hours on the timesheet.');
      }
      const shift: Shift = { ...old, ...req.body, id: req.params.id, published: false };
      validateShift(org, shift);
      org.state.shifts[i] = shift;
      audit(org, req.principal.name, 'shift.updated', { id: shift.id });
      return { shift, issues: shiftIssues(org, shift) };
    },
  );

  app.delete<{ Params: { id: string } }>('/v1/shifts/:id', { ...write, schema: { tags: ['Shifts'], params: idParam } }, async (req, reply) => {
    const org = orgOf(req);
    const target = org.state.shifts.find((s) => s.id === req.params.id);
    if (!target) throw notFound(`Shift ${req.params.id}`);
    if (isWorked(org, target)) throw workedError(target, 'it cannot be removed. Record an absence on the timesheet instead.');
    org.state.shifts = org.state.shifts.filter((s) => s.id !== req.params.id);
    audit(org, req.principal.name, 'shift.deleted', { id: req.params.id });
    return reply.code(204).send();
  });

  app.get<{ Querystring: SiteWeek }>('/v1/rota/week', { ...read, schema: { tags: ['Rota'], querystring: siteWeekQuery } }, async (req) => {
    const org = orgOf(req);
    const { siteId, weekStart: ws } = req.query;
    requireSite(org, siteId);
    const dates = weekDates(ws);
    return {
      siteId,
      weekStart: ws,
      shifts: org.state.shifts.filter((s) => s.siteId === siteId && dates.includes(s.date)),
      metrics: serialiseMetrics(weekMetrics(org.state, siteId, ws)),
      issues: checkWeek(org.state, ws, siteId),
    };
  });

  app.post<{ Body: SitesWeek }>(
    '/v1/rota/build',
    {
      ...write,
      schema: {
        tags: ['Rota'],
        description: "Builds one site or several from the forecast. Each site's own team goes first, then agreed cover from other sites.",
        body: sitesWeekBody,
      },
    },
    async (req) => {
      const org = orgOf(req);
      const siteIds = sitesOf(org, req.body, true);
      const result = autoScheduleSites(org.state, siteIds, req.body.weekStart);
      // The build fills the whole week; hours already gone are left as they happened.
      const now = londonParts(new Date());
      const late = new Set(result.added.filter((s) => hasStarted(s, now)).map((s) => s.id));
      result.added = result.added.filter((s) => !late.has(s.id));
      result.unfilled = result.unfilled.filter((g) => !hasStarted({ date: g.date, startMinute: g.toHour * 60 - 1 }, now));
      org.state.shifts = result.shifts.filter((s) => !late.has(s.id));
      audit(org, req.principal.name, 'rota.built', { siteIds, weekStart: req.body.weekStart, added: result.added.length, unfilled: result.unfilled.length });
      return { added: result.added, unfilled: result.unfilled };
    },
  );

  // Replaces a site's week in one go: how an accepted rota assistant draft is saved. All or nothing,
  // refused if the week changed since the draft began, and never touches a shift that has started
  // or been clocked against, because timesheets and payroll hang off those.
  app.put<{ Body: SiteWeek & { shifts: Shift[]; baseline?: string; source?: 'assistant'; instruction?: string } }>(
    '/v1/rota/week',
    {
      ...write,
      schema: {
        tags: ['Rota'],
        description:
          "Replaces every shift in the site's week with the shifts given, after validating each. Pass the week's " +
          'fingerprint as `baseline` to have the save refused if anyone changed the week since. Shifts that have ' +
          'started or have clock records must be included unchanged.',
        body: {
          type: 'object',
          required: ['siteId', 'weekStart', 'shifts'],
          properties: {
            ...siteWeekQuery.properties,
            shifts: { type: 'array', maxItems: 2000, items: shiftBody },
            baseline: { type: 'string', maxLength: 64 },
            source: { type: 'string', enum: ['assistant'] },
            instruction: { type: 'string', maxLength: 2000 },
          },
        },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const { siteId, weekStart: ws, baseline } = req.body;
      requireSite(org, siteId);
      const dates = weekDates(ws);
      if (baseline !== undefined && baseline !== weekFingerprint(org.state.shifts, siteId, ws)) {
        throw new HttpError(409, 'rota_changed', 'Someone changed this week while the draft was being written. Draft again from the current rota.');
      }

      const current = org.state.shifts.filter((s) => s.siteId === siteId && dates.includes(s.date));
      const byId = new Map(current.map((s) => [s.id, s]));
      const incoming: Shift[] = req.body.shifts.map((s) => {
        const id = s.id ?? `s_${randomUUID()}`;
        const old = byId.get(id);
        const same = old && sameShift(old, s);
        // An unchanged shift keeps its published state, so a small change does not unpublish the week.
        return { ...s, id, breakMinutes: s.breakMinutes ?? 0, published: same ? Boolean(old.published) : false };
      });
      for (const s of incoming) {
        if (s.siteId !== siteId || !dates.includes(s.date)) {
          throw new HttpError(422, 'outside_week', `Shift ${s.id} is not in this site's week`);
        }
        validateShift(org, s);
      }

      const now = londonParts(new Date());
      const clocked = new Set(org.timeEntries.map((t) => t.shiftId).filter(Boolean));
      const kept = new Map(incoming.map((s) => [s.id, s]));
      const touched = current.filter((s) => (hasStarted(s, now) || clocked.has(s.id)) && !(kept.has(s.id) && sameShift(s, kept.get(s.id)!)));
      if (touched.length) {
        throw new HttpError(409, 'worked_shift', 'Shifts that have started or been clocked cannot be moved or removed here.', touched.map((s) => s.id));
      }

      const keep = org.state.shifts.filter((s) => !(s.siteId === siteId && dates.includes(s.date)));
      org.state.shifts = [...keep, ...incoming];
      audit(org, req.principal.name, req.body.source === 'assistant' ? 'rota.assistant_applied' : 'rota.replaced', {
        siteId,
        weekStart: ws,
        shifts: incoming.length,
        ...(req.body.instruction ? { instruction: req.body.instruction } : {}),
      });
      return { shifts: incoming, issues: checkWeek(org.state, ws, siteId) };
    },
  );

  app.post<{ Body: SitesWeek }>('/v1/rota/clear', { ...write, schema: { tags: ['Rota'], body: sitesWeekBody } }, async (req) => {
    const org = orgOf(req);
    const siteIds = sitesOf(org, req.body, false);
    const dates = weekDates(req.body.weekStart);
    const now = londonParts(new Date());
    // Worked shifts stay: clearing a week plans it afresh, it does not rewrite what happened.
    const keep = org.state.shifts.filter((s) => !(siteIds.includes(s.siteId) && dates.includes(s.date)) || isWorked(org, s, now));
    const removed = org.state.shifts.length - keep.length;
    const kept = keep.filter((s) => siteIds.includes(s.siteId) && dates.includes(s.date)).length;
    org.state.shifts = keep;
    audit(org, req.principal.name, 'rota.cleared', { siteIds, weekStart: req.body.weekStart, removed, kept });
    return { removed, kept };
  });

  app.post<{ Body: SitesWeek }>('/v1/rota/publish', { ...write, schema: { tags: ['Rota'], body: sitesWeekBody } }, async (req) => {
    const org = orgOf(req);
    const siteIds = sitesOf(org, req.body, false);
    const ws = req.body.weekStart;
    // All or nothing: a group publish is refused if any site in it has a blocking issue.
    const blocks = checkWeek(org.state, ws, siteIds).filter((i) => i.severity === 'block');
    if (blocks.length) throw new HttpError(409, 'compliance_block', 'Resolve blocking issues before publishing', blocks);
    const dates = weekDates(ws);
    let published = 0;
    for (const s of org.state.shifts) {
      if (siteIds.includes(s.siteId) && dates.includes(s.date)) {
        s.published = true;
        published++;
      }
    }
    audit(org, req.principal.name, 'rota.published', { siteIds, weekStart: ws, published });
    return { published };
  });

  app.get<{ Querystring: Range }>('/v1/forecast', { ...read, schema: { tags: ['Forecast'], querystring: rangeQuery } }, async (req) =>
    orgOf(req).state.forecast.filter(inRange(req.query)),
  );

  // Preshift Reports (or any forecasting source) pushes hourly sales and covers here.
  app.put<{ Body: { rows: HourForecast[] } }>('/v1/forecast', { ...write, schema: { tags: ['Forecast'], body: forecastBody } }, async (req) => {
    const org = orgOf(req);
    const key = (f: HourForecast) => `${f.siteId}|${f.date}|${f.hour}`;
    const incoming = new Map(req.body.rows.map((r) => [key(r), r]));
    org.state.forecast = [...org.state.forecast.filter((f) => !incoming.has(key(f))), ...incoming.values()];
    audit(org, req.principal.name, 'forecast.upserted', { rows: incoming.size });
    return { upserted: incoming.size };
  });
}
