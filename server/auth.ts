import type { FastifyReply, FastifyRequest } from 'fastify';
import { cookieFrom, readSession } from './session';
import type { UserRecord, UserStore } from './store';

export type Scope = 'rota:read' | 'rota:write' | 'time:write' | 'time:approve' | 'payroll:write' | 'hr:read' | 'hr:write' | '*';

export interface ApiKey {
  key: string;
  orgId: string;
  name: string;
  scopes: Scope[];
  /** Set when the caller is a signed-in person rather than an integration key. */
  user?: { email: string; role: UserRecord['role'] };
}

declare module 'fastify' {
  interface FastifyRequest {
    principal: ApiKey;
  }
}

/**
 * Keys come from PRESHIFT_API_KEYS as JSON: [{"key":"...","orgId":"...","name":"...","scopes":["*"]}].
 * Outside production a development key is available so the demo runs with no setup.
 */
export function loadApiKeys(env = process.env): ApiKey[] {
  if (env.PRESHIFT_API_KEYS) return JSON.parse(env.PRESHIFT_API_KEYS) as ApiKey[];
  if (env.NODE_ENV === 'production') return [];
  return [{ key: 'dev-key', orgId: 'demo', name: 'Development', scopes: ['*'] }];
}

/**
 * The signed-in person behind a request, or null. Checked against the database each time,
 * so removing someone or resetting their password takes effect on their next request.
 */
export async function sessionUser(cookieHeader: string | undefined, users: UserStore): Promise<UserRecord | null> {
  const token = cookieFrom(cookieHeader);
  if (!token) return null;
  const claims = await readSession(token, await users.sessionSecret());
  if (!claims) return null;
  const user = await users.getUser(claims.email);
  if (!user || user.orgId !== claims.orgId || claims.issuedAt < user.sessionsValidFrom) return null;
  return user;
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
    const user = await sessionUser(req.headers.cookie, users);
    if (!user) return reply.code(401).send({ error: 'unauthorised', message: 'Sign in, or send a valid API key' });
    // Everyone signed in works across their own organisation; managing access is for admins only.
    req.principal = {
      key: `session:${user.email}`,
      orgId: user.orgId,
      name: user.email,
      scopes: ['*'],
      user: { email: user.email, role: user.role },
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
