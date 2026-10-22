import type { FastifyInstance } from 'fastify';
import { markWeekPaid, markWeekUnpaid, troncSchemeProblems } from '../../src/engine/tronc';
import { weekDates, weekStart } from '../../src/engine/time';
import type { Dish, DishSales, Purchase, StockCount, TipsTaken, TroncScheme } from '../../src/engine/types';
import { requireScope } from '../auth';
import { HttpError, notFound, orgOf, type AppContext } from '../context';
import { actorName, guard, type Guard } from '../guard';
import { audit } from '../store';

/**
 * Feeds for the tronc and prime cost screens. Tips and cost of sales are money a site is
 * accountable for, so both follow labour cost: only those who see cost at a site see them.
 * Tips and cost of sales come from the organisation's state; a site's tronc scheme can be recorded here.
 */

/**
 * Recording a tronc scheme sets how every tip at the site becomes pay, so it sits with payroll:
 * whoever sends pay to payroll or approves pay, both behind an authenticator. Not the owner, who
 * holds neither by design, and not a GM, so the people whose labour cost the tips would cover
 * cannot steer them. For an independent scheme this records what the troncmaster decided.
 */
function allowTronc(g: Guard) {
  if (g.can('payroll.send') || g.can('pay.approve')) return;
  g.allow('payroll.send');
}

const DEPARTMENT_SHARE = { type: 'number', minimum: 0, maximum: 1 } as const;
const ISO_DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;
const SCHEME_FIELDS = ['troncmaster', 'independent', 'pointsPerHour', 'departmentShares', 'serviceCharge', 'policyPublishedOn', 'lastReviewedOn'] as const;

export function labourRoutes(app: FastifyInstance, ctx: AppContext) {
  const read = { preHandler: requireScope('rota:read') };
  const write = { preHandler: requireScope('rota:write') };

  app.get('/v1/tronc', { ...read, schema: { tags: ['Labour'], description: 'Tips taken and tronc schemes, at sites where the caller sees cost.' } }, async (req) => {
    const org = orgOf(req);
    const seen = guard(ctx, req, org).at('costs.view');
    return {
      tips: (org.state.tips ?? []).filter(seen) as TipsTaken[],
      troncSchemes: (org.state.troncSchemes ?? []).filter(seen) as TroncScheme[],
    };
  });

  app.put<{ Params: { siteId: string }; Body: Omit<TroncScheme, 'siteId' | 'updatedBy' | 'updatedAt'> }>(
    '/v1/tronc/schemes/:siteId',
    {
      ...write,
      schema: {
        tags: ['Labour'],
        description: "Records a site's tronc scheme, replacing the one in force. For payroll: payroll.send or pay.approve.",
        params: { type: 'object', required: ['siteId'], properties: { siteId: { type: 'string' } } },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['troncmaster', 'independent', 'pointsPerHour', 'serviceCharge'],
          properties: {
            troncmaster: { type: 'string', minLength: 1, maxLength: 120 },
            independent: { type: 'boolean' },
            pointsPerHour: { type: 'object', additionalProperties: { type: 'number', minimum: 0, maximum: 1000 } },
            departmentShares: { type: 'object', additionalProperties: false, properties: { FOH: DEPARTMENT_SHARE, BAR: DEPARTMENT_SHARE, BOH: DEPARTMENT_SHARE, MGMT: DEPARTMENT_SHARE } },
            serviceCharge: { type: 'string', enum: ['none', 'discretionary', 'mandatory'] },
            policyPublishedOn: ISO_DATE,
            lastReviewedOn: ISO_DATE,
          },
        },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const { siteId } = req.params;
      if (!org.state.sites.some((s) => s.id === siteId)) throw notFound(`Site ${siteId}`);
      const g = guard(ctx, req, org);
      allowTronc(g);
      const body = req.body;
      // An empty split means no split, rather than a pool shared between no departments.
      const departmentShares = body.departmentShares && Object.keys(body.departmentShares).length ? body.departmentShares : undefined;
      const scheme: TroncScheme = {
        siteId,
        troncmaster: body.troncmaster.trim(),
        independent: body.independent,
        pointsPerHour: body.pointsPerHour,
        ...(departmentShares ? { departmentShares } : {}),
        serviceCharge: body.serviceCharge,
        ...(body.policyPublishedOn ? { policyPublishedOn: body.policyPublishedOn } : {}),
        ...(body.lastReviewedOn ? { lastReviewedOn: body.lastReviewedOn } : {}),
        updatedBy: actorName(g),
        updatedAt: new Date().toISOString(),
      };
      const problems = troncSchemeProblems(scheme, org.state.roles, g.today);
      if (problems.length) throw new HttpError(422, 'invalid_scheme', 'The tronc scheme has problems to fix', problems);

      const before = (org.state.troncSchemes ?? []).find((s) => s.siteId === siteId);
      const fields = before ? SCHEME_FIELDS.filter((f) => JSON.stringify(before[f]) !== JSON.stringify(scheme[f])) : [...SCHEME_FIELDS];
      org.state.troncSchemes = [...(org.state.troncSchemes ?? []).filter((s) => s.siteId !== siteId), scheme];
      audit(org, actorName(g), 'tronc.scheme_saved', { siteId, fields, independent: scheme.independent });
      return scheme;
    },
  );

  // Payroll confirms the week's tips reached the team: what clears the Act's deadline on the Tronc
  // and Compliance risk screens. `undo` takes one payment marked in error back off, by its date,
  // leaving any other payment that week standing. Both are audited.
  app.post<{ Body: { siteId: string; weekStart: string; paidOn?: string; undo?: string } }>(
    '/v1/tronc/tips/paid',
    {
      ...write,
      schema: {
        tags: ['Labour'],
        description: "Marks a site's unpaid tips for one week as paid through payroll on paidOn, or takes the payment made on undo back off. One of the two. For payroll: payroll.send or pay.approve.",
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['siteId', 'weekStart'],
          properties: { siteId: { type: 'string' }, weekStart: ISO_DATE, paidOn: ISO_DATE, undo: ISO_DATE },
        },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const { siteId, weekStart: week, paidOn, undo } = req.body;
      if (!paidOn === !undo) throw new HttpError(400, 'invalid_request', 'Give either paidOn, to mark the week paid, or undo, to take one payment back off.');
      if (!org.state.sites.some((s) => s.id === siteId)) throw notFound(`Site ${siteId}`);
      const g = guard(ctx, req, org);
      allowTronc(g);
      if (weekStart(week) !== week) throw new HttpError(400, 'invalid_week', 'weekStart must be the Monday the week starts on.');
      if (paidOn && paidOn > g.today) throw new HttpError(422, 'future_date', 'Tips cannot be marked paid on a date still to come.');

      const days = new Set(weekDates(week));
      const inWeek = (t: TipsTaken) => t.siteId === siteId && days.has(t.date);
      const tips = org.state.tips ?? [];
      const next = paidOn ? markWeekPaid(tips, siteId, week, paidOn) : markWeekUnpaid(tips, siteId, week, undo!);
      const changed = next.filter((t, i) => t !== tips[i]);
      if (changed.length === 0) {
        throw new HttpError(409, 'nothing_to_mark', paidOn ? 'No unpaid tips that week had been taken by that date.' : 'No tips that week were marked paid on that date.');
      }
      org.state.tips = next;
      const amount = Math.round(changed.reduce((s, t) => s + t.amount, 0) * 100) / 100;
      audit(org, actorName(g), paidOn ? 'tronc.tips_paid' : 'tronc.tips_unpaid', { siteId, weekStart: week, count: changed.length, paidOn: paidOn ?? undo });
      return { count: changed.length, amount, tips: next.filter(inWeek) };
    },
  );

  app.get('/v1/prime', { ...read, schema: { tags: ['Labour'], description: 'Menu, dish sales, purchases and stock counts, at sites where the caller sees cost.' } }, async (req) => {
    const org = orgOf(req);
    const seen = guard(ctx, req, org).at('costs.view');
    return {
      dishes: (org.state.dishes ?? []).filter(seen) as Dish[],
      dishSales: (org.state.dishSales ?? []).filter(seen) as DishSales[],
      purchases: (org.state.purchases ?? []).filter(seen) as Purchase[],
      stockCounts: (org.state.stockCounts ?? []).filter(seen) as StockCount[],
    };
  });
}
