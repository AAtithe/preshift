import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { addDays, weekDates } from '../../src/engine/time';
import type { TimeEntry } from '../../src/engine/types';
import { requireScope } from '../auth';
import { HttpError, orgOf, type AppContext } from '../context';
import { guard } from '../guard';
import { siteWeekQuery, isoDate } from '../schemas';

// Deterministic jitter per shift so demos and tests are repeatable.
function jitter(seed: string, min: number, max: number) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return min + (Math.abs(h) % (max - min + 1));
}

/** Demo-only routes, registered only when running against the TeamPay simulator. */
export function devRoutes(app: FastifyInstance, ctx: AppContext) {
  const simulator = ctx.simulator;
  if (!simulator) return;
  const write = { preHandler: requireScope('*') };

  // Who the demo can sign in as. Each has a dev-<id> key outside production.
  app.get('/v1/dev/people', { schema: { tags: ['Demo'] } }, async (req) =>
    orgOf(ctx, req).users.map((u) => ({ id: u.id, name: u.name, jobTitle: u.jobTitle, status: u.status })),
  );

  app.post<{ Body: { siteId: string; weekStart: string } }>(
    '/v1/dev/simulate-clocking',
    { ...write, schema: { tags: ['Demo'], description: 'Creates clock-in and clock-out records from the rota, with realistic drift.', body: siteWeekQuery } },
    async (req) => {
      const org = orgOf(ctx, req);
      guard(ctx, req, org).allow('time.record', req.body.siteId);
      const dates = weekDates(req.body.weekStart);
      const shifts = org.state.shifts.filter((s) => s.siteId === req.body.siteId && dates.includes(s.date));
      let created = 0;
      for (const s of shifts) {
        if (org.timeEntries.some((t) => t.shiftId === s.id)) continue;
        const entry: TimeEntry = {
          id: `te_${randomUUID().slice(0, 12)}`,
          employeeId: s.employeeId,
          siteId: s.siteId,
          roleId: s.roleId,
          shiftId: s.id,
          date: s.date,
          clockIn: s.startMinute + jitter(`${s.id}in`, -8, 12),
          clockOut: s.endMinute + jitter(`${s.id}out`, -10, 35),
          breakMinutes: s.breakMinutes,
          status: 'submitted',
          source: 'clock',
        };
        org.timeEntries.push(entry);
        created++;
      }
      return { created };
    },
  );

  app.post<{ Body: { weekStart: string } }>(
    '/v1/dev/teampay/run-payroll',
    {
      ...write,
      schema: {
        tags: ['Demo'],
        description: 'Has the TeamPay simulator run payroll for the week and send its signed webhook back to Preshift.',
        body: { type: 'object', required: ['weekStart'], properties: { weekStart: isoDate } },
      },
    },
    async (req) => {
      const org = orgOf(ctx, req);
      guard(ctx, req, org).allow('payroll.send');
      await ctx.dispatcher.processDue();
      const pending = org.outbox.filter((i) => i.status === 'pending').length;
      if (pending) throw new HttpError(409, 'outbox_pending', `${pending} changes are still waiting to reach TeamPay`);
      const { run, body, signature } = simulator.runPayroll(req.body.weekStart, addDays(req.body.weekStart, 6), org.state.employees);
      const res = await app.inject({
        method: 'POST',
        url: `/v1/integrations/teampay/webhook/${org.orgId}`,
        headers: { 'content-type': 'application/json', 'x-teampay-signature': signature },
        payload: body,
      });
      if (res.statusCode !== 200) throw new HttpError(502, 'webhook_failed', res.body);
      return { run: { id: run.id, employees: run.employees.length }, payRun: org.payRuns.at(-1) };
    },
  );
}
