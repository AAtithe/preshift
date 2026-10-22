import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { addDays, daysBetween } from '../../src/engine/time';
import { requireScope } from '../auth';
import { HttpError, londonParts, notFound, orgOf, type AppContext } from '../context';
import { actorName, guard } from '../guard';
import { credentialHint, readCredentials, saveCredentials, type EposCredentials } from '../integrations/epos/credentials';
import { exchangeLightspeedCode, lightspeedAuthoriseUrl, type LightspeedApp } from '../integrations/epos/lightspeed';
import { EposError, PROVIDER_LABEL, type EposEnvironment, type EposProvider, type EposProviderName } from '../integrations/epos/provider';
import { makeProvider } from '../integrations/epos/providers';
import { TillSimulator } from '../integrations/epos/simulator';
import { SquareProvider } from '../integrations/epos/square';
import { BACKFILL_DAYS, backfillStep, MAX_SYNC_DAYS, syncEpos } from '../integrations/epos/sync';
import { ToastProvider } from '../integrations/epos/toast';
import { baseUrl } from '../oauth';
import { isoDate } from '../schemas';
import { audit, type OrgData } from '../store';

interface Options {
  /** The simulated till is offered in the demo and in development, never against live payroll. */
  simulatorAllowed: boolean;
  /** Preshift's own Lightspeed app (LIGHTSPEED_CLIENT_ID and LIGHTSPEED_CLIENT_SECRET). Without it, Lightspeed is not offered. */
  lightspeedApp?: LightspeedApp;
  /** The address Preshift is reached on (PRESHIFT_PUBLIC_URL): Lightspeed must send the venue back to exactly this. */
  publicUrl?: string;
}

/** A Lightspeed sign-in in progress, for ten minutes, so the callback can prove it was asked for. */
interface OAuthState {
  orgId: string;
  environment: 'production' | 'sandbox';
  by: string;
  next: string;
  expiresAt: number;
}
const oauthStateSetting = (state: string) => `epos_oauth:${state}`;
const OAUTH_MINUTES = 10;

const PROVIDERS: EposProviderName[] = ['square', 'toast', 'lightspeed'];

async function providerFor(ctx: AppContext, org: OrgData, opts: Options): Promise<EposProvider> {
  const conn = org.epos;
  if (!conn) throw new HttpError(409, 'not_connected', 'No till is connected. Someone who manages settings connects one in Settings.');
  if (conn.environment === 'simulator' && !opts.simulatorAllowed) {
    throw new HttpError(409, 'simulator_off', 'The simulated till is only available in the demo. Connect the real till in Settings.');
  }
  try {
    return makeProvider(conn, await readCredentials(ctx.store, org.orgId), { store: ctx.store, orgId: org.orgId, state: org.state, fetch: ctx.fetch, lightspeedApp: opts.lightspeedApp });
  } catch (err) {
    if (err instanceof EposError) throw new HttpError(409, 'no_credentials', err.message);
    throw err;
  }
}

/** Turns a till failure into a reply that says what to do, rather than a 500. */
function tillProblem(err: unknown): never {
  if (err instanceof EposError) throw new HttpError(err.retryable ? 502 : 422, 'epos_error', err.message);
  throw err;
}

const today = (ctx: AppContext) => londonParts(ctx.now()).date;

/**
 * Saves a new connection: drops matches to locations the new till does not have, because they
 * would sync another business's takings, and matches the simulator's one location per site for you.
 */
function connect(ctx: AppContext, org: OrgData, by: string, provider: EposProviderName, environment: EposEnvironment, accountName: string | undefined, locationIds: string[]) {
  org.epos = { provider, environment, connectedAt: ctx.now().toISOString(), connectedBy: by, accountName };
  for (const site of org.state.sites) {
    if (site.eposLocationId && !locationIds.includes(site.eposLocationId)) delete site.eposLocationId;
    if (environment === 'simulator') site.eposLocationId = `sim-${site.id}`;
  }
  audit(org, by, 'epos.connected', { provider, environment });
}

/** The last few finished trading days for every organisation with a till, and any backfill still under way. */
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
      // A backfill left half done in the browser carries on here, a few chunks a night.
      for (let i = 0; i < 6 && org.epos.backfill && !org.epos.backfill.finishedAt && !org.epos.backfill.error; i++) await backfillStep(org, provider, ctx.now());
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
  // Registered with Lightspeed as Preshift's redirect address, so it comes from configuration, not the request, wherever one is set.
  const callbackUrl = (req: FastifyRequest) => `${opts.publicUrl ?? baseUrl(req)}/v1/integrations/epos/lightspeed/callback`;

  /** Connecting a till is a setting: a person with settings.manage, never an integration key, as for the Claude key. */
  function settingsPerson(req: FastifyRequest) {
    if (!req.principal.email) throw new HttpError(403, 'forbidden', 'The till is connected by a person signed in, not an API key.');
    const g = guard(ctx, req, orgOf(req));
    g.allow('settings.manage');
    return actorName(g);
  }

  /** Bringing takings in is the forecast's right at each matched site, exactly as keying them in is. */
  function takingsPerson(req: FastifyRequest, org: OrgData) {
    const g = guard(ctx, req, org);
    for (const site of org.state.sites.filter((s) => s.eposLocationId)) g.allow('demand.manage', site.id);
    return actorName(g);
  }

  app.get('/v1/integrations/epos', { ...read, schema: { tags: ['EPOS'], description: 'The connected till, which site takes which till location, the last sync and any backfill.' } }, async (req) => {
    const org = orgOf(req);
    const g = guard(ctx, req, org);
    // The end of the credential helps whoever manages settings tell two apart; nobody else needs it.
    const creds = req.principal.email && g.can('settings.manage') ? await readCredentials(ctx.store, org.orgId) : null;
    return {
      connection: org.epos ?? null,
      tokenEndsWith: credentialHint(creds),
      sites: org.state.sites.filter((s) => g.can('rota.view', s.id)).map((s) => ({ siteId: s.id, name: s.name, locationId: s.eposLocationId ?? null })),
      simulatorAllowed: opts.simulatorAllowed,
      providers: { square: true, toast: true, lightspeed: !!opts.lightspeedApp },
    };
  });

  app.put<{ Body: { provider?: EposProviderName; environment?: EposEnvironment; accessToken?: string; clientId?: string; clientSecret?: string } }>(
    '/v1/integrations/epos',
    hidden,
    async (req) => {
      const by = settingsPerson(req);
      const org = orgOf(req);
      const provider = req.body?.provider ?? 'square';
      const environment = req.body?.environment ?? 'production';
      if (!PROVIDERS.includes(provider)) throw new HttpError(400, 'invalid_provider', 'Choose Square, Toast or Lightspeed.');
      if (!['production', 'sandbox', 'simulator'].includes(environment)) throw new HttpError(400, 'invalid_environment', 'Choose production, sandbox or simulator.');
      if (environment === 'simulator' && !opts.simulatorAllowed) throw new HttpError(400, 'simulator_off', 'The simulated till is only available in the demo.');
      if (provider === 'lightspeed' && environment !== 'simulator') throw new HttpError(400, 'use_sign_in', 'Lightspeed is connected by signing in to Lightspeed, with Connect Lightspeed in Settings.');

      // A secret left blank keeps the one saved for the same till, so only a changed field need be retyped.
      const saved = await readCredentials(ctx.store, org.orgId);
      let creds: EposCredentials | null = null;
      if (environment !== 'simulator' && provider === 'square') {
        const accessToken = req.body?.accessToken?.trim() || (saved?.provider === 'square' ? saved.accessToken : '');
        if (!accessToken) throw new HttpError(400, 'token_required', 'Paste the Square access token.');
        creds = { provider: 'square', accessToken };
      }
      if (environment !== 'simulator' && provider === 'toast') {
        const clientId = req.body?.clientId?.trim() || (saved?.provider === 'toast' ? saved.clientId : '');
        const clientSecret = req.body?.clientSecret?.trim() || (saved?.provider === 'toast' ? saved.clientSecret : '');
        if (!clientId || !clientSecret) throw new HttpError(400, 'credentials_required', 'Paste the Toast client ID and client secret.');
        creds = { provider: 'toast', clientId, clientSecret };
      }

      // Prove the credentials work before saving anything, so a typo never looks connected.
      let accountName: string | undefined;
      let locationIds: string[];
      try {
        if (environment === 'simulator') {
          locationIds = (await new TillSimulator(org.state, provider).listLocations()).map((l) => l.id);
          accountName = `Simulated ${PROVIDER_LABEL[provider]} account`;
        } else if (creds?.provider === 'square') {
          const square = new SquareProvider({ accessToken: creds.accessToken, environment, fetch: ctx.fetch });
          accountName = await square.merchantName();
          locationIds = (await square.listLocations()).map((l) => l.id);
        } else {
          const toast = new ToastProvider({ clientId: (creds as { clientId: string }).clientId, clientSecret: (creds as { clientSecret: string }).clientSecret, environment, fetch: ctx.fetch });
          const locations = await toast.listLocations();
          if (locations.length === 0) throw new EposError('Toast accepted the credentials but shows no restaurants for them. Ask Toast to connect your restaurants to the integration.', false);
          locationIds = locations.map((l) => l.id);
          accountName = locations.length === 1 ? locations[0].name : `${locations.length} Toast restaurants`;
        }
      } catch (err) {
        tillProblem(err);
      }

      await saveCredentials(ctx.store, org.orgId, creds);
      connect(ctx, org, by, provider, environment, accountName, locationIds);
      return { connection: org.epos, tokenEndsWith: credentialHint(creds) };
    },
  );

  // Lightspeed: the venue signs in at Lightspeed and approves Preshift, which then holds a token
  // pair that it refreshes itself. Nobody pastes a secret.
  app.post<{ Body: { environment?: 'production' | 'sandbox'; next?: string } }>('/v1/integrations/epos/lightspeed/start', hidden, async (req) => {
    const by = settingsPerson(req);
    if (!opts.lightspeedApp) throw new HttpError(409, 'lightspeed_off', 'This server has no Lightspeed app set up yet, so Lightspeed cannot be connected.');
    const environment = req.body?.environment === 'sandbox' ? 'sandbox' : 'production';
    const next = typeof req.body?.next === 'string' && req.body.next.startsWith('/') && !req.body.next.startsWith('//') ? req.body.next : '/app/';
    const state = randomBytes(24).toString('base64url');
    const pending: OAuthState = { orgId: orgOf(req).orgId, environment, by, next, expiresAt: ctx.now().getTime() + OAUTH_MINUTES * 60_000 };
    await ctx.store.setSetting(oauthStateSetting(state), JSON.stringify(pending));
    const redirectUri = callbackUrl(req);
    return { url: lightspeedAuthoriseUrl(opts.lightspeedApp, environment, redirectUri, state) };
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/v1/integrations/epos/lightspeed/callback', hidden, async (req, reply) => {
    const by = settingsPerson(req);
    const org = orgOf(req);
    const { code, state, error } = req.query;
    const raw = state ? await ctx.store.getSetting(oauthStateSetting(state)) : null;
    if (state) await ctx.store.setSetting(oauthStateSetting(state), null); // single use, whatever happens next
    const pending = raw ? (JSON.parse(raw) as OAuthState) : null;
    // The sign-in must be the one this organisation started, recently, or anyone could attach their own till.
    if (!pending || pending.orgId !== org.orgId || pending.expiresAt < ctx.now().getTime()) {
      throw new HttpError(400, 'invalid_state', 'This Lightspeed sign-in has expired or was not started here. Start again from Settings.');
    }
    if (error || !code) return reply.code(303).header('location', `${pending.next}?epos=declined`).send();
    if (!opts.lightspeedApp) throw new HttpError(409, 'lightspeed_off', 'This server has no Lightspeed app set up.');
    const redirectUri = callbackUrl(req);
    let locationIds: string[];
    try {
      const tokens = await exchangeLightspeedCode(opts.lightspeedApp, pending.environment, code, redirectUri, ctx.fetch, ctx.now().getTime());
      await saveCredentials(ctx.store, org.orgId, { provider: 'lightspeed', ...tokens });
      org.epos = { provider: 'lightspeed', environment: pending.environment, connectedAt: ctx.now().toISOString(), connectedBy: by };
      locationIds = (await (await providerFor(ctx, org, opts)).listLocations()).map((l) => l.id);
    } catch (err) {
      delete org.epos;
      await saveCredentials(ctx.store, org.orgId, null);
      tillProblem(err);
    }
    connect(ctx, org, by, 'lightspeed', pending.environment, `${locationIds.length} Lightspeed location${locationIds.length === 1 ? '' : 's'}`, locationIds);
    return reply.code(303).header('location', `${pending.next}?epos=connected`).send();
  });

  app.delete('/v1/integrations/epos', hidden, async (req) => {
    const by = settingsPerson(req);
    const org = orgOf(req);
    await saveCredentials(ctx.store, org.orgId, null);
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
      const by = takingsPerson(req, org);
      const provider = await providerFor(ctx, org, opts);
      const to = req.body?.to ?? addDays(today(ctx), -1);
      const from = req.body?.from ?? addDays(to, -6);
      if (from > to) throw new HttpError(400, 'invalid_range', 'The start date is after the end date.');
      if (daysBetween(from, to) >= MAX_SYNC_DAYS) throw new HttpError(400, 'range_too_long', `Sync at most ${MAX_SYNC_DAYS} days at a time, or use the backfill for longer.`);
      const result = await syncEpos(org, provider, from, to, ctx.now());
      org.epos!.lastSync = result;
      audit(org, by, 'epos.synced', { from, to, written: result.written, ok: result.ok, error: result.error });
      return result;
    },
  );

  app.post<{ Body: { from?: string } }>(
    '/v1/integrations/epos/backfill',
    {
      ...write,
      schema: {
        tags: ['EPOS'],
        description: `Starts bringing in past takings, by default the last ${BACKFILL_DAYS} days, so forecasts can work from the same week last year. Work it with /backfill/step; the daily schedule also carries it on.`,
        body: { type: 'object', properties: { from: isoDate } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const by = takingsPerson(req, org);
      await providerFor(ctx, org, opts);
      const to = addDays(today(ctx), -1);
      const from = req.body?.from ?? addDays(to, -(BACKFILL_DAYS - 1));
      if (from > to) throw new HttpError(400, 'invalid_range', 'The start date is after yesterday.');
      if (daysBetween(from, to) > 3 * 366) throw new HttpError(400, 'range_too_long', 'Bring in at most three years at a time.');
      org.epos!.backfill = { from, to, next: from, startedAt: ctx.now().toISOString(), startedBy: by, written: 0 };
      audit(org, by, 'epos.backfill_started', { from, to });
      return org.epos!.backfill;
    },
  );

  app.post('/v1/integrations/epos/backfill/step', { ...write, schema: { tags: ['EPOS'], description: 'Brings in the next two weeks of a backfill and says how far it has got.' } }, async (req) => {
    const org = orgOf(req);
    const by = takingsPerson(req, org);
    if (!org.epos?.backfill) throw new HttpError(409, 'no_backfill', 'No backfill has been started.');
    const provider = await providerFor(ctx, org, opts);
    const job = await backfillStep(org, provider, ctx.now());
    if (job?.finishedAt) audit(org, by, 'epos.backfill_finished', { from: job.from, to: job.to, written: job.written });
    return job;
  });
}
