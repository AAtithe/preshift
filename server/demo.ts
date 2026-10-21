import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { seedState } from '../src/engine/seed';
import { sessionUser } from './auth';
import { hashPassword } from './passwords';
import { createSession, sessionCookie } from './session';
import { audit, type Store } from './store';

// The public demo. With PRESHIFT_DEMO=1 a deployment becomes a sandbox for prospects: anyone who
// opens /demo gets their own organisation, seeded with the demo group, and is signed in to it as
// its admin without creating an account. Nobody sees anyone else's sandbox, payroll always runs
// against the TeamPay simulator, and sandboxes are deleted after SANDBOX_HOURS. Run it as its own
// deployment with its own database, never on the system that holds customer data.

const PREFIX = 'sandbox-';
export const SANDBOX_HOURS = 24;
/** Claude calls one sandbox may make on the shared demo key. One assistant request is several calls. */
export const ASSISTANT_CALLS = 40;
const SWEEP_EVERY_MS = 10 * 60 * 1000;

export const isSandbox = (orgId: string) => orgId.startsWith(PREFIX);

/** When the sandbox was created, from its id (epoch milliseconds), or null for any other organisation. */
export function sandboxCreatedAt(orgId: string): number | null {
  if (!isSandbox(orgId)) return null;
  const t = parseInt(orgId.slice(PREFIX.length).split('-')[0], 36);
  return Number.isFinite(t) ? t : null;
}

const secure = (req: FastifyRequest) => req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';

/** Deletes sandboxes older than SANDBOX_HOURS, with their visitor account and assistant allowance. */
export async function sweepSandboxes(store: Store, now = Date.now()): Promise<number> {
  let removed = 0;
  for (const orgId of await store.orgIds()) {
    const created = sandboxCreatedAt(orgId);
    if (created === null || now - created < SANDBOX_HOURS * 3600_000) continue;
    for (const user of await store.listUsers(orgId)) await store.deleteUser(user.email);
    await store.setSetting(assistantCallsSetting(orgId), null);
    await store.deleteOrg(orgId);
    removed++;
  }
  return removed;
}

export const assistantCallsSetting = (orgId: string) => `demo_assistant_calls:${orgId}`;

/** Requests a sandbox visitor may not make: managing access, saving a Claude key, passwords, owner setup. */
export function demoRefuses(method: string, url: string): boolean {
  const path = url.split('?')[0];
  if (method === 'POST' && (path === '/auth/setup' || path === '/auth/password')) return true;
  if (method === 'PUT' && path === '/v1/settings/claude-api-key') return true;
  return method !== 'GET' && (path === '/v1/users' || path.startsWith('/v1/users/'));
}

export function demoRoutes(app: FastifyInstance, store: Store, options: { appPath: string }) {
  let lastSweep = 0;

  app.addHook('onRequest', async (req, reply) => {
    if (demoRefuses(req.method, req.url)) {
      return reply.code(403).send({ error: 'demo', message: 'This is the public demo, so accounts, passwords and keys cannot be changed here.' });
    }
  });

  // Open the demo. A visitor already in a sandbox goes back to it; ?fresh=1 starts a new one.
  app.get<{ Querystring: { fresh?: string } }>('/demo', { schema: { hide: true } }, async (req, reply) => {
    const current = await sessionUser(req.headers.cookie, store);
    if (current && isSandbox(current.orgId) && !req.query.fresh) {
      return reply.code(303).header('location', options.appPath).send();
    }

    if (Date.now() - lastSweep > SWEEP_EVERY_MS) {
      lastSweep = Date.now();
      void sweepSandboxes(store).catch((err) => app.log.error(err));
    }

    const orgId = `${PREFIX}${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`;
    const org = await store.load(orgId);
    org.state = seedState();
    const email = `visitor@${orgId}.demo`;
    // Nobody ever types this password: the visitor is signed in by the cookie set below.
    const user = {
      email,
      orgId,
      role: 'admin' as const,
      ...(await hashPassword(randomBytes(24).toString('hex'))),
      createdAt: new Date().toISOString(),
      sessionsValidFrom: 0,
      failedAttempts: 0,
      lockedUntil: 0,
    };
    await store.createUser(user);
    audit(org, email, 'demo.sandbox_created');
    await store.save(org);

    const token = await createSession(user, await store.sessionSecret());
    return reply.code(303).header('set-cookie', sessionCookie(token, secure(req))).header('location', options.appPath).send();
  });
}
