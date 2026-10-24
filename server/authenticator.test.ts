import { afterEach, describe, expect, it } from 'vitest';
import { seal, sealingKey, sealingKeyFor, unseal } from './secrets';
import { DEMO_TOTP_SECRET } from './seedUsers';
import { COOKIE, readSession } from './session';
import { kit } from './testkit';
import { base32Encode, codeAt, stepAt, verifyCode } from './totp';

const OLIVIA = 'olivia@marylebonegroup.example'; // Owner: enrolled in the demo with the published demo secret
const NADIA = 'nadia@marylebonegroup.example'; // Finance director: role needs an authenticator, taken away in boot()
const KEYS = [
  { key: 'system', orgId: 'demo', name: 'System', scopes: ['*'] as ['*'] },
  { key: 'priya-key', orgId: 'demo', name: 'Priya key', scopes: ['*'] as ['*'], userId: 'usr_gm_mar' },
  // James, operations director, resets other people's authenticators: never his own, never by a system key.
  { key: 'james-key', orgId: 'demo', name: 'James key', scopes: ['*'] as ['*'], userId: 'usr_ops', mfa: true },
  // A second owner, added in the tests that need one: only an owner may reset an owner.
  { key: 'owner2-key', orgId: 'demo', name: 'Second owner key', scopes: ['*'] as ['*'], userId: 'usr_owner2', mfa: true },
];
const invite = (n: number) => ({ email: `new${n}@example.com`, name: `New ${n}`, audience: 'operator', roleId: 'viewer' });

async function boot() {
  const k = await kit({ keys: KEYS });
  // The demo's finance director has an authenticator; these tests start her without one.
  const org = await k.store.load('demo');
  org.users.find((u) => u.id === 'usr_fd')!.mfaEnrolled = false;
  delete org.authenticators.usr_fd;
  const call = async (method: string, url: string, as: { cookie?: string; key?: string }, body?: unknown) => {
    const res = await k.call(method, url, as.cookie ? `${COOKIE}=${as.cookie}` : as.key ? { key: as.key } : null, body);
    return { ...res, cookie: res.cookie?.split('=').slice(1).join('=') };
  };
  const signIn = async (email: string) => (await k.as(email)).split('=').slice(1).join('=');
  return { call, signIn, store: k.store };
}

afterEach(() => {
  delete process.env.VERCEL;
});

describe('codes', () => {
  it('matches the RFC 6238 test vectors', () => {
    const s = base32Encode(Buffer.from('12345678901234567890'));
    expect(codeAt(s, stepAt(59_000), 8)).toBe('94287082');
    expect(codeAt(s, stepAt(1_111_111_109_000), 8)).toBe('07081804');
    expect(codeAt(s, stepAt(20_000_000_000_000), 8)).toBe('65353130');
  });

  it('allows a step of clock drift either way, never more, and never the same step twice', () => {
    const now = 1_800_000_000_000;
    const at = (ms: number) => codeAt(DEMO_TOTP_SECRET, stepAt(ms));
    expect(verifyCode(DEMO_TOTP_SECRET, at(now - 30_000), now)).not.toBeNull();
    expect(verifyCode(DEMO_TOTP_SECRET, at(now + 30_000), now)).not.toBeNull();
    expect(verifyCode(DEMO_TOTP_SECRET, at(now - 90_000), now)).toBeNull();
    const used = verifyCode(DEMO_TOTP_SECRET, at(now), now)!;
    expect(verifyCode(DEMO_TOTP_SECRET, at(now), now, used)).toBeNull();
    expect(verifyCode(DEMO_TOTP_SECRET, 'abcdef', now)).toBeNull();
  });

  it('seals so that tampering is detected and another key cannot read it', () => {
    const key = sealingKey({})!;
    const sealed = seal('secret', key);
    expect(unseal(sealed, key)).toBe('secret');
    expect(unseal(sealed.slice(0, -2) + 'AA', key)).toBeNull();
    expect(unseal(sealed, Buffer.alloc(32, 7))).toBeNull();
    expect(sealingKey({ NODE_ENV: 'production' })).toBeNull();
  });
});

describe('the authenticator in a session', () => {
  it('keeps strong rights off until this session enters a code, then switches them on', async () => {
    const { call, signIn, store } = await boot();
    const before = await signIn(OLIVIA);
    const me = await call('GET', '/v1/me', { cookie: before });
    expect(me.body.authenticator).toMatchObject({ required: true, enrolled: true, verified: false });
    const refused = await call('POST', '/v1/users', { cookie: before }, invite(1));
    expect(refused.status).toBe(422);
    expect(refused.body.message).toMatch(/authenticator/);

    const ok = await call('POST', '/v1/me/authenticator/verify', { cookie: before }, { code: codeAt(DEMO_TOTP_SECRET, stepAt(Date.now())) });
    expect(ok.status).toBe(200);
    expect((await readSession(ok.cookie, await store.sessionSecret()))?.mfa).toBe('demo-usr_owner');
    expect((await call('GET', '/v1/me', { cookie: ok.cookie })).body.authenticator.verified).toBe(true);
    expect((await call('POST', '/v1/users', { cookie: ok.cookie }, invite(2))).status).toBe(201);
    // The cookie from before the code still has no proof.
    expect((await call('POST', '/v1/users', { cookie: before }, invite(3))).status).toBe(422);
  });

  it('refuses a code used once already', async () => {
    const { call, signIn } = await boot();
    const session = await signIn(OLIVIA);
    const code = codeAt(DEMO_TOTP_SECRET, stepAt(Date.now()));
    expect((await call('POST', '/v1/me/authenticator/verify', { cookie: session }, { code })).status).toBe(200);
    const again = await call('POST', '/v1/me/authenticator/verify', { cookie: session }, { code });
    expect(again.status).toBe(422);
    expect(again.body.message).toMatch(/already been used/);
  });

  it('locks after five wrong codes, even for the right code', async () => {
    const { call, signIn } = await boot();
    const session = await signIn(OLIVIA);
    for (let i = 0; i < 5; i++) expect((await call('POST', '/v1/me/authenticator/verify', { cookie: session }, { code: '000000' })).status).toBe(422);
    const locked = await call('POST', '/v1/me/authenticator/verify', { cookie: session }, { code: codeAt(DEMO_TOTP_SECRET, stepAt(Date.now())) });
    expect(locked.status).toBe(429);
    const trail = (await call('GET', '/v1/access/audit?userId=usr_owner', { key: 'james-key' })).body.map((e: { action: string }) => e.action);
    expect(trail).toContain('authenticator.locked');
  });

  it('enrols from scratch: QR, confirm, recovery codes once each', async () => {
    const { call, signIn } = await boot();
    const session = await signIn(NADIA);
    expect((await call('GET', '/v1/me', { cookie: session })).body.authenticator).toMatchObject({ required: true, enrolled: false });
    const start = await call('POST', '/v1/me/authenticator/start', { cookie: session });
    expect(start.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\/Preshift:nadia/);
    expect(start.body.qrSvg).toMatch(/^<svg/);
    expect((await call('POST', '/v1/me/authenticator/confirm', { cookie: session }, { code: '123456' })).status).toBe(422);
    const confirm = await call('POST', '/v1/me/authenticator/confirm', { cookie: session }, { code: codeAt(start.body.secret, stepAt(Date.now())) });
    expect(confirm.status).toBe(200);
    expect(confirm.body.recoveryCodes).toHaveLength(10);

    // A later session uses a recovery code instead of the phone; it works once.
    const later = await signIn(NADIA);
    const [first] = confirm.body.recoveryCodes as string[];
    const used = await call('POST', '/v1/me/authenticator/verify', { cookie: later }, { recoveryCode: first.toUpperCase() });
    expect(used.status).toBe(200);
    expect(used.body.state.recoveryLeft).toBe(9);
    expect((await call('POST', '/v1/me/authenticator/verify', { cookie: later }, { recoveryCode: first })).status).toBe(422);
    // Verified, Nadia may now send pay: the next thing to stop her is that no hours are approved.
    expect((await call('POST', '/v1/payroll/submissions', { cookie: used.cookie }, { weekStart: '2026-10-19' })).status).toBe(422);
  });

  it('ends every verified session when someone resets the authenticator', async () => {
    const { call, signIn, store } = await boot();
    const org = await store.load('demo');
    const owner = org.users.find((u) => u.id === 'usr_owner')!;
    org.users.push({ ...owner, id: 'usr_owner2', email: 'owner2@marylebonegroup.example', name: 'Second Owner', employeeId: undefined });
    const ok = await call('POST', '/v1/me/authenticator/verify', { cookie: await signIn(OLIVIA) }, { code: codeAt(DEMO_TOTP_SECRET, stepAt(Date.now())) });
    expect((await call('POST', '/v1/users', { cookie: ok.cookie }, invite(4))).status).toBe(201);
    // The operations director cannot: resetting someone who holds more than he could grant could hand him their account.
    const refused = await call('POST', '/v1/users/usr_owner/reset-authenticator', { key: 'james-key' });
    expect(refused.status).toBe(403);
    expect(refused.body.message).toContain('could hand you their account');
    expect((await call('POST', '/v1/users/usr_owner/reset-authenticator', { key: 'owner2-key' })).status).toBe(200);
    expect((await call('POST', '/v1/users', { cookie: ok.cookie }, invite(5))).status).toBe(422);
    expect((await call('GET', '/v1/me', { cookie: ok.cookie })).body.authenticator).toMatchObject({ enrolled: false, verified: false });

    // Re-enrolled on a new phone: the session proved against the old one stays without rights.
    const fresh = await signIn(OLIVIA);
    const start = await call('POST', '/v1/me/authenticator/start', { cookie: fresh });
    const confirm = await call('POST', '/v1/me/authenticator/confirm', { cookie: fresh }, { code: codeAt(start.body.secret, stepAt(Date.now())) });
    expect((await call('POST', '/v1/users', { cookie: confirm.cookie }, invite(6))).status).toBe(201);
    expect((await call('POST', '/v1/users', { cookie: ok.cookie }, invite(7))).status).toBe(422);
  });

  it('will not replace an authenticator from a session that has not proved the current one', async () => {
    const { call, signIn } = await boot();
    const session = await signIn(OLIVIA);
    expect((await call('POST', '/v1/me/authenticator/start', { cookie: session })).status).toBe(403);
    const ok = await call('POST', '/v1/me/authenticator/verify', { cookie: session }, { code: codeAt(DEMO_TOTP_SECRET, stepAt(Date.now())) });
    expect((await call('POST', '/v1/me/authenticator/start', { cookie: ok.cookie })).status).toBe(200);
  });

  it('never sends the secret or the recovery codes in any answer about people', async () => {
    const { call, signIn } = await boot();
    const session = await signIn(OLIVIA);
    for (const url of ['/v1/me', '/v1/users', '/v1/users/usr_owner', '/v1/me/authenticator', '/v1/access/health', '/v1/access/audit']) {
      const res = await call('GET', url, { cookie: session });
      expect(res.raw).not.toContain(DEMO_TOTP_SECRET);
      expect(res.raw).not.toMatch(/"(secret|pending|recovery)"/);
    }
  });

  it('does not let an API key type a code, and keeps the key in the database when none is set', async () => {
    const { call, signIn, store } = await boot();
    expect((await call('POST', '/v1/me/authenticator/verify', { key: 'priya-key' }, { code: '123456' })).status).toBe(400);
    process.env.VERCEL = '1';
    try {
      // A deployment without PRESHIFT_SECRET_KEY makes a key once, keeps it in the settings table and reuses it.
      const first = await sealingKeyFor(store);
      expect((await sealingKeyFor(store)).equals(first)).toBe(true);
      expect(first.equals(sealingKey({})!)).toBe(false);
      expect((await call('POST', '/v1/me/authenticator/start', { cookie: await signIn(NADIA) })).status).toBe(200);
      // A key set in the environment wins over the stored one.
      const fixed = 'ab'.repeat(32);
      expect((await sealingKeyFor(store, { VERCEL: '1', PRESHIFT_SECRET_KEY: fixed })).toString('hex')).toBe(fixed);
    } finally {
      delete process.env.VERCEL;
    }
  });
});
