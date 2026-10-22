import { buildApp } from './app';
import { hashPassword } from './passwords';
import { MemoryStore } from './store';

const DEV_USER = { email: 'dev@preshift.local', password: 'preshift-dev-password' };

const port = Number(process.env.PORT ?? 8787);
const { app, ctx } = await buildApp({ logger: true });

// Local development without a database starts empty on every restart, so give it a ready-made
// admin rather than asking for the owner set-up each time. Never with a real database. Locally the
// same person also plays the WS lead, so the labour programme can be tried end to end.
if (process.env.NODE_ENV !== 'production' && ctx.store instanceof MemoryStore) {
  await ctx.store.createUser({
    email: DEV_USER.email,
    orgId: 'demo',
    role: 'admin',
    ...(await hashPassword(DEV_USER.password)),
    createdAt: new Date().toISOString(),
    sessionsValidFrom: 0,
    failedAttempts: 0,
    lockedUntil: 0,
    leadOrgs: ['demo'],
  });
  app.log.info(`Sign in locally as ${DEV_USER.email} / ${DEV_USER.password}`);
}

// Safety net for anything the immediate dispatch could not deliver (retries with backoff).
setInterval(() => void ctx.dispatcher.processDue(), 15_000).unref();

await app.listen({ port, host: '0.0.0.0' });
app.log.info(`Preshift API on :${port}, docs at /docs, payroll via ${ctx.providerFor('demo').name}`);
if (process.env.PRESHIFT_DEMO === '1') app.log.info('Public demo on: open /demo for a sandbox of your own, alongside the dev account');
