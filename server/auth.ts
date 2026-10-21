import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { cookieFrom, readSession } from './session';
import type { ApiKeyStore, UserRecord, UserStore } from './store';

export type Scope = 'rota:read' | 'employees:read' | 'rota:write' | 'time:write' | 'time:approve' | 'payroll:write' | 'hr:read' | 'hr:write' | 'webhooks:write' | '*';

/** What each scope allows, as shown to an admin choosing them for a new key. */
export const SCOPES: Record<Exclude<Scope, '*'>, string> = {
  'rota:read': 'Read sites, roles, shifts, forecast, labour totals, clocked hours, payroll status and journals',
  'employees:read': 'Read staff records and pay: names, dates of birth, rates, right to work, cost and pay by person, clock locations',
  'rota:write': 'Change shifts and people, build and publish rotas, load the forecast',
  'time:write': 'Clock in and out, and enter or edit time',
  'time:approve': 'Approve clocked time for payroll',
  'payroll:write': 'Send people and approved hours to payroll',
  'hr:read': 'Read personnel files: contracts, training, reviews, absence reasons and documents (includes staff records)',
  'hr:write': 'Change personnel files and record absence (includes reading them, and staff records)',
  'webhooks:write': 'Register and remove webhook endpoints',
};

/** Keys made in the app start with this, so a leaked one is easy to recognise and search for. */
export const KEY_PREFIX = 'psk_';
export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');

/** Requests one key may make each minute, on each server instance. */
export const RATE_LIMIT = 300;

export interface ApiKey {
  key: string;
  orgId: string;
  name: string;
  scopes: Scope[];
  /** Set for a key made in the app, so it can be revoked by id. */
  keyId?: string;
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
  if (env.PRESHIFT_API_KEYS) return (JSON.parse(env.PRESHIFT_API_KEYS) as ApiKey[]).map(keepEmployeeAccess);
  if (env.NODE_ENV === 'production') return [];
  return [{ key: 'dev-key', orgId: 'demo', name: 'Development', scopes: ['*'] }];
}

/**
 * Staff records and pay used to come with rota:read. Keys set by deployment before employees:read
 * existed keep what they had, so splitting the scope breaks no running integration. Keys made in
 * the app choose it explicitly.
 */
function keepEmployeeAccess(k: ApiKey): ApiKey {
  return k.scopes.includes('rota:read') && !k.scopes.includes('employees:read') ? { ...k, scopes: [...k.scopes, 'employees:read'] } : k;
}

/** Scopes that carry another with them: personnel files are no use without the staff record they belong to. */
const IMPLIED_BY: Partial<Record<Scope, Scope[]>> = { 'employees:read': ['hr:read', 'hr:write'] };

/** Whether the caller holds the scope, one that implies it, or every scope. */
export function hasScope(req: FastifyRequest, scope: Scope) {
  const scopes = req.principal?.scopes ?? [];
  return scopes.includes('*') || scopes.includes(scope) || (IMPLIED_BY[scope] ?? []).some((s) => scopes.includes(s));
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

const USED_EVERY_MS = 5 * 60_000;

/** A fixed one minute window per key. Per instance, so a guard against runaway loops rather than a quota. */
function rateLimiter(limit: number) {
  const windows = new Map<string, { start: number; count: number }>();
  return (id: string, now = Date.now()) => {
    let w = windows.get(id);
    if (!w || now - w.start >= 60_000) {
      if (windows.size > 10_000) windows.clear();
      w = { start: now, count: 0 };
      windows.set(id, w);
    }
    w.count++;
    return { allowed: w.count <= limit, remaining: Math.max(0, limit - w.count), resetSeconds: Math.ceil((w.start + 60_000 - now) / 1000) };
  };
}

/**
 * Integrations authenticate with an API key: one an admin made under Settings (stored hashed),
 * or one from PRESHIFT_API_KEYS. People in the web app authenticate with the signed session
 * cookie from signing in, scoped to their own organisation, so the browser carries no key.
 */
export function authenticate(keys: ApiKey[], users: UserStore & ApiKeyStore, options: { rateLimit?: number } = {}) {
  const byKey = new Map(keys.map((k) => [k.key, k]));
  const limit = rateLimiter(options.rateLimit ?? RATE_LIMIT);
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    let keyed = byKey.get(token);
    if (!keyed && token.startsWith(KEY_PREFIX)) {
      const stored = await users.getApiKeyByHash(hashKey(token));
      if (stored) {
        keyed = { key: `key:${stored.id}`, keyId: stored.id, orgId: stored.orgId, name: `API key ${stored.name}`, scopes: stored.scopes as Scope[] };
        if (!stored.lastUsedAt || Date.now() - Date.parse(stored.lastUsedAt) > USED_EVERY_MS) {
          await users.putApiKey({ ...stored, lastUsedAt: new Date().toISOString() });
        }
      }
    }
    if (keyed) {
      const rate = limit(keyed.key);
      reply.header('x-ratelimit-limit', options.rateLimit ?? RATE_LIMIT).header('x-ratelimit-remaining', rate.remaining).header('x-ratelimit-reset', rate.resetSeconds);
      if (!rate.allowed) {
        return reply.code(429).header('retry-after', rate.resetSeconds).send({ error: 'rate_limited', message: `Slow down: this key has made more than ${options.rateLimit ?? RATE_LIMIT} requests this minute` });
      }
      req.principal = keyed;
      return;
    }
    const user = await sessionUser(req.headers.cookie, users);
    if (!user) {
      const message = token ? 'That API key is not valid. It may have been revoked.' : 'Sign in, or send a valid API key';
      return reply.code(401).send({ error: 'unauthorised', message });
    }
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
    if (!hasScope(req, scope)) {
      return reply.code(403).send({ error: 'forbidden', message: `This key lacks the ${scope} scope` });
    }
  };
}
