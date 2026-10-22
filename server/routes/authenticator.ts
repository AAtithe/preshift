import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { live, roleOf, type User } from '../../src/engine/access';
import { HttpError, orgOf, type AppContext } from '../context';
import { actorOf, enrolled, verified } from '../guard';
import { seal, sealingKeyFor, unseal } from '../secrets';
import { createSession, sessionCookie } from '../session';
import { audit, type AuthenticatorRecord, type OrgData } from '../store';
import { newRecoveryCodes, newSecret, normaliseRecovery, otpauthUrl, verifyCode } from '../totp';

// Setting up an authenticator, and entering its code each session. The code switches on the
// strong rights (pay, payroll, locking, the journal, settings, access) for roles that need it.

const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60_000;
const LOCK_MS = 15 * 60_000;
const RECOVERY_LOW = 3;

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const codeBody = {
  type: 'object',
  additionalProperties: false,
  properties: { code: { type: 'string', maxLength: 12 }, recoveryCode: { type: 'string', maxLength: 20 } },
} as const;

/** The person behind this request, as stored: only a person has an authenticator. */
function person(req: FastifyRequest, org: OrgData, today: string): User {
  const actor = actorOf(req, org, today);
  if (actor.kind !== 'user') throw new HttpError(400, 'no_person', 'Only a person with an access record has an authenticator.');
  return org.users.find((u) => u.id === actor.user.id)!;
}

const key = (ctx: AppContext) => sealingKeyFor(ctx.store);

/** Where a person's authenticator is kept, and how a change to it is kept. */
interface Holder {
  record?: AuthenticatorRecord;
  save(record: AuthenticatorRecord): Promise<void>;
}

/**
 * A signed-in person's authenticator is the account's, one for every organisation they work in,
 * as the password is. A record still kept in the organisation from before moves to the account
 * the next time it changes. A personal key has no account, so its person's stays in the
 * organisation.
 */
/** The person's authenticator record, wherever it is kept. Never sent anywhere as it is. */
export const authenticatorOf = async (ctx: AppContext, req: FastifyRequest, org: OrgData, u: User) => (await holderFor(ctx, req, org, u)).record;

async function holderFor(ctx: AppContext, req: FastifyRequest, org: OrgData, u: User): Promise<Holder> {
  const email = req.principal.email;
  const account = email ? await ctx.store.getUser(email) : null;
  if (!account) {
    return {
      record: org.authenticators[u.id],
      save: async (record) => {
        org.authenticators[u.id] = record;
        req.orgChanged = true;
      },
    };
  }
  return {
    record: account.authenticator ?? org.authenticators[u.id],
    save: async (record) => {
      await ctx.store.updateUser(account.email, { authenticator: record });
      if (org.authenticators[u.id]) {
        delete org.authenticators[u.id];
        req.orgChanged = true;
      }
    },
  };
}

export const needsAuthenticator = (u: User, today: string) => u.memberships.some((m) => live(m, today) && roleOf(m.roleId)?.mfa);

/** What a person's own screen needs to know. Never the secret, never the codes. */
export function authenticatorState(req: FastifyRequest, org: OrgData, u: User, today: string, record: AuthenticatorRecord | undefined) {
  return {
    required: needsAuthenticator(u, today),
    enrolled: !!record?.secret && enrolled(req, org, u),
    verified: !!record?.secret && enrolled(req, org, u) && verified(req, org, u),
    recoveryLeft: record?.secret ? record.recovery.length : 0,
    recoveryLow: !!record?.secret && record.recovery.length < RECOVERY_LOW,
    lockedUntil: record?.lockedUntil && Date.parse(record.lockedUntil) > Date.now() ? record.lockedUntil : undefined,
    // Always: the key comes from PRESHIFT_SECRET_KEY or, failing that, the database.
    configured: true,
    // A key cannot type a code; only a signed-in session can prove itself.
    canVerify: !!req.principal.email,
  };
}

/** Re-issue the session cookie carrying the proof. Keys have no session, so nothing to set. */
async function proveSession(ctx: AppContext, req: FastifyRequest, reply: FastifyReply, record: AuthenticatorRecord) {
  const { email, orgId } = req.principal;
  if (!email) return;
  // Issued now: sessionsValidFrom is never later than a session the person is using.
  const token = await createSession({ email, orgId }, await ctx.store.sessionSecret(), Date.now(), record.id);
  const https = req.headers['x-forwarded-proto'] === 'https' || req.protocol === 'https';
  reply.header('set-cookie', sessionCookie(token, https));
}

/**
 * Keeps a failure, although the answer is an error: the organisation is not saved after an error,
 * so its audit row and any record still kept there are saved here.
 */
async function failed(ctx: AppContext, org: OrgData, holder: Holder, record: AuthenticatorRecord) {
  await holder.save(record);
  await ctx.store.save(org).catch(() => undefined);
}

function lockedOut(record: AuthenticatorRecord, now: number) {
  if (record.lockedUntil && Date.parse(record.lockedUntil) > now) {
    throw new HttpError(429, 'locked', `Too many wrong codes. Try again after ${new Date(record.lockedUntil).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' })}.`);
  }
}

function recordFailure(org: OrgData, u: User, record: AuthenticatorRecord, now: number) {
  record.failures = [...record.failures.filter((t) => now - Date.parse(t) < WINDOW_MS), new Date(now).toISOString()];
  if (record.failures.length >= MAX_FAILURES) {
    record.lockedUntil = new Date(now + LOCK_MS).toISOString();
    record.failures = [];
    audit(org, u.name, 'authenticator.locked', { userId: u.id });
  }
}

export function authenticatorRoutes(app: FastifyInstance, ctx: AppContext) {
  const tags = ['Authenticator'];
  const today = () => ctx.store.todayISO();

  app.get('/v1/me/authenticator', { schema: { tags, description: 'Whether your roles need an authenticator, whether it is set up, and whether this session has entered a code.' } }, async (req) => {
    const org = orgOf(req);
    const u = person(req, org, today());
    return authenticatorState(req, org, u, today(), (await holderFor(ctx, req, org, u)).record);
  });

  app.post('/v1/me/authenticator/start', { schema: { tags, description: 'A new secret to add to an authenticator app, with its QR code. Nothing changes until a code from it is confirmed.' } }, async (req) => {
    const org = orgOf(req);
    const u = person(req, org, today());
    const holder = await holderFor(ctx, req, org, u);
    // Moving to a new phone is allowed only from a session that has already proved the old one.
    if (holder.record?.secret && enrolled(req, org, u) && !verified(req, org, u)) {
      throw new HttpError(403, 'forbidden', 'Enter a code from your current authenticator first, or ask whoever manages access to reset it.');
    }
    const secret = newSecret();
    const record: AuthenticatorRecord = holder.record ?? { id: '', lastStep: -1, recovery: [], failures: [] };
    record.pending = seal(secret, await key(ctx));
    await holder.save(record);
    const url = otpauthUrl(secret, u.email);
    return { secret, otpauthUrl: url, qrSvg: await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) };
  });

  app.post<{ Body: { code?: string } }>(
    '/v1/me/authenticator/confirm',
    { schema: { tags, description: 'Confirms the new secret with a code from the app. Returns ten recovery codes, shown this once.', body: codeBody } },
    async (req, reply) => {
      const org = orgOf(req);
      const u = person(req, org, today());
      const holder = await holderFor(ctx, req, org, u);
      const record = holder.record;
      const pending = record?.pending ? unseal(record.pending, await key(ctx)) : null;
      if (!record || !pending) throw new HttpError(409, 'not_started', 'Start setting up the authenticator first.');
      const now = Date.now();
      lockedOut(record, now);
      const step = verifyCode(pending, req.body.code ?? '', now);
      if (step === null) {
        recordFailure(org, u, record, now);
        // Saved so the lockout counts, although the answer is an error.
        await failed(ctx, org, holder, record);
        throw new HttpError(422, 'wrong_code', 'That code does not match. Check the time on your phone is set automatically, then try the newest code.');
      }
      const codes = newRecoveryCodes();
      Object.assign(record, {
        id: randomBytes(12).toString('base64url'),
        secret: record.pending,
        pending: undefined,
        enrolledAt: new Date(now).toISOString(),
        lastStep: step,
        recovery: codes.map((c) => hash(normaliseRecovery(c))),
        failures: [],
        lockedUntil: undefined,
      });
      u.mfaEnrolled = true;
      await holder.save(record);
      audit(org, u.name, 'authenticator.enrolled', { userId: u.id });
      await proveSession(ctx, req, reply, record);
      // A session was just re-issued with its proof; it takes effect from the next request.
      if (req.principal.email) req.principal.accountMfaId = record.id;
      const state = authenticatorState(req, org, u, today(), record);
      return { recoveryCodes: codes, state: { ...state, verified: state.verified || !!req.principal.email } };
    },
  );

  app.post<{ Body: { code?: string; recoveryCode?: string } }>(
    '/v1/me/authenticator/verify',
    {
      schema: {
        tags,
        description: 'Enters a code (or a single-use recovery code) for this session, which switches on the rights that need it. Five wrong codes in 15 minutes lock it for 15 minutes.',
        body: codeBody,
      },
    },
    async (req, reply) => {
      const org = orgOf(req);
      const u = person(req, org, today());
      if (!req.principal.email) throw new HttpError(400, 'no_session', 'Codes are entered by a person signed in, not by an API key.');
      const holder = await holderFor(ctx, req, org, u);
      const record = holder.record;
      const secret = record?.secret ? unseal(record.secret, await key(ctx)) : null;
      if (!record || !secret || !enrolled(req, org, u)) throw new HttpError(409, 'not_enrolled', 'Set up an authenticator first.');
      const now = Date.now();
      lockedOut(record, now);
      let how: 'code' | 'recovery' = 'code';
      if (req.body.recoveryCode) {
        const h = hash(normaliseRecovery(req.body.recoveryCode));
        if (!record.recovery.includes(h)) {
          recordFailure(org, u, record, now);
          await failed(ctx, org, holder, record);
          throw new HttpError(422, 'wrong_code', 'That recovery code is not one of yours, or has been used.');
        }
        record.recovery = record.recovery.filter((x) => x !== h);
        how = 'recovery';
      } else {
        const step = verifyCode(secret, req.body.code ?? '', now, record.lastStep);
        if (step === null) {
          recordFailure(org, u, record, now);
          await failed(ctx, org, holder, record);
          throw new HttpError(422, 'wrong_code', 'That code does not match, or has already been used. Wait for the next one.');
        }
        record.lastStep = step;
      }
      record.failures = [];
      await holder.save(record);
      audit(org, u.name, how === 'code' ? 'authenticator.verified' : 'authenticator.recovery_used', { userId: u.id, ...(how === 'recovery' ? { left: record.recovery.length } : {}) });
      await proveSession(ctx, req, reply, record);
      // The cookie takes effect from the next request; this answer reports the state it gives.
      return { state: { ...authenticatorState(req, org, u, today(), record), verified: true } };
    },
  );

  app.post('/v1/me/authenticator/recovery-codes', { schema: { tags, description: 'Replaces your recovery codes with ten new ones. Needs a session that has entered a code.' } }, async (req) => {
    const org = orgOf(req);
    const u = person(req, org, today());
    const holder = await holderFor(ctx, req, org, u);
    const record = holder.record;
    if (!record?.secret || !verified(req, org, u)) throw new HttpError(403, 'forbidden', 'Enter a code from your authenticator first.');
    const codes = newRecoveryCodes();
    record.recovery = codes.map((c) => hash(normaliseRecovery(c)));
    await holder.save(record);
    audit(org, u.name, 'authenticator.recovery_replaced', { userId: u.id });
    return { recoveryCodes: codes };
  });
}
