import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { parseTillFeed } from '../../src/engine/tillFeed';
import { addDays, daysBetween } from '../../src/engine/time';
import { requireScope } from '../auth';
import { HttpError, londonParts, notFound, orgOf, type AppContext } from '../context';
import { actorName, guard } from '../guard';
import { FeedProvider, receiveFeed } from '../integrations/epos/feed';
import { LightspeedProvider, lightspeedAuthorizeUrl, lightspeedExchangeCode, type LightspeedConfig, type LightspeedTokens } from '../integrations/epos/lightspeed';
import { EPOS_PROVIDERS, EposError, type EposEnvironment, type EposProvider, type EposProviderName, type EposSyncResult } from '../integrations/epos/provider';
import { SquareSimulator } from '../integrations/epos/simulator';
import { SquareProvider } from '../integrations/epos/square';
import { MAX_RESYNC_DAYS, MAX_SYNC_DAYS, resyncTakings, syncEpos } from '../integrations/epos/sync';
import { isoDate } from '../schemas';
import { audit, type OrgData } from '../store';

/**
 * The till's secret, kept with the other secrets and never returned: Square's access token,
 * Lightspeed's tokens as JSON, or the key a Zonal or Tevalis file feed signs in with.
 */
export const eposTokenSetting = (orgId: string) => `epos_token:${orgId}`;
/** A Lightspeed sign-in in progress: which organisation, who started it, until when. */
const oauthStateSetting = (state: string) => `epos_oauth:${state}`;
/** How long someone has to finish signing in to Lightspeed. */
const OAUTH_MINUTES = 15;

interface Options {
  /** The simulated till is offered in the demo and in development, never against live payroll. */
  simulatorAllowed: boolean;
  /** Preshift's Lightspeed app, when one is registered. Without it Lightspeed is not offered. */
  lightspeed?: LightspeedConfig;
  /** Where Preshift is served, for the address Lightspeed sends people back to and the feed address. */
  appUrl?: string;
}

/** Where Lightspeed sends someone back once they have approved Preshift. Registered with Lightspeed. */
export const lightspeedRedirect = (appUrl: string) => `${appUrl}/integrations/lightspeed/callback`;

/** A feed key: long and random, shown once, kept only as its hash. */
const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');

async function providerFor(ctx: AppContext, org: OrgData, opts: Options): Promise<EposProvider> {
  const conn = org.epos;
  if (!conn) throw new HttpError(409, 'not_connected', 'No till is connected. Someone who manages settings connects one in Settings.');
  if (EPOS_PROVIDERS[conn.provider].feed) return new FeedProvider(EPOS_PROVIDERS[conn.provider].label, conn.feed ?? { locations: [], rows: [] });
  if (conn.environment === 'simulator') {
    if (!opts.simulatorAllowed) throw new HttpError(409, 'simulator_off', 'The simulated till is only available in the demo. Connect a till in Settings.');
    return new SquareSimulator(org.state);
  }
  const token = await ctx.store.getSetting(eposTokenSetting(org.orgId));
  if (conn.provider === 'lightspeed') {
    if (!opts.lightspeed) throw new HttpError(409, 'lightspeed_off', 'Lightspeed is not set up on this server.');
    if (!token) throw new HttpError(409, 'no_token', 'The Lightspeed connection is missing. Someone who manages settings connects Lightspeed again.');
    return new LightspeedProvider({
      config: opts.lightspeed,
      tokens: JSON.parse(token) as LightspeedTokens,
      fetch: ctx.fetch,
      now: ctx.now,
      // Lightspeed hands out a new refresh token with each access token: keep the latest or the next run fails.
      onTokens: (t) => ctx.store.setSetting(eposTokenSetting(org.orgId), JSON.stringify(t)),
    });
  }
  if (!token) throw new HttpError(409, 'no_token', 'The Square access token is missing. Someone who manages settings saves it again in Settings.');
  return new SquareProvider({ accessToken: token, environment: conn.environment, fetch: ctx.fetch });
}

/**
 * Takes in a file feed's rows and brings the finished trading days they cover into takings, a
 * quarter at most. What could not be read is reported line by line, and kept with the connection.
 */
async function takeFeed(ctx: AppContext, org: OrgData, body: string | { rows: Record<string, unknown>[] }, by: string): Promise<{ received: number; problems: { line: number; message: string }[]; sync: EposSyncResult | null }> {
  const conn = org.epos!;
  const read = parseTillFeed(body);
  conn.feed ??= { locations: [], rows: [] };
  const at = ctx.now().toISOString();
  const dates = receiveFeed(conn.feed, read.rows, today(ctx), at);
  conn.feed.lastReceived = { at, rows: read.rows.length, problems: read.problems.slice(0, 50), by };
  let sync: EposSyncResult | null = null;
  const finished = dates.filter((d) => d < today(ctx));
  if (finished.length && org.state.sites.some((s) => s.eposLocationId)) {
    const from = finished[0] < addDays(today(ctx), -MAX_SYNC_DAYS) ? addDays(today(ctx), -MAX_SYNC_DAYS) : finished[0];
    sync = await syncEpos(org, new FeedProvider(EPOS_PROVIDERS[conn.provider].label, conn.feed), from, finished[finished.length - 1], ctx.now());
    conn.lastSync = sync;
  }
  audit(org, by, 'epos.feed_received', { provider: conn.provider, rows: read.rows.length, problems: read.problems.length, written: sync?.written ?? 0 });
  return { received: read.rows.length, problems: read.problems, sync };
}

/**
 * Lightspeed sends someone back here once they approve Preshift. The organisation comes from the
 * one-time state Preshift made when they set out, never from the address, so a forged link connects
 * nothing.
 */
export function eposOAuthRoutes(app: FastifyInstance, ctx: AppContext, opts: Options) {
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/integrations/lightspeed/callback', { schema: { hide: true } }, async (req, reply) => {
    const back = (q: Record<string, string>) => reply.redirect(`/app/?${new URLSearchParams({ view: 'settings', ...q })}`);
    const state = req.query.state ?? '';
    const saved = state ? await ctx.store.getSetting(oauthStateSetting(state)) : null;
    if (state) await ctx.store.setSetting(oauthStateSetting(state), null);
    if (!saved) return back({ epos: 'expired' });
    const pending = JSON.parse(saved) as { orgId: string; by: string; expiresAt: string };
    if (new Date(pending.expiresAt) < ctx.now()) return back({ epos: 'expired' });
    if (req.query.error || !req.query.code) return back({ epos: 'declined' });
    if (!opts.lightspeed || !opts.appUrl) return back({ epos: 'unavailable' });
    try {
      const tokens = await lightspeedExchangeCode(opts.lightspeed, ctx.fetch, req.query.code, lightspeedRedirect(opts.appUrl), ctx.now());
      let latest = tokens;
      const ls = new LightspeedProvider({ config: opts.lightspeed, tokens, fetch: ctx.fetch, now: ctx.now, onTokens: async (t) => void (latest = t) });
      const accountName = await ls.businessName();
      const locationIds = (await ls.listLocations()).map((l) => l.id);
      const org = await ctx.store.load(pending.orgId);
      await ctx.store.setSetting(eposTokenSetting(org.orgId), JSON.stringify(latest));
      org.epos = { provider: 'lightspeed', environment: 'production', connectedAt: ctx.now().toISOString(), connectedBy: pending.by, accountName };
      for (const site of org.state.sites) if (site.eposLocationId && !locationIds.includes(site.eposLocationId)) delete site.eposLocationId;
      audit(org, pending.by, 'epos.connected', { provider: 'lightspeed', environment: 'production' });
      await ctx.store.save(org);
      return back({ epos: 'connected' });
    } catch (err) {
      return back({ epos: 'failed', reason: err instanceof EposError ? err.message : 'Lightspeed could not be reached.' });
    }
  });
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
    const conn = org.epos;
    // A feed's rows are takings already summed into the sales; the connection carries only what it last received.
    const connection = conn ? { ...conn, feed: undefined, feedReceived: conn.feed?.lastReceived ?? null } : null;
    const feed = !!conn && EPOS_PROVIDERS[conn.provider].feed;
    return {
      connection,
      // Square's token can be told apart by its end; Lightspeed's rotates and a feed key is kept only as a hash.
      tokenEndsWith: token && conn?.provider === 'square' ? token.slice(-4) : null,
      feedUrl: feed && opts.appUrl ? `${opts.appUrl}/v1/integrations/epos/feed/${org.orgId}` : feed ? `/v1/integrations/epos/feed/${org.orgId}` : null,
      sites: org.state.sites.filter((s) => g.can('rota.view', s.id)).map((s) => ({ siteId: s.id, name: s.name, locationId: s.eposLocationId ?? null })),
      simulatorAllowed: opts.simulatorAllowed,
      providers: (Object.keys(EPOS_PROVIDERS) as EposProviderName[])
        .filter((p) => p !== 'lightspeed' || (!!opts.lightspeed && !!opts.appUrl))
        .map((p) => ({ id: p, label: EPOS_PROVIDERS[p].label, feed: EPOS_PROVIDERS[p].feed })),
    };
  });

  app.put<{ Body: { provider?: EposProviderName; environment?: EposEnvironment; accessToken?: string } }>('/v1/integrations/epos', hidden, async (req) => {
    const by = settingsPerson(req);
    const org = orgOf(req);
    const provider = req.body?.provider ?? 'square';
    if (!(provider in EPOS_PROVIDERS)) throw new HttpError(400, 'invalid_provider', 'Choose Square, Lightspeed, Zonal or Tevalis.');

    if (provider === 'lightspeed') {
      // Nothing changes until Lightspeed sends them back approved: an abandoned sign-in leaves the old till connected.
      if (!opts.lightspeed || !opts.appUrl) throw new HttpError(409, 'lightspeed_off', 'Lightspeed is not set up on this server yet.');
      const state = randomBytes(24).toString('base64url');
      const expiresAt = new Date(ctx.now().getTime() + OAUTH_MINUTES * 60_000).toISOString();
      await ctx.store.setSetting(oauthStateSetting(state), JSON.stringify({ orgId: org.orgId, by, expiresAt }));
      return { authorizeUrl: lightspeedAuthorizeUrl(opts.lightspeed, lightspeedRedirect(opts.appUrl), state) };
    }

    if (EPOS_PROVIDERS[provider].feed) {
      // A new key each time, shown once: whoever set up the old one has to be given the new.
      const feedKey = `psf_${randomBytes(24).toString('base64url')}`;
      await ctx.store.setSetting(eposTokenSetting(org.orgId), hashKey(feedKey));
      const same = org.epos?.provider === provider;
      org.epos = { provider, environment: 'production', connectedAt: ctx.now().toISOString(), connectedBy: by, accountName: EPOS_PROVIDERS[provider].label, feed: same ? org.epos!.feed : { locations: [], rows: [] } };
      if (!same) for (const site of org.state.sites) delete site.eposLocationId;
      audit(org, by, 'epos.connected', { provider, environment: 'feed' });
      return { connection: { ...org.epos, feed: undefined }, feedKey, feedUrl: `${opts.appUrl ?? ''}/v1/integrations/epos/feed/${org.orgId}` };
    }

    const environment = req.body?.environment ?? 'production';
    if (!['production', 'sandbox', 'simulator'].includes(environment)) throw new HttpError(400, 'invalid_environment', 'Choose production, sandbox or simulator.');
    if (environment === 'simulator' && !opts.simulatorAllowed) throw new HttpError(400, 'simulator_off', 'The simulated till is only available in the demo.');
    // Keep the saved token only when it is Square's own: another till's secret is no Square token.
    const kept = org.epos?.provider === 'square' && environment !== 'simulator' ? await ctx.store.getSetting(eposTokenSetting(org.orgId)) : null;
    const accessToken = req.body?.accessToken?.trim() || kept;
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

  // A Zonal or Tevalis file feed posts here: CSV, or JSON as { rows }. The key in the Authorization
  // header is the proof; the organisation in the address only says where to look.
  app.post<{ Params: { orgId: string } }>(
    '/v1/integrations/epos/feed/:orgId',
    { schema: { tags: ['EPOS'], description: 'Receives a Zonal or Tevalis file feed: CSV with a header row, or JSON { rows }, signed in with the feed key as a Bearer token. Days finished trading are brought into takings.' } },
    async (req, reply) => {
      const presented = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      const stored = req.org ? await ctx.store.getSetting(eposTokenSetting(req.org.orgId)) : null;
      const ok = !!presented && !!stored && req.org?.epos && EPOS_PROVIDERS[req.org.epos.provider].feed && timingSafeEqual(Buffer.from(hashKey(presented)), Buffer.from(stored.padEnd(64, '0').slice(0, 64)));
      if (!ok) return reply.code(401).send({ error: 'bad_feed_key', message: 'The feed key is missing or wrong.' });
      const org = req.org!;
      const body = req.body as string | { rows?: Record<string, unknown>[] } | undefined;
      if (typeof body !== 'string' && !Array.isArray(body?.rows)) throw new HttpError(400, 'invalid_feed', 'Send CSV with a header row, or JSON as { "rows": [...] }.');
      req.orgChanged = true;
      return takeFeed(ctx, org, typeof body === 'string' ? body : { rows: body!.rows! }, `${EPOS_PROVIDERS[org.epos!.provider].label} feed`);
    },
  );

  // The same file uploaded by a manager, when the export comes by email rather than straight in.
  app.post<{ Body: { csv: string } }>(
    '/v1/integrations/epos/feed-upload',
    { schema: { hide: true, body: { type: 'object', required: ['csv'], properties: { csv: { type: 'string', maxLength: 5_000_000 } } } } },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      if (!org.epos || !EPOS_PROVIDERS[org.epos.provider].feed) throw new HttpError(409, 'not_feed', 'Uploads are for a till connected by file feed (Zonal or Tevalis).');
      // Bringing in takings is the forecast's right at each site, as a sync is.
      const mapped = org.state.sites.filter((s) => s.eposLocationId);
      if (mapped.length) for (const site of mapped) g.allow('demand.manage', site.id);
      else g.allow('settings.manage');
      return takeFeed(ctx, org, req.body.csv, actorName(g));
    },
  );
}
