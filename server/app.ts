import Fastify, { type FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { authenticate, loadApiKeys, type ApiKey } from './auth';
import { HttpError, londonToday, type AppContext } from './context';
import { addDays } from '../src/engine/time';
import type { PayrollProvider } from './integrations/payroll/provider';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { TeamPayProvider } from './integrations/payroll/teampay';
import { OutboxDispatcher } from './outbox';
import { settingsRoutes, signInRoutes } from './routes/access';
import { assistantRoutes } from './routes/assistant';
import { demoRoutes, keepSandboxTrading, sandboxGuard, sweepSandboxes } from './demo';
import { isSandbox } from './sandbox';
import { devRoutes } from './routes/dev';
import { developerRoutes } from './routes/developers';
import { documentCipherFromEnv } from './documentCrypto';
import { documentRoutes, hrFileRoutes, MAX_DOCUMENT_BYTES, UPLOAD_CONTENT_TYPES } from './routes/documents';
import { employeeRoutes } from './routes/employees';
import { eposRoutes, syncAllTills } from './routes/epos';
import { applyDuePayChanges, payDaily, payRoutes } from './routes/pay';
import { hrRoutes } from './routes/hr';
import { payrollRoutes } from './routes/payroll';
import { payrollLinkRoutes } from './routes/payrollLink';
import { privacyRoutes } from './routes/privacy';
import { rotaRoutes } from './routes/rota';
import { setupRoutes } from './routes/setup';
import { timeRoutes } from './routes/time';
import { labourRoutes } from './routes/labour';
import { authenticatorRoutes } from './routes/authenticator';
import { userRoutes } from './routes/users';
import { clientRoutes } from './routes/clients';
import { supportRoutes } from './routes/support';
import { clockingRoutes } from './routes/clocking';
import { insightRoutes } from './routes/insights';
import { calendarRoutes } from './routes/calendar';
import { bookingRoutes } from './routes/bookings';
import { billingRoutes, stripeWebhookRoutes } from './routes/billing';
import { signupRoutes } from './routes/signup';
import { allowedWhileLocked, getBilling, LOCKED_MESSAGE, standingOf, stripeFromEnv, trialDaysFromEnv } from './billing';
import { applyOutside, feedConfig, fetchOutside } from './forecasting';
import { publicFetch } from './integrations/feeds';
import { refreshStaleTravel, travelRoutes } from './routes/travel';
import { kioskAdminRoutes, kioskRoutes } from './routes/kiosk';
import { staffAdminRoutes, staffRoutes } from './routes/staff';
import { requestRoutes } from './routes/requests';
import { deliverNotifications } from './notify';
import { sendManagerDigests } from './digest';
import { runShiftAlerts } from './reminders';
import { webRoutes } from './routes/web';
import { syncAllRewards, welfareRoutes } from './routes/welfare';
import { cashRoutes } from './routes/cash';
import { accountingRoutes, xeroFromEnv } from './routes/accounting';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { neon } from '@neondatabase/serverless';
import { mcpRoutes } from './mcp';
import { oauthRoutes } from './oauth';
import { API_CALL_RETENTION_DAYS, MemoryStore, PgStore, type Store } from './store';
import { deliverAllWebhooks, deliverWebhooks, type Fetch } from './webhooks';

export interface BuildOptions {
  apiKeys?: ApiKey[];
  store?: Store;
  /** Supply a provider directly (tests). Otherwise TeamPay if configured, else the simulator. */
  provider?: PayrollProvider;
  autoDispatch?: boolean;
  logger?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Where the Swagger UI assets live when the server is bundled (Vercel). */
  docsBaseDir?: string;
  /** The sign-in page. Defaults to site/login.html in the repository. */
  loginPage?: string;
  /** The built web app, served at /app/ to signed-in people only. Unset in development, where Vite serves it. */
  appDir?: string;
  /** The built staff app (hosted build). Public: it holds no data until someone signs in. */
  staffDir?: string;
  /** The built kiosk page for shared iPads (hosted build). Public: it does nothing until the iPad is paired. */
  kioskDir?: string;
  /** Outbound HTTP for postcode and journey lookups, the till, and weather and event feeds (tests pass a stub). */
  fetch?: typeof fetch;
  /** The public demo alongside customers: a sandbox per visitor at /demo. Defaults to PRESHIFT_DEMO=1. See server/demo.ts. */
  demo?: boolean;
  /** The demo's start page. Defaults to site/demo.html in the repository. */
  demoPage?: string;
  /** The clock (tests fix it). */
  now?: () => Date;
  /** How webhooks reach partner systems. Defaults to fetch; tests supply a recorder. */
  webhookFetch?: Fetch;
  /** Requests per minute per API key. */
  rateLimit?: number;
  /** Self sign-up from the sign-in page. Defaults to PRESHIFT_SIGNUP=1. See server/routes/signup.ts. */
  signup?: boolean;
}

function payrollFromEnv(env: NodeJS.ProcessEnv): { provider: PayrollProvider; simulator?: TeamPaySimulator } {
  if (env.TEAMPAY_API_KEY) {
    return {
      provider: new TeamPayProvider({
        baseUrl: env.TEAMPAY_BASE_URL ?? 'https://api.team-pay.co.uk/v1',
        apiKey: env.TEAMPAY_API_KEY,
        webhookSecret: env.TEAMPAY_WEBHOOK_SECRET ?? '',
        employerId: env.TEAMPAY_EMPLOYER_ID ?? '',
      }),
    };
  }
  const simulator = new TeamPaySimulator();
  return { provider: simulator, simulator };
}

/**
 * Which database Preshift uses. PRESHIFT_DATABASE_URL wins. On Vercel only, the
 * DATABASE_URL that the project's Neon integration sets is used otherwise; a
 * generic DATABASE_URL anywhere else (a laptop, a CI box, a coding container)
 * is ignored. Either way PgStore refuses a database that holds another
 * system's tables.
 */
export function storeFromEnv(env: NodeJS.ProcessEnv): Store {
  const url = env.PRESHIFT_DATABASE_URL ?? (env.VERCEL === '1' ? env.DATABASE_URL : undefined);
  if (!url) return new MemoryStore();
  const sql = neon(url);
  return new PgStore((text, params) => sql(text, params) as Promise<Record<string, unknown>[]>);
}

export async function buildApp(options: BuildOptions = {}): Promise<{ app: FastifyInstance; ctx: AppContext; routes: string[] }> {
  const env = options.env ?? process.env;
  const demo = options.demo ?? env.PRESHIFT_DEMO === '1';
  const app = Fastify({ logger: options.logger ?? false });
  // Every route as "METHOD /pattern", so a test can check each has a decision for the demo.
  const routes: string[] = [];
  app.addHook('onRoute', (r) => {
    for (const method of [r.method].flat()) if (method !== 'HEAD') routes.push(`${method} ${r.url}`);
  });
  const store = options.store ?? storeFromEnv(env);
  const payroll = options.provider
    ? { provider: options.provider, simulator: options.provider instanceof TeamPaySimulator ? options.provider : undefined }
    : payrollFromEnv(env);
  // Demo sandboxes never reach real payroll. Their simulator's webhook secret is random and lives
  // only in this process, so nobody outside can sign a payroll event into a sandbox.
  const sandboxPayroll = new TeamPaySimulator(randomBytes(32).toString('hex'));
  const providerFor = (orgId: string) => (isSandbox(orgId) ? sandboxPayroll : payroll.provider);
  const simulatorFor = (orgId: string) => (isSandbox(orgId) ? sandboxPayroll : payroll.simulator);
  const documents = documentCipherFromEnv(env, store instanceof PgStore);
  const employers = { defaultEmployerId: env.TEAMPAY_EMPLOYER_ID || undefined, simulated: !!payroll.simulator };
  const ctx: AppContext = {
    store,
    providerFor,
    simulatorFor,
    employers,
    simulator: payroll.simulator,
    dispatcher: new OutboxDispatcher(store, providerFor, employers),
    autoDispatch: options.autoDispatch ?? true,
    documentCipher: documents.cipher,
    fetch: options.fetch ?? fetch,
    // Feed addresses are typed in by people, so the server's own reads of them are kept to public https.
    feedFetch: options.fetch ?? publicFetch,
    feeds: feedConfig(env),
    tflAppKey: env.TFL_APP_KEY || undefined,
    now: options.now ?? (() => new Date()),
  };

  // The sign-in and setup forms post as ordinary HTML forms, so they work before any script loads.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  // Keep the raw body: webhook signatures are computed over the exact bytes sent.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as unknown as { rawBody: string }).rawBody = body as string;
    if (!body) return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      (err as { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  });

  // Uploaded files arrive as the raw request body. The route checks what the bytes really are.
  app.addContentTypeParser(UPLOAD_CONTENT_TYPES, { parseAs: 'buffer', bodyLimit: MAX_DOCUMENT_BYTES }, (_req, body, done) => {
    done(null, body);
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Preshift API',
        version: '1.0.0',
        description:
          'Rota, time and attendance, and payroll for UK hospitality. Every Preshift screen runs on this API, ' +
          'and payroll is native to TeamPay: starters, leavers and approved hours flow to TeamPay, and pay runs flow back ' +
          'to reconcile against the labour accrual. Access is role based, scoped by site, and checked for paired duties.\n\n' +
          'Authenticate with `Authorization: Bearer psk_...`, a key a person with the settings permission makes under Settings, API keys, limited to the scopes ' +
          'it needs. Each key reaches its own organisation only and may make 300 requests a minute. ' +
          'Webhooks tell your system when something changes: register an https endpoint, then verify the ' +
          '`preshift-signature` header (`t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body" with the endpoint secret>`) on every event. ' +
          'Events carry ids, never personal data; fetch the detail with your key.',
      },
      tags: [
        { name: 'Reference' },
        { name: 'Employees' },
        { name: 'Shifts' },
        { name: 'Rota' },
        { name: 'Forecast' },
        { name: 'Webhooks', description: 'Signed event notifications to your own https endpoint.' },
      ],
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
      security: [{ bearer: [] }],
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs', ...(options.docsBaseDir ? { baseDir: options.docsBaseDir } : {}) });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message, details: err.details });
    }
    if (err.validation) return reply.code(400).send({ error: 'invalid_request', message: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: 'bad_request', message: err.message });
    app.log.error(err);
    return reply.code(500).send({ error: 'internal', message: 'Something went wrong' });
  });

  app.get('/health', { schema: { hide: true } }, async (_req, reply) => {
    const database = store instanceof PgStore ? await store.status() : 'not configured';
    const ok = database === 'ok' || database === 'not configured';
    return reply.code(ok ? 200 : 503).send({
      ok,
      ...(demo ? { demo: true } : {}),
      payroll: payroll.provider.name,
      storage: store instanceof PgStore ? 'postgres' : 'memory',
      database,
      documents: documents.status,
      // Which build is live, so a check run after a deploy can wait for it. Vercel sets this on git deployments.
      ...(env.VERCEL_GIT_COMMIT_SHA ? { commit: env.VERCEL_GIT_COMMIT_SHA.slice(0, 7) } : {}),
    });
  });

  // Scheduled retry of anything payroll has not yet confirmed (Vercel Cron sends CRON_SECRET).
  app.get('/internal/dispatch', { schema: { hide: true } }, async (req, reply) => {
    if (!env.CRON_SECRET || req.headers.authorization !== `Bearer ${env.CRON_SECRET}`) return reply.code(401).send();
    await ctx.dispatcher.processDue();
    await syncAllTills(ctx, { simulatorAllowed: demo || !!payroll.simulator });
    await syncAllRewards(ctx, { simulatorAllowed: demo || !!payroll.simulator });
    await deliverAllWebhooks(store, options.webhookFetch);
    await store.purgeApiCalls(new Date(Date.now() - API_CALL_RETENTION_DAYS * 86_400_000).toISOString());
    // Once a day per organisation: weather, event feeds and the forecast ahead. This route also ticks the
    // payroll outbox and may run often, so organisations already refreshed today are skipped, the longest
    // waiting go first, the run stops before the function's time runs out, and one organisation failing
    // never stops the rest.
    const today = londonToday(ctx);
    const started = Date.now();
    // Once a day per organisation: approved pay changes dated today take effect, and finance hears
    // what waits. Kept apart from the refresh below, which skips organisations with nothing to fetch.
    let payRuns = 0;
    for (const orgId of await store.orgIds()) {
      if (Date.now() - started > 20_000) break;
      try {
        const org = await store.load(orgId);
        if (org.payDailyOn === today || (!org.payChanges.some((c) => c.status === 'pending' || (c.status === 'approved' && !c.appliedOn)))) continue;
        await payDaily(store, org, today);
        try {
          await store.save(org);
        } catch (err) {
          if (!(err instanceof HttpError && err.statusCode === 409)) throw err;
          // Someone saved meanwhile. Apply again over their copy, and mark the day done so the reminder is not sent twice.
          const fresh = await store.load(orgId);
          applyDuePayChanges(fresh, today);
          fresh.payDailyOn = today;
          await store.save(fresh);
        }
        payRuns++;
      } catch (err) {
        app.log.error({ orgId, err: (err as Error).message }, 'daily pay run failed');
      }
    }
    const due: { orgId: string; last: string }[] = [];
    for (const orgId of await store.orgIds()) {
      // Demo sandboxes last a day and fetch nothing from outside.
      if (isSandbox(orgId)) continue;
      const org = await store.load(orgId);
      if (org.lastOutsideRefresh === today) continue;
      // Somewhere to look for weather or events, or pushed bookings waiting to become pace history.
      const outside = org.state.sites.some((s) => s.location || s.geofence) || org.eventFeeds.length > 0;
      const bookingsToCompact = (org.state.bookings ?? []).some((b) => b.date < addDays(today, -2));
      if (!outside && !bookingsToCompact) continue;
      due.push({ orgId, last: org.lastOutsideRefresh ?? '' });
    }
    due.sort((a, b) => a.last.localeCompare(b.last));
    let refreshed = 0;
    const failed: string[] = [];
    for (const { orgId } of due) {
      if (Date.now() - started > 40_000) break;
      try {
        // Fetch once. If someone saved the organisation meanwhile, lay the same results over a fresh copy
        // with the same merges, so their change survives; never copy whole lists across.
        const org = await store.load(orgId);
        const fetched = await fetchOutside(ctx, org, today);
        applyOutside(org, fetched, today, 'scheduled refresh');
        org.lastOutsideRefresh = today;
        try {
          await store.save(org);
        } catch (err) {
          if (!(err instanceof HttpError && err.statusCode === 409)) throw err;
          const fresh = await store.load(orgId);
          applyOutside(fresh, fetched, today, 'scheduled refresh');
          fresh.lastOutsideRefresh = today;
          await store.save(fresh);
        }
        refreshed++;
      } catch (err) {
        app.log.error({ orgId, err: (err as Error).message }, 'outside refresh failed');
        failed.push(orgId);
      }
    }
    // Journey times between sites drift as routes and timetables change: plan any out of date
    // ones again with what time is left. Sandboxes keep their seeded times.
    const journeys = Date.now() - started < 40_000 ? await refreshStaleTravel(store, ctx.fetch, ctx.tflAppKey, today, { skip: isSandbox, deadline: started + 50_000 }) : 0;
    return { ok: true, refreshed, failed: failed.length, waiting: due.length - refreshed - failed.length, journeys, payRuns };
  });

  // Every 15 minutes: webhook retries that no request has picked up, so a partner that was down
  // hears within the quarter hour of coming back, even from an organisation nobody is editing.
  app.get('/internal/webhooks', { schema: { hide: true } }, async (req, reply) => {
    if (!env.CRON_SECRET || req.headers.authorization !== `Bearer ${env.CRON_SECRET}`) return reply.code(401).send();
    await deliverAllWebhooks(store, options.webhookFetch);
    return { ok: true };
  });

  // Each morning: every manager hears what staff have asked for that is theirs to decide. Once a
  // day per organisation, however often it is called.
  app.get('/internal/digest', { schema: { hide: true } }, async (req, reply) => {
    if (!env.CRON_SECRET || req.headers.authorization !== `Bearer ${env.CRON_SECRET}`) return reply.code(401).send();
    return { ok: true, ...(await sendManagerDigests(store, londonToday(ctx), (msg, detail) => app.log.error(detail, msg))) };
  });

  // Every five minutes: shift reminders, and an alert when someone has not clocked in for a shift
  // that has started. Each is sent once, however often this runs.
  app.get('/internal/reminders', { schema: { hide: true } }, async (req, reply) => {
    if (!env.CRON_SECRET || req.headers.authorization !== `Bearer ${env.CRON_SECRET}`) return reply.code(401).send();
    return { ok: true, ...(await runShiftAlerts(store, ctx.now(), (msg, detail) => app.log.error(detail, msg))) };
  });

  // The demo's midnight reset, scheduled either side of midnight UTC so it lands just after
  // midnight UK time in winter and summer alike. Runs whether or not the demo is switched on,
  // so switching it off still clears what visitors left.
  app.get('/internal/demo-reset', { schema: { hide: true } }, async (req, reply) => {
    if (!env.CRON_SECRET || req.headers.authorization !== `Bearer ${env.CRON_SECRET}`) return reply.code(401).send();
    return { removed: await sweepSandboxes(store) };
  });

  const keys = options.apiKeys ?? loadApiKeys(env);
  const auth = authenticate(keys, store, { rateLimit: options.rateLimit });
  // Billing through Stripe for organisations that signed themselves up (server/billing.ts).
  const stripe = stripeFromEnv(env);
  const signup = options.signup ?? env.PRESHIFT_SIGNUP === '1';
  demoRoutes(app, store, { enabled: demo, appPath: '/app/', demoPage: options.demoPage ?? path.resolve('site/demo.html') });
  signInRoutes(app, ctx, { demo, signup, stripe: !!stripe });
  signupRoutes(app, ctx, { enabled: signup, trialDays: trialDaysFromEnv(env) });
  stripeWebhookRoutes(app, ctx, stripe);
  // Claude and other MCP clients, with the same keys and the same rules as the API it calls.
  mcpRoutes(app, auth);
  // Sign in with Preshift for claude.ai and other MCP clients: tokens that act as the person who approved them.
  oauthRoutes(app, store);
  staffRoutes(app, ctx);
  kioskRoutes(app, ctx);
  assistantRoutes(app, store, { demoKey: demo ? env.PRESHIFT_DEMO_CLAUDE_KEY : undefined });
  webRoutes(app, store, {
    loginPage: options.loginPage ?? path.resolve('site/login.html'),
    appDir: options.appDir,
    staffDir: options.staffDir,
    kioskDir: options.kioskDir,
  });
  await app.register(async (api) => {
    const isWebhook = (url: string) => url.startsWith('/v1/integrations/teampay/webhook/');
    api.addHook('onRequest', async (req, reply) => {
      if (isWebhook(req.url)) return;
      return auth(req, reply);
    });
    // Demo visitors reach only the routes on the sandbox allowlist, refused before the body is even
    // validated. Customers are not affected.
    const guard = sandboxGuard(demo);
    api.addHook('preValidation', async (req) => {
      if (!isWebhook(req.url)) await guard(req);
    });
    // Load the organisation once per request; webhooks name it in the path, everything else by API key.
    api.addHook('preHandler', async (req) => {
      const orgId = isWebhook(req.url) ? (req.params as { orgId: string }).orgId : req.principal.orgId;
      // A webhook names its organisation in an unauthenticated path, so it must never create one.
      // The handler checks the signature first, so the reply does not say which organisations exist.
      if (isWebhook(req.url) && !(await store.has(orgId))) return;
      req.org = await store.load(orgId);
    });
    // A demo sandbox's takings move on with the clock, so the cut call has a day to read whenever it is opened.
    api.addHook('preHandler', async (req) => {
      if (req.method === 'GET' && req.routeOptions.url === '/v1/sales' && req.org && keepSandboxTrading(req.org, ctx.now())) req.orgTouched = true;
    });
    // An organisation whose trial or subscription has lapsed keeps reading everything, and changes
    // nothing until someone pays. Paying, the person's own sign-in and data protection duties go on.
    api.addHook('preHandler', async (req) => {
      if (req.method === 'GET' || !req.org || isWebhook(req.url) || isSandbox(req.org.orgId) || allowedWhileLocked(req.routeOptions.url)) return;
      if (standingOf(await getBilling(store, req.org.orgId), ctx.now(), !!stripe).locked) throw new HttpError(402, 'billing_required', LOCKED_MESSAGE);
    });
    // Save once, only after a successful write, so a failed request leaves nothing half done.
    api.addHook('onSend', async (req, reply, payload) => {
      if (req.org && req.method === 'GET' && req.orgTouched && !req.orgChanged && reply.statusCode < 400) {
        await store.save(req.org).catch(() => undefined);
        return payload;
      }
      if (!req.org || (req.method === 'GET' && !req.orgChanged) || reply.statusCode >= 400) return payload;
      try {
        // Events this request raised go out now, inside it, so they are saved as sent with it.
        if (ctx.autoDispatch) await deliverWebhooks(req.org, options.webhookFetch);
        // Staff hear about a change only once it is certain to save: emailed here, recorded as sent with it.
        await deliverNotifications(store, req.org);
        await store.save(req.org);
        return payload;
      } catch (err) {
        const e = err instanceof HttpError ? err : new HttpError(500, 'internal', 'Could not save');
        reply.code(e.statusCode).header('content-type', 'application/json; charset=utf-8');
        return JSON.stringify({ error: e.code, message: e.message });
      }
    });
    // Every call made with an API key is recorded, refused ones included, after the save above so
    // the status is final. Written before the response leaves: on serverless hosting work after it
    // can be cut off, and an access log with gaps proves nothing. A failed write never fails the call.
    api.addHook('onSend', async (req, reply, payload) => {
      const call = req.apiCall;
      if (!call) return payload;
      const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
      await store
        .logApiCall({
          orgId: call.orgId,
          keyId: call.keyId,
          at: new Date(call.started).toISOString(),
          method: req.method,
          path: req.url,
          status: reply.statusCode,
          ip: forwarded || req.ip,
          ms: Date.now() - call.started,
          ...(call.refused ? { refused: call.refused } : {}),
        })
        .catch((err) => app.log.error(err, 'Could not record an API call'));
      return payload;
    });
    rotaRoutes(api, ctx);
    employeeRoutes(api, ctx);
    payRoutes(api, ctx);
    setupRoutes(api, ctx);
    hrRoutes(api, ctx);
    documentRoutes(api, ctx);
    hrFileRoutes(api, ctx);
    timeRoutes(api, ctx);
    labourRoutes(api, ctx);
    clockingRoutes(api, ctx);
    insightRoutes(api, ctx);
    calendarRoutes(api, ctx);
    bookingRoutes(api, ctx);
    travelRoutes(api, ctx);
    eposRoutes(api, ctx, { simulatorAllowed: demo || !!payroll.simulator });
    payrollRoutes(api, ctx);
    payrollLinkRoutes(api, ctx);
    cashRoutes(api, ctx);
    accountingRoutes(api, ctx, { xero: xeroFromEnv(env), simulatorAllowed: demo || !!payroll.simulator });
    welfareRoutes(api, ctx, { simulatorAllowed: demo || !!payroll.simulator });
    userRoutes(api, ctx);
    clientRoutes(api, ctx);
    supportRoutes(api, ctx);
    billingRoutes(api, ctx, { stripe, appUrl: env.PRESHIFT_APP_URL?.replace(/\/+$/, '') || undefined });
    authenticatorRoutes(api, ctx);
    privacyRoutes(api, ctx);
    devRoutes(api, ctx);
    settingsRoutes(api, ctx);
    developerRoutes(api, ctx, { production: env.NODE_ENV === 'production' || env.VERCEL === '1', fetcher: options.webhookFetch });
    // People who manage are on userRoutes; staff app logins answer to the same access rules.
    staffAdminRoutes(api, ctx);
    // What staff ask for in the staff app, decided here by whoever runs their rota or team.
    requestRoutes(api, ctx);
    kioskAdminRoutes(api, ctx);
  });

  return { app, ctx, routes };
}

