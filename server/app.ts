import Fastify, { type FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { authenticate, loadApiKeys, type ApiKey } from './auth';
import { HttpError, type AppContext } from './context';
import type { PayrollProvider } from './integrations/payroll/provider';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { TeamPayProvider } from './integrations/payroll/teampay';
import { OutboxDispatcher } from './outbox';
import { accessRoutes, signInRoutes } from './routes/access';
import { assistantRoutes } from './routes/assistant';
import { devRoutes } from './routes/dev';
import { employeeRoutes } from './routes/employees';
import { payrollRoutes } from './routes/payroll';
import { rotaRoutes } from './routes/rota';
import { timeRoutes } from './routes/time';
import { clockingRoutes } from './routes/clocking';
import { staffAdminRoutes, staffRoutes } from './routes/staff';
import { webRoutes } from './routes/web';
import path from 'node:path';
import { neon } from '@neondatabase/serverless';
import { MemoryStore, PgStore, type Store } from './store';

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

export async function buildApp(options: BuildOptions = {}): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const env = options.env ?? process.env;
  const app = Fastify({ logger: options.logger ?? false });
  const store = options.store ?? storeFromEnv(env);
  const payroll = options.provider
    ? { provider: options.provider, simulator: options.provider instanceof TeamPaySimulator ? options.provider : undefined }
    : payrollFromEnv(env);
  const providerFor = () => payroll.provider;
  const employers = { defaultEmployerId: env.TEAMPAY_EMPLOYER_ID || undefined, simulated: !!payroll.simulator };
  const ctx: AppContext = {
    store,
    providerFor,
    employers,
    simulator: payroll.simulator,
    dispatcher: new OutboxDispatcher(store, providerFor, employers),
    autoDispatch: options.autoDispatch ?? true,
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

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Preshift API',
        version: '1.0.0',
        description:
          'Rota, time and attendance, and payroll for UK hospitality. Every Preshift screen runs on this API, ' +
          'and payroll is native to TeamPay: starters, leavers and approved hours flow to TeamPay, and pay runs flow back ' +
          'to reconcile against the labour accrual.',
      },
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
      payroll: payroll.provider.name,
      storage: store instanceof PgStore ? 'postgres' : 'memory',
      database,
    });
  });

  // Scheduled retry of anything payroll has not yet confirmed (Vercel Cron sends CRON_SECRET).
  app.get('/internal/dispatch', { schema: { hide: true } }, async (req, reply) => {
    if (!env.CRON_SECRET || req.headers.authorization !== `Bearer ${env.CRON_SECRET}`) return reply.code(401).send();
    await ctx.dispatcher.processDue();
    return { ok: true };
  });

  const keys = options.apiKeys ?? loadApiKeys(env);
  const auth = authenticate(keys, store);
  signInRoutes(app, store);
  staffRoutes(app, store);
  assistantRoutes(app, store);
  webRoutes(app, store, { loginPage: options.loginPage ?? path.resolve('site/login.html'), appDir: options.appDir, staffDir: options.staffDir });
  await app.register(async (api) => {
    const isWebhook = (url: string) => url.startsWith('/v1/integrations/teampay/webhook/');
    api.addHook('onRequest', async (req, reply) => {
      if (isWebhook(req.url)) return;
      return auth(req, reply);
    });
    // Load the organisation once per request; webhooks name it in the path, everything else by API key.
    api.addHook('preHandler', async (req) => {
      const orgId = isWebhook(req.url) ? (req.params as { orgId: string }).orgId : req.principal.orgId;
      req.org = await store.load(orgId);
    });
    // Save once, only after a successful write, so a failed request leaves nothing half done.
    api.addHook('onSend', async (req, reply, payload) => {
      if (!req.org || req.method === 'GET' || reply.statusCode >= 400) return payload;
      try {
        await store.save(req.org);
        return payload;
      } catch (err) {
        const e = err instanceof HttpError ? err : new HttpError(500, 'internal', 'Could not save');
        reply.code(e.statusCode).header('content-type', 'application/json; charset=utf-8');
        return JSON.stringify({ error: e.code, message: e.message });
      }
    });
    rotaRoutes(api, ctx);
    employeeRoutes(api, ctx);
    timeRoutes(api, ctx);
    clockingRoutes(api, ctx);
    payrollRoutes(api, ctx);
    devRoutes(api, ctx);
    accessRoutes(api, store);
    staffAdminRoutes(api, store);
  });

  return { app, ctx };
}

