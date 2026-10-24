import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { weekDates } from '../../src/engine/time';
import type { TimeEntry } from '../../src/engine/types';
import { requireScope } from '../auth';
import { HttpError, orgOf, type AppContext } from '../context';
import { guard } from '../guard';
import { employerFor } from '../payrollEmployers';
import { siteWeekQuery, isoDate } from '../schemas';

// Deterministic jitter per shift so demos and tests are repeatable.
function jitter(seed: string, min: number, max: number) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return min + (Math.abs(h) % (max - min + 1));
}

/**
 * Demo-only routes, for organisations whose payroll runs on the TeamPay simulator: every demo
 * sandbox, and everyone when no TeamPay keys are configured. A customer on real TeamPay gets a
 * 404, so nobody can fake clocking or a pay run on live payroll.
 */
export function devRoutes(app: FastifyInstance, ctx: AppContext) {
  const simulated = async (req: FastifyRequest) => {
    if (!ctx.simulatorFor(req.principal.orgId)) throw new HttpError(404, 'not_found', 'Only available on the TeamPay simulator');
  };
  const write = { preHandler: [requireScope('*'), simulated] };

  // Who the demo can sign in as. Each has a dev-<id> key outside production. It lists everyone,
  // past the site rules, so it answers only those demo keys, never a session or a deployment.
  app.get('/v1/dev/people', { schema: { tags: ['Demo'] } }, async (req) => {
    const deployed = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';
    if (deployed || !/^dev-/.test(req.principal.key)) throw new HttpError(404, 'not_found', 'Not found');
    return orgOf(req).users.map((u) => ({ id: u.id, name: u.name, jobTitle: u.jobTitle, status: u.status }));
  });

  // A client who ran TeamPay before Preshift: everyone at the site not yet linked is put on the simulated
  // payroll as an existing record, unlinked. Every third differs the way real records do, so linking can be shown.
  app.post<{ Body: { siteId: string } }>(
    '/v1/dev/payroll-existing',
    {
      ...write,
      schema: {
        tags: ['Demo'],
        description: 'Puts a site\'s unlinked people on the simulated TeamPay as if they were there before Preshift, some with differences.',
        body: { type: 'object', required: ['siteId'], properties: { siteId: { type: 'string' } } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      guard(ctx, req, org).allow('payroll.send');
      const people = org.state.employees.filter((e) => e.siteId === req.body.siteId && !e.payrollId && e.status !== 'leaver');
      people.forEach((e, i) => {
        const twist = i % 3 === 1 ? 'rate' : i % 3 === 2 ? 'name' : null;
        ctx.simulatorFor(org.orgId)!.addExisting(employerFor(org, e.entityId, ctx.employers), {
          name: twist === 'name' ? e.name.replace(/^(\S+)/, (first) => `${first[0]}.`) : e.name,
          dateOfBirth: e.dateOfBirth,
          payBasis: e.payBasis,
          hourlyRate: e.payBasis === 'hourly' ? (twist === 'rate' ? Math.round((e.hourlyRate - 0.5) * 100) / 100 : e.hourlyRate) : undefined,
          annualSalary: e.payBasis === 'salaried' ? e.annualSalary : undefined,
          contractedHours: e.contractedHours,
        });
      });
      return { added: people.length };
    },
  );

  app.post<{ Body: { siteId: string; weekStart: string } }>(
    '/v1/dev/simulate-clocking',
    { ...write, schema: { tags: ['Demo'], description: 'Creates clock-in and clock-out records from the rota, with realistic drift.', body: siteWeekQuery } },
    async (req) => {
      const org = orgOf(req);
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
        description:
          "Has the TeamPay simulator run payroll for the week, once for each company that has sent hours, each under its " +
          'own employer, and send each signed webhook back to Preshift.',
        body: { type: 'object', required: ['weekStart'], properties: { weekStart: isoDate } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      guard(ctx, req, org).allow('payroll.send');
      await ctx.dispatcher.processOrg(org);
      const pending = org.outbox.filter((i) => i.status === 'pending').length;
      if (pending) throw new HttpError(409, 'outbox_pending', `${pending} changes are still waiting to reach TeamPay`);
      // The latest sent batch for each company this week.
      const latest = new Map<string, (typeof org.submissions)[number]>();
      for (const s of org.submissions) {
        if (s.periodStart === req.body.weekStart && s.status === 'sent') latest.set(s.entityId ?? org.state.entities[0]?.id ?? '', s);
      }
      if (latest.size === 0) throw new HttpError(409, 'no_hours_sent', 'Send this week\'s hours to TeamPay first');
      const webhooks = [...latest].map(([entityId, sent]) => {
        const item = org.outbox.find((i) => i.type === 'hours.submit' && i.payload.submissionId === sent.id);
        if (!item || item.type !== 'hours.submit') throw new HttpError(409, 'no_hours_sent', 'Send this week\'s hours to TeamPay first');
        const people = org.state.employees.filter((e) => e.entityId === entityId);
        return ctx.simulatorFor(org.orgId)!.runPayroll(sent.employerId!, sent.periodStart, sent.periodEnd, people, item.payload.batch);
      });
      // Each webhook is its own request with its own load and save, exactly as when TeamPay calls in.
      await ctx.store.save(org);
      for (const { body, signature } of webhooks) {
        const res = await app.inject({
          method: 'POST',
          url: `/v1/integrations/teampay/webhook/${org.orgId}`,
          headers: { 'content-type': 'application/json', 'x-teampay-signature': signature },
          payload: body,
        });
        if (res.statusCode !== 200) throw new HttpError(502, 'webhook_failed', res.body);
      }
      req.org = await ctx.store.load(org.orgId);
      const ids = new Set(webhooks.map((w) => w.run.id));
      return {
        runs: webhooks.map(({ run }) => ({ id: run.id, employerId: run.employerId, employees: run.employees.length })),
        payRuns: req.org.payRuns.filter((r) => ids.has(r.id)),
      };
    },
  );

}
