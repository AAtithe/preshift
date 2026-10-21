import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { weekCost } from '../../src/engine/cost';
import { rotaJournal, toXeroCsv } from '../../src/engine/journal';
import { addDays } from '../../src/engine/time';
import { entriesAsShifts, payrollHours, payrollVariance } from '../../src/engine/timesheet';
import { requireScope } from '../auth';
import { HttpError, kick, notFound, orgOf, type AppContext } from '../context';
import { enqueue } from '../outbox';
import { idParam, isoDate } from '../schemas';
import { audit, type OrgData } from '../store';

function approvedIn(org: OrgData, from: string, to: string) {
  return org.timeEntries.filter((t) => t.status === 'approved' && t.date >= from && t.date <= to);
}

/** The labour basis for a week: approved actuals once there are any, otherwise the rota. */
export function labourBasis(org: OrgData, weekStart: string, basis: 'rota' | 'actual' | 'auto' = 'auto') {
  const actual = approvedIn(org, weekStart, addDays(weekStart, 6));
  const useActual = basis === 'actual' || (basis === 'auto' && actual.length > 0);
  return {
    basis: useActual ? ('actual' as const) : ('rota' as const),
    state: useActual ? { ...org.state, shifts: entriesAsShifts(actual) } : org.state,
  };
}

export function payrollRoutes(app: FastifyInstance, ctx: AppContext) {
  const read = { preHandler: requireScope('rota:read') };
  const write = { preHandler: requireScope('payroll:write') };

  app.get('/v1/integrations/payroll', { ...read, schema: { tags: ['Payroll'], description: 'Payroll connection health.' } }, async (req) => {
    const org = orgOf(req);
    const active = org.state.employees.filter((e) => e.status !== 'leaver');
    return {
      provider: ctx.providerFor(org.orgId).name,
      employees: { total: active.length, synced: active.filter((e) => e.payrollId).length },
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

  app.post<{ Body: { weekStart: string } }>(
    '/v1/payroll/submissions',
    {
      ...write,
      schema: {
        tags: ['Payroll'],
        description:
          'Sends the week\'s approved hours to TeamPay. Every entry must be approved or rejected first. ' +
          'Sending again for the same week supersedes the earlier batch.',
        body: { type: 'object', required: ['weekStart'], properties: { weekStart: isoDate } },
      },
    },
    async (req, reply) => {
      const org = orgOf(req);
      const periodStart = req.body.weekStart;
      const periodEnd = addDays(periodStart, 6);
      const inPeriod = org.timeEntries.filter((t) => t.date >= periodStart && t.date <= periodEnd);
      const unapproved = inPeriod.filter((t) => t.status === 'open' || t.status === 'submitted');
      if (unapproved.length) {
        throw new HttpError(409, 'unapproved_time', `${unapproved.length} time entries still need approving or rejecting`, unapproved.map((t) => t.id));
      }
      const batch = payrollHours(org.state.employees, inPeriod, periodStart, periodEnd);
      if (batch.lines.length === 0) throw new HttpError(422, 'no_hours', 'No approved hours in this period');

      // Anyone not yet in payroll is set up first; the outbox delivers in order.
      const queued = new Set(org.outbox.filter((i) => i.status === 'pending' && i.type === 'employee.upsert').map((i) => (i.payload as { employeeId: string }).employeeId));
      for (const line of batch.lines) {
        const e = org.state.employees.find((x) => x.id === line.employeeId)!;
        if (!e.payrollId && !queued.has(e.id)) {
          enqueue(org, { type: 'employee.upsert', payload: { employeeId: e.id }, idempotencyKey: `emp:${e.id}:initial` });
          queued.add(e.id);
        }
      }

      const previous = org.submissions.filter((s) => s.periodStart === periodStart && s.status !== 'superseded');
      for (const p of previous) p.status = 'superseded';
      const version = org.submissions.filter((s) => s.periodStart === periodStart).length + 1;
      const { state } = labourBasis(org, periodStart, 'actual');
      const cost = weekCost(state, periodStart);
      const submission = {
        id: `sub_${randomUUID().slice(0, 12)}`,
        periodStart,
        periodEnd,
        version,
        status: 'queued' as const,
        totalHours: batch.totalHours,
        lineCount: batch.lines.length,
        createdAt: new Date().toISOString(),
        createdBy: req.principal.name,
        accrued: Object.fromEntries([...cost.employees].map(([id, c]) => [id, c.total])),
      };
      org.submissions.push(submission);
      enqueue(org, {
        type: 'hours.submit',
        payload: { submissionId: submission.id, batch },
        idempotencyKey: `hours:${org.orgId}:${periodStart}:v${version}`,
      });
      audit(org, req.principal.name, 'payroll.hours_submitted', { id: submission.id, hours: batch.totalHours, version });
      await kick(ctx, org);
      return reply.code(202).send(submission);
    },
  );

  app.get('/v1/payroll/submissions', { ...read, schema: { tags: ['Payroll'] } }, async (req) => orgOf(req).submissions.slice().reverse());
  app.get('/v1/payroll/runs', { ...read, schema: { tags: ['Payroll'], description: 'Completed TeamPay runs with rota-to-payroll variance.' } }, async (req) =>
    orgOf(req).payRuns.slice().reverse(),
  );

  app.get<{ Querystring: { weekStart: string; basis?: 'rota' | 'actual' | 'auto'; format?: 'json' | 'xero-csv' } }>(
    '/v1/journal',
    {
      ...read,
      schema: {
        tags: ['Finance'],
        description: 'Labour accrual journal by role nominal and site. Basis is approved actuals once there are any, otherwise the rota.',
        querystring: {
          type: 'object',
          required: ['weekStart'],
          properties: {
            weekStart: isoDate,
            basis: { type: 'string', enum: ['rota', 'actual', 'auto'], default: 'auto' },
            format: { type: 'string', enum: ['json', 'xero-csv'], default: 'json' },
          },
        },
      },
    },
    async (req, reply) => {
      const org = orgOf(req);
      const { basis, state } = labourBasis(org, req.query.weekStart, req.query.basis);
      const lines = rotaJournal(state, req.query.weekStart);
      if (req.query.format === 'xero-csv') {
        return reply
          .header('content-type', 'text/csv; charset=utf-8')
          .header('content-disposition', `attachment; filename="preshift-journal-${req.query.weekStart}.csv"`)
          .send(toXeroCsv(lines));
      }
      return { basis, lines };
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
        const run = await provider.getPayRun(event.data.pay_run_id);
        const submission = org.submissions
          .filter((s) => s.periodStart === run.periodStart && s.status === 'sent')
          .at(-1);
        const accrued = new Map(Object.entries(submission?.accrued ?? {}));
        const variance = payrollVariance(accrued, run.employees);
        org.payRuns.push({ id: run.id, periodStart: run.periodStart, periodEnd: run.periodEnd, receivedAt: new Date().toISOString(), variance });
        audit(org, 'TeamPay', 'payroll.run_completed', { run: run.id, variance: variance.variance });
      } else if (event.type === 'payroll.run.flagged') {
        audit(org, 'TeamPay', 'payroll.run_flagged', event.data);
      }
      org.processedWebhookIds.add(event.id);
      return { received: true };
    },
  );
}
