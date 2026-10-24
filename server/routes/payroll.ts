import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { weekCost, weekOnCosts } from '../../src/engine/cost';
import { employmentAllowanceIssues, employmentAllowanceWeek } from '../../src/engine/allowance';
import { intercompanyBalances, rotaJournal, toXeroCsv } from '../../src/engine/journal';
import { addDays, weekDates } from '../../src/engine/time';
import { sspEstimate, sspInPeriod, type SspCheckLine } from '../../src/engine/ssp';
import { entriesAsShifts, payrollHours, payrollVariance, type PayrollSicknessLine, type PayRunEmployee } from '../../src/engine/timesheet';
import { describeRule } from '../../src/engine/premiums';
import type { PremiumRule, TravelPay } from '../../src/engine/types';
import { requireScope } from '../auth';
import { HttpError, kick, notFound, orgOf, type AppContext } from '../context';
import { actorName, guard, type Guard } from '../guard';
import { enqueue } from '../outbox';
import { PayrollError } from '../integrations/payroll/provider';
import { employerFor, employerStatus } from '../payrollEmployers';
import { idParam, isoDate } from '../schemas';
import { audit, type OrgData } from '../store';

function approvedIn(org: OrgData, from: string, to: string) {
  return org.timeEntries.filter((t) => t.status === 'approved' && t.date >= from && t.date <= to);
}

/**
 * The labour basis for a week: approved actuals once there are any, otherwise
 * the rota. Only the week itself is swapped for actuals; other weeks keep their
 * rota, which is what Employment Allowance rolls forward through.
 */
/**
 * The companies whose payroll a person may read. Payroll runs per company (one PAYE scheme each) and
 * its records hold every employee's pay, so reading one needs payroll.view at every site the company
 * has, not only some. Records from before per-company payroll carry no company and stay org-wide.
 */
function payrollReach(g: Guard, org: OrgData): (entityId?: string) => boolean {
  const reach = g.sites('payroll.view');
  if (reach === 'all') return () => true;
  const whole = new Set(
    org.state.entities
      .filter((e) => {
        const sites = org.state.sites.filter((s) => s.entityId === e.id);
        return sites.length > 0 && sites.every((s) => reach.has(s.id));
      })
      .map((e) => e.id),
  );
  return (entityId) => !!entityId && whole.has(entityId);
}

export function labourBasis(org: OrgData, weekStart: string, basis: 'rota' | 'actual' | 'auto' = 'auto') {
  const actual = approvedIn(org, weekStart, addDays(weekStart, 6));
  const useActual = basis === 'actual' || (basis === 'auto' && actual.length > 0);
  const dates = new Set(weekDates(weekStart));
  return {
    basis: useActual ? ('actual' as const) : ('rota' as const),
    state: useActual
      ? { ...org.state, shifts: [...org.state.shifts.filter((s) => !dates.has(s.date)), ...entriesAsShifts(actual)] }
      : org.state,
  };
}

/** Sickness with SSP due in the period, for the people a company employs. */
export function sicknessIn(org: OrgData, entityId: string, from: string, to: string, today: string): PayrollSicknessLine[] {
  return org.state.employees
    .filter((e) => e.entityId === entityId && (e.absences ?? []).some((a) => a.type === 'sickness' && a.from <= to && (a.to ?? today) >= from))
    .flatMap((e) => {
      const estimate = sspEstimate(e, org.state.shifts, today < to ? today : to);
      const days = estimate.spells.flatMap((s) => s.days).filter((d) => d.date >= from && d.date <= to);
      if (!days.length) return [];
      const perWeek = estimate.spells.find((s) => s.days.includes(days[0]))?.pattern.days.length ?? 5;
      return [{ employeeId: e.id, ...(e.payrollId ? { payrollId: e.payrollId } : {}), dates: days.map((d) => d.date), qualifyingDaysPerWeek: perWeek, sspEstimate: sspInPeriod(estimate, from, to) }];
    });
}

/**
 * What payroll paid in SSP against what the absence record says was due, person by person. Only
 * when the payroll reports SSP at all: a run without it has nothing to check.
 */
export function sspCheck(org: OrgData, entityId: string, from: string, to: string, paid: PayRunEmployee[], today: string): SspCheckLine[] | undefined {
  if (!paid.some((p) => p.ssp !== undefined)) return undefined;
  const expected = new Map(sicknessIn(org, entityId, from, to, today).map((l) => [l.employeeId, l.sspEstimate]));
  const ids = new Set([...expected.keys(), ...paid.filter((p) => (p.ssp ?? 0) > 0).map((p) => p.employeeId)]);
  return [...ids].map((employeeId) => {
    const e = expected.get(employeeId) ?? 0;
    const p = paid.find((x) => x.employeeId === employeeId)?.ssp ?? 0;
    return { employeeId, expected: e, paid: p, difference: Math.round((p - e) * 100) / 100 };
  });
}

export function payrollRoutes(app: FastifyInstance, ctx: AppContext) {
  const read = { preHandler: requireScope('rota:read') };
  // Pay by person: hours batches carry rates, submissions and runs carry accrued and paid cost per person.
  const pay = { preHandler: requireScope('employees:read') };
  const write = { preHandler: requireScope('payroll:write') };

  app.get('/v1/integrations/payroll', { ...read, schema: { tags: ['Payroll'], description: 'Payroll connection health, overall and for each PAYE scheme.' } }, async (req) => {
    const org = orgOf(req);
    const g = guard(ctx, req, org);
    g.allow('payroll.view');
    const mine = payrollReach(g, org);
    const everyCompany = g.sites('payroll.view') === 'all';
    const active = org.state.employees.filter((e) => e.status !== 'leaver' && (everyCompany || mine(e.entityId)));
    const submissions = org.submissions.filter((x) => mine(x.entityId));
    const payRuns = org.payRuns.filter((x) => mine(x.entityId));
    return {
      provider: ctx.providerFor(org.orgId).name,
      employees: { total: active.length, synced: active.filter((e) => e.payrollId).length },
      // One row per company: its TeamPay employer, and how many of its people are set up there.
      employers: org.state.entities.filter((entity) => mine(entity.id)).map((entity) => {
        const people = active.filter((e) => e.entityId === entity.id);
        return {
          ...employerStatus(org, entity, ctx.employers),
          employees: { total: people.length, synced: people.filter((e) => e.payrollId).length },
        };
      }),
      // The outbox runs across every company, so its counts are for those who read every company's payroll.
      outbox: everyCompany
        ? {
            pending: org.outbox.filter((i) => i.status === 'pending').length,
            failed: org.outbox.filter((i) => i.status === 'failed').length,
            delivered: org.outbox.filter((i) => i.status === 'delivered').length,
          }
        : { pending: 0, failed: 0, delivered: 0 },
      lastSubmission: submissions.at(-1) ?? null,
      lastPayRun: payRuns.at(-1) ?? null,
    };
  });

  app.post('/v1/integrations/payroll/sync-employees', { ...write, schema: { tags: ['Payroll'], description: 'Sets up everyone not yet in TeamPay.' } }, async (req) => {
    const org = orgOf(req);
    const g = guard(ctx, req, org);
    g.allow('payroll.send');
    const pending = new Set(org.outbox.filter((i) => i.status === 'pending' && i.type === 'employee.upsert').map((i) => (i.payload as { employeeId: string }).employeeId));
    const toSync = org.state.employees.filter((e) => !e.payrollId && e.status !== 'leaver' && !pending.has(e.id));
    for (const e of toSync) enqueue(org, { type: 'employee.upsert', payload: { employeeId: e.id }, idempotencyKey: `emp:${e.id}:initial` });
    audit(org, actorName(g), 'payroll.employees_queued', { count: toSync.length });
    await kick(ctx, org);
    return { queued: toSync.length };
  });

  app.get('/v1/integrations/payroll/outbox', { ...pay, schema: { tags: ['Payroll'] } }, async (req) => {
    const org = orgOf(req);
    const g = guard(ctx, req, org);
    g.allow('payroll.view');
    // Every company's people and batches are in it, so it is for those who read every company's payroll.
    return g.sites('payroll.view') === 'all' ? org.outbox.slice(-200).reverse() : [];
  });

  app.post<{ Params: { id: string } }>('/v1/integrations/payroll/outbox/:id/retry', { ...write, schema: { tags: ['Payroll'], params: idParam } }, async (req) => {
    const org = orgOf(req);
    const g = guard(ctx, req, org);
    g.allow('payroll.send');
    const item = org.outbox.find((i) => i.id === req.params.id);
    if (!item) throw notFound(`Outbox item ${req.params.id}`);
    if (item.status !== 'failed') throw new HttpError(409, 'not_failed', 'Only failed items can be retried');
    Object.assign(item, { status: 'pending', attempts: 0, nextAttemptAt: Date.now() });
    if (item.type === 'hours.submit') {
      const sub = org.submissions.find((s) => s.id === item.payload.submissionId);
      if (sub) sub.status = 'queued';
    }
    audit(org, actorName(g), 'payroll.retry', { item: item.id });
    await kick(ctx, org);
    return item;
  });

  app.post<{ Body: { weekStart: string; entityId?: string } }>(
    '/v1/payroll/submissions',
    {
      ...write,
      schema: {
        tags: ['Payroll'],
        description:
          "Sends the week's approved hours to TeamPay, one batch per company, each to that company's own PAYE scheme. " +
          'Pass entityId to send one company only. Every entry in scope must be approved or rejected first, and every ' +
          'company with hours must have a TeamPay employer; otherwise nothing is sent. ' +
          "Sending again for the same week supersedes that company's earlier batch.",
        body: { type: 'object', required: ['weekStart'], properties: { weekStart: isoDate, entityId: { type: 'string' } } },
      },
    },
    async (req, reply) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      g.allow('payroll.send');
      const { weekStart: periodStart, entityId } = req.body;
      if (entityId && !org.state.entities.some((e) => e.id === entityId)) throw notFound(`Entity ${entityId}`);
      const periodEnd = addDays(periodStart, 6);
      // Hours belong to the company that employs the person, wherever they worked.
      const employerOf = new Map(org.state.employees.map((e) => [e.id, e.entityId]));
      const inScope = org.timeEntries.filter(
        (t) => t.date >= periodStart && t.date <= periodEnd && (!entityId || employerOf.get(t.employeeId) === entityId),
      );
      const unapproved = inScope.filter((t) => t.status === 'open' || t.status === 'submitted');
      if (unapproved.length) {
        throw new HttpError(409, 'unapproved_time', `${unapproved.length} time entries still need approving or rejecting`, unapproved.map((t) => t.id));
      }

      const batches = org.state.entities
        .filter((entity) => !entityId || entity.id === entityId)
        .map((entity) => ({
          entity,
          batch: payrollHours(
            org.state.employees.filter((e) => e.entityId === entity.id),
            inScope.filter((t) => employerOf.get(t.employeeId) === entity.id),
            periodStart,
            periodEnd,
            org.state.sites,
            org.state.entities,
          ),
        }))
        .filter((b) => b.batch.lines.length > 0)
        // Sickness goes with the hours, so payroll pays SSP for it and we can check what it paid.
        .map((b) => ({ ...b, batch: { ...b.batch, sickness: sicknessIn(org, b.entity.id, periodStart, periodEnd, ctx.store.todayISO()) } }));
      if (batches.length === 0) throw new HttpError(422, 'no_hours', 'No approved hours in this period');

      // Hours carry a rate. Someone whose rate in Preshift and in TeamPay disagree, undecided, would be
      // paid at a rate nobody has confirmed, so the batch waits for that decision.
      const inBatch = new Set(batches.flatMap((b) => b.batch.lines.map((l) => l.employeeId)));
      const undecided = org.state.employees.filter((e) => inBatch.has(e.id) && e.payrollReview?.differences.some((d) => d.pay));
      if (undecided.length) {
        throw new HttpError(
          409,
          'payroll_review',
          `Pay for ${undecided.map((e) => e.name).join(', ')} differs between Preshift and TeamPay. Decide which is right in Payroll, then send.`,
          undecided.map((e) => e.id),
        );
      }

      // All or nothing: a group's payroll is not half sent because one company is not set up.
      const missing = batches.map((b) => employerStatus(org, b.entity, ctx.employers)).filter((s) => !s.employerId);
      if (missing.length) {
        throw new HttpError(409, 'payroll_employer_missing', missing.map((s) => s.problem).join(' '), missing.map((s) => s.entityId));
      }

      const { state } = labourBasis(org, periodStart, 'actual');
      const cost = weekCost(state, periodStart);
      const queued = new Set(org.outbox.filter((i) => i.status === 'pending' && i.type === 'employee.upsert').map((i) => (i.payload as { employeeId: string }).employeeId));
      const created = [];
      for (const { entity, batch: hours } of batches) {
        // Batches from before per-scheme payroll covered the whole organisation, so they count for every company.
        const mine = org.submissions.filter((s) => s.periodStart === periodStart && (!s.entityId || s.entityId === entity.id));
        for (const p of mine) if (p.status !== 'superseded') p.status = 'superseded';
        // Back pay not yet sent goes with this batch; arrears sent with a batch since replaced go again with this one.
        const replaced = new Set(org.submissions.filter((s) => s.status === 'superseded').map((s) => s.id));
        const owed = org.payChanges.filter((c) => c.backPay && (!c.backPay.sentIn || replaced.has(c.backPay.sentIn)) &&
          org.state.employees.find((e) => e.id === c.employeeId)?.entityId === entity.id);
        const batch = {
          ...hours,
          adjustments: owed.map((c) => {
            const e = org.state.employees.find((x) => x.id === c.employeeId)!;
            return {
              employeeId: e.id,
              ...(e.payrollId ? { payrollId: e.payrollId } : {}),
              amount: c.backPay!.amount,
              description: `Back pay from ${c.backPay!.from} to ${c.backPay!.to}`,
              reference: c.id,
            };
          }),
        };
        // Anyone not yet in payroll is set up first; the outbox delivers in order.
        for (const line of [...batch.lines, ...batch.adjustments]) {
          const e = org.state.employees.find((x) => x.id === line.employeeId)!;
          if (!e.payrollId && !queued.has(e.id)) {
            enqueue(org, { type: 'employee.upsert', payload: { employeeId: e.id }, idempotencyKey: `emp:${e.id}:initial` });
            queued.add(e.id);
          }
        }
        const version = mine.length + 1;
        const people = new Set(org.state.employees.filter((e) => e.entityId === entity.id).map((e) => e.id));
        const submission = {
          id: `sub_${randomUUID().slice(0, 12)}`,
          entityId: entity.id,
          periodStart,
          periodEnd,
          version,
          status: 'queued' as const,
          totalHours: batch.totalHours,
          lineCount: batch.lines.length,
          createdAt: new Date().toISOString(),
          createdBy: actorName(g),
          accrued: Object.fromEntries([...cost.employees].filter(([id]) => people.has(id)).map(([id, c]) => [id, c.total])),
        };
        // Back pay costs what any pay costs: priced on top of the week's pay, so on-costs cross thresholds as payroll's will.
        for (const a of batch.adjustments) {
          const e = org.state.employees.find((x) => x.id === a.employeeId)!;
          const gross = cost.employees.get(e.id)?.gross ?? 0;
          submission.accrued[e.id] = Math.round(((submission.accrued[e.id] ?? 0) + weekOnCosts(e, gross + a.amount).total - weekOnCosts(e, gross).total) * 100) / 100;
        }
        for (const c of owed) c.backPay!.sentIn = submission.id;
        org.submissions.push(submission);
        enqueue(org, {
          type: 'hours.submit',
          payload: { submissionId: submission.id, batch, entityId: entity.id },
          idempotencyKey: `hours:${org.orgId}:${entity.id}:${periodStart}:v${version}`,
        });
        audit(org, actorName(g), 'payroll.hours_submitted', { id: submission.id, entityId: entity.id, hours: batch.totalHours, version });
        created.push(submission);
      }
      await kick(ctx, org);
      const totalHours = Math.round(created.reduce((s, x) => s + x.totalHours, 0) * 100) / 100;
      return reply.code(202).send({ periodStart, totalHours, submissions: created });
    },
  );

  app.patch<{ Params: { id: string }; Body: { payrollEmployerId?: string | null; payeReference?: string; leaveYearStart?: string; travelPay?: TravelPay } }>(
    '/v1/entities/:id',
    {
      ...write,
      schema: {
        tags: ['Payroll'],
        description:
          "Sets a company's PAYE reference, the TeamPay employer its PAYE scheme is set up as, its leave year start (MM-DD), and what it pays for travel between sites: the normal rate, the minimum wage for each person's age, or a fixed hourly rate, lifted to the minimum wage on every hour unless `averaging` is set, when the pay period is topped up to average it instead.",
        params: idParam,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            payrollEmployerId: { type: ['string', 'null'] },
            payeReference: { type: 'string' },
            leaveYearStart: { type: 'string', pattern: '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' },
            travelPay: {
              type: 'object',
              additionalProperties: false,
              required: ['basis'],
              properties: {
                basis: { type: 'string', enum: ['normal', 'minimum', 'fixed'] },
                hourly: { type: 'number', minimum: 0, maximum: 200 },
                averaging: { type: 'boolean' },
              },
            },
          },
        },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const entity = org.state.entities.find((e) => e.id === req.params.id);
      if (!entity) throw notFound(`Entity ${req.params.id}`);
      // Which TeamPay employer a company pays through decides where its hours go: a setting,
      // behind the authenticator, like the clocking area.
      const g = guard(ctx, req, org);
      g.allow('settings.manage');
      if (req.body.payrollEmployerId !== undefined) {
        const next = req.body.payrollEmployerId?.trim() || undefined;
        if (next && org.state.entities.some((e) => e.id !== entity.id && e.payrollEmployerId === next)) {
          throw new HttpError(409, 'employer_in_use', 'Another company already uses that TeamPay employer. Each PAYE scheme is one company.');
        }
        const current = employerStatus(org, entity, ctx.employers).employerId;
        const onCurrent = org.state.employees.filter((e) => e.entityId === entity.id && e.payrollId && e.payrollEmployerId === current).length;
        if (current && next !== current && onCurrent > 0) {
          throw new HttpError(
            409,
            'employer_has_people',
            `${onCurrent} of ${entity.name}'s people are already set up under ${current}. Moving them to another PAYE scheme is a leaver and a new starter for each, not a settings change.`,
          );
        }
        entity.payrollEmployerId = next;
      }
      if (req.body.payeReference !== undefined) entity.payeReference = req.body.payeReference;
      if (req.body.leaveYearStart !== undefined) entity.leaveYearStart = req.body.leaveYearStart;
      if (req.body.travelPay !== undefined) {
        const t = req.body.travelPay;
        if (t.basis === 'fixed' && typeof t.hourly !== 'number') throw new HttpError(400, 'travel_rate_missing', 'A fixed travel rate needs an hourly amount.');
        // Normal is stored as a choice, so a company that chose it is not asked again.
        entity.travelPay =
          t.basis === 'normal'
            ? { basis: 'normal' }
            : t.basis === 'minimum'
              ? { basis: 'minimum' }
              : { basis: 'fixed', hourly: Math.round(t.hourly * 100) / 100, ...(t.averaging ? { averaging: true } : {}) };
      }
      audit(org, actorName(g), 'entity.updated', { id: entity.id, fields: Object.keys(req.body) });
      return entity;
    },
  );

  app.put<{ Params: { id: string }; Body: { premiums: PremiumRule[] } }>(
    '/v1/entities/:id/premiums',
    {
      ...write,
      schema: {
        tags: ['Payroll'],
        description:
          "Replaces a company's pay premiums for hourly staff: day rates (Sundays), bank holidays, night hours and overtime. " +
          'Each pays a multiple of the normal rate (1.5 is time and a half) or a fixed amount per hour on top. Where several apply ' +
          'to one hour only the highest is paid. Premiums raise pay, so changing them needs pay approval rights.',
        params: idParam,
        body: {
          type: 'object',
          required: ['premiums'],
          additionalProperties: false,
          properties: {
            premiums: {
              type: 'array',
              maxItems: 20,
              items: {
                type: 'object',
                required: ['name', 'kind'],
                additionalProperties: false,
                properties: {
                  id: { type: 'string', maxLength: 64 },
                  name: { type: 'string', minLength: 1, maxLength: 60 },
                  kind: { type: 'string', enum: ['day', 'bank_holiday', 'night', 'overtime'] },
                  multiplier: { type: 'number', minimum: 1, maximum: 4 },
                  perHour: { type: 'number', minimum: 0, maximum: 50 },
                  weekdays: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 }, maxItems: 7 },
                  fromMinute: { type: 'integer', minimum: 0, maximum: 1439 },
                  toMinute: { type: 'integer', minimum: 0, maximum: 1439 },
                  afterHours: { type: 'number', minimum: 0, maximum: 100 },
                  roleIds: { type: 'array', items: { type: 'string' }, maxItems: 50 },
                },
              },
            },
          },
        },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const entity = org.state.entities.find((e) => e.id === req.params.id);
      if (!entity) throw notFound(`Entity ${req.params.id}`);
      const g = guard(ctx, req, org);
      // A premium rule is a pay rise for everyone it touches, so it sits with whoever approves pay.
      g.allow('pay.approve');
      const roles = new Set(org.state.roles.map((r) => r.id));
      const clean = req.body.premiums.map((r): PremiumRule => {
        const bad = (message: string) => new HttpError(400, 'invalid_premium', `${r.name}: ${message}`);
        if ((typeof r.multiplier === 'number') === (typeof r.perHour === 'number')) throw bad('give either a multiplier or an amount per hour, not both.');
        if (r.kind === 'day' && !r.weekdays?.length) throw bad('choose at least one day.');
        if (r.kind === 'night' && (typeof r.fromMinute !== 'number' || typeof r.toMinute !== 'number' || r.fromMinute === r.toMinute)) {
          throw bad('give the hours it covers.');
        }
        const unknown = (r.roleIds ?? []).filter((id) => !roles.has(id));
        if (unknown.length) throw bad(`unknown role ${unknown.join(', ')}.`);
        return {
          id: r.id ?? `prem_${randomUUID().slice(0, 8)}`,
          name: r.name.trim(),
          kind: r.kind,
          ...(typeof r.multiplier === 'number' ? { multiplier: Math.round(r.multiplier * 1000) / 1000 } : { perHour: Math.round(r.perHour! * 100) / 100 }),
          ...(r.kind === 'day' ? { weekdays: [...new Set(r.weekdays)].sort() } : {}),
          ...(r.kind === 'night' ? { fromMinute: r.fromMinute, toMinute: r.toMinute } : {}),
          ...(r.kind === 'overtime' && typeof r.afterHours === 'number' ? { afterHours: r.afterHours } : {}),
          ...(r.roleIds?.length ? { roleIds: [...new Set(r.roleIds)] } : {}),
        };
      });
      const ids = clean.map((r) => r.id);
      if (new Set(ids).size !== ids.length) throw new HttpError(400, 'invalid_premium', 'Each premium needs its own id.');
      const before = (entity.premiums ?? []).map((r) => `${r.name}: ${describeRule(r)}`);
      entity.premiums = clean;
      audit(org, actorName(g), 'entity.premiums_set', {
        id: entity.id,
        before,
        after: clean.map((r) => `${r.name}: ${describeRule(r)}`),
      });
      return entity;
    },
  );

  app.get('/v1/payroll/submissions', { ...pay, schema: { tags: ['Payroll'] } }, async (req) => {
    const org = orgOf(req);
    const g = guard(ctx, req, org);
    g.allow('payroll.view');
    return org.submissions.filter((x) => payrollReach(g, org)(x.entityId)).reverse();
  });
  app.get('/v1/payroll/runs', { ...pay, schema: { tags: ['Payroll'], description: 'Completed TeamPay runs with rota-to-payroll variance.' } }, async (req) => {
    const org = orgOf(req);
    const g = guard(ctx, req, org);
    g.allow('payroll.view');
    return org.payRuns.filter((x) => payrollReach(g, org)(x.entityId)).reverse();
  });

  app.get<{ Querystring: { weekStart: string; basis?: 'rota' | 'actual' | 'auto'; format?: 'json' | 'xero-csv'; entityId?: string } }>(
    '/v1/journal',
    {
      ...read,
      schema: {
        tags: ['Finance'],
        description:
          'Labour accrual journals by role nominal and site, one per company, with intercompany recharges and Employment Allowance. ' +
          'Basis is approved actuals once there are any, otherwise the rota. Pass entityId for one company, which is what a Xero file needs.',
        querystring: {
          type: 'object',
          required: ['weekStart'],
          properties: {
            weekStart: isoDate,
            basis: { type: 'string', enum: ['rota', 'actual', 'auto'], default: 'auto' },
            format: { type: 'string', enum: ['json', 'xero-csv'], default: 'json' },
            entityId: { type: 'string' },
          },
        },
      },
    },
    async (req, reply) => {
      const org = orgOf(req);
      guard(ctx, req, org).allow('close.export');
      const { basis, state } = labourBasis(org, req.query.weekStart, req.query.basis);
      const { entityId, weekStart: ws } = req.query;
      if (entityId && !org.state.entities.some((e) => e.id === entityId)) throw notFound(`Entity ${entityId}`);
      const all = rotaJournal(state, ws);
      const lines = entityId ? all.filter((l) => l.entityId === entityId) : all;
      if (req.query.format === 'xero-csv') {
        // A Xero organisation is one company, so a file holding several would post them all into one set of books.
        if (!entityId && org.state.entities.length > 1) throw new HttpError(400, 'entity_required', 'Pass entityId: each company needs its own Xero file');
        return reply
          .header('content-type', 'text/csv; charset=utf-8')
          .header('content-disposition', `attachment; filename="preshift-journal-${entityId ? `${entityId}-` : ''}${ws}.csv"`)
          .send(toXeroCsv(lines));
      }
      return {
        basis,
        lines,
        intercompany: intercompanyBalances(state, all),
        employmentAllowance: employmentAllowanceWeek(state, ws),
        employmentAllowanceIssues: employmentAllowanceIssues(state),
      };
    },
  );

  // Inbound from TeamPay. Authenticated by signature, not API key.
  app.post<{ Params: { orgId: string } }>(
    '/v1/integrations/teampay/webhook/:orgId',
    { schema: { tags: ['Payroll'], description: 'TeamPay webhook receiver (payroll.run.completed, payroll.run.flagged).' } },
    async (req, reply) => {
      const provider = ctx.providerFor(req.params.orgId);
      const raw = (req as unknown as { rawBody?: string }).rawBody ?? '';
      const signature = req.headers['x-teampay-signature'] as string | undefined;
      if (!provider.verifyWebhook(raw, signature)) return reply.code(401).send({ error: 'bad_signature' });
      if (!req.org) throw notFound('Organisation');

      const org = orgOf(req);
      const event = JSON.parse(raw) as { id: string; type: string; data: Record<string, string> };
      if (org.processedWebhookIds.has(event.id)) return { received: true, duplicate: true };

      if (event.type === 'payroll.run.completed') {
        // Each PAYE scheme runs its own payroll; the employer on the event says whose run this is.
        const entity = event.data.employer_id
          ? org.state.entities.find((e) => employerStatus(org, e, ctx.employers).employerId === event.data.employer_id)
          : org.state.entities.length === 1 ? org.state.entities[0] : undefined;
        if (!entity) {
          // Not marked processed, so TeamPay's retry succeeds once the employer is set on the right company.
          audit(org, 'TeamPay', 'payroll.run_unmatched', event.data);
          return reply.code(422).send({ error: 'unknown_employer', message: `No company is set up as TeamPay employer ${event.data.employer_id ?? '(none given)'}` });
        }
        let employerId: string;
        try {
          employerId = event.data.employer_id ?? employerFor(org, entity.id, ctx.employers);
        } catch (err) {
          if (err instanceof PayrollError) return reply.code(422).send({ error: 'unknown_employer', message: err.message });
          throw err;
        }
        const run = await provider.getPayRun(employerId, event.data.pay_run_id);
        const submission = org.submissions
          .filter((s) => s.periodStart === run.periodStart && s.status === 'sent' && (s.entityId ?? org.state.entities[0]?.id) === entity.id)
          .at(-1);
        const accrued = new Map(Object.entries(submission?.accrued ?? {}));
        const variance = payrollVariance(accrued, run.employees);
        const ssp = sspCheck(org, entity.id, run.periodStart, run.periodEnd, run.employees, ctx.store.todayISO());
        org.payRuns.push({
          id: run.id,
          entityId: entity.id,
          employerId,
          periodStart: run.periodStart,
          periodEnd: run.periodEnd,
          receivedAt: new Date().toISOString(),
          variance,
          ...(ssp ? { ssp } : {}),
        });
        const wrong = ssp?.filter((l) => Math.abs(l.difference) >= 0.01) ?? [];
        if (wrong.length) audit(org, 'TeamPay', 'payroll.ssp_mismatch', { run: run.id, entityId: entity.id, people: wrong.length, difference: Math.round(wrong.reduce((s, l) => s + l.difference, 0) * 100) / 100 });
        audit(org, 'TeamPay', 'payroll.run_completed', { run: run.id, entityId: entity.id, variance: variance.variance });
      } else if (event.type === 'payroll.run.flagged') {
        audit(org, 'TeamPay', 'payroll.run_flagged', event.data);
      }
      org.processedWebhookIds.add(event.id);
      return { received: true };
    },
  );
}
