import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAdmin, sessionUser } from '../auth';
import { HttpError, notFound } from '../context';
import { hashPassword, passwordProblem, verifyPassword } from '../passwords';
import { emailSetting, parseEmailSettings, resetEmail, sendMail } from '../mail';
import { createSession, safeNext, sessionCookie } from '../session';
import { audit, type Store, type UserRecord, type UserRole } from '../store';

export const MAX_FAILURES = 5;
export const LOCK_SECONDS = 15 * 60;
const FIRST_ORG = 'demo';
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESET_MINUTES = 30;
/** Links an admin hands over themselves last a working day. */
const ADMIN_RESET_HOURS = 24;
/** Reset emails one account can be sent in an hour, so the form cannot be used to flood someone's inbox. */
const MAX_RESETS_PER_HOUR = 3;
/** The forgot form always takes at least this long, so its timing does not show whether an account exists. */
const FORGOT_MIN_MS = 1200;

export const now = () => Math.floor(Date.now() / 1000);
export const normalise = (email: unknown) => (typeof email === 'string' ? email.trim().toLowerCase() : '');

/** What an admin sees about a person: never the hash. */
const view = (u: UserRecord) => ({ email: u.email, role: u.role, ...(u.role === 'manager' ? { siteIds: u.siteIds ?? [] } : {}), createdAt: u.createdAt, locked: u.lockedUntil > now() });

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

export function secure(req: FastifyRequest) {
  return req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';
}

async function signIn(req: FastifyRequest, reply: FastifyReply, store: Store, user: UserRecord, next: string) {
  const token = await createSession(user, await store.sessionSecret());
  return reply.code(303).header('set-cookie', sessionCookie(token, secure(req))).header('location', next).send();
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** A new reset link for the person, replacing any earlier one. Only its hash is kept. */
async function issueReset(store: Store, user: UserRecord, seconds: number, patch: Partial<UserRecord> = {}) {
  const token = randomBytes(32).toString('base64url');
  await store.updateUser(user.email, { ...patch, resetTokenHash: hashToken(token), resetExpires: now() + seconds });
  return token;
}

const backToLogin = (reply: FastifyReply, params: Record<string, string>) =>
  reply.code(303).header('location', `/login?${new URLSearchParams(params)}`).send();

/** Sign-in and first-run setup. Registered outside the authenticated API. */
export function signInRoutes(app: FastifyInstance, store: Store, options: { demo?: boolean } = {}) {
  const hidden = { schema: { hide: true } };
  const demo = options.demo ? { demo: true } : {};

  app.get('/auth/status', hidden, async () => (options.demo ? { setupNeeded: false, ...demo } : { setupNeeded: !(await store.hasUsers()) }));

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
    return { email: user.email, orgId: user.orgId, role: user.role, ...(user.role === 'manager' ? { siteIds: user.siteIds ?? [] } : {}), ...demo };
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
    await store.updateUser(user.email, { ...hashed, sessionsValidFrom: issued, resetTokenHash: undefined, resetExpires: undefined });
    const token = await createSession(user, await store.sessionSecret(), issued);
    return reply.header('set-cookie', sessionCookie(token, secure(req))).send({ ok: true });
  });

  // The reply is the same whether or not the email has an account, so the form cannot be used
  // to find out who has one.
  app.post<{ Body: Record<string, string> }>('/auth/forgot', hidden, async (req, reply) => {
    const started = Date.now();
    const email = normalise(req.body?.email);
    const user = EMAIL.test(email) ? await store.getUser(email) : null;
    if (user) {
      const recent = (user.resetRequests ?? []).filter((t) => t > now() - 3600);
      const settings = parseEmailSettings(await store.getSetting(emailSetting(user.orgId)));
      if (!settings) console.error(`Reset email not sent to ${email}: email is not set up under Settings`);
      else if (recent.length < MAX_RESETS_PER_HOUR) {
        const token = await issueReset(store, user, RESET_MINUTES * 60, { resetRequests: [...recent, now()] });
        // The token goes in the fragment, which browsers never send to a server or in a Referer header.
        await sendMail(settings, resetEmail(email, `${settings.appUrl}/login#reset=${token}`, RESET_MINUTES));
      }
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, FORGOT_MIN_MS - (Date.now() - started))));
    return backToLogin(reply, { sent: '1' });
  });

  // With only the token, says whether the link still works so the page can say so before any typing.
  // With a new password too, sets it, signs out every other device and signs this one in.
  app.post<{ Body: { token?: string; password?: string } }>('/auth/reset', hidden, async (req, reply) => {
    const expired = () => reply.code(410).send({ error: 'expired', message: 'This reset link has expired or has already been used. Ask for a new one.' });
    const tokenHash = hashToken(typeof req.body?.token === 'string' ? req.body.token : '');
    const user = await store.findUserByResetToken(tokenHash, now());
    if (!user) return expired();
    if (req.body?.password === undefined) return { ok: true, email: user.email };

    const problem = passwordProblem(req.body.password);
    if (problem) throw new HttpError(400, 'weak_password', problem);
    const issued = Date.now();
    // Proving control of the inbox also clears any lockout from earlier wrong guesses.
    const claimed = await store.claimPasswordReset(tokenHash, now(), {
      ...(await hashPassword(req.body.password)),
      sessionsValidFrom: issued,
      failedAttempts: 0,
      lockedUntil: 0,
    });
    if (!claimed) return expired();
    const org = await store.load(claimed.orgId);
    audit(org, claimed.email, 'access.password_reset_by_link');
    await store.save(org);
    const token = await createSession(claimed, await store.sessionSecret(), issued);
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

  const ROLES: UserRole[] = ['admin', 'member', 'manager'];
  const roleOf = (role: unknown): UserRole => (ROLES.includes(role as UserRole) ? (role as UserRole) : 'member');

  /** A manager runs at least one of the organisation's own sites. */
  function managedSites(req: FastifyRequest, siteIds: unknown): string[] {
    const known = new Set(req.org!.state.sites.map((s) => s.id));
    const ids = Array.isArray(siteIds) ? [...new Set(siteIds.filter((x): x is string => typeof x === 'string'))] : [];
    if (ids.length === 0) throw new HttpError(400, 'sites_required', 'Choose the sites this manager runs.');
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length) throw notFound(`Site ${unknown.join(', ')}`);
    return ids;
  }

  async function keepAnAdmin(req: FastifyRequest, leaving: UserRecord) {
    if (leaving.role !== 'admin') return;
    const admins = (await store.listUsers(orgId(req))).filter((u) => u.role === 'admin');
    if (admins.length <= 1) throw new HttpError(409, 'last_admin', 'Someone else must be an admin first. Every organisation needs one.');
  }

  app.get('/v1/users', admin, async (req) => (await store.listUsers(orgId(req))).map(view));

  app.post<{ Body: { email?: string; password?: string; role?: UserRole; siteIds?: string[] } }>('/v1/users', admin, async (req, reply) => {
    const email = normalise(req.body?.email);
    if (!EMAIL.test(email)) throw new HttpError(400, 'invalid_email', 'Enter a valid email address.');
    const problem = passwordProblem(req.body?.password);
    if (problem) throw new HttpError(400, 'weak_password', problem);
    const role = roleOf(req.body?.role);
    const siteIds = role === 'manager' ? managedSites(req, req.body?.siteIds) : undefined;
    const user = { ...(await newUser(email, orgId(req), role, req.body.password!)), ...(siteIds ? { siteIds } : {}) };
    if (!(await store.createUser(user))) {
      throw new HttpError(409, 'email_taken', 'That email already has an account.');
    }
    audit(req.org!, actor(req), 'access.user_added', { email, role, ...(siteIds ? { siteIds } : {}) });
    return reply.code(201).send(view((await store.getUser(email))!));
  });

  app.patch<{ Params: { email: string }; Body: { role?: UserRole; siteIds?: string[]; password?: string } }>('/v1/users/:email', admin, async (req) => {
    const user = await mine(req, req.params.email);
    const patch: Partial<UserRecord> = {};
    if (req.body?.role && req.body.role !== user.role) {
      if (req.body.role !== 'admin') await keepAnAdmin(req, user);
      patch.role = roleOf(req.body.role);
    }
    const role = patch.role ?? user.role;
    if (role === 'manager' && (req.body?.siteIds !== undefined || user.role !== 'manager')) {
      patch.siteIds = managedSites(req, req.body?.siteIds);
    }
    if (role !== 'manager' && user.siteIds) patch.siteIds = undefined;
    // A change of role or sites takes effect on the person's next request: sessions are checked against
    // the database every time, and the principal is built from the stored record.
    if (req.body?.password !== undefined) {
      const problem = passwordProblem(req.body.password);
      if (problem) throw new HttpError(400, 'weak_password', problem);
      // A reset signs them out everywhere and clears any lockout.
      Object.assign(patch, await hashPassword(req.body.password), { sessionsValidFrom: Date.now(), failedAttempts: 0, lockedUntil: 0, resetTokenHash: undefined, resetExpires: undefined });
    }
    await store.updateUser(user.email, patch);
    audit(req.org!, actor(req), 'access.user_changed', { email: user.email, role: patch.role, siteIds: patch.siteIds, passwordReset: req.body?.password !== undefined });
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

  // For when email is not set up, or did not arrive: the admin hands the link over themselves.
  app.post<{ Params: { email: string } }>('/v1/users/:email/reset-link', admin, async (req) => {
    const user = await mine(req, req.params.email);
    const token = await issueReset(store, user, ADMIN_RESET_HOURS * 3600);
    audit(req.org!, actor(req), 'access.reset_link_issued', { email: user.email });
    return { token, expiresInHours: ADMIN_RESET_HOURS };
  });

  const emailView = async (req: FastifyRequest) => {
    const email = parseEmailSettings(await store.getSetting(emailSetting(orgId(req))));
    return email ? { set: true, from: email.from, appUrl: email.appUrl, keyEndsWith: email.resendApiKey.slice(-4) } : { set: false };
  };

  app.get('/v1/settings', admin, async (req) => {
    const key = await store.getSetting(claudeKeySetting(orgId(req)));
    return { claudeApiKey: key ? { set: true, endsWith: key.slice(-4) } : { set: false }, email: await emailView(req) };
  });

  // Saving without a key keeps the one already saved, so the address can change without re-entering it.
  app.put<{ Body: { resendApiKey?: string; from?: string; appUrl?: string } }>('/v1/settings/email', admin, async (req) => {
    const setting = emailSetting(orgId(req));
    const resendApiKey = req.body?.resendApiKey?.trim() || parseEmailSettings(await store.getSetting(setting))?.resendApiKey;
    if (!resendApiKey || !/^re_[A-Za-z0-9_]{10,}$/.test(resendApiKey)) {
      throw new HttpError(400, 'invalid_key', 'That does not look like a Resend API key. It starts with re_.');
    }
    const from = req.body?.from?.trim() ?? '';
    if (!/^([^<>]+<)?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?$/.test(from)) {
      throw new HttpError(400, 'invalid_from', 'Enter the address emails come from, on a domain verified in Resend.');
    }
    let appUrl: string;
    try {
      const url = new URL(req.body?.appUrl?.trim() ?? '');
      if (url.protocol !== 'https:' && url.hostname !== 'localhost') throw new Error('not https');
      appUrl = url.origin;
    } catch {
      throw new HttpError(400, 'invalid_app_url', 'Enter the address people open Preshift at, starting https://.');
    }
    await store.setSetting(setting, JSON.stringify({ resendApiKey, from, appUrl }));
    audit(req.org!, actor(req), 'settings.email_set', { from, appUrl });
    return { email: await emailView(req) };
  });

  app.delete('/v1/settings/email', admin, async (req) => {
    await store.setSetting(emailSetting(orgId(req)), null);
    audit(req.org!, actor(req), 'settings.email_removed');
    return { email: { set: false } };
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
