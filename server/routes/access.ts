import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { User } from '../../src/engine/access';
import { signedIn } from '../auth';
import { HttpError, orgOf, type AppContext } from '../context';
import { guard } from '../guard';
import { hashPassword, passwordProblem, verifyPassword } from '../passwords';
import { createSession, safeNext, sessionCookie } from '../session';
import { audit, type OrgData, type Store, type UserRecord } from '../store';
import { hashToken } from './users';

const MAX_FAILURES = 5;
const LOCK_SECONDS = 15 * 60;
const FIRST_ORG = 'demo';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const now = () => Math.floor(Date.now() / 1000);
const normalise = (email: unknown) => (typeof email === 'string' ? email.trim().toLowerCase() : '');

/**
 * An account is how a person signs in: their email, password hash and lockout. What they may do
 * is their access record in the organisation (src/engine/access.ts), found by the same email.
 * The account's role is kept for older rows and decides nothing.
 */
export async function newAccount(email: string, orgId: string, password: string): Promise<UserRecord> {
  return {
    email,
    orgId,
    role: 'member',
    ...(await hashPassword(password)),
    createdAt: new Date().toISOString(),
    sessionsValidFrom: 0,
    failedAttempts: 0,
    lockedUntil: 0,
  };
}

function secure(req: FastifyRequest) {
  return req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';
}

async function signIn(req: FastifyRequest, reply: FastifyReply, store: Store, user: UserRecord, next: string) {
  const token = await createSession(user, await store.sessionSecret());
  return reply.code(303).header('set-cookie', sessionCookie(token, secure(req))).header('location', next).send();
}

const backToLogin = (reply: FastifyReply, params: Record<string, string>) =>
  reply.code(303).header('location', `/login?${new URLSearchParams(params)}`).send();

const recordFor = (org: OrgData, email: string) => org.users.find((u) => u.email === email);

/** The organisation a link belongs to, without creating one for a forged prefix. */
async function linkTarget(store: Store, token: string) {
  const orgId = token.split('.')[0];
  if (!orgId || !(await store.has(orgId))) return null;
  const org = await store.load(orgId);
  const entry = org.inviteTokens[hashToken(token)];
  const user = entry && org.users.find((u) => u.id === entry.userId);
  return entry && user ? { org, entry, user } : null;
}

/** Sign-in, first-run setup and setting a password from a link. Registered outside the authenticated API. */
export function signInRoutes(app: FastifyInstance, ctx: AppContext) {
  const { store } = ctx;
  const hidden = { schema: { hide: true } };

  app.get('/auth/status', hidden, async () => ({ setupNeeded: !(await store.hasUsers()) }));

  // First run only: whoever opens the app first on a fresh database creates the owner account,
  // with the Owner role on record, so their access follows the same rules as everyone's.
  app.post<{ Body: Record<string, string> }>('/auth/setup', hidden, async (req, reply) => {
    const next = safeNext(req.body?.next, '/app/');
    const email = normalise(req.body?.email);
    const problem = !EMAIL.test(email) ? 'email' : passwordProblem(req.body?.password) ? 'weak' : req.body?.password !== req.body?.confirm ? 'mismatch' : null;
    if (problem) return backToLogin(reply, { next, error: problem, setup: '1' });
    const owner = await newAccount(email, FIRST_ORG, req.body.password);
    if (!(await store.createUser(owner, { onlyIfFirst: true }))) return backToLogin(reply, { next, error: 'taken' });
    const org = await store.load(FIRST_ORG);
    if (!recordFor(org, email)) {
      const at = new Date().toISOString();
      const today = store.todayISO();
      org.users.push({
        id: `usr_${randomUUID().slice(0, 12)}`,
        email,
        name: email.split('@')[0],
        jobTitle: 'Owner',
        audience: 'operator',
        status: 'active',
        mfaEnrolled: false,
        createdAt: at,
        activatedAt: at,
        memberships: [{ id: `mem_${randomUUID().slice(0, 12)}`, roleId: 'owner', siteIds: null, starts: today, active: true, grantedBy: 'Set-up', grantedAt: at }],
      });
    }
    audit(org, email, 'access.owner_created');
    await store.save(org);
    return signIn(req, reply, store, owner, next);
  });

  app.post<{ Body: Record<string, string> }>('/auth/login', hidden, async (req, reply) => {
    const next = safeNext(req.body?.next, '/app/');
    const email = normalise(req.body?.email);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const user = email ? await store.getUser(email) : null;
    if (user && user.lockedUntil > now()) return backToLogin(reply, { next, error: 'locked' });

    if (!(await verifyPassword(user, password)) || !user) {
      if (user) {
        const failedAttempts = user.failedAttempts + 1;
        const lock = failedAttempts >= MAX_FAILURES;
        await store.updateUser(user.email, { failedAttempts: lock ? 0 : failedAttempts, lockedUntil: lock ? now() + LOCK_SECONDS : 0 });
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
      return backToLogin(reply, { next, error: 'invalid' });
    }
    // The right password does not open a suspended account. Said only once the password is right.
    const record = recordFor(await store.load(user.orgId), user.email);
    if (record?.status === 'suspended') return backToLogin(reply, { next, error: 'suspended' });
    if (user.failedAttempts || user.lockedUntil) await store.updateUser(user.email, { failedAttempts: 0, lockedUntil: 0 });
    return signIn(req, reply, store, user, next);
  });

  // A person sets their own password from an invitation or a reset link. Nobody else ever knows it.
  app.post<{ Body: Record<string, string> }>('/auth/accept', hidden, async (req, reply) => {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    const back = (error: string) => backToLogin(reply, { link: token, error });
    const target = token ? await linkTarget(store, token) : null;
    if (!target) return backToLogin(reply, { error: 'badlink' });
    const { org, entry, user } = target;
    if (entry.expiresAt < store.todayISO()) return backToLogin(reply, { error: 'expired' });
    if (user.status === 'suspended') return backToLogin(reply, { error: 'suspended' });
    const problem = passwordProblem(req.body?.password);
    if (problem) return back('weak');
    if (req.body.password !== req.body?.confirm) return back('mismatch');

    const existing = await store.getUser(user.email);
    if (existing && existing.orgId !== org.orgId) return backToLogin(reply, { error: 'elsewhere' });
    let account: UserRecord;
    if (existing) {
      // Every session signed in before this ends, and any lockout clears.
      await store.updateUser(user.email, { ...(await hashPassword(req.body.password)), sessionsValidFrom: Date.now(), failedAttempts: 0, lockedUntil: 0 });
      account = (await store.getUser(user.email))!;
    } else {
      account = await newAccount(user.email, org.orgId, req.body.password);
      if (!(await store.createUser(account))) return backToLogin(reply, { error: 'elsewhere' });
    }
    delete org.inviteTokens[hashToken(token)];
    if (user.status === 'invited') {
      Object.assign(user, { status: 'active', activatedAt: new Date().toISOString(), inviteExpiresAt: undefined } satisfies Partial<User>);
      audit(org, user.name, 'invite.accepted', { userId: user.id, by: 'password' });
    } else {
      audit(org, user.name, 'user.password_set', { userId: user.id, by: entry.kind ?? 'invite' });
    }
    await store.save(org);
    return signIn(req, reply, store, account, '/app/');
  });

  // Who a link is for, so the page can greet them. Says nothing about anyone else.
  app.get<{ Querystring: { token?: string } }>('/auth/link', hidden, async (req, reply) => {
    const target = req.query.token ? await linkTarget(store, req.query.token) : null;
    if (!target || target.entry.expiresAt < store.todayISO()) return reply.code(404).send({ error: 'badlink' });
    return { name: target.user.name, email: target.user.email, kind: target.entry.kind ?? 'invite' };
  });

  app.get('/auth/logout', hidden, async (req, reply) =>
    reply.code(303).header('set-cookie', sessionCookie('', secure(req), 0)).header('location', '/login?signedout=1').send(),
  );

  app.get('/auth/me', hidden, async (req, reply) => {
    const session = await signedIn(req.headers.cookie, store);
    if (!session) return reply.code(401).send({ error: 'unauthorised', message: 'Not signed in' });
    // What the person may do is their access record (/v1/me), not anything on the account.
    return { email: session.user.email, orgId: session.user.orgId };
  });

  // Anyone signed in can change their own password; every other session of theirs ends.
  app.post<{ Body: { currentPassword?: string; newPassword?: string } }>('/auth/password', hidden, async (req, reply) => {
    const session = await signedIn(req.headers.cookie, store);
    if (!session) return reply.code(401).send({ error: 'unauthorised', message: 'Not signed in' });
    const { user, claims } = session;
    if (!(await verifyPassword(user, req.body?.currentPassword ?? ''))) {
      throw new HttpError(400, 'wrong_password', 'Your current password is not right.');
    }
    const problem = passwordProblem(req.body?.newPassword);
    if (problem) throw new HttpError(400, 'weak_password', problem);
    const hashed = await hashPassword(req.body.newPassword!);
    const issued = Date.now();
    await store.updateUser(user.email, { ...hashed, sessionsValidFrom: issued });
    // This session carries on, still proved by its authenticator code if it was.
    const token = await createSession(user, await store.sessionSecret(), issued, claims.mfa);
    return reply.header('set-cookie', sessionCookie(token, secure(req))).send({ ok: true });
  });
}

/** Deployment settings for the caller's organisation. People are managed on the Access routes. */
export function settingsRoutes(app: FastifyInstance, ctx: AppContext) {
  const { store } = ctx;
  const hidden = { schema: { hide: true } };
  const orgId = (req: FastifyRequest) => req.principal.orgId;

  /** A person with settings.manage, never an integration key: the Claude key spends the client's money. */
  function settingsPerson(req: FastifyRequest) {
    if (!req.principal.email) throw new HttpError(403, 'forbidden', 'Settings are changed by a person signed in, not an API key.');
    const g = guard(ctx, req, orgOf(req));
    g.allow('settings.manage');
    return g.actor.kind === 'user' ? g.actor.user.name : req.principal.name;
  }

  app.get('/v1/settings', hidden, async (req) => {
    settingsPerson(req);
    const key = await store.getSetting(claudeKeySetting(orgId(req)));
    return { claudeApiKey: key ? { set: true, endsWith: key.slice(-4) } : { set: false } };
  });

  app.put<{ Body: { claudeApiKey?: string | null } }>('/v1/settings/claude-api-key', hidden, async (req) => {
    const who = settingsPerson(req);
    const value = req.body?.claudeApiKey?.trim() || null;
    if (value && !/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(value)) {
      throw new HttpError(400, 'invalid_key', 'That does not look like a Claude API key. It starts with sk-ant-.');
    }
    await store.setSetting(claudeKeySetting(orgId(req)), value);
    audit(req.org!, who, value ? 'settings.claude_key_set' : 'settings.claude_key_removed');
    return { claudeApiKey: value ? { set: true, endsWith: value.slice(-4) } : { set: false } };
  });
}

export const claudeKeySetting = (orgId: string) => `claude_api_key:${orgId}`;
