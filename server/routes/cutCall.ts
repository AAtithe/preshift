import type { FastifyInstance } from 'fastify';
import { namesOf, shiftLine } from '../../src/engine/requests';
import { formatMinute } from '../../src/engine/time';
import { requireScope } from '../auth';
import { HttpError, notFound, orgOf, type AppContext } from '../context';
import { siteCall, tradingNow } from '../cutCall';
import { actorName, guard } from '../guard';
import { notify, syncTold } from '../notify';
import { audit } from '../store';

export function cutCallRoutes(app: FastifyInstance, ctx: AppContext) {
  const read = { preHandler: requireScope('rota:read') };
  const write = { preHandler: requireScope('rota:write') };

  app.get<{ Querystring: { siteId: string } }>(
    '/v1/cut-call',
    {
      ...read,
      schema: {
        tags: ['Rota'],
        description:
          "Today's cut call and labour flash for a site, now: trading pace against forecast, the day reforecast, who to send home with the saving on " +
          'their whole week (short notice pay deducted once the Employment Rights Act measure has started), hours short, and labour so far and by close.',
        querystring: { type: 'object', required: ['siteId'], properties: { siteId: { type: 'string' } } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      if (!org.state.sites.some((s) => s.id === req.query.siteId)) throw notFound(`Site ${req.query.siteId}`);
      const g = guard(ctx, req, org);
      // Savings and labour are pay.
      g.allow('costs.view', req.query.siteId);
      return siteCall(org, req.query.siteId, ctx.now());
    },
  );

  app.post<{ Body: { siteId: string; cuts: { shiftId: string; endMinute: number; breakMinutes: number }[] } }>(
    '/v1/cut-call/apply',
    {
      ...write,
      schema: {
        tags: ['Rota'],
        description:
          "Applies early finishes from today's cut call. Each shift keeps its published state and the person is told at once, since the change is for " +
          'today. A cut to a published shift for a covered worker is logged as short notice like any other change.',
        body: {
          type: 'object',
          required: ['siteId', 'cuts'],
          additionalProperties: false,
          properties: {
            siteId: { type: 'string' },
            cuts: {
              type: 'array',
              minItems: 1,
              maxItems: 50,
              items: {
                type: 'object',
                required: ['shiftId', 'endMinute', 'breakMinutes'],
                additionalProperties: false,
                properties: { shiftId: { type: 'string' }, endMinute: { type: 'integer', minimum: 0, maximum: 2880 }, breakMinutes: { type: 'integer', minimum: 0 } },
              },
            },
          },
        },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const { siteId, cuts } = req.body;
      const g = guard(ctx, req, org);
      g.allow('rota.edit', siteId);
      const at = ctx.now();
      // Today's trading day: after midnight at a late site, still the night before.
      const now = tradingNow(org, siteId, at);
      const names = namesOf(org.state);
      // All checked before any change, so a bad cut leaves the rest untouched.
      const plan = cuts.map((c) => {
        const shift = org.state.shifts.find((s) => s.id === c.shiftId);
        if (!shift) throw notFound(`Shift ${c.shiftId}`);
        if (shift.siteId !== siteId || shift.date !== now.date) throw new HttpError(422, 'not_today', `${shiftLine(shift, names)} is not today at this site.`);
        if (c.endMinute >= shift.endMinute) throw new HttpError(422, 'not_a_cut', `${shiftLine(shift, names)} would not finish any earlier.`);
        if (c.endMinute < now.minute) throw new HttpError(422, 'in_the_past', `${shiftLine(shift, names)} cannot finish before now.`);
        if (c.breakMinutes > Math.max(0, c.endMinute - shift.startMinute)) throw new HttpError(422, 'invalid_break', 'The break is longer than the shift.');
        return { shift, next: { ...shift, endMinute: Math.max(c.endMinute, shift.startMinute), breakMinutes: c.breakMinutes } };
      });
      const told: string[] = [];
      for (const { shift, next } of plan) {
        org.state.shifts = org.state.shifts.map((s) => (s.id === shift.id ? next : s));
        if (shift.published) {
          const standDown = next.endMinute <= shift.startMinute;
          notify(
            org,
            shift.employeeId,
            'rota_changed',
            standDown ? 'You are not needed today' : `You can finish at ${formatMinute(next.endMinute)} today`,
            standDown
              ? `${shiftLine(shift, names)} is no longer needed. Trading is quieter than forecast.`
              : `${shiftLine(shift, names)} now finishes at ${formatMinute(next.endMinute)}. Trading is quieter than forecast.`,
            at,
          );
          told.push(shift.employeeId);
        }
      }
      if (told.length) syncTold(org, told, plan.map((p) => p.shift));
      audit(org, actorName(g), 'cutcall.applied', { siteId, shifts: plan.map((p) => p.shift.id), minutes: plan.reduce((m, p) => m + (p.shift.endMinute - p.next.endMinute), 0) });
      return { applied: plan.map((p) => p.next), told: told.length };
    },
  );
}
