import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { autoScheduleSites } from '../../src/engine/autoschedule';
import { checkEmployeeWeek, checkWeek } from '../../src/engine/compliance';
import { weekMetrics, type WeekMetrics } from '../../src/engine/metrics';
import { addDays, weekDates, weekStart } from '../../src/engine/time';
import type { DaySales, HourForecast, Shift } from '../../src/engine/types';
import { requireScope } from '../auth';
import { HttpError, notFound, orgOf, type AppContext } from '../context';
import { forecastBody, idParam, rangeQuery, salesBody, shiftBody, siteDateQuery, sitesWeekBody, siteWeekQuery } from '../schemas';
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
      const shift: Shift = { ...org.state.shifts[i], ...req.body, id: req.params.id, published: false };
      validateShift(org, shift);
      org.state.shifts[i] = shift;
      audit(org, req.principal.name, 'shift.updated', { id: shift.id });
      return { shift, issues: shiftIssues(org, shift) };
    },
  );

  app.delete<{ Params: { id: string } }>('/v1/shifts/:id', { ...write, schema: { tags: ['Shifts'], params: idParam } }, async (req, reply) => {
    const org = orgOf(req);
    const before = org.state.shifts.length;
    org.state.shifts = org.state.shifts.filter((s) => s.id !== req.params.id);
    if (org.state.shifts.length === before) throw notFound(`Shift ${req.params.id}`);
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
      org.state.shifts = result.shifts;
      audit(org, req.principal.name, 'rota.built', { siteIds, weekStart: req.body.weekStart, added: result.added.length, unfilled: result.unfilled.length });
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
      audit(org, req.principal.name, 'rota.replaced', { siteId, weekStart: ws, shifts: incoming.length });
      return { shifts: incoming, issues: checkWeek(org.state, ws, siteId) };
    },
  );

  app.post<{ Body: SitesWeek }>('/v1/rota/clear', { ...write, schema: { tags: ['Rota'], body: sitesWeekBody } }, async (req) => {
    const org = orgOf(req);
    const siteIds = sitesOf(org, req.body, false);
    const dates = weekDates(req.body.weekStart);
    const keep = org.state.shifts.filter((s) => !(siteIds.includes(s.siteId) && dates.includes(s.date)));
    const removed = org.state.shifts.length - keep.length;
    org.state.shifts = keep;
    audit(org, req.principal.name, 'rota.cleared', { siteIds, weekStart: req.body.weekStart, removed });
    return { removed };
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

  app.get<{ Querystring: Range }>('/v1/sales', { ...read, schema: { tags: ['Sales'], querystring: rangeQuery, description: 'Actual takings by site and day, net of VAT.' } }, async (req) =>
    (orgOf(req).state.sales ?? []).filter(inRange(req.query)),
  );

  // A till or EPOS integration pushes each day's takings here; the web app keys them in or imports a file.
  app.put<{ Body: { rows: (Omit<DaySales, 'source'> & { source?: DaySales['source'] })[] } }>(
    '/v1/sales',
    { ...write, schema: { tags: ['Sales'], body: salesBody, description: 'Adds or replaces takings for each site and day given. Net of VAT.' } },
    async (req) => {
      const org = orgOf(req);
      for (const r of req.body.rows) requireSite(org, r.siteId);
      const key = (r: { siteId: string; date: string }) => `${r.siteId}|${r.date}`;
      const incoming = new Map(req.body.rows.map((r): [string, DaySales] => [key(r), { ...r, netSales: Math.round(r.netSales * 100) / 100, source: r.source ?? 'till' }]));
      org.state.sales = [...(org.state.sales ?? []).filter((s) => !incoming.has(key(s))), ...incoming.values()];
      audit(org, req.principal.name, 'sales.upserted', { rows: incoming.size });
      return { upserted: incoming.size };
    },
  );

  app.delete<{ Querystring: { siteId: string; date: string } }>(
    '/v1/sales',
    { ...write, schema: { tags: ['Sales'], querystring: siteDateQuery, description: "Removes one day's takings, so reports fall back to the forecast for it." } },
    async (req, reply) => {
      const org = orgOf(req);
      const { siteId, date } = req.query;
      const before = (org.state.sales ?? []).length;
      org.state.sales = (org.state.sales ?? []).filter((s) => !(s.siteId === siteId && s.date === date));
      if (org.state.sales.length === before) throw notFound(`Takings for ${siteId} on ${date}`);
      audit(org, req.principal.name, 'sales.deleted', { siteId, date });
      return reply.code(204).send();
    },
  );
}
