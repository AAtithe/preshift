import type { FastifyInstance, FastifyRequest } from 'fastify';
import { addDays, daysBetween } from '../../src/engine/time';
import { requireScope } from '../auth';
import { HttpError, londonParts, notFound, orgOf, type AppContext } from '../context';
import { actorName, guard } from '../guard';
import { EposError, type EposEnvironment, type EposProvider } from '../integrations/epos/provider';
import { SquareSimulator } from '../integrations/epos/simulator';
import { SquareProvider } from '../integrations/epos/square';
import { MAX_RESYNC_DAYS, MAX_SYNC_DAYS, resyncTakings, syncEpos } from '../integrations/epos/sync';
import { isoDate } from '../schemas';
import { audit, type OrgData } from '../store';

/** The seller's Square access token, kept with the other secrets and never returned. */
export const eposTokenSetting = (orgId: string) => `epos_token:${orgId}`;

interface Options {
  /** The simulated till is offered in the demo and in development, never against live payroll. */
  simulatorAllowed: boolean;
}

async function providerFor(ctx: AppContext, org: OrgData, opts: Options): Promise<EposProvider> {
  const conn = org.epos;
  if (!conn) throw new HttpError(409, 'not_connected', 'No till is connected. Someone who manages settings connects one in Settings.');
  if (conn.environment === 'simulator') {
    if (!opts.simulatorAllowed) throw new HttpError(409, 'simulator_off', 'The simulated till is only available in the demo. Connect Square in Settings.');
    return new SquareSimulator(org.state);
  }
  const token = await ctx.store.getSetting(eposTokenSetting(org.orgId));
  if (!token) throw new HttpError(409, 'no_token', 'The Square access token is missing. Someone who manages settings saves it again in Settings.');
  return new SquareProvider({ accessToken: token, environment: conn.environment, fetch: ctx.fetch });
}

/** Turns a till failure into a reply that says what to do, rather than a 500. */
function tillProblem(err: unknown): never {
  if (err instanceof EposError) throw new HttpError(err.retryable ? 502 : 422, 'epos_error', err.message);
  throw err;
}

const today = (ctx: AppContext) => londonParts(ctx.now()).date;

/** The last few finished trading days for every organisation with a till, from the daily schedule. */
export async function syncAllTills(ctx: AppContext, opts: Options) {
  for (const orgId of await ctx.store.orgIds()) {
    try {
      const org = await ctx.store.load(orgId);
      if (!org.epos) continue;
      const provider = await providerFor(ctx, org, opts);
      // Three days back, so a late refund or a missed night is picked up on the next run.
      const result = await syncEpos(org, provider, addDays(today(ctx), -3), addDays(today(ctx), -1), ctx.now());
      org.epos.lastSync = result;
      audit(org, 'Schedule', 'epos.synced', { written: result.written, ok: result.ok, error: result.error });
      await ctx.store.save(org);
    } catch {
      // One organisation's till must not stop the others; its next manual sync shows the problem.
    }
  }
}

export function eposRoutes(app: FastifyInstance, ctx: AppContext, opts: Options) {
  const read = { preHandler: requireScope('rota:read') };
  const write = { preHandler: requireScope('rota:write') };
  const hidden = { schema: { hide: true } };

  /** Connecting a till is a setting: a person with settings.manage, never an integration key, as for the Claude key. */
  function settingsPerson(req: FastifyRequest) {
    if (!req.principal.email) throw new HttpError(403, 'forbidden', 'The till is connected by a person signed in, not an API key.');
    const g = guard(ctx, req, orgOf(req));
    g.allow('settings.manage');
    return actorName(g);
  }

  app.get('/v1/integrations/epos', { ...read, schema: { tags: ['EPOS'], description: 'The connected till, which site takes which till location, and the last sync.' } }, async (req) => {
    const org = orgOf(req);
    const g = guard(ctx, req, org);
    // The end of the token helps whoever manages settings tell two tokens apart; nobody else needs it.
    const token = req.principal.email && g.can('settings.manage') ? await ctx.store.getSetting(eposTokenSetting(org.orgId)) : null;
    return {
      connection: org.epos ?? null,
      tokenEndsWith: token ? token.slice(-4) : null,
      sites: org.state.sites.filter((s) => g.can('rota.view', s.id)).map((s) => ({ siteId: s.id, name: s.name, locationId: s.eposLocationId ?? null })),
      simulatorAllowed: opts.simulatorAllowed,
    };
  });

  app.put<{ Body: { environment?: EposEnvironment; accessToken?: string } }>('/v1/integrations/epos', hidden, async (req) => {
    const by = settingsPerson(req);
    const org = orgOf(req);
    const environment = req.body?.environment ?? 'production';
    if (!['production', 'sandbox', 'simulator'].includes(environment)) throw new HttpError(400, 'invalid_environment', 'Choose production, sandbox or simulator.');
    if (environment === 'simulator' && !opts.simulatorAllowed) throw new HttpError(400, 'simulator_off', 'The simulated till is only available in the demo.');
    const accessToken = req.body?.accessToken?.trim() || (environment !== 'simulator' ? await ctx.store.getSetting(eposTokenSetting(org.orgId)) : null);
    if (environment !== 'simulator' && !accessToken) throw new HttpError(400, 'token_required', 'Paste the Square access token.');

    // Prove the token works before saving anything, so a typo never looks connected.
    let accountName: string | undefined;
    let locationIds: string[];
    try {
      if (environment === 'simulator') {
        locationIds = (await new SquareSimulator(org.state).listLocations()).map((l) => l.id);
        accountName = 'Simulated Square account';
      } else {
        const square = new SquareProvider({ accessToken: accessToken!, environment, fetch: ctx.fetch });
        accountName = await square.merchantName();
        locationIds = (await square.listLocations()).map((l) => l.id);
      }
    } catch (err) {
      tillProblem(err);
    }

    await ctx.store.setSetting(eposTokenSetting(org.orgId), environment === 'simulator' ? null : accessToken!);
    org.epos = { provider: 'square', environment, connectedAt: ctx.now().toISOString(), connectedBy: by, accountName };
    for (const site of org.state.sites) {
      // A location from another account or environment would sync the wrong takings: drop it.
      if (site.eposLocationId && !locationIds.includes(site.eposLocationId)) delete site.eposLocationId;
      // The simulator has one location per site, so it can be matched for you.
      if (environment === 'simulator') site.eposLocationId = `sim-${site.id}`;
    }
    audit(org, by, 'epos.connected', { provider: 'square', environment });
    return { connection: org.epos, tokenEndsWith: accessToken ? accessToken.slice(-4) : null };
  });

  app.delete('/v1/integrations/epos', hidden, async (req) => {
    const by = settingsPerson(req);
    const org = orgOf(req);
    await ctx.store.setSetting(eposTokenSetting(org.orgId), null);
    delete org.epos;
    for (const site of org.state.sites) delete site.eposLocationId;
    audit(org, by, 'epos.disconnected');
    // Takings already brought in stay: they are the record of what was sold.
    return { connection: null };
  });

  app.get('/v1/integrations/epos/locations', { ...read, schema: { tags: ['EPOS'], description: "The till's locations, and the site each is matched to." } }, async (req) => {
    const org = orgOf(req);
    guard(ctx, req, org).allow('rota.view');
    const provider = await providerFor(ctx, org, opts);
    const locations = await provider.listLocations().catch(tillProblem);
    return locations.map((l) => ({ ...l, siteId: org.state.sites.find((s) => s.eposLocationId === l.id)?.id ?? null }));
  });

  app.put<{ Body: { sites: Record<string, string | null> } }>(
    '/v1/integrations/epos/mapping',
    { schema: { hide: true, body: { type: 'object', required: ['sites'], properties: { sites: { type: 'object', additionalProperties: { type: ['string', 'null'] } } } } } },
    async (req) => {
      const by = settingsPerson(req);
      const org = orgOf(req);
      const provider = await providerFor(ctx, org, opts);
      const locations = await provider.listLocations().catch(tillProblem);
      const next = new Map(org.state.sites.map((s) => [s.id, s.eposLocationId ?? null]));
      for (const [siteId, locationId] of Object.entries(req.body.sites)) {
        if (!next.has(siteId)) throw notFound(`Site ${siteId}`);
        if (locationId && !locations.some((l) => l.id === locationId)) throw new HttpError(422, 'unknown_location', `The till has no location ${locationId}.`);
        next.set(siteId, locationId || null);
      }
      // Two sites on one till location would count the same takings twice.
      const used = [...next.values()].filter((v) => v !== null);
      if (new Set(used).size !== used.length) throw new HttpError(422, 'location_shared', 'Each till location can belong to one site only.');
      for (const site of org.state.sites) {
        const locationId = next.get(site.id);
        if (locationId) site.eposLocationId = locationId;
        else delete site.eposLocationId;
      }
      audit(org, by, 'epos.mapped', { sites: Object.fromEntries(next) });
      return org.state.sites.map((s) => ({ siteId: s.id, locationId: s.eposLocationId ?? null }));
    },
  );

  app.post<{ Body: { from?: string; to?: string } }>(
    '/v1/integrations/epos/sync',
    {
      ...write,
      schema: {
        tags: ['EPOS'],
        description: 'Brings in finished trading days from the till for every matched site. Defaults to the last seven days. Days keyed in by hand are kept.',
        body: { type: 'object', properties: { from: isoDate, to: isoDate } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      // Syncing writes takings, the forecast's right at each site, exactly as keying them in is.
      const g = guard(ctx, req, org);
      for (const site of org.state.sites.filter((s) => s.eposLocationId)) g.allow('demand.manage', site.id);
      const provider = await providerFor(ctx, org, opts);
      const to = req.body?.to ?? addDays(today(ctx), -1);
      const from = req.body?.from ?? addDays(to, -6);
      if (from > to) throw new HttpError(400, 'invalid_range', 'The start date is after the end date.');
      if (daysBetween(from, to) >= MAX_SYNC_DAYS) throw new HttpError(400, 'range_too_long', `Sync at most ${MAX_SYNC_DAYS} days at a time.`);
      const result = await syncEpos(org, provider, from, to, ctx.now());
      org.epos!.lastSync = result;
      audit(org, actorName(g), 'epos.synced', { from, to, written: result.written, ok: result.ok, error: result.error });
      return result;
    },
  );

  // After a fix to how takings are worked out from the till, the days it already wrote are read again.
  // Takings only, till days only: hand-keyed and imported days stand, and tips are left alone.
  app.post<{ Body: { from?: string; to?: string } }>(
    '/v1/integrations/epos/resync',
    {
      ...write,
      schema: {
        tags: ['EPOS'],
        description: `Reads takings the till already brought in again, after a fix to how they are worked out. Only days the till wrote; hand-keyed and imported days and tips are left alone. Defaults to every till day up to yesterday; at most ${MAX_RESYNC_DAYS} days.`,
        body: { type: 'object', properties: { from: isoDate, to: isoDate } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      // Rewriting takings is the forecast's right at each site, as a sync is.
      const g = guard(ctx, req, org);
      const mapped = org.state.sites.filter((s) => s.eposLocationId);
      for (const site of mapped) g.allow('demand.manage', site.id);
      const provider = await providerFor(ctx, org, opts);
      const tillDays = (org.state.sales ?? []).filter((s) => s.source === 'till' && mapped.some((m) => m.id === s.siteId)).map((s) => s.date).sort();
      const to = req.body?.to ?? addDays(today(ctx), -1);
      const from = req.body?.from ?? tillDays[0] ?? to;
      if (from > to) throw new HttpError(400, 'invalid_range', 'The start date is after the end date.');
      if (daysBetween(from, to) >= MAX_RESYNC_DAYS) throw new HttpError(400, 'range_too_long', `Re-sync at most ${MAX_RESYNC_DAYS} days at a time.`);
      const result = await resyncTakings(org, provider, from, to, ctx.now());
      org.epos!.lastResync = result;
      audit(org, actorName(g), 'epos.resynced', { from, to, read: result.read, changed: result.changed, ok: result.ok, error: result.error });
      return result;
    },
  );
}
