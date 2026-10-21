import Fastify, { type FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { authenticate, loadApiKeys, type ApiKey } from './auth';
import { HttpError, type AppContext } from './context';
import type { PayrollProvider } from './integrations/payroll/provider';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { TeamPayProvider } from './integrations/payroll/teampay';
import { OutboxDispatcher } from './outbox';
import { devRoutes } from './routes/dev';
import { employeeRoutes } from './routes/employees';
import { payrollRoutes } from './routes/payroll';
import { rotaRoutes } from './routes/rota';
import { timeRoutes } from './routes/time';
import { MemoryStore } from './store';

export interface BuildOptions {
  apiKeys?: ApiKey[];
  store?: MemoryStore;
  /** Supply a provider directly (tests). Otherwise TeamPay if configured, else the simulator. */
  provider?: PayrollProvider;
  autoDispatch?: boolean;
  logger?: boolean;
  env?: NodeJS.ProcessEnv;
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

export async function buildApp(options: BuildOptions = {}): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const env = options.env ?? process.env;
  const app = Fastify({ logger: options.logger ?? false });
  const store = options.store ?? new MemoryStore();
  const payroll = options.provider
    ? { provider: options.provider, simulator: options.provider instanceof TeamPaySimulator ? options.provider : undefined }
    : payrollFromEnv(env);
  const providerFor = () => payroll.provider;
  const ctx: AppContext = {
    store,
    providerFor,
    simulator: payroll.simulator,
    dispatcher: new OutboxDispatcher(store, providerFor),
    autoDispatch: options.autoDispatch ?? true,
  };

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
  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message, details: err.details });
    }
    if (err.validation) return reply.code(400).send({ error: 'invalid_request', message: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: 'bad_request', message: err.message });
    app.log.error(err);
    return reply.code(500).send({ error: 'internal', message: 'Something went wrong' });
  });

  app.get('/health', { schema: { hide: true } }, async () => ({ ok: true, payroll: payroll.provider.name }));

  const keys = options.apiKeys ?? loadApiKeys(env);
  const auth = authenticate(keys);
  await app.register(async (api) => {
    api.addHook('onRequest', async (req, reply) => {
      if (req.url.startsWith('/v1/integrations/teampay/webhook/')) return;
      return auth(req, reply);
    });
    rotaRoutes(api, ctx);
    employeeRoutes(api, ctx);
    timeRoutes(api, ctx);
    payrollRoutes(api, ctx);
    devRoutes(api, ctx);
  });

  return { app, ctx };
}
