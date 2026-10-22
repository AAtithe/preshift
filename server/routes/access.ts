import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { User } from '../../src/engine/access';
import { getLimits, setLimits, spend } from '../assistantLimits';
import { signedIn } from '../auth';
import { HttpError, orgOf, type AppContext } from '../context';
import { guard } from '../guard';
import { hashPassword, passwordProblem, verifyPassword } from '../passwords';
import { createSession, safeNext, sessionCookie } from '../session';
import { audit, orgsOfAccount, type OrgData, type Store, type UserRecord } from '../store';
import { emailSetting, parseEmailSettings, resetEmail, sendMail } from '../mail';
import { addEvent, fromWebhook, recordSent, verifyWebhook, webhookPath } from '../maillog';
import { hashToken } from './users';

export const MAX_FAILURES = 5;
export const LOCK_SECONDS = 15 * 60;
const FIRST_ORG = 'demo';
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const RESET_MINUTES = 30;
/** Links an admin hands over themselves last a working day. */
export const ADMIN_RESET_HOURS = 24;
/** Reset emails one account can be sent in an hour, so the form cannot be used to flood someone's inbox. */
const MAX_RESETS_PER_HOUR = 3;
/** The forgot form always takes at least this long, so its timing does not show whether an account exists. */
const FORGOT_MIN_MS = 1200;

export const now = () => Math.floor(Date.now() / 1000);
export const normalise = (email: unknown) => (typeof email === 'string' ? email.trim().toLowerCase() : '');

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

/** A new reset link for the person, replacing any earlier one. Only its hash is kept. */
export async function issueReset(store: Store, user: UserRecord, seconds: number, patch: Partial<UserRecord> = {}) {
  const token = randomBytes(32).toString('base64url');
  await store.updateUser(user.email, { ...patch, resetTokenHash: hashToken(token), resetExpires: now() + seconds });
  return token;
}

export function secure(req: FastifyRequest) {
  return req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';
}

async function signIn(req: FastifyRequest, reply: FastifyReply, store: Store, user: UserRecord, next: string, orgId = user.orgId) {
  const token = await createSession({ email: user.email, orgId }, await store.sessionSecret());
  if (user.lastOrgId !== orgId) await store.updateUser(user.email, { lastOrgId: orgId });
  return reply.code(303).header('set-cookie', sessionCookie(token, secure(req))).header('location', next).send();
}

/** An organisation's name for the switcher: its companies, as there is no other. */
export const orgName = (org: OrgData) => org.state.entities.map((e) => e.name).join(', ') || org.orgId;

/**
 * Where a person lands on signing in: where they last worked, else home, else the first other
 * organisation that still lets them in. Null when every one has suspended them. An organisation
 * with no record of them opens only at home, where an account from before roles keeps its access.
 */
async function landingOrg(store: Store, user: UserRecord): Promise<string | null> {
  const order = [...new Set([...(user.lastOrgId ? [user.lastOrgId] : []), ...orgsOfAccount(user)])];
  for (const orgId of order) {
    if (!orgsOfAccount(user).includes(orgId) || !(await store.has(orgId))) continue;
    const record = recordFor(await store.load(orgId), user.email);
    if (record ? record.status === 'active' || record.status === 'invited' : orgId === user.orgId) return orgId;
  }
  return null;
}

/** A wrong password counts towards the lockout, wherever it was typed. */
async function wrongPassword(store: Store, user: UserRecord) {
  const failedAttempts = user.failedAttempts + 1;
  const lock = failedAttempts >= MAX_FAILURES;
  await store.updateUser(user.email, { failedAttempts: lock ? 0 : failedAttempts, lockedUntil: lock ? now() + LOCK_SECONDS : 0 });
  await new Promise((resolve) => setTimeout(resolve, 400));
}

/** Back to the sign-in page. A link's token rides after #, so it never reaches a server log. */
const backToLogin = (reply: FastifyReply, params: Record<string, string>, fragment = '') =>
  reply.code(303).header('location', `/login?${new URLSearchParams(params)}${fragment}`).send();

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
export function signInRoutes(app: FastifyInstance, ctx: AppContext, options: { demo?: boolean } = {}) {
  const { store } = ctx;
  const hidden = { schema: { hide: true } };
  const demo = options.demo ? { demo: true } : {};

  app.get('/auth/status', hidden, async () => (options.demo ? { setupNeeded: false, ...demo } : { setupNeeded: !(await store.hasUsers()) }));

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
      if (user) await wrongPassword(store, user);
      else await new Promise((resolve) => setTimeout(resolve, 400));
      return backToLogin(reply, { next, error: 'invalid' });
    }
    // The right password does not open a suspended account. Said only once the password is right.
    const orgId = await landingOrg(store, user);
    if (!orgId) return backToLogin(reply, { next, error: 'suspended' });
    if (user.failedAttempts || user.lockedUntil) await store.updateUser(user.email, { failedAttempts: 0, lockedUntil: 0 });
    return signIn(req, reply, store, user, next, orgId);
  });

  // A person sets their own password from an invitation or a reset link. Nobody else ever knows it.
  app.post<{ Body: Record<string, string> }>('/auth/accept', hidden, async (req, reply) => {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    const back = (error: string) => backToLogin(reply, { error }, `#invite=${encodeURIComponent(token)}`);
    const target = token ? await linkTarget(store, token) : null;
    if (!target) return backToLogin(reply, { error: 'badlink' });
    const { org, entry, user } = target;
    if (entry.expiresAt < store.todayISO()) return backToLogin(reply, { error: 'expired' });
    if (user.status === 'suspended') return backToLogin(reply, { error: 'suspended' });
    const existing = await store.getUser(user.email);
    let account: UserRecord;
    if (existing) {
      // Already signs in to Preshift: they prove it is them with the password they have. A link
      // that set a new one would hand the account, and every organisation it opens, to whoever
      // held the link, and an inviter holds it whenever email is not set up.
      if (existing.lockedUntil > now()) return back('locked');
      if (!(await verifyPassword(existing, req.body?.password ?? ''))) {
        await wrongPassword(store, existing);
        return back('invalid');
      }
      await store.updateUser(user.email, { orgs: [...new Set([...orgsOfAccount(existing), org.orgId])], failedAttempts: 0, lockedUntil: 0 });
      account = (await store.getUser(user.email))!;
    } else {
      if (passwordProblem(req.body?.password)) return back('weak');
      if (req.body.password !== req.body?.confirm) return back('mismatch');
      account = await newAccount(user.email, org.orgId, req.body.password);
      // Made meanwhile by another link: the person opens this one again and signs in with that password.
      if (!(await store.createUser(account))) return back('elsewhere');
    }
    delete org.inviteTokens[hashToken(token)];
    if (user.status === 'invited') {
      Object.assign(user, { status: 'active', activatedAt: new Date().toISOString(), inviteExpiresAt: undefined } satisfies Partial<User>);
      audit(org, user.name, 'invite.accepted', { userId: user.id, by: existing ? 'existing_account' : 'password' });
    } else if (!existing) {
      audit(org, user.name, 'user.password_set', { userId: user.id, by: entry.kind ?? 'invite' });
    }
    await store.save(org);
    return signIn(req, reply, store, account, '/app/', org.orgId);
  });

  // Who a link is for, so the page can greet them. Says nothing about anyone else. The token comes
  // in the body, never the address, so it stays out of logs.
  app.post<{ Body: { token?: string } }>('/auth/link', hidden, async (req, reply) => {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    const target = token ? await linkTarget(store, token) : null;
    if (!target || target.entry.expiresAt < store.todayISO()) return reply.code(404).send({ error: 'badlink' });
    // Whether they already sign in, so the page asks for their password rather than a new one.
    return { name: target.user.name, email: target.user.email, kind: target.entry.kind ?? 'invite', existing: !!(await store.getUser(target.user.email)) };
  });

  app.get('/auth/logout', hidden, async (req, reply) =>
    reply.code(303).header('set-cookie', sessionCookie('', secure(req), 0)).header('location', '/login?signedout=1').send(),
  );

  app.get('/auth/me', hidden, async (req, reply) => {
    const session = await signedIn(req.headers.cookie, store);
    if (!session) return reply.code(401).send({ error: 'unauthorised', message: 'Not signed in' });
    // What the person may do is their access record (/v1/me), not anything on the account.
    return { email: session.user.email, orgId: session.claims.orgId, organisations: await organisationsOf(session.user, session.claims.orgId), ...demo };
  });

  /** The organisations a person can switch to: their own list, never anyone else's. */
  async function organisationsOf(user: UserRecord, current: string) {
    const out: { orgId: string; name: string; current: boolean; home: boolean }[] = [];
    for (const orgId of orgsOfAccount(user)) {
      if (!(await store.has(orgId))) continue;
      const org = await store.load(orgId);
      const record = recordFor(org, user.email);
      const open = record ? record.status === 'active' : orgId === user.orgId;
      if (open || orgId === current) out.push({ orgId, name: orgName(org), current: orgId === current, home: orgId === user.orgId });
    }
    return out;
  }

  // Moves the session to another organisation the person works in. The authenticator code
  // entered this session still counts: it is the same person and the same authenticator.
  app.post<{ Body: { orgId?: string } }>('/auth/switch', hidden, async (req, reply) => {
    const session = await signedIn(req.headers.cookie, store);
    if (!session) return reply.code(401).send({ error: 'unauthorised', message: 'Not signed in' });
    const orgId = typeof req.body?.orgId === 'string' ? req.body.orgId : '';
    const target = (await organisationsOf(session.user, session.claims.orgId)).find((o) => o.orgId === orgId);
    if (!target) return reply.code(403).send({ error: 'forbidden', message: 'You have no access to that organisation.' });
    const token = await createSession({ email: session.user.email, orgId }, await store.sessionSecret(), Date.now(), session.claims.mfa);
    await store.updateUser(session.user.email, { lastOrgId: orgId });
    return reply.header('set-cookie', sessionCookie(token, secure(req))).send({ ok: true, orgId, name: target.name });
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
    await store.updateUser(user.email, { ...hashed, sessionsValidFrom: issued, resetTokenHash: undefined, resetExpires: undefined });
    // This session carries on, still proved by its authenticator code if it was.
    const token = await createSession({ email: user.email, orgId: claims.orgId }, await store.sessionSecret(), issued, claims.mfa);
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
        const id = await sendMail(settings, resetEmail(email, `${settings.appUrl}/login#reset=${token}`, RESET_MINUTES));
        // Logged against the person, so a reset that bounces shows on the Access tab.
        if (id) {
          const org = await store.load(user.orgId);
          recordSent(org, id, { to: email, kind: 'forgot', userId: recordFor(org, email)?.id, by: 'Forgot your password?' });
          await store.save(org).catch((err) => console.error('Reset email not logged:', err));
        }
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
    const landing = (await landingOrg(store, claimed)) ?? claimed.orgId;
    const token = await createSession({ email: claimed.email, orgId: landing }, await store.sessionSecret(), issued);
    return reply.header('set-cookie', sessionCookie(token, secure(req))).send({ ok: true });
  });

  // What Resend reports about the emails it sent: delivered, delayed, bounced, complained or failed.
  // Believed only with Resend's signature over the exact bytes, under the secret saved in Settings.
  app.post<{ Params: { orgId: string } }>('/v1/integrations/resend/webhook/:orgId', hidden, async (req, reply) => {
    const { orgId } = req.params;
    const settings = parseEmailSettings(await store.getSetting(emailSetting(orgId)));
    const raw = (req as unknown as { rawBody?: string }).rawBody ?? '';
    if (!settings?.webhookSecret || !verifyWebhook(settings.webhookSecret, req.headers, raw)) {
      return reply.code(401).send({ error: 'unauthorised', message: 'Signature not valid' });
    }
    const report = fromWebhook(String(req.headers['svix-id']), req.body);
    if (!report || !(await store.has(orgId))) return { ok: true, recorded: false };
    const org = await store.load(orgId);
    const record = addEvent(org, report.mailId, report.event);
    if (!record) return { ok: true, recorded: false };
    if (report.event.type === 'bounced' || report.event.type === 'complained' || report.event.type === 'failed') {
      audit(org, 'Resend', `email.${report.event.type}`, { mailId: report.mailId, kind: record.kind, userId: record.userId });
    }
    // A conflicting save answers 409, and Resend sends the report again.
    await store.save(org);
    return { ok: true, recorded: true };
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

  const emailView = async (req: FastifyRequest) => {
    const email = parseEmailSettings(await store.getSetting(emailSetting(orgId(req))));
    return email
      ? {
          set: true,
          from: email.from,
          appUrl: email.appUrl,
          keyEndsWith: email.resendApiKey.slice(-4),
          // The address to give Resend, and whether its signing secret is saved. Never the secret.
          webhook: { url: `${email.appUrl}${webhookPath(orgId(req))}`, set: !!email.webhookSecret },
        }
      : { set: false };
  };

  app.get('/v1/settings', hidden, async (req) => {
    settingsPerson(req);
    const key = await store.getSetting(claudeKeySetting(orgId(req)));
    return {
      claudeApiKey: key ? { set: true, endsWith: key.slice(-4) } : { set: false },
      claudeLimits: await getLimits(store, orgId(req)),
      claudeSpend: await spend(store, orgId(req), req.principal.email ?? req.principal.user?.email ?? null),
      email: await emailView(req),
    };
  });

  app.put<{ Body: { monthlyUsd?: number; dailyPerPersonUsd?: number } }>('/v1/settings/claude-limits', hidden, async (req) => {
    const who = settingsPerson(req);
    const current = await getLimits(store, orgId(req));
    const pick = (v: unknown, fallback: number) => (v === undefined ? fallback : Number(v));
    const next = {
      monthlyUsd: pick(req.body?.monthlyUsd, current.monthlyUsd),
      dailyPerPersonUsd: pick(req.body?.dailyPerPersonUsd, current.dailyPerPersonUsd),
    };
    for (const v of Object.values(next)) {
      if (!Number.isFinite(v) || v < 0 || v > 100_000) throw new HttpError(400, 'invalid_limit', 'Limits are dollar amounts between 0 and 100,000.');
    }
    await setLimits(store, orgId(req), next);
    audit(req.org!, who, 'settings.claude_limits_set', next);
    return { claudeLimits: next };
  });

  // Saving without a key keeps the one already saved, so the address can change without re-entering it.
  app.put<{ Body: { resendApiKey?: string; from?: string; appUrl?: string; webhookSecret?: string | null } }>('/v1/settings/email', hidden, async (req) => {
    const who = settingsPerson(req);
    const setting = emailSetting(orgId(req));
    const saved = parseEmailSettings(await store.getSetting(setting));
    const resendApiKey = req.body?.resendApiKey?.trim() || saved?.resendApiKey;
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
    // Blank keeps the saved secret, null removes it.
    const given = req.body?.webhookSecret;
    const webhookSecret = given === null ? undefined : given?.trim() || saved?.webhookSecret;
    if (webhookSecret && !/^whsec_[A-Za-z0-9+/]{20,}={0,2}$/.test(webhookSecret)) {
      throw new HttpError(400, 'invalid_webhook_secret', 'That does not look like a Resend webhook signing secret. It starts with whsec_.');
    }
    await store.setSetting(setting, JSON.stringify({ resendApiKey, from, appUrl, ...(webhookSecret ? { webhookSecret } : {}) }));
    audit(req.org!, who, 'settings.email_set', { from, appUrl, webhook: !!webhookSecret });
    return { email: await emailView(req) };
  });

  app.delete('/v1/settings/email', hidden, async (req) => {
    const who = settingsPerson(req);
    await store.setSetting(emailSetting(orgId(req)), null);
    audit(req.org!, who, 'settings.email_removed');
    return { email: { set: false } };
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
