import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { autoScheduleSites } from '../../src/engine/autoschedule';
import { checkEmployeeWeek, checkWeek } from '../../src/engine/compliance';
import { weekMetrics, type WeekMetrics } from '../../src/engine/metrics';
import { addDays, weekDates, weekStart } from '../../src/engine/time';
import type { DaySales, HourForecast, Shift } from '../../src/engine/types';
import { requireScope } from '../auth';
import { HttpError, notFound, orgOf, type AppContext } from '../context';
import { actorName, guard } from '../guard';
import { forecastBody, idParam, rangeQuery, salesBody, shiftBody, siteDateQuery, sitesWeekBody, siteWeekQuery } from '../schemas';
import { audit, type OrgData } from '../store';
import { travelIssues } from '../../src/engine/travel';

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
  return [...checkEmployeeWeek(employee, ws, context), ...travelIssues(employee, context, org.state.sites)];
}

export function rotaRoutes(app: FastifyInstance, ctx: AppContext) {
  const read = { preHandler: requireScope('rota:read') };
  const write = { preHandler: requireScope('rota:write') };

  app.get('/v1/entities', { ...read, schema: { tags: ['Reference'], description: 'Companies in the group: each is its own PAYE scheme and ledger.' } }, async (req) => {
    const org = orgOf(req);
    guard(ctx, req, org).allow('rota.view');
    return org.state.entities;
  });
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
      const g = guard(ctx, req, org);
      // A group build needs the right at every site in it: all or nothing.
      for (const id of siteIds) g.allow('rota.edit', id);
      const result = autoScheduleSites(org.state, siteIds, req.body.weekStart);
      org.state.shifts = result.shifts;
      audit(org, actorName(g), 'rota.built', { siteIds, weekStart: req.body.weekStart, added: result.added.length, unfilled: result.unfilled.length });
      return { added: result.added, unfilled: result.unfilled };
    },
  );

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

  app.post<{ Body: SitesWeek }>('/v1/rota/clear', { ...write, schema: { tags: ['Rota'], body: sitesWeekBody } }, async (req) => {
    const org = orgOf(req);
    const siteIds = sitesOf(org, req.body, false);
    const g = guard(ctx, req, org);
    for (const id of siteIds) g.allow('rota.edit', id);
    const dates = weekDates(req.body.weekStart);
    const keep = org.state.shifts.filter((s) => !(siteIds.includes(s.siteId) && dates.includes(s.date)));
    const removed = org.state.shifts.length - keep.length;
    org.state.shifts = keep;
    audit(org, actorName(g), 'rota.cleared', { siteIds, weekStart: req.body.weekStart, removed });
    return { removed };
  });

  app.post<{ Body: SitesWeek }>('/v1/rota/publish', { ...write, schema: { tags: ['Rota'], body: sitesWeekBody } }, async (req) => {
    const org = orgOf(req);
    const siteIds = sitesOf(org, req.body, false);
    const g = guard(ctx, req, org);
    for (const id of siteIds) g.allow('rota.publish', id);
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
    audit(org, actorName(g), 'rota.published', { siteIds, weekStart: ws, published });
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

  app.get<{ Querystring: Range }>('/v1/sales', { ...read, schema: { tags: ['Sales'], querystring: rangeQuery, description: 'Actual takings by site and day, net of VAT.' } }, async (req) =>
    // Takings by site go with the rota: whoever sees a site's rota sees its takings, as they see its forecast.
    (orgOf(req).state.sales ?? []).filter(inRange(req.query)).filter(guard(ctx, req, orgOf(req)).at('rota.view')),
  );

  // A till or EPOS integration pushes each day's takings here; the web app keys them in or imports a file.
  app.put<{ Body: { rows: (Omit<DaySales, 'source'> & { source?: DaySales['source'] })[] } }>(
    '/v1/sales',
    { ...write, schema: { tags: ['Sales'], body: salesBody, description: 'Adds or replaces takings for each site and day given. Net of VAT.' } },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      // Keying or importing takings is the forecast's right, site by site, all or nothing.
      for (const r of req.body.rows) {
        requireSite(org, r.siteId);
        g.allow('demand.manage', r.siteId);
      }
      const key = (r: { siteId: string; date: string }) => `${r.siteId}|${r.date}`;
      const incoming = new Map(req.body.rows.map((r): [string, DaySales] => [key(r), { ...r, netSales: Math.round(r.netSales * 100) / 100, source: r.source ?? 'till' }]));
      org.state.sales = [...(org.state.sales ?? []).filter((s) => !incoming.has(key(s))), ...incoming.values()];
      audit(org, actorName(g), 'sales.upserted', { rows: incoming.size });
      return { upserted: incoming.size };
    },
  );

  app.delete<{ Querystring: { siteId: string; date: string } }>(
    '/v1/sales',
    { ...write, schema: { tags: ['Sales'], querystring: siteDateQuery, description: "Removes one day's takings, so reports fall back to the forecast for it." } },
    async (req, reply) => {
      const org = orgOf(req);
      const { siteId, date } = req.query;
      const g = guard(ctx, req, org);
      g.allow('demand.manage', siteId);
      const before = (org.state.sales ?? []).length;
      org.state.sales = (org.state.sales ?? []).filter((s) => !(s.siteId === siteId && s.date === date));
      if (org.state.sales.length === before) throw notFound(`Takings for ${siteId} on ${date}`);
      audit(org, actorName(g), 'sales.deleted', { siteId, date });
      return reply.code(204).send();
    },
  );
}
