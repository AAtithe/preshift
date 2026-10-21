import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { autoSchedule } from '../../src/engine/autoschedule';
import { checkEmployeeWeek, checkWeek } from '../../src/engine/compliance';
import { weekMetrics, type WeekMetrics } from '../../src/engine/metrics';
import { addDays, weekDates, weekStart } from '../../src/engine/time';
import type { HourForecast, Shift } from '../../src/engine/types';
import { requireScope } from '../auth';
import { HttpError, notFound, orgOf, type AppContext } from '../context';
import { actorName, guard } from '../guard';
import { forecastBody, idParam, rangeQuery, shiftBody, siteWeekQuery } from '../schemas';
import { audit, type OrgData } from '../store';

type SiteWeek = { siteId: string; weekStart: string };
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

export function rotaRoutes(app: FastifyInstance, ctx: AppContext) {
  const read = { preHandler: requireScope('rota:read') };
  const write = { preHandler: requireScope('rota:write') };

  // A personal key sees only the sites its person can see the rota for.
  app.get('/v1/sites', { ...read, schema: { tags: ['Reference'] } }, async (req) => {
    const org = orgOf(req);
    const visible = guard(ctx, req, org).at('rota.view');
    return org.state.sites.filter((s) => visible({ siteId: s.id }));
  });
  app.get('/v1/roles', { ...read, schema: { tags: ['Reference'] } }, async (req) => {
    const org = orgOf(req);
    guard(ctx, req, org).allow('rota.view');
    return org.state.roles;
  });
  app.get('/v1/demand-rules', { ...read, schema: { tags: ['Reference'] } }, async (req) => {
    const org = orgOf(req);
    return org.state.demandRules.filter(guard(ctx, req, org).at('rota.view'));
  });

  app.get<{ Querystring: Range }>('/v1/shifts', { ...read, schema: { tags: ['Shifts'], querystring: rangeQuery } }, async (req) => {
    const org = orgOf(req);
    return org.state.shifts.filter(inRange(req.query)).filter(guard(ctx, req, org).at('rota.view'));
  });

  app.post<{ Body: Shift }>('/v1/shifts', { ...write, schema: { tags: ['Shifts'], body: shiftBody } }, async (req, reply) => {
    const org = orgOf(req);
    const g = guard(ctx, req, org);
    const shift: Shift = { ...req.body, id: req.body.id ?? `s_${randomUUID()}`, published: false };
    if (org.state.shifts.some((s) => s.id === shift.id)) throw new HttpError(409, 'conflict', `Shift ${shift.id} exists`);
    validateShift(org, shift);
    g.allow('rota.edit', shift.siteId);
    org.state.shifts.push(shift);
    audit(org, actorName(g), 'shift.created', { id: shift.id });
    return reply.code(201).send({ shift, issues: shiftIssues(org, shift) });
  });

  app.patch<{ Params: { id: string }; Body: Partial<Shift> }>(
    '/v1/shifts/:id',
    { ...write, schema: { tags: ['Shifts'], params: idParam, body: { ...shiftBody, required: [] } } },
    async (req) => {
      const org = orgOf(req);
      const i = org.state.shifts.findIndex((s) => s.id === req.params.id);
      if (i < 0) throw notFound(`Shift ${req.params.id}`);
      const g = guard(ctx, req, org);
      const shift: Shift = { ...org.state.shifts[i], ...req.body, id: req.params.id, published: false };
      validateShift(org, shift);
      // Moving a shift needs the right at both ends.
      g.allow('rota.edit', org.state.shifts[i].siteId);
      g.allow('rota.edit', shift.siteId);
      org.state.shifts[i] = shift;
      audit(org, actorName(g), 'shift.updated', { id: shift.id });
      return { shift, issues: shiftIssues(org, shift) };
    },
  );

  app.delete<{ Params: { id: string } }>('/v1/shifts/:id', { ...write, schema: { tags: ['Shifts'], params: idParam } }, async (req, reply) => {
    const org = orgOf(req);
    const shift = org.state.shifts.find((s) => s.id === req.params.id);
    if (!shift) throw notFound(`Shift ${req.params.id}`);
    const g = guard(ctx, req, org);
    g.allow('rota.edit', shift.siteId);
    org.state.shifts = org.state.shifts.filter((s) => s.id !== req.params.id);
    audit(org, actorName(g), 'shift.deleted', { id: req.params.id });
    return reply.code(204).send();
  });

  app.get<{ Querystring: SiteWeek }>('/v1/rota/week', { ...read, schema: { tags: ['Rota'], querystring: siteWeekQuery } }, async (req) => {
    const org = orgOf(req);
    const { siteId, weekStart: ws } = req.query;
    requireSite(org, siteId);
    const g = guard(ctx, req, org);
    g.allow('rota.view', siteId);
    const dates = weekDates(ws);
    return {
      siteId,
      weekStart: ws,
      shifts: org.state.shifts.filter((s) => s.siteId === siteId && dates.includes(s.date)),
      // Labour cost is worked from pay rates, so it goes only to those who see them.
      metrics: g.can('costs.view', siteId) ? serialiseMetrics(weekMetrics(org.state, siteId, ws)) : null,
      issues: checkWeek(org.state, ws, siteId),
    };
  });

  app.post<{ Body: SiteWeek }>('/v1/rota/build', { ...write, schema: { tags: ['Rota'], body: siteWeekQuery } }, async (req) => {
    const org = orgOf(req);
    requireSite(org, req.body.siteId);
    const g = guard(ctx, req, org);
    g.allow('rota.edit', req.body.siteId);
    const result = autoSchedule(org.state, req.body.siteId, req.body.weekStart);
    org.state.shifts = result.shifts;
    audit(org, actorName(g), 'rota.built', { ...req.body, added: result.added.length, unfilled: result.unfilled.length });
    return { added: result.added, unfilled: result.unfilled };
  });

  // Replaces a site's week in one go: how an accepted rota assistant draft is saved.
  app.put<{ Body: SiteWeek & { shifts: Shift[] } }>(
    '/v1/rota/week',
    {
      ...write,
      schema: {
        tags: ['Rota'],
        description: "Replaces every shift in the site's week with the shifts given, after validating each.",
        body: {
          type: 'object',
          required: ['siteId', 'weekStart', 'shifts'],
          properties: { ...siteWeekQuery.properties, shifts: { type: 'array', maxItems: 2000, items: shiftBody } },
        },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const { siteId, weekStart: ws } = req.body;
      requireSite(org, siteId);
      const g = guard(ctx, req, org);
      g.allow('rota.edit', siteId);
      const dates = weekDates(ws);
      const incoming: Shift[] = req.body.shifts.map((s) => ({ ...s, id: s.id ?? `s_${randomUUID()}`, published: false }));
      for (const s of incoming) {
        if (s.siteId !== siteId || !dates.includes(s.date)) {
          throw new HttpError(422, 'outside_week', `Shift ${s.id} is not in this site's week`);
        }
        validateShift(org, s);
      }
      const keep = org.state.shifts.filter((s) => !(s.siteId === siteId && dates.includes(s.date)));
      org.state.shifts = [...keep, ...incoming];
      audit(org, actorName(g), 'rota.replaced', { siteId, weekStart: ws, shifts: incoming.length });
      return { shifts: incoming, issues: checkWeek(org.state, ws, siteId) };
    },
  );

  app.post<{ Body: SiteWeek }>('/v1/rota/clear', { ...write, schema: { tags: ['Rota'], body: siteWeekQuery } }, async (req) => {
    const org = orgOf(req);
    const g = guard(ctx, req, org);
    g.allow('rota.edit', req.body.siteId);
    const dates = weekDates(req.body.weekStart);
    const keep = org.state.shifts.filter((s) => !(s.siteId === req.body.siteId && dates.includes(s.date)));
    const removed = org.state.shifts.length - keep.length;
    org.state.shifts = keep;
    audit(org, actorName(g), 'rota.cleared', { ...req.body, removed });
    return { removed };
  });

  app.post<{ Body: SiteWeek }>('/v1/rota/publish', { ...write, schema: { tags: ['Rota'], body: siteWeekQuery } }, async (req) => {
    const org = orgOf(req);
    const { siteId, weekStart: ws } = req.body;
    const g = guard(ctx, req, org);
    g.allow('rota.publish', siteId);
    const blocks = checkWeek(org.state, ws, siteId).filter((i) => i.severity === 'block');
    if (blocks.length) throw new HttpError(409, 'compliance_block', 'Resolve blocking issues before publishing', blocks);
    const dates = weekDates(ws);
    let published = 0;
    for (const s of org.state.shifts) {
      if (s.siteId === siteId && dates.includes(s.date)) {
        s.published = true;
        published++;
      }
    }
    audit(org, actorName(g), 'rota.published', { siteId, weekStart: ws, published });
    return { published };
  });

  app.get<{ Querystring: Range }>('/v1/forecast', { ...read, schema: { tags: ['Forecast'], querystring: rangeQuery } }, async (req) => {
    const org = orgOf(req);
    return org.state.forecast.filter(inRange(req.query)).filter(guard(ctx, req, org).at('rota.view'));
  });

  // Preshift Reports (or any forecasting source) pushes hourly sales and covers here.
  app.put<{ Body: { rows: HourForecast[] } }>('/v1/forecast', { ...write, schema: { tags: ['Forecast'], body: forecastBody } }, async (req) => {
    const org = orgOf(req);
    const g = guard(ctx, req, org);
    for (const siteId of new Set(req.body.rows.map((r) => r.siteId))) g.allow('demand.manage', siteId);
    const key = (f: HourForecast) => `${f.siteId}|${f.date}|${f.hour}`;
    const incoming = new Map(req.body.rows.map((r) => [key(r), r]));
    org.state.forecast = [...org.state.forecast.filter((f) => !incoming.has(key(f))), ...incoming.values()];
    audit(org, actorName(g), 'forecast.upserted', { rows: incoming.size });
    return { upserted: incoming.size };
  });
}
