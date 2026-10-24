import type { FastifyInstance } from 'fastify';
import { weekCost } from '../../src/engine/cost';
import {
  periodContaining,
  scheduleFor,
  scheduleProblems,
  schedulesOf,
  upcomingPeriods,
  type PaySchedule,
} from '../../src/engine/payPeriods';
import { addDays, weekStart } from '../../src/engine/time';
import { payrollHours } from '../../src/engine/timesheet';
import type { Entity, TimeEntry } from '../../src/engine/types';
import { requireScope } from '../auth';
import { HttpError, kick, londonToday, notFound, orgOf, type AppContext } from '../context';
import { actorName, guard, type Guard } from '../guard';
import { employerStatus } from '../payrollEmployers';
import { peopleOn, periodEntries, recordFor, resolvePeriod, summarise } from '../payPeriods';
import { idParam, isoDate } from '../schemas';
import { audit, type OrgData } from '../store';
import { labourBasis, queueHours, sicknessIn } from './payroll';

const scheduleBody = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'frequency', 'cutoffDaysBeforePay', 'cutoffTime'],
  properties: {
    id: { type: 'string', pattern: '^[a-z0-9-]{1,32}$' },
    name: { type: 'string', minLength: 1, maxLength: 60 },
    frequency: { type: 'string', enum: ['weekly', 'fortnightly', 'four_weekly', 'monthly', 'last_friday'] },
    anchorDate: isoDate,
    periodEndDay: { type: 'integer', minimum: 1, maximum: 31 },
    payDay: { type: 'integer', minimum: 1, maximum: 31 },
    payMonthOffset: { type: 'integer', enum: [0, 1] },
    payDaysAfterPeriodEnd: { type: 'integer', minimum: 0, maximum: 28 },
    periodEndDaysBeforePay: { type: 'integer', minimum: 0, maximum: 21 },
    cutoffDaysBeforePay: { type: 'integer', minimum: 0, maximum: 27 },
    cutoffTime: { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' },
  },
} as const;

const periodParams = {
  type: 'object',
  required: ['entityId', 'scheduleId', 'periodStart'],
  properties: { entityId: { type: 'string' }, scheduleId: { type: 'string' }, periodStart: isoDate },
} as const;

type PeriodParams = { entityId: string; scheduleId: string; periodStart: string };

/** Who sees pay periods: those who approve or lock time, or run payroll. Counts and hours, never pay. */
const PERIOD_READERS = ['time.approve', 'time.lock', 'payroll.view'] as const;

/** Every site a company trades from or its people work at: a period's rota and hours reach all of them. */
function sitesOfPeriod(org: OrgData, entity: Entity, people: { id: string; siteId: string }[]) {
  const ids = new Set(people.map((p) => p.id));
  return new Set([
    ...org.state.sites.filter((s) => s.entityId === entity.id).map((s) => s.id),
    ...people.map((p) => p.siteId),
    ...org.state.shifts.filter((s) => ids.has(s.employeeId)).map((s) => s.siteId),
  ]);
}

function canSeeAny(g: Guard) {
  const reach = g.sites(...PERIOD_READERS);
  return reach === 'all' || reach.size > 0;
}

/** Loaded labour and gross pay per person accrued for the period's days, from approved time, week by week. */
function accruedFor(org: OrgData, people: Set<string>, from: string, to: string) {
  const total = new Map<string, number>();
  const gross = new Map<string, number>();
  const add = (m: Map<string, number>, id: string, n: number) => m.set(id, Math.round(((m.get(id) ?? 0) + n) * 100) / 100);
  for (let ws = weekStart(from); ws <= to; ws = addDays(ws, 7)) {
    const { state } = labourBasis(org, ws, 'actual');
    const cost = weekCost(state, ws);
    for (const s of state.shifts) {
      if (s.date < from || s.date > to || s.date < ws || s.date > addDays(ws, 6) || !people.has(s.employeeId)) continue;
      const c = cost.shifts.get(s.id);
      if (!c) continue;
      add(total, s.employeeId, c.total);
      add(gross, s.employeeId, c.gross);
    }
  }
  return { total, gross };
}

/** The weeks whose tips go with a period: each week goes with the period its Sunday falls in, so none is paid twice or missed. */
function troncWeeksOf(from: string, to: string) {
  const weeks: string[] = [];
  for (let ws = weekStart(from); ws <= to; ws = addDays(ws, 7)) {
    const sunday = addDays(ws, 6);
    if (sunday >= from && sunday <= to) weeks.push(ws);
  }
  return weeks;
}

export function payPeriodRoutes(app: FastifyInstance, ctx: AppContext) {
  const read = { preHandler: requireScope('rota:read') };
  const approve = { preHandler: requireScope('time:approve') };
  const write = { preHandler: requireScope('payroll:write') };

  app.get('/v1/pay-schedules', {
    ...read,
    schema: {
      tags: ['Pay periods'],
      description: "Each company's payrolls with how many people each pays, and the next six periods of each: hours covered, cutoff and payday.",
    },
  }, async (req) => {
    const org = orgOf(req);
    const g = guard(ctx, req, org);
    if (!canSeeAny(g) && !g.can('settings.manage')) g.allow('payroll.view');
    const today = londonToday(ctx);
    return org.state.entities.map((entity) => ({
      entityId: entity.id,
      name: entity.name,
      custom: Boolean(entity.paySchedules?.length),
      schedules: schedulesOf(entity).map((s) => ({
        ...s,
        people: peopleOn(org, entity, s.id).filter((e) => e.status !== 'leaver').length,
        upcoming: upcomingPeriods(s, today, 6),
      })),
    }));
  });

  app.post<{ Body: { schedule: PaySchedule } }>('/v1/pay-schedules/preview', {
    ...read,
    schema: {
      tags: ['Pay periods'],
      description: 'Checks a pay calendar before it is saved and shows its next twelve periods.',
      body: { type: 'object', required: ['schedule'], properties: { schedule: scheduleBody } },
    },
  }, async (req) => {
    const org = orgOf(req);
    const g = guard(ctx, req, org);
    if (!canSeeAny(g)) g.allow('settings.manage');
    const today = londonToday(ctx);
    const problems = scheduleProblems(req.body.schedule, today);
    return { problems, upcoming: problems.length ? [] : upcomingPeriods(req.body.schedule, today, 12) };
  });

  app.put<{ Params: { id: string }; Body: { schedules: PaySchedule[] } }>(
    '/v1/entities/:id/pay-schedules',
    {
      ...write,
      schema: {
        tags: ['Pay periods'],
        description:
          "Sets the payrolls a company runs. The first is where anyone not placed on another is paid. A payroll still paying " +
          'people cannot be removed, and one with a period locked or passed that is not yet paid keeps its calendar until it is. ' +
          'An empty list goes back to the weekly default.',
        params: idParam,
        body: { type: 'object', required: ['schedules'], properties: { schedules: { type: 'array', maxItems: 8, items: scheduleBody } } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const entity = org.state.entities.find((e) => e.id === req.params.id);
      if (!entity) throw notFound(`Entity ${req.params.id}`);
      // A company's pay calendar decides when hours are due and when people are paid: a setting, behind the authenticator.
      const g = guard(ctx, req, org);
      g.allow('settings.manage');
      const today = londonToday(ctx);
      const next = req.body.schedules;
      const ids = next.map((s) => s.id);
      if (new Set(ids).size !== ids.length) throw new HttpError(422, 'duplicate_schedule', 'Each payroll needs its own id.');
      const problems = next.flatMap((s) => scheduleProblems(s, today).map((p) => `${s.name}: ${p}`));
      if (problems.length) throw new HttpError(422, 'invalid_schedule', problems.join(' '), problems);

      const before = schedulesOf(entity);
      const after = next.length ? next : schedulesOf(undefined);
      // Someone on a payroll that goes would drop to another without anyone deciding it.
      for (const old of before) {
        if (after.some((s) => s.id === old.id)) continue;
        const paid = peopleOn(org, entity, old.id).filter((e) => e.status !== 'leaver' && e.payScheduleId === old.id);
        if (paid.length) {
          throw new HttpError(409, 'schedule_in_use', `${old.name} still pays ${paid.length} people. Move them to another payroll first.`, paid.map((e) => e.id));
        }
      }
      // A period in flight keeps the dates it was locked or passed with: its calendar cannot move under it.
      for (const s of after) {
        const old = before.find((b) => b.id === s.id);
        if (!old) continue;
        const inFlight = (org.payPeriods ?? []).filter((r) => r.entityId === entity.id && r.scheduleId === s.id && (r.rotaLock || r.passes.length) && r.payDate >= today);
        const moved = inFlight.find((r) => {
          const p = periodContaining(s, r.periodStart);
          return p.periodStart !== r.periodStart || p.periodEnd !== r.periodEnd;
        });
        if (moved) {
          throw new HttpError(409, 'period_in_flight', `${s.name}'s period ${moved.periodStart} to ${moved.periodEnd} is locked or passed and not yet paid. Change its calendar after payday ${moved.payDate}.`);
        }
      }
      entity.paySchedules = next.length ? next : undefined;
      audit(org, actorName(g), 'pay_schedules.updated', { entityId: entity.id, schedules: next.map((s) => ({ id: s.id, frequency: s.frequency })) });
      return { entityId: entity.id, schedules: schedulesOf(entity) };
    },
  );

  app.put<{ Params: { id: string }; Body: { scheduleId: string } }>(
    '/v1/employees/:id/pay-schedule',
    {
      ...write,
      schema: {
        tags: ['Pay periods'],
        description:
          "Moves a person to another of their company's payrolls. Hours already passed stay with the payroll that paid them, " +
          'so nothing is paid twice; hours not yet passed go with the person.',
        params: idParam,
        body: { type: 'object', required: ['scheduleId'], properties: { scheduleId: { type: 'string' } } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const employee = org.state.employees.find((e) => e.id === req.params.id);
      if (!employee) throw notFound(`Employee ${req.params.id}`);
      const g = guard(ctx, req, org);
      g.allow('payroll.send');
      const entity = org.state.entities.find((e) => e.id === employee.entityId);
      const target = schedulesOf(entity).find((s) => s.id === req.body.scheduleId);
      if (!target) throw notFound(`Pay schedule ${req.body.scheduleId}`);
      const from = scheduleFor(employee, entity);
      // Moving someone whose rota is locked would take their shifts out of a locked period without unlocking it.
      const locked = (org.payPeriods ?? []).find((r) => r.entityId === employee.entityId && (r.scheduleId === from.id || r.scheduleId === target.id) && r.rotaLock && !r.passes.length);
      if (locked) {
        throw new HttpError(409, 'rota_locked', `The pay period ${locked.periodStart} to ${locked.periodEnd} is locked and not yet passed. Move ${employee.name} once it is passed, or unlock it.`);
      }
      employee.payScheduleId = target.id === schedulesOf(entity)[0].id ? undefined : target.id;
      audit(org, actorName(g), 'employee.pay_schedule', { id: employee.id, from: from.id, to: target.id });
      return { employeeId: employee.id, scheduleId: target.id };
    },
  );

  app.get<{ Querystring: { date?: string; previous?: number } }>(
    '/v1/pay-periods',
    {
      ...read,
      schema: {
        tags: ['Pay periods'],
        description:
          'For every payroll, the pay period a day falls in (today by default) and as many before it as asked, each with where it ' +
          'stands: rota locked, time cards approved, passed to payroll, and whether it is past its cutoff.',
        querystring: { type: 'object', properties: { date: isoDate, previous: { type: 'integer', minimum: 0, maximum: 12, default: 0 } } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      if (!canSeeAny(g)) g.allow('time.approve');
      const today = londonToday(ctx);
      const reach = g.sites(...PERIOD_READERS);
      const out = [];
      for (const entity of org.state.entities) {
        for (const schedule of schedulesOf(entity)) {
          const people = peopleOn(org, entity, schedule.id);
          if (reach !== 'all' && ![...sitesOfPeriod(org, entity, people)].some((id) => reach.has(id))) continue;
          let p = periodContaining(schedule, req.query.date ?? today);
          for (let i = 0; i <= (req.query.previous ?? 0); i++) {
            const { timeCards: _cards, ...summary } = summarise(org, entity, schedule, resolvePeriod(org, entity.id, schedule.id, p.periodStart).period, today, ctx.now());
            out.push(summary);
            p = periodContaining(schedule, addDays(p.periodStart, -1));
          }
        }
      }
      return out;
    },
  );

  app.get<{ Params: PeriodParams }>(
    '/v1/pay-periods/:entityId/:scheduleId/:periodStart',
    {
      ...read,
      schema: {
        tags: ['Pay periods'],
        description: "One pay period with a time card for each person: rostered against clocked hours, what is approved, and what still waits.",
        params: periodParams,
      },
    },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      if (!canSeeAny(g)) g.allow('time.approve');
      const { entity, schedule, period, record } = resolvePeriod(org, req.params.entityId, req.params.scheduleId, req.params.periodStart);
      const summary = summarise(org, entity, schedule, period, londonToday(ctx), ctx.now());
      // Each card is shown to those who read time at a site the person works or is based at.
      const reach = g.sites('time.record', ...PERIOD_READERS);
      const people = new Map(org.state.employees.map((e) => [e.id, e]));
      const sitesOf = (id: string) => new Set([
        people.get(id)?.siteId,
        ...org.state.shifts.filter((s) => s.employeeId === id && s.date >= period.periodStart && s.date <= period.periodEnd).map((s) => s.siteId),
        ...org.timeEntries.filter((t) => t.employeeId === id && t.date >= period.periodStart && t.date <= period.periodEnd).map((t) => t.siteId),
      ]);
      const timeCards = summary.timeCards.filter((c) => reach === 'all' || [...sitesOf(c.employeeId)].some((s) => s && reach.has(s)));
      return { ...summary, timeCards, history: record?.history ?? [], passes: record?.passes ?? [] };
    },
  );

  app.post<{ Params: PeriodParams }>(
    '/v1/pay-periods/:entityId/:scheduleId/:periodStart/lock-rota',
    {
      ...approve,
      schema: {
        tags: ['Pay periods'],
        description:
          "Locks the rota for everyone this payroll pays across the period: no shift of theirs in it can be added, moved or removed. " +
          'Time cards are approved against the locked rota. Needs the right to lock pay periods at every site the period reaches.',
        params: periodParams,
      },
    },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      const { entity, schedule, period, record: existing } = resolvePeriod(org, req.params.entityId, req.params.scheduleId, req.params.periodStart);
      for (const siteId of sitesOfPeriod(org, entity, peopleOn(org, entity, schedule.id))) g.allow('time.lock', siteId);
      if (existing?.rotaLock) throw new HttpError(409, 'already_locked', `Locked by ${existing.rotaLock.by}.`);
      const record = recordFor(org, entity, schedule, period);
      const at = ctx.now().toISOString();
      record.rotaLock = { at, by: actorName(g) };
      record.history.push({ at, by: actorName(g), action: 'rota_locked' });
      audit(org, actorName(g), 'pay_period.rota_locked', { id: record.id });
      return summaryOf(org, ctx, record.entityId, record.scheduleId, record.periodStart);
    },
  );

  app.post<{ Params: PeriodParams; Body: { reason: string } }>(
    '/v1/pay-periods/:entityId/:scheduleId/:periodStart/unlock-rota',
    {
      ...approve,
      schema: {
        tags: ['Pay periods'],
        description: 'Unlocks the rota, with a reason that is kept. Refused once the hours are passed to payroll: the rota is then the record payroll was reconciled to.',
        params: periodParams,
        body: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', minLength: 5, maxLength: 500 } } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      const { entity, schedule, record } = resolvePeriod(org, req.params.entityId, req.params.scheduleId, req.params.periodStart);
      for (const siteId of sitesOfPeriod(org, entity, peopleOn(org, entity, schedule.id))) g.allow('time.lock', siteId);
      if (!record?.rotaLock) throw new HttpError(409, 'not_locked', 'The rota for this period is not locked.');
      if (record.passes.length) throw new HttpError(409, 'period_passed', 'These hours have been passed to payroll, so the rota stays as it was paid. Correct the hours on the time cards and pass again.');
      const at = ctx.now().toISOString();
      record.rotaLock = undefined;
      record.history.push({ at, by: actorName(g), action: 'rota_unlocked', detail: { reason: req.body.reason } });
      audit(org, actorName(g), 'pay_period.rota_unlocked', { id: record.id, reason: req.body.reason });
      return summaryOf(org, ctx, record.entityId, record.scheduleId, record.periodStart);
    },
  );

  app.post<{ Params: PeriodParams; Body: { employeeIds?: string[] } }>(
    '/v1/pay-periods/:entityId/:scheduleId/:periodStart/approve',
    {
      ...approve,
      schema: {
        tags: ['Pay periods'],
        description:
          "Approves time cards: every submitted entry on each card, for everyone or the people given. Needs the rota locked first, so " +
          'cards are approved against a rota that cannot move. Only at sites the person approves time for, and never their own hours.',
        params: periodParams,
        body: { type: 'object', properties: { employeeIds: { type: 'array', items: { type: 'string' }, maxItems: 1000 } } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      const { entity, schedule, period, record } = resolvePeriod(org, req.params.entityId, req.params.scheduleId, req.params.periodStart);
      if (!record?.rotaLock) throw new HttpError(409, 'rota_not_locked', 'Lock the rota for this period first, so time cards are approved against a rota that cannot change.');
      const people = peopleOn(org, entity, schedule.id).filter((e) => !req.body.employeeIds || req.body.employeeIds.includes(e.id));
      const entries = periodEntries(org, people, period, record.id);
      const own = (t: TimeEntry) => !!g.behind?.employeeId && t.employeeId === g.behind.employeeId;
      const waiting = entries.filter((t) => t.status === 'submitted');
      const mine = g.at('time.approve');
      const approvable = waiting.filter((t) => mine(t) && !own(t));
      if (req.body.employeeIds && waiting.length && approvable.length === 0) {
        if (waiting.some(own)) throw new HttpError(403, 'forbidden', 'Somebody else approves your own hours.');
        g.allow('time.approve', waiting[0].siteId);
      }
      const at = ctx.now().toISOString();
      for (const t of approvable) Object.assign(t, { status: 'approved', approvedBy: actorName(g), approvedAt: at });
      const result = {
        approved: approvable.length,
        ownSkipped: waiting.filter(own).length,
        notYours: waiting.filter((t) => !mine(t) && !own(t)).length,
        stillOpen: entries.filter((t) => t.status === 'open').length,
      };
      if (approvable.length) {
        record.history.push({ at, by: actorName(g), action: 'timecards_approved', detail: { entries: approvable.length, people: new Set(approvable.map((t) => t.employeeId)).size } });
        audit(org, actorName(g), 'time.approved', { approved: approvable.length, ownSkipped: result.ownSkipped, payPeriod: record.id });
      }
      return result;
    },
  );

  app.post<{ Params: PeriodParams; Body: { reason?: string } }>(
    '/v1/pay-periods/:entityId/:scheduleId/:periodStart/pass',
    {
      ...write,
      schema: {
        tags: ['Pay periods'],
        description:
          "Passes the period's approved hours to the company's payroll, with the payday. Needs the period ended, the rota locked, every " +
          'time card approved and a TeamPay employer for the company. Hours already passed in another payroll are never sent again. ' +
          'Passing again is a correction: it needs a reason and supersedes the earlier batch. Passing after the cutoff is allowed and marked late.',
        params: periodParams,
        body: { type: 'object', properties: { reason: { type: 'string', minLength: 5, maxLength: 500 } } },
      },
    },
    async (req, reply) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      g.allow('payroll.send');
      const today = londonToday(ctx);
      const { entity, schedule, period, record } = resolvePeriod(org, req.params.entityId, req.params.scheduleId, req.params.periodStart);
      if (today <= period.periodEnd) throw new HttpError(409, 'period_not_ended', `The period runs to ${period.periodEnd}. Its hours can be passed from the day after.`);
      if (!record?.rotaLock) throw new HttpError(409, 'rota_not_locked', 'Lock the rota and approve the time cards first.');
      const correction = record.passes.length > 0;
      if (correction && !req.body.reason) throw new HttpError(422, 'reason_required', 'This period has been passed already. Say why it is being passed again: payroll sees it as a correction.');
      const people = peopleOn(org, entity, schedule.id);
      const entries = periodEntries(org, people, period, record.id);
      const unsettled = entries.filter((t) => t.status === 'open' || t.status === 'submitted');
      if (unsettled.length) {
        throw new HttpError(409, 'unapproved_time', `${unsettled.length} time entries still need approving or rejecting`, unsettled.map((t) => t.id));
      }
      const ids = new Set(people.map((e) => e.id));
      const batch = {
        ...payrollHours(people, entries, period.periodStart, period.periodEnd, org.state.sites, org.state.entities),
        payDate: period.payDate,
        // Sickness goes with the hours, so payroll pays SSP for it and the pay run can be checked against it.
        sickness: sicknessIn(org, entity.id, period.periodStart, period.periodEnd, today).filter((l) => ids.has(l.employeeId)),
      };
      if (batch.lines.length) {
        const employer = employerStatus(org, entity, ctx.employers);
        if (!employer.employerId) throw new HttpError(409, 'payroll_employer_missing', employer.problem ?? `${entity.name} has no TeamPay employer.`, [entity.id]);
        // A rate Preshift and TeamPay disagree on, undecided, would pay hours at a rate nobody has confirmed.
        const inBatch = new Set(batch.lines.map((l) => l.employeeId));
        const undecided = org.state.employees.filter((e) => inBatch.has(e.id) && e.payrollReview?.differences.some((d) => d.pay));
        if (undecided.length) {
          throw new HttpError(409, 'payroll_review', `Pay for ${undecided.map((e) => e.name).join(', ')} differs between Preshift and TeamPay. Decide which is right in Payroll, then pass.`, undecided.map((e) => e.id));
        }
      }
      const costs = accruedFor(org, ids, period.periodStart, period.periodEnd);
      const multiple = schedulesOf(entity).length > 1;
      const submission = batch.lines.length
        ? queueHours(org, actorName(g), entity, batch, costs, { scheduleId: schedule.id, troncWeeks: troncWeeksOf(period.periodStart, period.periodEnd), ...(multiple ? { people: ids } : {}) })
        : undefined;
      const approved = entries.filter((t) => t.status === 'approved');
      for (const t of approved) t.passedIn = record.id;
      const at = ctx.now().toISOString();
      const pass = {
        at,
        by: actorName(g),
        version: record.passes.length + 1,
        late: at > record.cutoffAt,
        hours: batch.totalHours,
        entries: approved.length,
        ...(submission ? { submissionId: submission.id } : {}),
        ...(req.body.reason ? { reason: req.body.reason } : {}),
      };
      record.passes.push(pass);
      record.history.push({ at, by: actorName(g), action: 'passed', detail: { version: pass.version, hours: pass.hours, late: pass.late, ...(pass.reason ? { reason: pass.reason } : {}) } });
      audit(org, actorName(g), 'pay_period.passed', { id: record.id, version: pass.version, hours: pass.hours, late: pass.late, ...(submission ? { submissionId: submission.id } : {}) });
      if (submission) await kick(ctx, org);
      return reply.code(202).send({ pass, submission: submission ?? null, period: summaryOf(org, ctx, record.entityId, record.scheduleId, record.periodStart) });
    },
  );
}

function summaryOf(org: OrgData, ctx: AppContext, entityId: string, scheduleId: string, periodStart: string) {
  const { entity, schedule, period } = resolvePeriod(org, entityId, scheduleId, periodStart);
  const { timeCards: _cards, ...summary } = summarise(org, entity, schedule, period, londonToday(ctx), ctx.now());
  return summary;
}
