import type { FastifyInstance } from 'fastify';
import { requireScope } from '../auth';
import { londonToday, orgOf, type AppContext } from '../context';
import { planFor } from '../golive';
import { guard } from '../guard';

// Getting started: the organisation's go-live plan (src/engine/golive.ts), for whoever runs its
// settings. Read only: every step is proved by the organisation's own data, so there is nothing to tick.

export function goLiveRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get(
    '/v1/golive',
    {
      preHandler: requireScope('rota:read'),
      schema: {
        tags: ['Set-up'],
        description:
          "The organisation's go-live plan: each step from the authenticator to the first published rota, takings and clocking, " +
          'with the day it is due, whether it is done, and the next one. Counts only. Needs settings.manage.',
      },
    },
    async (req) => {
      const org = orgOf(req);
      guard(ctx, req, org).allow('settings.manage');
      const today = londonToday(ctx);
      const hadLive = !!org.goLive?.liveOn;
      const plan = await planFor(ctx.store, org, today, ctx.now());
      // The day it went live is kept the first time it is seen, from a read as from the morning run.
      if (!hadLive && org.goLive?.liveOn) req.orgTouched = true;
      return plan;
    },
  );
}
