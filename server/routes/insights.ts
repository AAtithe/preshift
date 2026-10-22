import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { cohortBenchmark, quartileOf, type BenchmarkMetric, type SiteSample } from '../../src/engine/benchmark';
import { moveIssues, realisedSaving, recordOf, weeklyMoves, type MoveRecord } from '../../src/engine/coach';
import { forecastAccuracy, overrideForecast } from '../../src/engine/forecast';
import { accuracyReport } from '../../src/engine/forecastreport';
import { weekMetrics } from '../../src/engine/metrics';
import { baselineFromHistory, MILESTONES, newProgramme, programmeStatus, wholeWeeks, type Programme } from '../../src/engine/programme';
import { finishedWeeks, siteScorecard, type Scorecard } from '../../src/engine/scorecard';
import { weekDates, weekStart } from '../../src/engine/time';
import type { AdjustmentReason, ForecastAdjustment, HourActual, Shift } from '../../src/engine/types';
import { requireScope } from '../auth';
import { HttpError, londonToday, notFound, orgOf, type AppContext } from '../context';
import { forecastBody, isoDate, rangeQuery, siteWeekQuery } from '../schemas';
import { modelDates } from '../forecasting';
import { canOrgWide } from '../../src/engine/access';
import { actorOf, guard } from '../guard';
import { isSandbox } from '../sandbox';
import { assertRotaOpen } from '../payPeriods';
import { audit, type OrgData } from '../store';

type SiteWeek = { siteId: string; weekStart: string };
type Range = { siteId?: string; from?: string; to?: string };

const siteParam = { type: 'object', required: ['siteId'], properties: { siteId: { type: 'string' } } } as const;
const siteQuery = { type: 'object', required: ['siteId'], properties: { siteId: { type: 'string' }, weeks: { type: 'integer', minimum: 1, maximum: 26 } } } as const;
const money = { type: 'number', minimum: 0 } as const;

/** A verification that proves a saving: real sales, after the baseline, inside the programme. */
const counts = (p: Programme) => p.verifications.some((v) => v.sales > 0 && v.from >= p.startWeek && (!p.baseline || v.from > p.baseline.to));

function requireSite(org: OrgData, siteId: string) {
  if (!org.state.sites.some((s) => s.id === siteId)) throw notFound(`Site ${siteId}`);
}

function scorecardFor(org: OrgData, siteId: string, today: string, weeks = 8): Scorecard {
  return siteScorecard({
    today,
    state: org.state,
    siteId,
    weeks: finishedWeeks(weekStart(today), weeks),
    publications: org.publications,
    timeEntries: org.timeEntries,
    moves: org.moves,
  });
}

/** Records the moves now offered for a site's week. Moves already taken or turned down stay as they were. */
function offer(org: OrgData, siteId: string, ws: string, today: string, at: string) {
  const result = weeklyMoves(org.state, siteId, ws, { today });
  const decided = org.moves.filter((m) => m.siteId === siteId && m.weekStart === ws && m.status !== 'offered');
  const decidedIds = new Set(decided.map((m) => m.id));
  const fresh = result.moves.filter((m) => !decidedIds.has(m.id));
  org.moves = [...org.moves.filter((m) => !(m.siteId === siteId && m.weekStart === ws && m.status === 'offered')), ...fresh.map((m) => recordOf(m, at))];
  return { ...result, moves: fresh };
}

const sameShift = (a: Shift, b: Shift) =>
  a.employeeId === b.employeeId && a.roleId === b.roleId && a.siteId === b.siteId && a.date === b.date &&
  a.startMinute === b.startMinute && a.endMinute === b.endMinute && a.breakMinutes === b.breakMinutes;

/** A site's last four finished weeks, as one benchmark sample. Nothing in it names the site. */
function sampleOf(org: OrgData, siteId: string, today: string): SiteSample {
  const card = scorecardFor(org, siteId, today, 4);
  const weeks = card.weeks.filter((w) => w.plannedLabourPct > 0 || w.actualLabourPct !== null);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const splh = avg(finishedWeeks(weekStart(today), 4).map((ws) => weekMetrics(org.state, siteId, ws).splh).filter((x) => x > 0));
  return {
    orgId: org.orgId,
    labourPct: avg(weeks.map((w) => w.actualLabourPct ?? w.plannedLabourPct)),
    splh,
    overstaffedShare: avg(weeks.map((w) => w.overstaffedShare)),
    forecastWape: avg(card.weeks.map((w) => w.forecastWape).filter((x): x is number => x !== null)),
  };
}

export function insightRoutes(app: FastifyInstance, ctx: AppContext) {
  const read = { preHandler: requireScope('rota:read') };
  const write = { preHandler: requireScope('rota:write') };
  /**
   * Sign-offs, baselines, verifications and the gain share set the fee the operator pays, so they are
   * the WS lead's alone: a person holding the WS client partner role here (with their authenticator),
   * or a deployment key WS holds with the programme:lead scope. The operator's owner does not hold it,
   * a sign-in with no access record is not enough, and a full-access key is not either.
   */
  const requireLead = async (req: FastifyRequest) => {
    const actor = actorOf(req, orgOf(req), ctx.store.todayISO());
    const ok = actor.kind === 'user' ? canOrgWide(actor.user, 'programme.lead', ctx.store.todayISO()) : actor.ws === true;
    if (!ok) throw new HttpError(403, 'forbidden', 'Only the Williams, Stanley & Co. client partner can sign off the programme');
  };
  const lead = { preHandler: [requireScope('rota:write'), requireLead] };
  const today = () => londonToday(ctx);

  // ----- Till actuals and the forecast model -----

  app.get<{ Querystring: Range }>('/v1/actuals', { ...read, schema: { tags: ['Forecast'], description: 'Hourly till sales and covers, as traded.', querystring: rangeQuery } }, async (req) => {
    const q = req.query;
    const visible = guard(ctx, req, orgOf(req)).at('rota.view');
    return (orgOf(req).state.actuals ?? []).filter((a) => visible(a) && (!q.siteId || a.siteId === q.siteId) && (!q.from || a.date >= q.from) && (!q.to || a.date <= q.to));
  });

  app.put<{ Body: { rows: HourActual[] } }>(
    '/v1/actuals',
    { ...write, schema: { tags: ['Forecast'], description: 'Preshift Reports, or the till, pushes what each hour actually took. Upserts by site, date and hour.', body: forecastBody } },
    async (req) => {
      const org = orgOf(req);
      // What a site took is demand data, as takings are.
      const g = guard(ctx, req, org);
      for (const siteId of new Set(req.body.rows.map((r) => r.siteId))) g.allow('demand.manage', siteId);
      const key = (r: HourActual) => `${r.siteId}|${r.date}|${r.hour}`;
      const incoming = new Map(req.body.rows.map((r) => [key(r), { siteId: r.siteId, date: r.date, hour: r.hour, sales: r.sales, covers: r.covers }]));
      org.state.actuals = [...(org.state.actuals ?? []).filter((a) => !incoming.has(key(a))), ...incoming.values()];
      audit(org, req.principal.name, 'actuals.upserted', { rows: incoming.size });
      return { upserted: incoming.size };
    },
  );

  app.get<{ Querystring: { siteId?: string } }>('/v1/forecast/adjustments', { ...read, schema: { tags: ['Forecast'] } }, async (req) =>
    (orgOf(req).state.forecastAdjustments ?? []).filter(guard(ctx, req, orgOf(req)).at('rota.view')).filter((a) => !req.query.siteId || a.siteId === req.query.siteId),
  );

  app.post<{ Body: Omit<ForecastAdjustment, 'id'> }>(
    '/v1/forecast/adjustments',
    {
      ...write,
      schema: {
        tags: ['Forecast'],
        description: 'A known one-off that moves trade: weather, an event, a closure. Applied by the model as a multiplier.',
        body: {
          type: 'object',
          required: ['siteId', 'date', 'factor', 'reason'],
          additionalProperties: false,
          properties: {
            siteId: { type: 'string' },
            date: isoDate,
            factor: { type: 'number', minimum: 0, maximum: 5 },
            reason: { type: 'string', enum: ['weather', 'event', 'bank_holiday', 'closure', 'other'] satisfies AdjustmentReason[] },
            note: { type: 'string', maxLength: 200 },
            fromHour: { type: 'integer', minimum: 0, maximum: 23 },
            toHour: { type: 'integer', minimum: 1, maximum: 24 },
          },
        },
      },
    },
    async (req, reply) => {
      const org = orgOf(req);
      requireSite(org, req.body.siteId);
      guard(ctx, req, org).allow('demand.manage', req.body.siteId);
      // A zero factor closes the floor as well as the forecast, so only a closure may say zero.
      if (req.body.factor === 0 && req.body.reason !== 'closure') {
        throw new HttpError(422, 'invalid_factor', 'Only a closure can take trade to zero. Choose Closure, or give a percentage of normal trade.');
      }
      const adjustment: ForecastAdjustment = { ...req.body, id: `adj_${randomUUID().slice(0, 12)}` };
      org.state.forecastAdjustments = [...(org.state.forecastAdjustments ?? []), adjustment];
      audit(org, req.principal.name, 'forecast.adjustment.added', { id: adjustment.id, siteId: adjustment.siteId, date: adjustment.date });
      return reply.code(201).send(adjustment);
    },
  );

  app.delete<{ Params: { id: string } }>('/v1/forecast/adjustments/:id', { ...write, schema: { tags: ['Forecast'] } }, async (req, reply) => {
    const org = orgOf(req);
    const before = org.state.forecastAdjustments ?? [];
    const found = before.find((a) => a.id === req.params.id);
    if (!found) throw notFound(`Adjustment ${req.params.id}`);
    guard(ctx, req, org).allow('demand.manage', found.siteId);
    org.state.forecastAdjustments = before.filter((a) => a.id !== req.params.id);
    audit(org, req.principal.name, 'forecast.adjustment.removed', { id: req.params.id });
    return reply.code(204).send();
  });

  app.post<{ Body: SiteWeek }>(
    '/v1/forecast/model',
    {
      ...write,
      schema: {
        tags: ['Forecast'],
        description: "Runs the baseline model for a site's week from its till history. Hours someone has overridden keep their figure.",
        body: siteWeekQuery,
      },
    },
    async (req) => {
      const org = orgOf(req);
      const { siteId, weekStart: ws } = req.body;
      requireSite(org, siteId);
      guard(ctx, req, org).allow('demand.manage', siteId);
      const result = modelDates(org, siteId, weekDates(ws), today());
      audit(org, req.principal.name, 'forecast.modelled', { siteId, weekStart: ws, rows: result.rows.length, skipped: result.skipped.length, automatic: result.automatic.length });
      return {
        rows: result.rows.length,
        skipped: result.skipped,
        trend: result.trend,
        bankHolidayFactor: result.bankHolidayFactor,
        // What the model applied by itself, with why, so the GM can see and overrule it.
        automatic: [
          ...result.automatic.map(({ date, factor, kind, note, fromHour, toHour, evidence }) => ({ date, factor, kind, note, fromHour, toHour, evidence })),
          ...result.bookings.map(({ date, factor, note, fromHour, toHour, evidence }) => ({ date, factor, kind: 'bookings', note, fromHour, toHour, evidence })),
        ],
      };
    },
  );

  app.patch<{ Body: { siteId: string; date: string; hour: number; sales: number; covers: number; reason?: string } }>(
    '/v1/forecast/hour',
    {
      ...write,
      schema: {
        tags: ['Forecast'],
        description: 'Overrides one hour of the forecast. The model figure is kept underneath so the override can be scored once the hour has traded.',
        body: {
          type: 'object',
          required: ['siteId', 'date', 'hour', 'sales', 'covers'],
          additionalProperties: false,
          properties: { siteId: { type: 'string' }, date: isoDate, hour: { type: 'integer', minimum: 0, maximum: 23 }, sales: money, covers: money, reason: { type: 'string', maxLength: 200 } },
        },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const { siteId, date, hour, sales, covers, reason } = req.body;
      requireSite(org, siteId);
      guard(ctx, req, org).allow('demand.manage', siteId);
      const i = org.state.forecast.findIndex((f) => f.siteId === siteId && f.date === date && f.hour === hour);
      const row = i >= 0 ? org.state.forecast[i] : { siteId, date, hour, sales: 0, covers: 0, modelSales: 0, modelCovers: 0 };
      const next = overrideForecast(row, sales, covers, req.principal.name, reason);
      if (i >= 0) org.state.forecast[i] = next;
      else org.state.forecast.push(next);
      audit(org, req.principal.name, 'forecast.overridden', { siteId, date, hour, sales, modelSales: next.modelSales });
      return next;
    },
  );

  app.get<{ Querystring: { siteId: string; from: string; to: string } }>(
    '/v1/forecast/accuracy',
    {
      ...read,
      schema: {
        tags: ['Forecast'],
        description: 'Forecast against till actuals: hourly error, bias, by day and daypart, and how each person’s overrides did against the model.',
        querystring: { type: 'object', required: ['siteId', 'from', 'to'], properties: { siteId: { type: 'string' }, from: isoDate, to: isoDate } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      requireSite(org, req.query.siteId);
      guard(ctx, req, org).allow('rota.view', req.query.siteId);
      return forecastAccuracy(org.state.forecast, org.state.actuals ?? [], req.query.siteId, req.query.from, req.query.to);
    },
  );

  app.get<{ Querystring: { siteIds: string; week: string; weeks?: number } }>(
    '/v1/forecast/accuracy/report',
    {
      ...read,
      schema: {
        tags: ['Forecast'],
        description:
          "Forecast against takings for several sites over several weeks ending with `week`: day and hourly error, bias, sales over and under forecast and the labour they imply at each site's target, and days of the week wrong the same way. Sites the caller cannot see are left out.",
        querystring: {
          type: 'object',
          required: ['siteIds', 'week'],
          properties: { siteIds: { type: 'string', minLength: 1 }, week: isoDate, weeks: { type: 'integer', minimum: 1, maximum: 26 } },
        },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const ids = [...new Set(req.query.siteIds.split(',').map((s) => s.trim()).filter(Boolean))];
      for (const id of ids) requireSite(org, id);
      // The same right as the forecast and takings it reads: rota.view, site by site.
      const g = guard(ctx, req, org);
      const seen = ids.filter((id) => g.can('rota.view', id));
      if (seen.length === 0) throw new HttpError(403, 'forbidden', 'None of these sites is yours to see');
      return accuracyReport(org.state, org.state.actuals ?? [], seen, weekStart(req.query.week), req.query.weeks ?? 8, today());
    },
  );

  // ----- The weekly moves -----

  app.post<{ Body: SiteWeek }>(
    '/v1/coach/moves',
    {
      ...write,
      schema: {
        tags: ['Coach'],
        description: "Works out this week's moves for a site, priced at their marginal cost, and records them as offered.",
        body: siteWeekQuery,
      },
    },
    async (req) => {
      const org = orgOf(req);
      requireSite(org, req.body.siteId);
      // Moves are priced, and taking one changes the rota.
      const g = guard(ctx, req, org);
      g.allow('rota.edit', req.body.siteId);
      g.allow('costs.view', req.body.siteId);
      const result = offer(org, req.body.siteId, req.body.weekStart, today(), ctx.now().toISOString());
      const records = org.moves.filter((m) => m.siteId === req.body.siteId && m.weekStart === req.body.weekStart);
      return { ...result, records };
    },
  );

  app.post<{ Body: { moveId: string } }>(
    '/v1/coach/apply',
    {
      ...write,
      schema: { tags: ['Coach'], description: 'Takes a move: changes or removes the shift exactly as offered.', body: { type: 'object', required: ['moveId'], properties: { moveId: { type: 'string' } } } },
    },
    async (req) => {
      const org = orgOf(req);
      const record = org.moves.find((m) => m.id === req.body.moveId && m.status === 'offered');
      if (!record) throw notFound(`Offered move ${req.body.moveId}`);
      // A cover move changes another site's rota as well.
      const g = guard(ctx, req, org);
      for (const siteId of new Set([record.siteId, record.before.siteId, ...(record.after ? [record.after.siteId] : [])])) g.allow('rota.edit', siteId);
      const i = org.state.shifts.findIndex((s) => s.id === record.shiftId);
      // The rota has moved on since the move was worked out: offer again rather than apply something stale.
      if (i < 0 || !sameShift(org.state.shifts[i], record.before)) {
        throw new HttpError(409, 'stale_move', 'The shift has changed since this move was offered. Refresh the moves.');
      }
      if (record.before.date < today()) throw new HttpError(409, 'stale_move', 'That day has already been worked.');
      // Checked against the rota as it is now, for both people and their whole week: other shifts may have moved since.
      const issues = moveIssues(org.state, record.kind, org.state.shifts[i], record.after, record.weekStart);
      if (issues.length) throw new HttpError(409, 'compliance_block', 'This move now breaks a rule. Refresh the moves.', issues);
      assertRotaOpen(org, [org.state.shifts[i], ...(record.after ? [record.after] : [])]);
      const next = record.after
        ? [...org.state.shifts.slice(0, i), { ...record.after, published: false }, ...org.state.shifts.slice(i + 1)]
        : org.state.shifts.filter((s) => s.id !== record.shiftId);
      org.state.shifts = next;
      record.status = 'taken';
      record.decidedAt = ctx.now().toISOString();
      record.decidedBy = req.principal.name;
      audit(org, req.principal.name, 'coach.move.taken', { id: record.id, shiftId: record.shiftId, expectedSaving: record.expectedSaving });
      return record;
    },
  );

  app.post<{ Body: { moveId: string; reason?: string } }>(
    '/v1/coach/dismiss',
    {
      ...write,
      schema: {
        tags: ['Coach'],
        description: 'Turns a move down, ideally with the reason: the most useful coaching signal there is.',
        body: { type: 'object', required: ['moveId'], properties: { moveId: { type: 'string' }, reason: { type: 'string', maxLength: 300 } } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const record = org.moves.find((m) => m.id === req.body.moveId && m.status === 'offered');
      if (!record) throw notFound(`Offered move ${req.body.moveId}`);
      guard(ctx, req, org).allow('rota.edit', record.siteId);
      record.status = 'dismissed';
      record.reason = req.body.reason;
      record.decidedAt = ctx.now().toISOString();
      record.decidedBy = req.principal.name;
      audit(org, req.principal.name, 'coach.move.dismissed', { id: record.id, reason: record.reason });
      return record;
    },
  );

  app.get<{ Querystring: Range }>(
    '/v1/coach/history',
    { ...read, schema: { tags: ['Coach'], description: 'Moves offered, taken and turned down, with what each taken move actually saved once the week was worked.', querystring: rangeQuery } },
    async (req) => {
      const org = orgOf(req);
      const q = req.query;
      const now = today();
      const priced = guard(ctx, req, org).at('costs.view');
      return org.moves
        .filter(priced)
        .filter((m) => (!q.siteId || m.siteId === q.siteId) && (!q.from || m.weekStart >= q.from) && (!q.to || m.weekStart <= q.to))
        .map((m: MoveRecord) => ({ ...m, realisedSaving: m.status === 'taken' ? realisedSaving(m, org.state.employees, org.timeEntries, now) : null }));
    },
  );

  // ----- Scorecard, programme, benchmarks -----

  app.get<{ Querystring: { siteId: string; weeks?: number } }>(
    '/v1/scorecard',
    { ...read, schema: { tags: ['Coach'], description: "The GM scorecard for a site's finished weeks, and where the site sits on the four-rung ladder.", querystring: siteQuery } },
    async (req) => {
      const org = orgOf(req);
      requireSite(org, req.query.siteId);
      // Labour % and cost against target.
      guard(ctx, req, org).allow('costs.view', req.query.siteId);
      return scorecardFor(org, req.query.siteId, today(), req.query.weeks ?? 8);
    },
  );

  app.get('/v1/programmes', { ...read, schema: { tags: ['Programme'], description: 'Every site on the labour programme: week, phase, milestones, targets and the saving.' } }, async (req) => {
    const org = orgOf(req);
    const now = today();
    return org.programmes.filter(guard(ctx, req, org).at('costs.view')).map((p) => {
      const card = scorecardFor(org, p.siteId, now);
      return { programme: p, status: programmeStatus(p, card, org.state, now), maturity: card.maturity, summary: card.summary };
    });
  });

  app.put<{ Params: { siteId: string }; Body: { startWeek: string; gainSharePct?: number } }>(
    '/v1/programmes/:siteId',
    {
      ...lead,
      schema: {
        tags: ['Programme'],
        description: 'Puts a site on the twelve-week programme, or changes its start or gain share.',
        params: siteParam,
        body: { type: 'object', required: ['startWeek'], additionalProperties: false, properties: { startWeek: isoDate, gainSharePct: { type: 'number', minimum: 0, maximum: 1 } } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      requireSite(org, req.params.siteId);
      const existing = org.programmes.find((p) => p.siteId === req.params.siteId);
      const moving = existing && (weekStart(req.body.startWeek) !== existing.startWeek || (req.body.gainSharePct ?? existing.gainSharePct) !== existing.gainSharePct);
      if (existing && moving && counts(existing)) {
        throw new HttpError(409, 'locked', 'A saving has been signed off, so the start and gain share are fixed. Start a new programme instead.');
      }
      const programme: Programme = { ...(existing ?? newProgramme(req.params.siteId, req.body.startWeek)), startWeek: weekStart(req.body.startWeek), gainSharePct: req.body.gainSharePct ?? existing?.gainSharePct };
      org.programmes = [...org.programmes.filter((p) => p.siteId !== req.params.siteId), programme];
      audit(org, req.principal.name, 'programme.set', { siteId: programme.siteId, startWeek: programme.startWeek });
      return programme;
    },
  );

  const programmeOf = (org: OrgData, siteId: string) => {
    const p = org.programmes.find((x) => x.siteId === siteId);
    if (!p) throw notFound(`Programme for site ${siteId}`);
    return p;
  };

  app.put<{ Params: { siteId: string }; Body: { from: string; to: string; source: 'management_accounts' | 'till_and_payroll'; sales?: number; labourCost?: number } }>(
    '/v1/programmes/:siteId/baseline',
    {
      ...lead,
      schema: {
        tags: ['Programme'],
        description: 'Records labour before the programme. From the management accounts give sales and labour cost; from till and payroll they are worked out from the site’s own history.',
        params: siteParam,
        body: {
          type: 'object',
          required: ['from', 'to', 'source'],
          additionalProperties: false,
          properties: { from: isoDate, to: isoDate, source: { type: 'string', enum: ['management_accounts', 'till_and_payroll'] }, sales: money, labourCost: money },
        },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const p = programmeOf(org, req.params.siteId);
      if (counts(p)) throw new HttpError(409, 'locked', 'A saving has been signed off against this baseline, so it is fixed.');
      const { from, to, source } = req.body;
      if (to < from) throw new HttpError(422, 'invalid_period', 'The baseline period ends before it starts');
      const whole = wholeWeeks(from, to);
      if (source === 'till_and_payroll' && !whole) {
        throw new HttpError(422, 'whole_weeks', 'A baseline from till and payroll must run Monday to Sunday, so weekly fixed pay lines up with sales');
      }
      // Hours over demand can only be measured on whole weeks; from the accounts, any period will do for the money.
      const history = whole ? baselineFromHistory(org.state, org.timeEntries, p.siteId, from, to) : { sales: 0, labourCost: 0, overstaffedShare: null };
      const sales = source === 'management_accounts' ? req.body.sales : history.sales;
      const labourCost = source === 'management_accounts' ? req.body.labourCost : history.labourCost;
      if (!sales || labourCost === undefined) {
        throw new HttpError(422, 'baseline_incomplete', source === 'management_accounts' ? 'Give sales and labour cost from the accounts' : 'No till sales for that period');
      }
      p.baseline = { from, to, sales, labourCost, overstaffedShare: history.overstaffedShare ?? undefined, source, recordedBy: req.principal.name, recordedAt: ctx.now().toISOString() };
      audit(org, req.principal.name, 'programme.baseline', { siteId: p.siteId, from, to, source });
      return p;
    },
  );

  app.post<{ Params: { siteId: string }; Body: { milestoneId: string; note?: string } }>(
    '/v1/programmes/:siteId/signoffs',
    {
      ...lead,
      schema: {
        tags: ['Programme'],
        params: siteParam,
        body: { type: 'object', required: ['milestoneId'], additionalProperties: false, properties: { milestoneId: { type: 'string' }, note: { type: 'string', maxLength: 300 } } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const p = programmeOf(org, req.params.siteId);
      const m = MILESTONES.find((x) => x.id === req.body.milestoneId);
      // Milestones the data proves cannot be ticked by hand.
      if (!m || m.proof !== 'signoff') throw new HttpError(422, 'not_signable', `${req.body.milestoneId} is not a sign-off milestone`);
      p.signoffs[m.id] = { by: req.principal.name, at: ctx.now().toISOString(), note: req.body.note };
      audit(org, req.principal.name, 'programme.signoff', { siteId: p.siteId, milestoneId: m.id });
      return p;
    },
  );

  app.delete<{ Params: { siteId: string; milestoneId: string } }>('/v1/programmes/:siteId/signoffs/:milestoneId', { ...lead, schema: { tags: ['Programme'] } }, async (req) => {
    const org = orgOf(req);
    const p = programmeOf(org, req.params.siteId);
    delete p.signoffs[req.params.milestoneId];
    audit(org, req.principal.name, 'programme.signoff.removed', { siteId: p.siteId, milestoneId: req.params.milestoneId });
    return p;
  });

  app.post<{ Params: { siteId: string }; Body: { from: string; to: string; sales: number; labourCost: number; note?: string } }>(
    '/v1/programmes/:siteId/verifications',
    {
      ...lead,
      schema: {
        tags: ['Programme'],
        description: "Signs off a period's sales and labour from the management accounts. The saving is only ever verified, and a gain share only ever charged, on these.",
        params: siteParam,
        body: {
          type: 'object',
          required: ['from', 'to', 'sales', 'labourCost'],
          additionalProperties: false,
          properties: { from: isoDate, to: isoDate, sales: { type: 'number', exclusiveMinimum: 0 }, labourCost: money, note: { type: 'string', maxLength: 300 } },
        },
      },
    },
    async (req, reply) => {
      const org = orgOf(req);
      const p = programmeOf(org, req.params.siteId);
      if (req.body.to < req.body.from) throw new HttpError(422, 'invalid_period', 'The period ends before it starts');
      // A saving is measured against a baseline; verifying first would lock the programme with nothing to measure against.
      if (!p.baseline) throw new HttpError(422, 'no_baseline', 'Record the baseline before signing off a period.');
      // A period that overlaps the baseline or predates the programme would never count; refuse it rather than look accepted.
      if (req.body.from < p.startWeek || (p.baseline && req.body.from <= p.baseline.to)) {
        throw new HttpError(422, 'outside_programme', `A verified period must start on or after ${p.baseline && p.baseline.to >= p.startWeek ? `the day after the baseline ends (${p.baseline.to})` : `programme week 1 (${p.startWeek})`}.`);
      }
      const v = { id: `ver_${randomUUID().slice(0, 12)}`, ...req.body, signedBy: req.principal.name, signedAt: ctx.now().toISOString() };
      p.verifications.push(v);
      audit(org, req.principal.name, 'programme.verified', { siteId: p.siteId, from: v.from, to: v.to });
      return reply.code(201).send(p);
    },
  );

  app.put<{ Body: { benchmarking: boolean } }>(
    '/v1/settings/benchmarking',
    {
      // The operator's data, so the operator decides: a person who manages their settings, or their own full-access key.
      preHandler: async (req: FastifyRequest, reply: FastifyReply) => {
        if (!req.principal.user && !req.principal.scopes.includes('*')) {
          return reply.code(403).send({ error: 'forbidden', message: 'Only the operator can change benchmarking' });
        }
      },
      schema: {
        tags: ['Benchmarks'],
        description: 'Opts the organisation in or out of anonymised benchmarking. Only operators who share see the cohort.',
        body: { type: 'object', required: ['benchmarking'], additionalProperties: false, properties: { benchmarking: { type: 'boolean' } } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      guard(ctx, req, org).allow('settings.manage');
      org.settings = { ...org.settings, benchmarking: req.body.benchmarking };
      audit(org, req.principal.name, 'settings.benchmarking', { benchmarking: req.body.benchmarking });
      return org.settings;
    },
  );

  app.get<{ Querystring: { siteId?: string } }>(
    '/v1/benchmarks',
    {
      ...read,
      schema: {
        tags: ['Benchmarks'],
        description:
          "Quartiles from other operators' sites over the last four finished weeks, and where your sites sit. Only operators who share see the cohort, " +
          'and nothing is returned from a cohort too small or too dominated by one operator to stay anonymous.',
        querystring: { type: 'object', properties: { siteId: { type: 'string' } } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const priced = guard(ctx, req, org).at('costs.view');
      if (!org.settings.benchmarking) {
        return { optedIn: false, benchmark: null, sites: [] };
      }
      const now = today();
      // Read-only pass over every organisation: loaded, sampled and never saved.
      const samples: SiteSample[] = [];
      for (const orgId of await ctx.store.orgIds()) {
        // Demo sandboxes are sample data, not a customer's figures.
        if (isSandbox(orgId)) continue;
        const other = orgId === org.orgId ? org : await ctx.store.load(orgId);
        if (!other.settings?.benchmarking) continue;
        for (const site of other.state.sites) {
          const sample = sampleOf(other, site.id, now);
          // A site with nothing to report would pad the cohort without adding a figure.
          if (sample.labourPct !== null || sample.splh !== null || sample.overstaffedShare !== null || sample.forecastWape !== null) samples.push(sample);
        }
      }
      const benchmark = cohortBenchmark(samples, org.orgId);
      const lowerIsBetter: Record<BenchmarkMetric, boolean> = { labourPct: true, splh: false, overstaffedShare: true, forecastWape: true };
      const sites = org.state.sites
        .filter((s) => (!req.query.siteId || s.id === req.query.siteId) && priced({ siteId: s.id }))
        .map((s) => {
          const own = sampleOf(org, s.id, now);
          const position = Object.fromEntries(
            (Object.keys(benchmark.metrics) as BenchmarkMetric[])
              .filter((m) => own[m] !== null)
              .map((m) => [m, quartileOf(own[m] as number, benchmark.metrics[m]!, lowerIsBetter[m])]),
          );
          const { orgId: _o, ...figures } = own;
          return { siteId: s.id, ...figures, position };
        });
      return { optedIn: true, benchmark, sites };
    },
  );
}
