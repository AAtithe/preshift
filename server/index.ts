import { buildApp } from './app';
import { hashPassword } from './passwords';
import { seedHistory, seedLiveDay } from '../src/engine/seedHistory';
import { londonParts } from '../src/engine/time';
import { MemoryStore } from './store';

const DEV_USER = { email: 'dev@preshift.local', password: 'preshift-dev-password' };

const port = Number(process.env.PORT ?? 8787);
const { app, ctx } = await buildApp({ logger: true });

// Local development without a database starts empty on every restart, so give it a ready-made
// admin rather than asking for the owner set-up each time. Never with a real database. To try the
// labour programme's sign-offs locally, act as the WS client partner from the demo people.
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
  });
  // The sample group's trading history, and today traded up to now so the cut call has a live day to read.
  // The memory store holds the object itself, so there is nothing to save.
  const demo = await ctx.store.load('demo');
  const live = londonParts(new Date());
  const history = seedHistory(demo.state, live.date);
  demo.state = seedLiveDay(history.state, live.date, live.minute);
  demo.timeEntries = history.timeEntries;
  app.log.info(`Sign in locally as ${DEV_USER.email} / ${DEV_USER.password}`);
}

// Safety net for anything the immediate dispatch could not deliver (retries with backoff).
setInterval(() => void ctx.dispatcher.processDue(), 15_000).unref();

await app.listen({ port, host: '0.0.0.0' });
app.log.info(`Preshift API on :${port}, docs at /docs, payroll via ${ctx.providerFor('demo').name}`);
if (process.env.PRESHIFT_DEMO === '1') app.log.info('Public demo on: open /demo for a sandbox of your own, alongside the dev account');
