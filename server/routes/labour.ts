import type { FastifyInstance } from 'fastify';
import type { Dish, DishSales, Purchase, StockCount, TipsTaken, TroncScheme } from '../../src/engine/types';
import { requireScope } from '../auth';
import { orgOf, type AppContext } from '../context';
import { guard } from '../guard';

/**
 * Read-only feeds for the tronc and prime cost screens. Tips and cost of sales are money a site
 * is accountable for, so both follow labour cost: only those who see cost at a site see them.
 * Nothing writes these yet; they come from the organisation's state.
 */
export function labourRoutes(app: FastifyInstance, ctx: AppContext) {
  const read = { preHandler: requireScope('rota:read') };

  app.get('/v1/tronc', { ...read, schema: { tags: ['Labour'], description: 'Tips taken and tronc schemes, at sites where the caller sees cost.' } }, async (req) => {
    const org = orgOf(req);
    const seen = guard(ctx, req, org).at('costs.view');
    return {
      tips: (org.state.tips ?? []).filter(seen) as TipsTaken[],
      troncSchemes: (org.state.troncSchemes ?? []).filter(seen) as TroncScheme[],
    };
  });

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
