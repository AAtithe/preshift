import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { weekCost } from '../../src/engine/cost';
import { employmentAllowanceIssues, employmentAllowanceWeek } from '../../src/engine/allowance';
import { intercompanyBalances, rotaJournal, toXeroCsv } from '../../src/engine/journal';
import { addDays, weekDates } from '../../src/engine/time';
import { entriesAsShifts, payrollHours, payrollVariance } from '../../src/engine/timesheet';
import { requireScope } from '../auth';
import { HttpError, kick, notFound, orgOf, type AppContext } from '../context';
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

export function payrollRoutes(app: FastifyInstance, ctx: AppContext) {
  const read = { preHandler: requireScope('rota:read') };
  const write = { preHandler: requireScope('payroll:write') };

  app.get('/v1/integrations/payroll', { ...read, schema: { tags: ['Payroll'], description: 'Payroll connection health, overall and for each PAYE scheme.' } }, async (req) => {
    const org = orgOf(req);
    const active = org.state.employees.filter((e) => e.status !== 'leaver');
    return {
      provider: ctx.providerFor(org.orgId).name,
      employees: { total: active.length, synced: active.filter((e) => e.payrollId).length },
      // One row per company: its TeamPay employer, and how many of its people are set up there.
      employers: org.state.entities.map((entity) => {
        const people = active.filter((e) => e.entityId === entity.id);
        return {
          ...employerStatus(org, entity, ctx.employers),
          employees: { total: people.length, synced: people.filter((e) => e.payrollId).length },
        };
      }),
      outbox: {
        pending: org.outbox.filter((i) => i.status === 'pending').length,
        failed: org.outbox.filter((i) => i.status === 'failed').length,
        delivered: org.outbox.filter((i) => i.status === 'delivered').length,
      },
      lastSubmission: org.submissions.at(-1) ?? null,
      lastPayRun: org.payRuns.at(-1) ?? null,
    };
  });

  app.post('/v1/integrations/payroll/sync-employees', { ...write, schema: { tags: ['Payroll'], description: 'Sets up everyone not yet in TeamPay.' } }, async (req) => {
    const org = orgOf(req);
    const pending = new Set(org.outbox.filter((i) => i.status === 'pending' && i.type === 'employee.upsert').map((i) => (i.payload as { employeeId: string }).employeeId));
    const toSync = org.state.employees.filter((e) => !e.payrollId && e.status !== 'leaver' && !pending.has(e.id));
    for (const e of toSync) enqueue(org, { type: 'employee.upsert', payload: { employeeId: e.id }, idempotencyKey: `emp:${e.id}:initial` });
    audit(org, req.principal.name, 'payroll.employees_queued', { count: toSync.length });
    await kick(ctx, org);
    return { queued: toSync.length };
  });

  app.get('/v1/integrations/payroll/outbox', { ...read, schema: { tags: ['Payroll'] } }, async (req) =>
    orgOf(req).outbox.slice(-200).reverse(),
  );

  app.post<{ Params: { id: string } }>('/v1/integrations/payroll/outbox/:id/retry', { ...write, schema: { tags: ['Payroll'], params: idParam } }, async (req) => {
    const org = orgOf(req);
    const item = org.outbox.find((i) => i.id === req.params.id);
    if (!item) throw notFound(`Outbox item ${req.params.id}`);
    if (item.status !== 'failed') throw new HttpError(409, 'not_failed', 'Only failed items can be retried');
    Object.assign(item, { status: 'pending', attempts: 0, nextAttemptAt: Date.now() });
    if (item.type === 'hours.submit') {
      const sub = org.submissions.find((s) => s.id === item.payload.submissionId);
      if (sub) sub.status = 'queued';
    }
    audit(org, req.principal.name, 'payroll.retry', { item: item.id });
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
          ),
        }))
        .filter((b) => b.batch.lines.length > 0);
      if (batches.length === 0) throw new HttpError(422, 'no_hours', 'No approved hours in this period');

      // All or nothing: a group's payroll is not half sent because one company is not set up.
      const missing = batches.map((b) => employerStatus(org, b.entity, ctx.employers)).filter((s) => !s.employerId);
      if (missing.length) {
        throw new HttpError(409, 'payroll_employer_missing', missing.map((s) => s.problem).join(' '), missing.map((s) => s.entityId));
      }

      const { state } = labourBasis(org, periodStart, 'actual');
      const cost = weekCost(state, periodStart);
      const queued = new Set(org.outbox.filter((i) => i.status === 'pending' && i.type === 'employee.upsert').map((i) => (i.payload as { employeeId: string }).employeeId));
      const created = [];
      for (const { entity, batch } of batches) {
        // Anyone not yet in payroll is set up first; the outbox delivers in order.
        for (const line of batch.lines) {
          const e = org.state.employees.find((x) => x.id === line.employeeId)!;
          if (!e.payrollId && !queued.has(e.id)) {
            enqueue(org, { type: 'employee.upsert', payload: { employeeId: e.id }, idempotencyKey: `emp:${e.id}:initial` });
            queued.add(e.id);
          }
        }
        // Batches from before per-scheme payroll covered the whole organisation, so they count for every company.
        const mine = org.submissions.filter((s) => s.periodStart === periodStart && (!s.entityId || s.entityId === entity.id));
        for (const p of mine) if (p.status !== 'superseded') p.status = 'superseded';
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
          createdBy: req.principal.name,
          accrued: Object.fromEntries([...cost.employees].filter(([id]) => people.has(id)).map(([id, c]) => [id, c.total])),
        };
        org.submissions.push(submission);
        enqueue(org, {
          type: 'hours.submit',
          payload: { submissionId: submission.id, batch, entityId: entity.id },
          idempotencyKey: `hours:${org.orgId}:${entity.id}:${periodStart}:v${version}`,
        });
        audit(org, req.principal.name, 'payroll.hours_submitted', { id: submission.id, entityId: entity.id, hours: batch.totalHours, version });
        created.push(submission);
      }
      await kick(ctx, org);
      const totalHours = Math.round(created.reduce((s, x) => s + x.totalHours, 0) * 100) / 100;
      return reply.code(202).send({ periodStart, totalHours, submissions: created });
    },
  );

  app.patch<{ Params: { id: string }; Body: { payrollEmployerId?: string | null; payeReference?: string; leaveYearStart?: string } }>(
    '/v1/entities/:id',
    {
      ...write,
      schema: {
        tags: ['Payroll'],
        description: "Sets a company's PAYE reference, the TeamPay employer its PAYE scheme is set up as, and its leave year start (MM-DD).",
        params: idParam,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            payrollEmployerId: { type: ['string', 'null'] },
            payeReference: { type: 'string' },
            leaveYearStart: { type: 'string', pattern: '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' },
          },
        },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const entity = org.state.entities.find((e) => e.id === req.params.id);
      if (!entity) throw notFound(`Entity ${req.params.id}`);
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
      audit(org, req.principal.name, 'entity.updated', { id: entity.id, fields: Object.keys(req.body) });
      return entity;
    },
  );

  app.get('/v1/payroll/submissions', { ...read, schema: { tags: ['Payroll'] } }, async (req) => orgOf(req).submissions.slice().reverse());
  app.get('/v1/payroll/runs', { ...read, schema: { tags: ['Payroll'], description: 'Completed TeamPay runs with rota-to-payroll variance.' } }, async (req) =>
    orgOf(req).payRuns.slice().reverse(),
  );

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
        org.payRuns.push({
          id: run.id,
          entityId: entity.id,
          employerId,
          periodStart: run.periodStart,
          periodEnd: run.periodEnd,
          receivedAt: new Date().toISOString(),
          variance,
        });
        audit(org, 'TeamPay', 'payroll.run_completed', { run: run.id, entityId: entity.id, variance: variance.variance });
      } else if (event.type === 'payroll.run.flagged') {
        audit(org, 'TeamPay', 'payroll.run_flagged', event.data);
      }
      org.processedWebhookIds.add(event.id);
      return { received: true };
    },
  );
}
