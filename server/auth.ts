import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { isSandbox, sandboxExpired } from './sandbox';
import { ACCESS_PREFIX, oauthPrincipal } from './oauth';
import { DEMO_OWNER_ID, seedUsers } from './seedUsers';
import { cookieFrom, readSession, type SessionClaims } from './session';
import { orgsOfAccount, type ApiKeyStore, type UserRecord, type UserStore } from './store';

export type Scope =
  | 'rota:read'
  | 'employees:read'
  | 'rota:write'
  | 'time:write'
  | 'time:approve'
  | 'payroll:write'
  | 'hr:read'
  | 'hr:write'
  | 'webhooks:write'
  | 'users:manage'
  /** Never implied by `*` and never offered for an app-made key: it belongs to Williams, Stanley & Co. alone. */
  | 'programme:lead'
  | '*';

/**
 * What each scope allows, as shown to a person choosing them for a new key. users:manage is never
 * offered: access is managed by people, never by a key. Nor is programme:lead: only a key WS holds carries it.
 */
export const SCOPES: Record<Exclude<Scope, '*' | 'users:manage' | 'programme:lead'>, string> = {
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
  /** For a key made in the app: who made it, by id where recorded and always by name. */
  madeBy?: { id?: string; name: string };
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
  /** The id of the account's own authenticator, read each request, so a reset ends the proof at once. */
  accountMfaId?: string;
  /** The account's home organisation. A person with no access record has legacy access only there. */
  homeOrgId?: string;
  /**
   * A personal key counts as having passed the authenticator only when its issuer says so.
   * Keys are long-lived secrets, not people at a keyboard, so the default is no.
   */
  mfa?: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal: ApiKey;
    /** Set whenever a key is presented and recognised, refused or not, so the call can be logged. */
    apiCall?: { orgId: string; keyId: string; refused?: 'revoked' | 'rate_limited'; started: number };
  }
}

/**
 * Keys come from PRESHIFT_API_KEYS as JSON: [{"key":"...","orgId":"...","name":"...","scopes":["*"],"userId":"optional","mfa":false}].
 * Outside production a development key is available so the demo runs with no setup.
 */
export function loadApiKeys(env = process.env): ApiKey[] {
  if (env.PRESHIFT_API_KEYS) {
    const keys = JSON.parse(env.PRESHIFT_API_KEYS) as ApiKey[];
    // Integration keys belong to customers. A key aimed at a demo sandbox is a mistake, so refuse to start.
    if (keys.some((k) => isSandbox(k.orgId))) throw new Error('PRESHIFT_API_KEYS names a demo sandbox; keys are for customer organisations only');
    return keys.map(keepEmployeeAccess);
  }
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
  return (await signedIn(cookieHeader, users))?.user ?? null;
}

/** The account and the session's own claims, which carry the authenticator proof. */
export async function signedIn(cookieHeader: string | undefined, users: UserStore): Promise<{ user: UserRecord; claims: SessionClaims } | null> {
  const token = cookieFrom(cookieHeader);
  if (!token) return null;
  const claims = await readSession(token, await users.sessionSecret());
  if (!claims) return null;
  const user = await users.getUser(claims.email);
  // A session works in one organisation at a time, which must be one the account has joined.
  if (!user || !orgsOfAccount(user).includes(claims.orgId) || claims.issuedAt < user.sessionsValidFrom) return null;
  // Sandboxes and customers never share an account. A sandbox is reached only by its own visitor
  // account, which works nowhere else; a customer account never reaches a sandbox, whatever its
  // memberships say, and keeps working in its own organisations.
  if (isSandbox(claims.orgId) && claims.orgId !== user.orgId) return null;
  if (isSandbox(user.orgId) && claims.orgId !== user.orgId) return null;
  // A demo sandbox ends at midnight UK time, whether or not the reset has deleted it yet.
  if (isSandbox(claims.orgId) && sandboxExpired(claims.orgId, Date.now())) return null;
  return { user, claims };
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
      if (stored?.revokedAt) {
        // Still recognised, so the attempt is logged against the key it used.
        req.apiCall = { orgId: stored.orgId, keyId: stored.id, refused: 'revoked', started: Date.now() };
        return reply.code(401).send({ error: 'unauthorised', message: 'That API key is not valid. It may have been revoked.' });
      }
      if (stored) {
        keyed = {
          key: `key:${stored.id}`,
          keyId: stored.id,
          orgId: stored.orgId,
          // Named with its maker, so the audit says who stands behind each change the key makes.
          name: `API key ${stored.name}, made by ${stored.createdBy}`,
          madeBy: { ...(stored.createdById ? { id: stored.createdById } : {}), name: stored.createdBy },
          scopes: stored.scopes as Scope[],
        };
        if (!stored.lastUsedAt || Date.now() - Date.parse(stored.lastUsedAt) > USED_EVERY_MS) {
          await users.putApiKey({ ...stored, lastUsedAt: new Date().toISOString() });
        }
      }
    }
    if (!keyed && token.startsWith(ACCESS_PREFIX)) {
      // A connection a person approved through Sign in with Preshift (server/oauth.ts).
      keyed = (await oauthPrincipal(token, users)) ?? undefined;
      if (!keyed) return reply.code(401).send({ error: 'unauthorised', message: 'That connection has expired or been disconnected. Connect to Preshift again.' });
    }
    if (keyed) {
      req.apiCall = { orgId: keyed.orgId, keyId: keyed.keyId ?? `env:${keyed.name}`, started: Date.now() };
      const rate = limit(keyed.key);
      reply.header('x-ratelimit-limit', options.rateLimit ?? RATE_LIMIT).header('x-ratelimit-remaining', rate.remaining).header('x-ratelimit-reset', rate.resetSeconds);
      if (!rate.allowed) {
        req.apiCall.refused = 'rate_limited';
        return reply.code(429).header('retry-after', rate.resetSeconds).send({ error: 'rate_limited', message: `Slow down: this key has made more than ${options.rateLimit ?? RATE_LIMIT} requests this minute` });
      }
      req.principal = keyed;
      return;
    }
    const session = await signedIn(req.headers.cookie, users);
    if (!session) {
      const message = token ? 'That API key is not valid. It may have been revoked.' : 'Sign in, or send a valid API key';
      return reply.code(401).send({ error: 'unauthorised', message });
    }
    const { user, claims } = session;
    // The scopes let a session reach every route; the person's access record then decides (server/guard.ts).
    req.principal = {
      key: `session:${user.email}`,
      orgId: claims.orgId,
      name: user.email,
      scopes: ['*'],
      user: { email: user.email, role: user.role },
      email: user.email,
      sessionMfa: claims.mfa,
      accountMfaId: user.authenticator?.secret ? user.authenticator.id : undefined,
      homeOrgId: user.orgId,
    };
  };
}

export function requireScope(scope: Scope) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!hasScope(req, scope)) {
      return reply.code(403).send({ error: 'forbidden', message: `This key lacks the ${scope} scope` });
    }
  };
}
