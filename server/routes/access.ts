import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAdmin, sessionUser } from '../auth';
import { HttpError, notFound } from '../context';
import { hashPassword, passwordProblem, verifyPassword } from '../passwords';
import { createSession, safeNext, sessionCookie } from '../session';
import { audit, type Store, type UserRecord, type UserRole } from '../store';

const MAX_FAILURES = 5;
const LOCK_SECONDS = 15 * 60;
const FIRST_ORG = 'demo';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const now = () => Math.floor(Date.now() / 1000);
const normalise = (email: unknown) => (typeof email === 'string' ? email.trim().toLowerCase() : '');

/** What an admin sees about a person: never the hash. */
const view = (u: UserRecord) => ({ email: u.email, role: u.role, createdAt: u.createdAt, locked: u.lockedUntil > now() });

async function newUser(email: string, orgId: string, role: UserRole, password: string): Promise<UserRecord> {
  return {
    email,
    orgId,
    role,
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

/** Sign-in and first-run setup. Registered outside the authenticated API. */
export function signInRoutes(app: FastifyInstance, store: Store) {
  const hidden = { schema: { hide: true } };

  app.get('/auth/status', hidden, async () => ({ setupNeeded: !(await store.hasUsers()) }));

  // First run only: whoever opens the app first on a fresh database creates the owner account.
  app.post<{ Body: Record<string, string> }>('/auth/setup', hidden, async (req, reply) => {
    const next = safeNext(req.body?.next, '/app/');
    const email = normalise(req.body?.email);
    const problem = !EMAIL.test(email) ? 'email' : passwordProblem(req.body?.password) ? 'weak' : req.body?.password !== req.body?.confirm ? 'mismatch' : null;
    if (problem) return backToLogin(reply, { next, error: problem, setup: '1' });
    const owner = await newUser(email, FIRST_ORG, 'admin', req.body.password);
    if (!(await store.createUser(owner, { onlyIfFirst: true }))) return backToLogin(reply, { next, error: 'taken' });
    const org = await store.load(FIRST_ORG);
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
    if (user.failedAttempts || user.lockedUntil) await store.updateUser(user.email, { failedAttempts: 0, lockedUntil: 0 });
    return signIn(req, reply, store, user, next);
  });

  app.get('/auth/logout', hidden, async (req, reply) =>
    reply.code(303).header('set-cookie', sessionCookie('', secure(req), 0)).header('location', '/login?signedout=1').send(),
  );

  app.get('/auth/me', hidden, async (req, reply) => {
    const user = await sessionUser(req.headers.cookie, store);
    if (!user) return reply.code(401).send({ error: 'unauthorised', message: 'Not signed in' });
    return { email: user.email, orgId: user.orgId, role: user.role, lead: user.lead === true };
  });

  // Anyone signed in can change their own password; every other session of theirs ends.
  app.post<{ Body: { currentPassword?: string; newPassword?: string } }>('/auth/password', hidden, async (req, reply) => {
    const user = await sessionUser(req.headers.cookie, store);
    if (!user) return reply.code(401).send({ error: 'unauthorised', message: 'Not signed in' });
    if (!(await verifyPassword(user, req.body?.currentPassword ?? ''))) {
      throw new HttpError(400, 'wrong_password', 'Your current password is not right.');
    }
    const problem = passwordProblem(req.body?.newPassword);
    if (problem) throw new HttpError(400, 'weak_password', problem);
    const hashed = await hashPassword(req.body.newPassword!);
    const issued = Date.now();
    await store.updateUser(user.email, { ...hashed, sessionsValidFrom: issued });
    const token = await createSession(user, await store.sessionSecret(), issued);
    return reply.header('set-cookie', sessionCookie(token, secure(req))).send({ ok: true });
  });
}

/** People and settings for the caller's organisation. Registered inside the authenticated API. */
export function accessRoutes(app: FastifyInstance, store: Store) {
  const admin = { preHandler: requireAdmin, schema: { hide: true } };
  const orgId = (req: FastifyRequest) => req.principal.orgId;
  const actor = (req: FastifyRequest) => req.principal.user?.email ?? req.principal.name;

  async function mine(req: FastifyRequest, email: string) {
    const user = await store.getUser(normalise(email));
    if (!user || user.orgId !== orgId(req)) throw notFound(`Person ${email}`);
    return user;
  }

  async function keepAnAdmin(req: FastifyRequest, leaving: UserRecord) {
    if (leaving.role !== 'admin') return;
    const admins = (await store.listUsers(orgId(req))).filter((u) => u.role === 'admin');
    if (admins.length <= 1) throw new HttpError(409, 'last_admin', 'Someone else must be an admin first. Every organisation needs one.');
  }

  app.get('/v1/users', admin, async (req) => (await store.listUsers(orgId(req))).map(view));

  app.post<{ Body: { email?: string; password?: string; role?: UserRole } }>('/v1/users', admin, async (req, reply) => {
    const email = normalise(req.body?.email);
    if (!EMAIL.test(email)) throw new HttpError(400, 'invalid_email', 'Enter a valid email address.');
    const problem = passwordProblem(req.body?.password);
    if (problem) throw new HttpError(400, 'weak_password', problem);
    const role: UserRole = req.body?.role === 'admin' ? 'admin' : 'member';
    if (!(await store.createUser(await newUser(email, orgId(req), role, req.body.password!)))) {
      throw new HttpError(409, 'email_taken', 'That email already has an account.');
    }
    audit(req.org!, actor(req), 'access.user_added', { email, role });
    return reply.code(201).send(view((await store.getUser(email))!));
  });

  app.patch<{ Params: { email: string }; Body: { role?: UserRole; password?: string } }>('/v1/users/:email', admin, async (req) => {
    const user = await mine(req, req.params.email);
    const patch: Partial<UserRecord> = {};
    if (req.body?.role && req.body.role !== user.role) {
      if (req.body.role !== 'admin') await keepAnAdmin(req, user);
      patch.role = req.body.role === 'admin' ? 'admin' : 'member';
    }
    if (req.body?.password !== undefined) {
      const problem = passwordProblem(req.body.password);
      if (problem) throw new HttpError(400, 'weak_password', problem);
      // A reset signs them out everywhere and clears any lockout.
      Object.assign(patch, await hashPassword(req.body.password), { sessionsValidFrom: Date.now(), failedAttempts: 0, lockedUntil: 0 });
    }
    await store.updateUser(user.email, patch);
    audit(req.org!, actor(req), 'access.user_changed', { email: user.email, role: patch.role, passwordReset: req.body?.password !== undefined });
    return view((await store.getUser(user.email))!);
  });

  app.delete<{ Params: { email: string } }>('/v1/users/:email', admin, async (req, reply) => {
    const user = await mine(req, req.params.email);
    if (user.email === req.principal.user?.email) throw new HttpError(409, 'self', 'You cannot remove yourself.');
    await keepAnAdmin(req, user);
    await store.deleteUser(user.email);
    audit(req.org!, actor(req), 'access.user_removed', { email: user.email });
    return reply.code(204).send();
  });

  app.get('/v1/settings', admin, async (req) => {
    const key = await store.getSetting(claudeKeySetting(orgId(req)));
    return { claudeApiKey: key ? { set: true, endsWith: key.slice(-4) } : { set: false } };
  });

  app.put<{ Body: { claudeApiKey?: string | null } }>('/v1/settings/claude-api-key', admin, async (req) => {
    const value = req.body?.claudeApiKey?.trim() || null;
    if (value && !/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(value)) {
      throw new HttpError(400, 'invalid_key', 'That does not look like a Claude API key. It starts with sk-ant-.');
    }
    await store.setSetting(claudeKeySetting(orgId(req)), value);
    audit(req.org!, actor(req), value ? 'settings.claude_key_set' : 'settings.claude_key_removed');
    return { claudeApiKey: value ? { set: true, endsWith: value.slice(-4) } : { set: false } };
  });
}

export const claudeKeySetting = (orgId: string) => `claude_api_key:${orgId}`;
