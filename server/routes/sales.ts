import type { FastifyInstance, FastifyRequest } from 'fastify';
import { forecastFromHistory, pruneBefore, replaceDays, spendPerHead, upsertHourSales } from '../../src/engine/sales';
import { addDays, daysBetween, toISODate, weekDates } from '../../src/engine/time';
import type { HourSales } from '../../src/engine/types';
import { requireAdmin, requireScope } from '../auth';
import { HttpError, londonParts, notFound, orgOf, type AppContext } from '../context';
import { bucketSales } from '../integrations/epos/aggregate';
import { DemoTill } from '../integrations/epos/demo';
import { EposError, type EposProvider } from '../integrations/epos/provider';
import { SquareProvider } from '../integrations/epos/square';
import { isoDate } from '../schemas';
import { audit, type EposConfig, type OrgData } from '../store';

/** Till history kept: enough for a six week forecast plus the weeks being compared against it. */
export const KEEP_DAYS = 70;
/** The most one sync reads, so a request stays well inside a serverless time limit. */
const MAX_SYNC_DAYS = 31;

export const eposTokenSetting = (orgId: string) => `epos_token:${orgId}`;

const today = () => londonParts(new Date()).date;

/** The instant a UK calendar date starts: midnight in London, GMT or BST. */
export function londonMidnight(date: string): Date {
  const utc = Date.parse(`${date}T00:00:00Z`);
  return new Date(utc - londonParts(new Date(utc)).minute * 60_000);
}

async function providerFor(ctx: AppContext, org: OrgData, config = org.epos): Promise<EposProvider | null> {
  if (!config) return null;
  if (config.provider === 'demo') return ctx.epos.demoAllowed ? new DemoTill() : null;
  const token = await ctx.store.getSetting(eposTokenSetting(org.orgId));
  return token ? new SquareProvider({ accessToken: token, environment: config.environment ?? 'production', fetchImpl: ctx.epos.fetchImpl }) : null;
}

/** Reads the till for whole UK days [from, to] and replaces what is held for those days. */
export async function syncTill(ctx: AppContext, org: OrgData, from: string, to: string) {
  const config = org.epos;
  const provider = await providerFor(ctx, org);
  if (!config || !provider) throw new HttpError(409, 'not_connected', 'No till is connected.');
  const mapped = Object.entries(config.locations).filter(([siteId]) => org.state.sites.some((s) => s.id === siteId));
  if (mapped.length === 0) throw new HttpError(409, 'no_sites_mapped', 'Match at least one site to a till location first.');
  const siteOf = new Map(mapped.map(([siteId, locationId]) => [locationId, siteId]));
  try {
    const bills = await provider.closedSales([...siteOf.keys()], londonMidnight(from), londonMidnight(addDays(from, daysBetween(from, to) + 1)));
    const hours = bucketSales(bills, (id) => siteOf.get(id), config.provider);
    const dates = Array.from({ length: daysBetween(from, to) + 1 }, (_, i) => addDays(from, i));
    org.salesActuals = pruneBefore(
      replaceDays(org.salesActuals, hours.filter((h) => dates.includes(h.date)), mapped.map(([siteId]) => siteId), dates),
      addDays(today(), -KEEP_DAYS),
    );
    config.lastSync = { at: new Date().toISOString(), from, to, bills: bills.length, hours: hours.length };
    delete config.lastError;
    return config.lastSync;
  } catch (err) {
    const message = err instanceof EposError ? err.message : 'The till sync failed.';
    config.lastError = { at: new Date().toISOString(), message };
    throw new HttpError(502, 'till_error', message);
  }
}

/** The scheduled run: yesterday and today for every organisation with a till, so late-closed bills are caught. */
export async function syncAllTills(ctx: AppContext) {
  let synced = 0;
  let failed = 0;
  for (const orgId of await ctx.store.orgIds()) {
    const org = await ctx.store.load(orgId);
    if (!org.epos || Object.keys(org.epos.locations).length === 0) continue;
    let ok = true;
    try {
      await syncTill(ctx, org, addDays(today(), -1), today());
    } catch {
      ok = false; // Recorded on the organisation as lastError, which the Integrations page shows.
    }
    try {
      await ctx.store.save(org);
    } catch {
      ok = false; // Someone changed the organisation meanwhile; tomorrow's run, or Sync now, reads these days again.
    }
    if (ok) synced++;
    else failed++;
  }
  return { synced, failed };
}

function status(ctx: AppContext, org: OrgData, connected: boolean) {
  const config = org.epos;
  return {
    provider: config?.provider ?? null,
    providerName: config ? (config.provider === 'demo' ? 'Demo till' : 'Square') : null,
    environment: config?.environment ?? null,
    connected,
    demoAvailable: ctx.epos.demoAllowed,
    lastSync: config?.lastSync ?? null,
    lastError: config?.lastError ?? null,
    sites: org.state.sites.map((site) => {
      const held = org.salesActuals.filter((r) => r.siteId === site.id);
      const latest = held.reduce<HourSales | null>((b, r) => (!b || r.date > b.date || (r.date === b.date && r.hour > b.hour) ? r : b), null);
      return {
        siteId: site.id,
        name: site.name,
        locationId: config?.locations[site.id] ?? null,
        daysHeld: new Set(held.map((r) => r.date)).size,
        latest: latest ? { date: latest.date, hour: latest.hour, source: latest.source } : null,
      };
    }),
  };
}

const salesRow = {
  type: 'object',
  required: ['siteId', 'date', 'hour', 'sales'],
  properties: {
    siteId: { type: 'string' },
    date: isoDate,
    hour: { type: 'integer', minimum: 0, maximum: 23 },
    sales: { type: 'number' },
    covers: { type: 'integer', minimum: 0 },
    transactions: { type: 'integer', minimum: 0 },
  },
} as const;

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function salesRoutes(app: FastifyInstance, ctx: AppContext) {
  const read = { preHandler: requireScope('rota:read') };
  const write = { preHandler: requireScope('sales:write') };
  const admin = { preHandler: requireAdmin };
  const actor = (req: FastifyRequest) => req.principal.user?.email ?? req.principal.name;
  const tags = ['Sales'];

  app.get('/v1/integrations/epos', { ...read, schema: { tags, description: 'Till connection, the location each site is matched to, and the history held.' } }, async (req) => {
    const org = orgOf(req);
    return status(ctx, org, !!(await providerFor(ctx, org)));
  });

  // Connecting checks the token against the till straight away, so a wrong one is refused here and not at 3am.
  app.put<{ Body: { provider: 'square' | 'demo'; accessToken?: string; environment?: 'production' | 'sandbox' } }>(
    '/v1/integrations/epos',
    {
      ...admin,
      schema: {
        tags,
        description: 'Connect the till: Square with an access token, or the demo till on a demo system.',
        body: {
          type: 'object',
          required: ['provider'],
          properties: {
            provider: { type: 'string', enum: ['square', 'demo'] },
            accessToken: { type: 'string', maxLength: 500 },
            environment: { type: 'string', enum: ['production', 'sandbox'] },
          },
        },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const { provider } = req.body;
      if (provider === 'demo' && !ctx.epos.demoAllowed) throw new HttpError(400, 'demo_unavailable', 'The demo till is only offered on a demo system.');
      const token = req.body.accessToken?.trim();
      if (provider === 'square' && !token) throw new HttpError(400, 'invalid_token', 'Paste the Square access token.');
      const config: EposConfig = { provider, environment: provider === 'square' ? req.body.environment ?? 'production' : undefined, locations: {} };
      const till = provider === 'demo' ? new DemoTill() : new SquareProvider({ accessToken: token!, environment: config.environment!, fetchImpl: ctx.epos.fetchImpl });
      let locations;
      try {
        locations = await till.listLocations();
      } catch (err) {
        throw new HttpError(400, 'till_refused', err instanceof EposError ? err.message : 'Could not reach the till.');
      }
      // Match sites to locations by name where it is unambiguous; anything else is left for a person to pick.
      for (const site of org.state.sites) {
        const hits = locations.filter((l) => l.active && (words(l.name).includes(words(site.name)) || words(site.name).includes(words(l.name))));
        if (hits.length === 1) config.locations[site.id] = hits[0].id;
      }
      await ctx.store.setSetting(eposTokenSetting(org.orgId), provider === 'square' ? token! : null);
      org.epos = config;
      audit(org, actor(req), 'epos.connected', { provider, environment: config.environment, matched: Object.keys(config.locations).length });
      return status(ctx, org, true);
    },
  );

  // Disconnecting keeps the history already imported: it is the business's own sales record.
  app.delete('/v1/integrations/epos', { ...admin, schema: { tags, description: 'Disconnect the till. Sales already imported are kept.' } }, async (req) => {
    const org = orgOf(req);
    await ctx.store.setSetting(eposTokenSetting(org.orgId), null);
    delete org.epos;
    audit(org, actor(req), 'epos.disconnected');
    return status(ctx, org, false);
  });

  app.get('/v1/integrations/epos/locations', { ...read, schema: { tags, description: 'Trading locations in the connected till.' } }, async (req) => {
    const provider = await providerFor(ctx, orgOf(req));
    if (!provider) throw new HttpError(409, 'not_connected', 'No till is connected.');
    try {
      return await provider.listLocations();
    } catch (err) {
      throw new HttpError(502, 'till_error', err instanceof EposError ? err.message : 'Could not reach the till.');
    }
  });

  app.put<{ Params: { siteId: string }; Body: { locationId: string | null } }>(
    '/v1/integrations/epos/sites/:siteId',
    {
      ...admin,
      schema: {
        tags,
        description: 'Match a site to its till location, or clear the match with null.',
        params: { type: 'object', properties: { siteId: { type: 'string' } } },
        body: { type: 'object', required: ['locationId'], properties: { locationId: { type: ['string', 'null'] } } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      if (!org.epos) throw new HttpError(409, 'not_connected', 'No till is connected.');
      if (!org.state.sites.some((s) => s.id === req.params.siteId)) throw notFound(`Site ${req.params.siteId}`);
      const { locationId } = req.body;
      // One location feeds one site: two sites on one location would count the same takings twice.
      const taken = Object.entries(org.epos.locations).find(([siteId, id]) => id === locationId && siteId !== req.params.siteId);
      if (locationId && taken) {
        const other = org.state.sites.find((s) => s.id === taken[0])?.name ?? taken[0];
        throw new HttpError(409, 'location_taken', `That till location already feeds ${other}.`);
      }
      if (locationId) org.epos.locations[req.params.siteId] = locationId;
      else delete org.epos.locations[req.params.siteId];
      audit(org, actor(req), 'epos.site_matched', { siteId: req.params.siteId, locationId });
      return status(ctx, org, !!(await providerFor(ctx, org)));
    },
  );

  app.post<{ Body: { from?: string; to?: string } }>(
    '/v1/integrations/epos/sync',
    {
      ...write,
      schema: {
        tags,
        description: `Reads the till for whole UK days and replaces what is held for them. Defaults to the day before the last sync through today. At most ${MAX_SYNC_DAYS} days a call.`,
        body: { type: 'object', properties: { from: isoDate, to: isoDate } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const now = today();
      const to = req.body?.to ?? now;
      const from = req.body?.from ?? (org.epos?.lastSync ? addDays(org.epos.lastSync.to, -1) : addDays(now, -7));
      if (from > to) throw new HttpError(400, 'invalid_range', 'The start date is after the end date.');
      if (to > now) throw new HttpError(400, 'invalid_range', 'The till cannot have sales for days still to come.');
      if (daysBetween(from, to) + 1 > MAX_SYNC_DAYS) throw new HttpError(400, 'range_too_long', `Sync at most ${MAX_SYNC_DAYS} days at a time.`);
      if (from < addDays(now, -KEEP_DAYS)) throw new HttpError(400, 'range_too_old', `Preshift keeps ${KEEP_DAYS} days of till history.`);
      const result = await syncTill(ctx, org, from, to);
      audit(org, actor(req), 'epos.synced', result);
      return result;
    },
  );

  app.get<{ Querystring: { siteId?: string; from?: string; to?: string } }>(
    '/v1/sales/actuals',
    { ...read, schema: { tags, description: 'Hourly takings held, by site, date and UK clock hour.', querystring: { type: 'object', properties: { siteId: { type: 'string' }, from: isoDate, to: isoDate } } } },
    async (req) => {
      const { siteId, from, to } = req.query;
      return orgOf(req).salesActuals.filter((r) => (!siteId || r.siteId === siteId) && (!from || r.date >= from) && (!to || r.date <= to));
    },
  );

  // For tills without a native connection: Tevalis, Zonal, Lightspeed exports, or middleware such as a data warehouse.
  app.put<{ Body: { rows: { siteId: string; date: string; hour: number; sales: number; covers?: number; transactions?: number }[]; source?: string } }>(
    '/v1/sales/actuals',
    {
      ...write,
      schema: {
        tags,
        description: 'Push hourly takings from any till or system. Each row replaces what is held for its site, date and hour.',
        body: {
          type: 'object',
          required: ['rows'],
          properties: { rows: { type: 'array', maxItems: 20000, items: salesRow }, source: { type: 'string', maxLength: 40 } },
        },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const sites = new Set(org.state.sites.map((s) => s.id));
      const unknown = [...new Set(req.body.rows.map((r) => r.siteId).filter((id) => !sites.has(id)))];
      if (unknown.length) throw new HttpError(400, 'unknown_site', `Unknown site: ${unknown.join(', ')}`);
      const cutoff = addDays(today(), -KEEP_DAYS);
      const source = req.body.source?.trim() || req.principal.name;
      const rows: HourSales[] = req.body.rows
        .filter((r) => r.date >= cutoff)
        .map((r) => ({ siteId: r.siteId, date: r.date, hour: r.hour, sales: r.sales, covers: r.covers, transactions: r.transactions ?? 0, source }));
      org.salesActuals = upsertHourSales(org.salesActuals, rows);
      audit(org, actor(req), 'sales.pushed', { rows: rows.length, source });
      return { upserted: rows.length, ignoredOlderThan: rows.length < req.body.rows.length ? cutoff : undefined };
    },
  );

  app.post<{ Body: { siteId?: string; siteIds?: string[]; weekStart: string; weeks?: number } }>(
    '/v1/forecast/from-history',
    {
      preHandler: requireScope('rota:write'),
      schema: {
        tags: ['Forecast'],
        description:
          'Forecasts a week from till history: each day from the same weekday in the weeks before, weighted to the most recent. ' +
          'Days with too little history are left as they are and listed as skipped.',
        body: {
          type: 'object',
          required: ['weekStart'],
          properties: {
            siteId: { type: 'string' },
            siteIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 500 },
            weekStart: isoDate,
            weeks: { type: 'integer', minimum: 2, maximum: 8 },
          },
        },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const siteIds = req.body.siteIds ?? (req.body.siteId ? [req.body.siteId] : []);
      if (siteIds.length === 0) throw new HttpError(400, 'invalid_request', 'Name a site.');
      for (const id of siteIds) if (!org.state.sites.some((s) => s.id === id)) throw notFound(`Site ${id}`);
      const dates = weekDates(req.body.weekStart);
      const results = siteIds.map((siteId) => {
        const spend = spendPerHead(org.state.forecast.filter((f) => f.siteId === siteId));
        const built = forecastFromHistory(org.salesActuals, siteId, dates, { weeks: req.body.weeks, spendPerHead: spend });
        const rebuilt = new Set(built.days.map((d) => d.date));
        org.state.forecast = [...org.state.forecast.filter((f) => !(f.siteId === siteId && rebuilt.has(f.date))), ...built.rows];
        return { siteId, days: built.days, skipped: built.skipped, sales: Math.round(built.rows.reduce((s, r) => s + r.sales, 0)) };
      });
      audit(org, actor(req), 'forecast.from_history', { weekStart: req.body.weekStart, sites: results.map((r) => ({ siteId: r.siteId, days: r.days.length })) });
      return { weekStart: req.body.weekStart, sites: results, asAt: toISODate(new Date()) };
    },
  );
}
