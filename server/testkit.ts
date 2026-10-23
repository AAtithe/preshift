// Shared by the tests that sign people in: real accounts, cookies signed with the key kept in the
// store, and the authenticator steps. Never imported by the app.

import type { FastifyInstance } from 'fastify';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { seedUsers } from './seedUsers';
import { COOKIE, createSession } from './session';
import { MemoryStore, type Store, type UserRecord } from './store';
import { codeAt, stepAt } from './totp';

export const TODAY = '2026-10-21';

/** An account that signs in by cookie only: its password hash matches nothing. */
export const account = (email: string, orgId = 'demo'): UserRecord => ({
  email, orgId, role: 'member', salt: '0'.repeat(32), hash: '0'.repeat(128), createdAt: '', sessionsValidFrom: 0, failedAttempts: 0, lockedUntil: 0,
});

/** Accounts for every seeded person, so their sessions are real ones. */
export async function seedAccounts(store: Store) {
  for (const u of seedUsers(TODAY).users) await store.createUser(account(u.email));
}

export interface Kit {
  app: FastifyInstance;
  store: Store;
  /** A signed-in cookie header for an email with an account. */
  as: (email: string, mfa?: string) => Promise<string>;
  call: (method: string, url: string, who: { cookie?: string; key?: string } | string | null, body?: unknown) => Promise<{ status: number; body: any; raw: string; cookie?: string; location?: string }>;
  form: (url: string, fields: Record<string, string>) => Promise<{ status: number; location?: string; cookie?: string }>;
}

export async function kit(options: { store?: Store; keys?: { key: string; orgId: string; name: string; scopes: ['*']; userId?: string; mfa?: boolean }[]; accounts?: boolean; fetch?: typeof fetch; now?: () => Date; env?: NodeJS.ProcessEnv; signup?: boolean } = {}): Promise<Kit> {
  const store = options.store ?? new MemoryStore(['demo'], TODAY);
  if (options.accounts !== false) await seedAccounts(store);
  const { app } = await buildApp({ apiKeys: options.keys ?? [], store, provider: new TeamPaySimulator(), autoDispatch: false, fetch: options.fetch, now: options.now, env: options.env, signup: options.signup });
  const cookieOf = (set: unknown) => (typeof set === 'string' ? set.split(';')[0] : Array.isArray(set) ? String(set[0]).split(';')[0] : undefined);
  const kitObj: Kit = {
    app,
    store,
    as: async (email, mfa) => `${COOKIE}=${await createSession({ email, orgId: (await store.getUser(email))?.orgId ?? 'demo' }, await store.sessionSecret(), Date.now(), mfa)}`,
    async call(method, url, who, body) {
      const auth = typeof who === 'string' ? { cookie: who } : who?.cookie ? { cookie: who.cookie } : who?.key ? { authorization: `Bearer ${who.key}` } : {};
      const res = await app.inject({
        method: method as 'GET',
        url,
        headers: { ...auth, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        payload: body !== undefined ? JSON.stringify(body) : undefined,
      });
      let parsed: unknown;
      try {
        parsed = res.body ? res.json() : undefined;
      } catch {
        parsed = res.body;
      }
      return { status: res.statusCode, body: parsed, raw: res.body, cookie: cookieOf(res.headers['set-cookie']), location: res.headers.location as string | undefined };
    },
    async form(url, fields) {
      const res = await app.inject({ method: 'POST', url, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(fields).toString() });
      return { status: res.statusCode, location: res.headers.location as string | undefined, cookie: cookieOf(res.headers['set-cookie']) };
    },
  };
  return kitObj;
}

/** Enters a code from an authenticator with this secret; returns the session cookie that proves it. */
export async function enterCode(k: Kit, cookie: string, secret: string) {
  const res = await k.call('POST', '/v1/me/authenticator/verify', cookie, { code: codeAt(secret, stepAt(Date.now())) });
  if (res.status !== 200) throw new Error(`verify failed: ${res.status} ${res.raw}`);
  return res.cookie!;
}

/** Sets up an authenticator from scratch; returns the proved cookie, the secret and the recovery codes. */
export async function enrol(k: Kit, cookie: string) {
  const start = await k.call('POST', '/v1/me/authenticator/start', cookie);
  if (start.status !== 200) throw new Error(`start failed: ${start.status} ${start.raw}`);
  const confirm = await k.call('POST', '/v1/me/authenticator/confirm', cookie, { code: codeAt(start.body.secret, stepAt(Date.now())) });
  if (confirm.status !== 200) throw new Error(`confirm failed: ${confirm.status} ${confirm.raw}`);
  return { cookie: confirm.cookie!, secret: start.body.secret as string, recoveryCodes: confirm.body.recoveryCodes as string[] };
}

/** The token in a link the API returned, as the login page reads it from after the #. */
export const tokenOf = (inviteUrl: string) => decodeURIComponent(inviteUrl.split(/#(?:invite|reset)=/)[1]);
