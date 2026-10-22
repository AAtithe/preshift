import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { autoScheduleSites } from '../../src/engine/autoschedule';
import { checkEmployeeWeek, checkWeek, issueSiteId, OVERRIDABLE } from '../../src/engine/compliance';
import { forecastFromTakings, type DayForecast } from '../../src/engine/forecasting';
import { weekMetrics, type WeekMetrics } from '../../src/engine/metrics';
import { missingForecast } from '../../src/engine/setup';
import { hasStarted, weekFingerprint } from '../../src/engine/rotaWeek';
import { addDays, londonParts, weekDates, weekStart } from '../../src/engine/time';
import type { DaySales, HourForecast, RestOverride, Shift } from '../../src/engine/types';
import { hasScope, requireScope } from '../auth';
import { HttpError, notFound, orgOf, type AppContext } from '../context';
import { actorName, guard } from '../guard';
import { forecastBody, idParam, rangeQuery, salesBody, shiftBody, siteDateQuery, sitesWeekBody, siteWeekQuery } from '../schemas';
import { audit, type OrgData } from '../store';
import { travelIssues } from '../../src/engine/travel';

type SiteWeek = { siteId: string; weekStart: string };
type SitesWeek = { siteId?: string; siteIds?: string[]; weekStart: string };
type Range = { siteId?: string; from?: string; to?: string };

/**
 * Without employees:read the week carries labour totals only. Cost by person, or by shift (which
 * names its person), would give away individual pay.
 */
export function serialiseMetrics(m: WeekMetrics, byPerson = true) {
  const { cost, ...rest } = m;
  return {
    ...rest,
    cost: {
      total: cost.total,
      unallocated: cost.unallocated,
      employees: byPerson ? Object.fromEntries(cost.employees) : {},
      shifts: byPerson ? Object.fromEntries(cost.shifts) : {},
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
  return [...checkEmployeeWeek(employee, ws, context, org.state.restOverrides, undefined, org.state.sites), ...travelIssues(employee, context, org.state.sites)];
}

type OverrideBody = { weekStart: string; key: string; reason: string };

/**
 * Checks and then applies replacement weeks for one or more sites. Nothing changes unless every
 * site passes: the week is as the draft found it (baseline), every shift is valid and in its own
 * site's week, and no shift that has started or been clocked is moved or removed.
 */
function replaceWeeks(org: OrgData, ws: string, sites: { siteId: string; shifts: Shift[]; baseline?: string }[]) {
  const dates = weekDates(ws);
  const now = londonParts(new Date());
  const clocked = new Set(org.timeEntries.map((t) => t.shiftId).filter(Boolean));
  const plans = sites.map(({ siteId, shifts, baseline }) => {
    requireSite(org, siteId);
    if (baseline !== undefined && baseline !== weekFingerprint(org.state.shifts, siteId, ws)) {
      throw new HttpError(409, 'rota_changed', 'Someone changed this week while the draft was being written. Draft again from the current rota.', { siteId });
    }
    const current = org.state.shifts.filter((s) => s.siteId === siteId && dates.includes(s.date));
    const byId = new Map(current.map((s) => [s.id, s]));
    const incoming: Shift[] = shifts.map((s) => {
      const id = s.id ?? `s_${randomUUID()}`;
      const old = byId.get(id);
      const same = old && sameShift(old, s);
      // An unchanged shift keeps its published state, so a small change does not unpublish the week.
      return { ...s, id, breakMinutes: s.breakMinutes ?? 0, published: same ? Boolean(old.published) : false };
    });
    for (const s of incoming) {
      if (s.siteId !== siteId || !dates.includes(s.date)) throw new HttpError(422, 'outside_week', `Shift ${s.id} is not in this site's week`);
      validateShift(org, s);
    }
    const kept = new Map(incoming.map((s) => [s.id, s]));
    const touched = current.filter((s) => (hasStarted(s, now) || clocked.has(s.id)) && !(kept.has(s.id) && sameShift(s, kept.get(s.id)!)));
    if (touched.length) {
      throw new HttpError(409, 'worked_shift', 'Shifts that have started or been clocked cannot be moved or removed here.', touched.map((s) => s.id));
    }
    return { siteId, incoming };
  });
  const replaced = new Set(plans.map((p) => p.siteId));
  org.state.shifts = [...org.state.shifts.filter((s) => !(replaced.has(s.siteId) && dates.includes(s.date))), ...plans.flatMap((p) => p.incoming)];
  return plans;
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
      const old = org.state.shifts[i];
      const g = guard(ctx, req, org);
      g.allow('rota.edit', old.siteId);
      if (isWorked(org, old)) {
        const moved = (['employeeId', 'roleId', 'siteId', 'date', 'startMinute'] as const).filter((k) => req.body[k] !== undefined && req.body[k] !== old[k]);
        if (moved.length) throw workedError(old, 'only its finish time and break can change.');
        if (hasFinished(old)) throw workedError(old, 'and it has finished, it can no longer be changed. Correct the hours on the timesheet.');
      }
      const shift: Shift = { ...old, ...req.body, id: req.params.id, published: false };
      validateShift(org, shift);
      // Moving a shift needs the right at both ends.
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
    if (isWorked(org, shift)) throw workedError(shift, 'it cannot be removed. Record an absence on the timesheet instead.');
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
      metrics: g.can('costs.view', siteId) ? serialiseMetrics(weekMetrics(org.state, siteId, ws), hasScope(req, 'employees:read')) : null,
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
      // A week no sales system has sent figures for is forecast from each site's typical week.
      const filled = missingForecast(org.state, siteIds, req.body.weekStart);
      if (filled.length) org.state.forecast.push(...filled);
      const result = autoScheduleSites(org.state, siteIds, req.body.weekStart);
      // The build fills the whole week; hours already gone are left as they happened.
      const now = londonParts(new Date());
      const late = new Set(result.added.filter((s) => hasStarted(s, now)).map((s) => s.id));
      result.added = result.added.filter((s) => !late.has(s.id));
      result.unfilled = result.unfilled.filter((gap) => !hasStarted({ date: gap.date, startMinute: gap.toHour * 60 - 1 }, now));
      org.state.shifts = result.shifts.filter((s) => !late.has(s.id));
      audit(org, actorName(g), 'rota.built', { siteIds, weekStart: req.body.weekStart, added: result.added.length, unfilled: result.unfilled.length });
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
      const { siteId, weekStart: ws, shifts, baseline } = req.body;
      requireSite(org, siteId);
      const g = guard(ctx, req, org);
      g.allow('rota.edit', siteId);
      const [plan] = replaceWeeks(org, ws, [{ siteId, shifts, baseline }]);
      audit(org, actorName(g), req.body.source === 'assistant' ? 'rota.assistant_applied' : 'rota.replaced', {
        siteId,
        weekStart: ws,
        shifts: plan.incoming.length,
        ...(req.body.instruction ? { instruction: req.body.instruction } : {}),
      });
      return { shifts: plan.incoming, issues: checkWeek(org.state, ws, siteId) };
    },
  );

  // Several sites' weeks in one all-or-nothing save: how a group-wide assistant draft is applied.
  // Every site is checked before any is changed, so a refusal at one site leaves them all as they were.
  app.put<{ Body: { weekStart: string; sites: { siteId: string; shifts: Shift[]; baseline?: string }[]; source?: 'assistant'; instruction?: string } }>(
    '/v1/rota/weeks',
    {
      ...write,
      schema: {
        tags: ['Rota'],
        description:
          'Replaces the week at several sites at once, on the same terms as PUT /v1/rota/week for each. Nothing is ' +
          'saved unless every site passes.',
        body: {
          type: 'object',
          required: ['weekStart', 'sites'],
          properties: {
            weekStart: siteWeekQuery.properties.weekStart,
            sites: {
              type: 'array',
              minItems: 1,
              maxItems: 50,
              items: {
                type: 'object',
                required: ['siteId', 'shifts'],
                additionalProperties: false,
                properties: {
                  siteId: { type: 'string' },
                  shifts: { type: 'array', maxItems: 2000, items: shiftBody },
                  baseline: { type: 'string', maxLength: 64 },
                },
              },
            },
            source: { type: 'string', enum: ['assistant'] },
            instruction: { type: 'string', maxLength: 2000 },
          },
        },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const ws = req.body.weekStart;
      const siteIds = req.body.sites.map((x) => x.siteId);
      if (new Set(siteIds).size !== siteIds.length) throw new HttpError(422, 'duplicate_site', 'Each site can appear once.');
      // Every site must be one the person may edit, checked before anything changes.
      const g = guard(ctx, req, org);
      for (const id of siteIds) {
        requireSite(org, id);
        g.allow('rota.edit', id);
      }
      const plans = replaceWeeks(org, ws, req.body.sites);
      audit(org, actorName(g), req.body.source === 'assistant' ? 'rota.assistant_applied' : 'rota.replaced', {
        siteIds,
        weekStart: ws,
        shifts: plans.reduce((sum, p) => sum + p.incoming.length, 0),
        ...(req.body.instruction ? { instruction: req.body.instruction } : {}),
      });
      return { shifts: plans.flatMap((p) => p.incoming), issues: checkWeek(org.state, ws, siteIds) };
    },
  );

  app.post<{ Body: SitesWeek }>('/v1/rota/clear', { ...write, schema: { tags: ['Rota'], body: sitesWeekBody } }, async (req) => {
    const org = orgOf(req);
    const siteIds = sitesOf(org, req.body, false);
    const g = guard(ctx, req, org);
    for (const id of siteIds) g.allow('rota.edit', id);
    const dates = weekDates(req.body.weekStart);
    const now = londonParts(new Date());
    // Worked shifts stay: clearing a week plans it afresh, it does not rewrite what happened.
    const keep = org.state.shifts.filter((s) => !(siteIds.includes(s.siteId) && dates.includes(s.date)) || isWorked(org, s, now));
    const removed = org.state.shifts.length - keep.length;
    const kept = keep.filter((s) => siteIds.includes(s.siteId) && dates.includes(s.date)).length;
    org.state.shifts = keep;
    audit(org, actorName(g), 'rota.cleared', { siteIds, weekStart: req.body.weekStart, removed, kept });
    return { removed, kept };
  });

  app.get('/v1/rota/overrides', { ...read, schema: { tags: ['Rota'], description: 'Rest breaches a manager has published through, with who and why.' } }, async (req) => {
    const org = orgOf(req);
    return (org.state.restOverrides ?? []).filter(guard(ctx, req, org).at('rota.view'));
  });

  // An override is a person's judgement, so it needs a person: never a system key, and never the
  // rota assistant, which drafts through the engine. It is part of publishing, so it needs the
  // right to publish the rota at the site where the short rest is worked.
  const requirePerson = (req: { principal: { userId?: string; email?: string } }, doing: string) => {
    if (!req.principal.userId && !req.principal.email) throw new HttpError(403, 'forbidden', `Only a person can ${doing}, not a system key`);
  };
  app.post<{ Body: OverrideBody }>(
    '/v1/rota/overrides',
    {
      ...write,
      schema: {
        tags: ['Rota'],
        description:
          "Lets a rest breach be published, with the manager's reason. Give the issue's overrideKey and the week it was reported in. It covers that breach only: moving either shift makes a new one.",
        body: {
          type: 'object',
          required: ['weekStart', 'key', 'reason'],
          additionalProperties: false,
          properties: { weekStart: siteWeekQuery.properties.weekStart, key: { type: 'string', maxLength: 500 }, reason: { type: 'string', maxLength: 500 } },
        },
      },
    },
    async (req, reply) => {
      requirePerson(req, 'override a rest breach');
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      const reason = req.body.reason.trim();
      if (reason.length < 15) throw new HttpError(422, 'reason_required', 'Say why, and what compensatory rest they will get (at least 15 characters)');
      const issue = checkWeek(org.state, req.body.weekStart).find((i) => i.overrideKey === req.body.key);
      if (!issue || !OVERRIDABLE.has(issue.code)) throw notFound('Rest breach');
      if (issue.overridden) throw new HttpError(409, 'conflict', 'That breach is already overridden');
      const siteId = issueSiteId(org.state, issue)!;
      g.allow('rota.publish', siteId);
      const override: RestOverride = {
        id: `ro_${randomUUID()}`,
        employeeId: issue.employeeId,
        siteId,
        code: issue.code as RestOverride['code'],
        key: req.body.key,
        reason,
        by: actorName(g),
        at: new Date().toISOString(),
      };
      org.state.restOverrides = [...(org.state.restOverrides ?? []), override];
      audit(org, actorName(g), 'rest.overridden', { id: override.id, employeeId: override.employeeId, code: override.code, date: issue.date, reason });
      return reply.code(201).send(override);
    },
  );

  app.delete<{ Params: { id: string } }>('/v1/rota/overrides/:id', { ...write, schema: { tags: ['Rota'], params: idParam } }, async (req, reply) => {
    requirePerson(req, 'withdraw an override');
    const org = orgOf(req);
    const before = org.state.restOverrides ?? [];
    const override = before.find((o) => o.id === req.params.id);
    if (!override) throw notFound(`Override ${req.params.id}`);
    const g = guard(ctx, req, org);
    g.allow('rota.publish', override.siteId);
    org.state.restOverrides = before.filter((o) => o.id !== req.params.id);
    audit(org, actorName(g), 'rest.override_withdrawn', { id: req.params.id });
    return reply.code(204).send();
  });

  app.post<{ Body: SitesWeek }>('/v1/rota/publish', { ...write, schema: { tags: ['Rota'], body: sitesWeekBody } }, async (req) => {
    const org = orgOf(req);
    const siteIds = sitesOf(org, req.body, false);
    const g = guard(ctx, req, org);
    for (const id of siteIds) g.allow('rota.publish', id);
    const ws = req.body.weekStart;
    // All or nothing: a group publish is refused if any site in it has a blocking issue.
    const issues = checkWeek(org.state, ws, siteIds);
    const blocks = issues.filter((i) => i.severity === 'block');
    if (blocks.length) throw new HttpError(409, 'compliance_block', 'Resolve blocking issues before publishing', blocks);
    const overridden = issues.flatMap((i) => (i.overridden ? [i.overridden.id] : []));
    const dates = weekDates(ws);
    let published = 0;
    for (const s of org.state.shifts) {
      if (siteIds.includes(s.siteId) && dates.includes(s.date)) {
        s.published = true;
        published++;
      }
    }
    audit(org, actorName(g), 'rota.published', { siteIds, weekStart: ws, published, overridden });
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
    // Pushed figures are the real forecast: never marked as profile rows, which set-up may replace.
    const incoming = new Map(req.body.rows.map(({ source: _source, ...r }) => [key(r), r as HourForecast]));
    org.state.forecast = [...org.state.forecast.filter((f) => !incoming.has(key(f))), ...incoming.values()];
    audit(org, actorName(g), 'forecast.upserted', { rows: incoming.size });
    return { upserted: incoming.size };
  });

  // For a site with no forecasting feed: the week worked from its own takings, day by day.
  app.post<{ Body: SitesWeek & { replace?: boolean } }>(
    '/v1/forecast/from-takings',
    {
      ...write,
      schema: {
        tags: ['Forecast'],
        description:
          "Forecasts the week from each site's past takings: the same day last year scaled by the recent trend, else the recent same weekdays. Days already forecast are left alone unless replace is true.",
        body: { ...sitesWeekBody, properties: { ...sitesWeekBody.properties, replace: { type: 'boolean' } } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const siteIds = sitesOf(org, req.body, true);
      const g = guard(ctx, req, org);
      for (const id of siteIds) g.allow('demand.manage', id);
      const dates = weekDates(req.body.weekStart);
      // A day on the typical week alone is set-up's placeholder: its own takings say more, so it is filled like an empty one.
      const forecast = (siteId: string, date: string) => org.state.forecast.some((f) => f.siteId === siteId && f.date === date && f.sales > 0 && f.source !== 'profile');
      const days: (DayForecast & { filled: boolean })[] = [];
      const rows: HourForecast[] = [];
      for (const siteId of siteIds) {
        const worked = forecastFromTakings(org.state, siteId, dates);
        for (const d of worked.days) {
          // A day with nothing to work from keeps whatever it had.
          const filled = d.basis !== 'none' && (req.body.replace === true || !forecast(siteId, d.date));
          days.push({ ...d, filled });
          if (filled) rows.push(...worked.rows.filter((r) => r.date === d.date));
        }
      }
      const replaced = new Set(days.filter((d) => d.filled).map((d) => `${d.siteId}|${d.date}`));
      org.state.forecast = [...org.state.forecast.filter((f) => !replaced.has(`${f.siteId}|${f.date}`)), ...rows];
      audit(org, actorName(g), 'forecast.from_takings', { siteIds, weekStart: req.body.weekStart, days: replaced.size, replace: req.body.replace === true });
      return { filled: replaced.size, days };
    },
  );

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
