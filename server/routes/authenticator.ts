import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { live, roleOf, type User } from '../../src/engine/access';
import { HttpError, orgOf, type AppContext } from '../context';
import { actorOf, verified } from '../guard';
import { seal, sealingKey, unseal } from '../secrets';
import { COOKIE, createSession, SESSION_SECONDS } from '../session';
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

function key() {
  const k = sealingKey();
  if (!k) throw new HttpError(503, 'not_configured', 'Authenticators need PRESHIFT_SECRET_KEY set on the server before anyone can enrol.');
  return k;
}

export const needsAuthenticator = (u: User, today: string) => u.memberships.some((m) => live(m, today) && roleOf(m.roleId)?.mfa);

/** What a person's own screen needs to know. Never the secret, never the codes. */
export function authenticatorState(req: FastifyRequest, org: OrgData, u: User, today: string) {
  const record = org.authenticators[u.id];
  return {
    required: needsAuthenticator(u, today),
    enrolled: u.mfaEnrolled && !!record?.secret,
    verified: u.mfaEnrolled && verified(req, org, u),
    recoveryLeft: record?.secret ? record.recovery.length : 0,
    recoveryLow: !!record?.secret && record.recovery.length < RECOVERY_LOW,
    lockedUntil: record?.lockedUntil && Date.parse(record.lockedUntil) > Date.now() ? record.lockedUntil : undefined,
    configured: !!sealingKey(),
    // A key cannot type a code; only a signed-in session can prove itself.
    canVerify: !!req.principal.email,
  };
}

/** Re-issue the session cookie carrying the proof. Keys have no session, so nothing to set. */
async function proveSession(ctx: AppContext, req: FastifyRequest, reply: FastifyReply, record: AuthenticatorRecord) {
  const { email, orgId } = req.principal;
  if (!email || !ctx.sessionSecret) return;
  const token = await createSession({ email, orgId, mfa: record.id }, ctx.sessionSecret);
  const https = req.headers['x-forwarded-proto'] === 'https' || req.protocol === 'https';
  reply.header('set-cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}${https ? '; Secure' : ''}`);
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
    return authenticatorState(req, org, person(req, org, today()), today());
  });

  app.post('/v1/me/authenticator/start', { schema: { tags, description: 'A new secret to add to an authenticator app, with its QR code. Nothing changes until a code from it is confirmed.' } }, async (req) => {
    const org = orgOf(req);
    const u = person(req, org, today());
    // Moving to a new phone is allowed only from a session that has already proved the old one.
    if (u.mfaEnrolled && org.authenticators[u.id]?.secret && !verified(req, org, u)) {
      throw new HttpError(403, 'forbidden', 'Enter a code from your current authenticator first, or ask whoever manages access to reset it.');
    }
    const secret = newSecret();
    const record: AuthenticatorRecord = org.authenticators[u.id] ?? { id: '', lastStep: -1, recovery: [], failures: [] };
    record.pending = seal(secret, key());
    org.authenticators[u.id] = record;
    const url = otpauthUrl(secret, u.email);
    return { secret, otpauthUrl: url, qrSvg: await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) };
  });

  app.post<{ Body: { code?: string } }>(
    '/v1/me/authenticator/confirm',
    { schema: { tags, description: 'Confirms the new secret with a code from the app. Returns ten recovery codes, shown this once.', body: codeBody } },
    async (req, reply) => {
      const org = orgOf(req);
      const u = person(req, org, today());
      const record = org.authenticators[u.id];
      const pending = record?.pending ? unseal(record.pending, key()) : null;
      if (!record || !pending) throw new HttpError(409, 'not_started', 'Start setting up the authenticator first.');
      const now = Date.now();
      lockedOut(record, now);
      const step = verifyCode(pending, req.body.code ?? '', now);
      if (step === null) {
        recordFailure(org, u, record, now);
        // Saved so the lockout counts, although the answer is an error.
        await ctx.store.save(org).catch(() => undefined);
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
      audit(org, u.name, 'authenticator.enrolled', { userId: u.id });
      await proveSession(ctx, req, reply, record);
      // A session was just re-issued with its proof; it takes effect from the next request.
      const state = authenticatorState(req, org, u, today());
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
      const record = org.authenticators[u.id];
      const secret = record?.secret ? unseal(record.secret, key()) : null;
      if (!record || !secret || !u.mfaEnrolled) throw new HttpError(409, 'not_enrolled', 'Set up an authenticator first.');
      const now = Date.now();
      lockedOut(record, now);
      let how: 'code' | 'recovery' = 'code';
      if (req.body.recoveryCode) {
        const h = hash(normaliseRecovery(req.body.recoveryCode));
        if (!record.recovery.includes(h)) {
          recordFailure(org, u, record, now);
          await ctx.store.save(org).catch(() => undefined);
          throw new HttpError(422, 'wrong_code', 'That recovery code is not one of yours, or has been used.');
        }
        record.recovery = record.recovery.filter((x) => x !== h);
        how = 'recovery';
      } else {
        const step = verifyCode(secret, req.body.code ?? '', now, record.lastStep);
        if (step === null) {
          recordFailure(org, u, record, now);
          await ctx.store.save(org).catch(() => undefined);
          throw new HttpError(422, 'wrong_code', 'That code does not match, or has already been used. Wait for the next one.');
        }
        record.lastStep = step;
      }
      record.failures = [];
      audit(org, u.name, how === 'code' ? 'authenticator.verified' : 'authenticator.recovery_used', { userId: u.id, ...(how === 'recovery' ? { left: record.recovery.length } : {}) });
      await proveSession(ctx, req, reply, record);
      // The cookie takes effect from the next request; this answer reports the state it gives.
      return { state: { ...authenticatorState(req, org, u, today()), verified: true } };
    },
  );

  app.post('/v1/me/authenticator/recovery-codes', { schema: { tags, description: 'Replaces your recovery codes with ten new ones. Needs a session that has entered a code.' } }, async (req) => {
    const org = orgOf(req);
    const u = person(req, org, today());
    const record = org.authenticators[u.id];
    if (!record?.secret || !verified(req, org, u)) throw new HttpError(403, 'forbidden', 'Enter a code from your authenticator first.');
    const codes = newRecoveryCodes();
    record.recovery = codes.map((c) => hash(normaliseRecovery(c)));
    audit(org, u.name, 'authenticator.recovery_replaced', { userId: u.id });
    return { recoveryCodes: codes };
  });
}
