import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { counted, drawProblem, earnedPayPosition, settingsOf, settingsProblems } from '../../src/engine/earnedPay';
import type { EarnedPayDraw, EarnedPaySettings } from '../../src/engine/types';
import { HttpError, londonParts, notFound, orgOf, type AppContext } from '../context';
import { actorName, guard } from '../guard';
import { enqueue } from '../outbox';
import { audit, type OrgData } from '../store';
import { requireStaff } from './staff';

const drawsOf = (org: OrgData) => (org.earnedPay ??= { draws: [] }).draws;

/** A draw as the person sees it, and as finance sees it. */
const view = (d: EarnedPayDraw) => ({ id: d.id, amount: d.amount, requestedAt: d.requestedAt, payDate: d.payDate, status: d.status, ...(d.failure ? { failure: d.failure } : {}) });

/**
 * Earned pay on demand in the staff app: what the person may draw today and how that is worked out,
 * and a draw. Each draw is checked again on the server, paid through payroll and taken off payday.
 */
export function earnedPayStaffRoutes(app: FastifyInstance, ctx: AppContext) {
  const today = () => londonParts(ctx.now()).date;

  app.get('/v1/staff/earned-pay', { schema: { hide: true } }, async (req) => {
    const { org, employee } = await requireStaff(req, ctx.store);
    const entity = org.state.entities.find((e) => e.id === employee.entityId);
    const p = earnedPayPosition(employee, entity, org.timeEntries, org.earnedPay?.draws ?? [], today());
    return {
      on: p.settings.on,
      allowed: p.allowed,
      reason: p.reason ?? null,
      available: p.available,
      earnedGross: p.earnedGross,
      earnedNet: p.earnedNet,
      drawn: p.drawn,
      drawsLeft: p.drawsLeft,
      minDraw: p.settings.minDraw,
      sharePct: p.settings.sharePct,
      period: { start: p.period.periodStart, end: p.period.periodEnd, payDate: p.period.payDate },
      draws: (org.earnedPay?.draws ?? []).filter((d) => d.employeeId === employee.id).slice(-12).reverse().map(view),
    };
  });

  app.post<{ Body: { amount: number } }>(
    '/v1/staff/earned-pay',
    { schema: { hide: true, body: { type: 'object', required: ['amount'], properties: { amount: { type: 'integer', minimum: 1, maximum: 5000 } }, additionalProperties: false } } },
    async (req) => {
      const { org, employee } = await requireStaff(req, ctx.store);
      const entity = org.state.entities.find((e) => e.id === employee.entityId);
      const p = earnedPayPosition(employee, entity, org.timeEntries, org.earnedPay?.draws ?? [], today());
      const problem = drawProblem(p, req.body.amount);
      if (problem) throw new HttpError(422, 'draw_refused', problem);
      const draw: EarnedPayDraw = {
        id: `ewa_${randomUUID().slice(0, 12)}`,
        employeeId: employee.id,
        entityId: employee.entityId,
        scheduleId: p.period.scheduleId,
        periodStart: p.period.periodStart,
        periodEnd: p.period.periodEnd,
        payDate: p.period.payDate,
        amount: req.body.amount,
        requestedAt: ctx.now().toISOString(),
        status: 'requested',
      };
      drawsOf(org).push(draw);
      enqueue(org, { type: 'earned_pay.pay', payload: { drawId: draw.id }, idempotencyKey: `ewa:${org.orgId}:${draw.id}` });
      audit(org, `staff:${employee.id}`, 'earned_pay.requested', { drawId: draw.id, employeeId: employee.id, amount: draw.amount });
      await ctx.store.save(org);
      return view(draw);
    },
  );
}

/** Finance's side: who has drawn what this period, the company's rules, and cancelling a draw not yet paid. */
export function earnedPayRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get<{ Querystring: { entityId?: string } }>(
    '/v1/earned-pay',
    { schema: { tags: ['Payroll'], description: 'Earned pay drawn early by staff, newest first, with each company\'s rules. Needs payroll.view across the company.', querystring: { type: 'object', properties: { entityId: { type: 'string' } } } } },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      const entities = org.state.entities.filter((e) => (!req.query.entityId || e.id === req.query.entityId) && org.state.sites.filter((s) => s.entityId === e.id).every((s) => g.can('payroll.view', s.id)));
      if (!entities.length) g.allow('payroll.view');
      const ids = new Set(entities.map((e) => e.id));
      const name = (id: string) => org.state.employees.find((e) => e.id === id)?.name ?? id;
      const draws = (org.earnedPay?.draws ?? []).filter((d) => ids.has(d.entityId));
      return {
        companies: entities.map((e) => {
          const mine = draws.filter((d) => d.entityId === e.id && counted(d));
          return { entityId: e.id, name: e.name, settings: settingsOf(e), outstanding: Math.round(mine.filter((d) => !d.deductedIn).reduce((s, d) => s + d.amount, 0) * 100) / 100 };
        }),
        draws: draws.slice(-500).reverse().map((d) => ({ ...view(d), employeeId: d.employeeId, name: name(d.employeeId), entityId: d.entityId, deductedIn: d.deductedIn ?? null })),
      };
    },
  );

  // Moving money is payroll's to switch on: the same right as sending hours to TeamPay.
  app.put<{ Params: { id: string }; Body: EarnedPaySettings }>(
    '/v1/entities/:id/earned-pay',
    {
      schema: {
        hide: true,
        body: {
          type: 'object',
          required: ['on', 'sharePct', 'minDraw', 'maxDrawsPerPeriod'],
          properties: { on: { type: 'boolean' }, sharePct: { type: 'number' }, minDraw: { type: 'number' }, maxDrawsPerPeriod: { type: 'integer' } },
          additionalProperties: false,
        },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      const entity = org.state.entities.find((e) => e.id === req.params.id);
      if (!entity) throw notFound(`Company ${req.params.id}`);
      for (const site of org.state.sites.filter((s) => s.entityId === entity.id)) g.allow('payroll.send', site.id);
      if (!req.principal.email && !req.principal.userId) throw new HttpError(403, 'forbidden', 'Early pay is switched on by a person, not a system key.');
      const problems = settingsProblems(req.body);
      if (problems.length) throw new HttpError(422, 'invalid_settings', problems.join(' '));
      const before = settingsOf(entity);
      entity.earnedPay = { on: req.body.on, sharePct: req.body.sharePct, minDraw: req.body.minDraw, maxDrawsPerPeriod: req.body.maxDrawsPerPeriod };
      audit(org, actorName(g), 'earned_pay.settings', { entityId: entity.id, before, after: entity.earnedPay });
      return settingsOf(entity);
    },
  );

  app.post<{ Params: { id: string } }>('/v1/earned-pay/:id/cancel', { schema: { hide: true } }, async (req) => {
    const org = orgOf(req);
    const g = guard(ctx, req, org);
    const draw = org.earnedPay?.draws.find((d) => d.id === req.params.id);
    if (!draw) throw notFound('Draw');
    for (const site of org.state.sites.filter((s) => s.entityId === draw.entityId)) g.allow('payroll.send', site.id);
    // Once payroll has it, it may already be in the person's bank: only payroll can reverse it.
    const item = org.outbox.find((i) => i.type === 'earned_pay.pay' && i.payload.drawId === draw.id);
    if (draw.status !== 'requested' || (item && item.status !== 'pending') || (item && item.attempts > 0)) throw new HttpError(409, 'already_sent', 'This draw has gone to payroll and can no longer be cancelled here.');
    // The queued payment finds the draw cancelled and sends nothing.
    draw.status = 'cancelled';
    audit(org, actorName(g), 'earned_pay.cancelled', { drawId: draw.id, employeeId: draw.employeeId, amount: draw.amount });
    return view(draw);
  });
}
