import type { FastifyReply, FastifyRequest } from 'fastify';
import { DEMO_OWNER_ID, seedUsers } from './seedUsers';
import { cookieFrom, readSession, type SessionClaims } from './session';
import type { UserRecord, UserStore } from './store';

export type Scope = 'rota:read' | 'rota:write' | 'time:write' | 'time:approve' | 'payroll:write' | 'users:manage' | '*';

export interface ApiKey {
  key: string;
  orgId: string;
  name: string;
  scopes: Scope[];
  /** Set when the caller is a signed-in person rather than an integration key. */
  user?: { email: string; role: UserRecord['role'] };
  /**
   * A personal key acts as that person: their roles decide, not the key's scopes alone.
   * Keys without a user are system keys with organisation-wide authority.
   */
  userId?: string;
  /** Set for a signed-in session: the person is found by this email in their organisation's access records. */
  email?: string;
  /** A session's verified authenticator enrolment id, from the cookie. */
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
 * Keys come from PRESHIFT_API_KEYS as JSON: [{"key":"...","orgId":"...","name":"...","scopes":["*"],"userId":"optional","mfa":false}].
 * Outside production a development key is available so the demo runs with no setup.
 */
export function loadApiKeys(env = process.env): ApiKey[] {
  if (env.PRESHIFT_API_KEYS) return JSON.parse(env.PRESHIFT_API_KEYS) as ApiKey[];
  if (env.NODE_ENV === 'production') return [];
  // The demo acts as the seeded owner, so access rules apply locally as they would to a person.
  // Each seeded person also has a key (dev-<userId>), so the demo can sign in as anyone and show the controls.
  // Demo keys stand in for people who have entered their authenticator code.
  const people = seedUsers(new Date().toISOString().slice(0, 10)).users;
  return [
    { key: 'dev-key', orgId: 'demo', name: 'Development', scopes: ['*'], userId: DEMO_OWNER_ID, mfa: true },
    ...people.map((u) => ({ key: `dev-${u.id}`, orgId: 'demo', name: `${u.name} (demo)`, scopes: ['*' as const], userId: u.id, mfa: true })),
  ];
}

/**
 * The signed-in person behind a request, or null. Checked against the database each time,
 * so removing someone or resetting their password takes effect on their next request.
 */
export async function sessionUser(cookieHeader: string | undefined, users: UserStore): Promise<UserRecord | null> {
  return (await signedIn(cookieHeader, users))?.user ?? null;
}

/** The account and the session's own claims, which carry the authenticator proof. */
export async function signedIn(cookieHeader: string | undefined, users: UserStore): Promise<{ user: UserRecord; claims: SessionClaims } | null> {
  const token = cookieFrom(cookieHeader);
  if (!token) return null;
  const claims = await readSession(token, await users.sessionSecret());
  if (!claims) return null;
  const user = await users.getUser(claims.email);
  if (!user || user.orgId !== claims.orgId || claims.issuedAt < user.sessionsValidFrom) return null;
  return { user, claims };
}

/**
 * Integrations authenticate with an API key. People in the web app authenticate with the signed
 * session cookie from signing in, scoped to their own organisation, so the browser carries no key.
 */
export function authenticate(keys: ApiKey[], users: UserStore) {
  const byKey = new Map(keys.map((k) => [k.key, k]));
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const keyed = byKey.get(token);
    if (keyed) {
      req.principal = keyed;
      return;
    }
    const session = await signedIn(req.headers.cookie, users);
    if (!session) return reply.code(401).send({ error: 'unauthorised', message: 'Sign in, or send a valid API key' });
    const { user, claims } = session;
    // The scopes let a session reach every route; the person's access record then decides (server/guard.ts).
    req.principal = {
      key: `session:${user.email}`,
      orgId: user.orgId,
      name: user.email,
      scopes: ['*'],
      user: { email: user.email, role: user.role },
      email: user.email,
      sessionMfa: claims.mfa,
    };
  };
}

/** For managing people and settings: a signed-in admin only, never an integration key. */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  if (req.principal?.user?.role !== 'admin') {
    return reply.code(403).send({ error: 'forbidden', message: 'Only an admin can manage access and settings' });
  }
}

export function requireScope(scope: Scope) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const scopes = req.principal?.scopes ?? [];
    if (!scopes.includes('*') && !scopes.includes(scope)) {
      return reply.code(403).send({ error: 'forbidden', message: `This key lacks the ${scope} scope` });
    }
  };
}
