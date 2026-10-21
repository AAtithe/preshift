import type { FastifyReply, FastifyRequest } from 'fastify';
import { DEMO_OWNER_ID, seedUsers } from './seedUsers';
import { cookieFrom, readSession } from './session';

export type Scope = 'rota:read' | 'rota:write' | 'time:write' | 'time:approve' | 'payroll:write' | 'users:manage' | '*';

export interface ApiKey {
  key: string;
  orgId: string;
  name: string;
  scopes: Scope[];
  /**
   * A personal key acts as that person: their roles decide, not the key's scopes alone.
   * Keys without a user are system keys with organisation-wide authority.
   */
  userId?: string;
  /** Set for a signed-in session: the person is found by this email in their organisation's access records. */
  email?: string;
  /** A session's verified enrolment id, from the cookie. */
  sessionMfa?: string;
  /**
   * A personal key counts as having passed the authenticator only when its issuer says so.
   * Keys are long-lived secrets, not people at a keyboard, so the default is no.
   */
  mfa?: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal: ApiKey;
  }
}

/**
 * Keys come from PRESHIFT_API_KEYS as JSON: [{"key":"...","orgId":"...","name":"...","scopes":["*"],"userId":"optional"}].
 * Outside production a development key is available so the demo runs with no setup.
 */
export function loadApiKeys(env = process.env): ApiKey[] {
  if (env.PRESHIFT_API_KEYS) return JSON.parse(env.PRESHIFT_API_KEYS) as ApiKey[];
  if (env.NODE_ENV === 'production') return [];
  // The demo acts as the seeded owner, so access rules apply locally as they would to a person.
  // Each seeded person also has a key (dev-<userId>), so the demo can sign in as anyone and show the controls.
  const people = seedUsers(new Date().toISOString().slice(0, 10)).users;
  return [
    // Demo keys stand in for people who have entered their code, so the demo shows roles as they work.
    { key: 'dev-key', orgId: 'demo', name: 'Development', scopes: ['*'], userId: DEMO_OWNER_ID, mfa: true },
    ...people.map((u) => ({ key: `dev-${u.id}`, orgId: 'demo', name: `${u.name} (demo)`, scopes: ['*' as const], userId: u.id, mfa: true })),
  ];
}

/**
 * Integrations authenticate with an API key. People in the web app authenticate with the signed
 * session cookie from signing in, scoped to their own organisation, so the browser carries no key.
 */
export function authenticate(keys: ApiKey[], sessionSecret: string | null = null) {
  const byKey = new Map(keys.map((k) => [k.key, k]));
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const keyed = byKey.get(token);
    if (keyed) {
      req.principal = keyed;
      return;
    }
    const user = await readSession(cookieFrom(req.headers.cookie), sessionSecret);
    if (!user) return reply.code(401).send({ error: 'unauthorised', message: 'Sign in, or send a valid API key' });
    // The scopes let a session reach every route; the person's access record then decides (server/guard.ts).
    req.principal = { key: `session:${user.email}`, orgId: user.orgId, name: user.email, scopes: ['*'], email: user.email, sessionMfa: user.mfa };
  };
}

export function requireScope(scope: Scope) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const scopes = req.principal?.scopes ?? [];
    if (!scopes.includes('*') && !scopes.includes(scope)) {
      return reply.code(403).send({ error: 'forbidden', message: `This key lacks the ${scope} scope` });
    }
  };
}
