import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { COOKIE, createSession, readSession, safeNext, SESSION_SECONDS } from './session';
import { MemoryStore, PgStore, type Query, type Store } from './store';
import { account, enrol, kit, tokenOf, TODAY, type Kit } from './testkit';

// Sign-in is main's: accounts, scrypt hashes, lockout, the session key in the database. What a
// person may do is their access record. These are main's tests, carried onto that one system.

const OWNER = { email: 'owner@ws.example', password: 'correct horse battery' };
const INTEGRATION = [{ key: 'integration', orgId: 'demo', name: 'Integration', scopes: ['*'] as ['*'] }];

function pglite(): Query {
  const db = new PGlite();
  return async (text, params) => (await db.query(text, params)).rows as Record<string, unknown>[];
}

/** A fresh system: an empty organisation, no accounts, so the first visitor creates the owner. */
const fresh = (store: Store = new MemoryStore([], TODAY), appDir?: string) => kit({ store, accounts: false, keys: INTEGRATION, ...(appDir ? {} : {}) }).then((k) => ({ ...k, appDir }));

async function setup(k: Kit, fields: Partial<Record<string, string>> = {}) {
  return k.form('/auth/setup', { email: OWNER.email, password: OWNER.password, confirm: OWNER.password, next: '/app/', ...fields });
}
const signIn = (k: Kit, email: string, password: string, next = '/app/') => k.form('/auth/login', { email, password, next });

/** The owner, signed in and with an authenticator, as they must be before managing access. */
async function owner(k: Kit) {
  const res = await setup(k);
  return (await enrol(k, res.cookie!)).cookie;
}

/** Invites someone and has them set their own password from the link. Returns their record id and cookie. */
async function invite(k: Kit, by: string, email: string, password: string, roleId = 'viewer') {
  const sent = await k.call('POST', '/v1/users', by, { email, name: email.split('@')[0], audience: 'operator', roleId });
  if (sent.status !== 201) throw new Error(`invite: ${sent.status} ${sent.raw}`);
  const accepted = await k.form('/auth/accept', { token: tokenOf(sent.body.inviteUrl), password, confirm: password });
  return { id: sent.body.user.id as string, cookie: accepted.cookie!, accepted };
}

describe('first-run owner setup', () => {
  it('creates the owner once with the Owner role on record, signs them in, then closes for good', async () => {
    const k = await fresh();
    expect((await k.call('GET', '/auth/status', null)).body).toEqual({ setupNeeded: true });
    const res = await setup(k);
    expect(res.status).toBe(303);
    expect(res.location).toBe('/app/');
    expect((await k.call('GET', '/auth/me', res.cookie!)).body).toEqual({ email: OWNER.email, orgId: 'demo' });
    const me = (await k.call('GET', '/v1/me', res.cookie!)).body;
    expect(me.user.memberships.map((m: { roleId: string }) => m.roleId)).toEqual(['owner']);
    // The owner manages access, which needs an authenticator: set up before anyone is invited.
    expect(me.authenticator).toMatchObject({ required: true, enrolled: false });

    expect((await k.call('GET', '/auth/status', null)).body).toEqual({ setupNeeded: false });
    const again = await setup(k, { email: 'intruder@evil.example' });
    expect(again.location).toMatch(/error=taken/);
    expect(again.cookie).toBeUndefined();
  });

  it('lets only one of two simultaneous attempts become owner, in Postgres', async () => {
    const k = await fresh(new PgStore(pglite(), [], TODAY));
    const [a, b] = await Promise.all([setup(k), setup(k, { email: 'second@ws.example' })]);
    expect([a, b].filter((r) => r.cookie)).toHaveLength(1);
  });

  it('rejects a weak or mistyped password and a bad email', async () => {
    const k = await fresh();
    expect((await setup(k, { password: 'short', confirm: 'short' })).location).toMatch(/error=weak/);
    expect((await setup(k, { confirm: 'something else entirely' })).location).toMatch(/error=mismatch/);
    expect((await setup(k, { email: 'not-an-email' })).location).toMatch(/error=email/);
    expect((await k.call('GET', '/auth/status', null)).body).toEqual({ setupNeeded: true });
  });
});

describe('a deployment', () => {
  it('has no fictional demo people on record, so the real owner is the only one who manages access', async () => {
    process.env.VERCEL = '1';
    try {
      const k = await kit({ store: new MemoryStore(['demo'], TODAY), accounts: false, keys: INTEGRATION });
      const res = await setup(k);
      const me = (await k.call('GET', '/v1/me', res.cookie!)).body;
      const people = (await k.call('GET', '/v1/access/health', res.cookie!)).body.counts.people;
      expect(me.user.memberships[0].roleId).toBe('owner');
      expect(people).toBe(1);
    } finally {
      delete process.env.VERCEL;
    }
  });
});

describe('signing in', () => {
  it('signs in case-insensitively, refuses wrong details, and only redirects on-site', async () => {
    const k = await fresh();
    await setup(k);
    expect((await signIn(k, '  OWNER@ws.example ', OWNER.password)).location).toBe('/app/');
    expect((await signIn(k, OWNER.email, 'wrong password here')).location).toBe('/login?next=%2Fapp%2F&error=invalid');
    expect((await signIn(k, 'nobody@ws.example', OWNER.password)).location).toMatch(/error=invalid/);
    expect((await signIn(k, OWNER.email, OWNER.password, '//evil.example')).location).toBe('/app/');
    expect(safeNext('/\\evil.example', '/app/')).toBe('/app/');
  });

  it('locks an account after five failures, and a reset link unlocks it', async () => {
    const k = await fresh();
    const boss = await owner(k);
    const gm = await invite(k, boss, 'gm@ws.example', 'gm password long');
    for (let i = 0; i < 5; i++) await signIn(k, 'gm@ws.example', 'wrong password here');
    expect((await signIn(k, 'gm@ws.example', 'gm password long')).location).toMatch(/error=locked/);
    const listed = (await k.call('GET', '/v1/users', boss)).body.find((u: { email: string }) => u.email === 'gm@ws.example');
    expect(listed.account).toMatchObject({ exists: true, locked: true });
    const reset = await k.call('POST', `/v1/users/${gm.id}/reset-password`, boss);
    expect(reset.status).toBe(200);
    expect((await k.call('POST', '/auth/reset', null, { token: tokenOf(reset.body.inviteUrl), password: 'a brand new password' })).status).toBe(200);
    expect((await signIn(k, 'gm@ws.example', 'a brand new password')).location).toBe('/app/');
  });

  it('keeps sessions across a cold start, because the signing key is in the database', async () => {
    const query = pglite();
    const first = await fresh(new PgStore(query, [], TODAY));
    const cookie = (await setup(first)).cookie!;
    const second = await fresh(new PgStore(query, [], TODAY));
    expect((await second.call('GET', '/v1/sites', cookie)).status).toBe(200);
  });

  it('refuses forged, expired and other-deployment sessions', async () => {
    const k = await fresh();
    await setup(k);
    const secret = await k.store.sessionSecret();
    const expired = await createSession({ email: OWNER.email, orgId: 'demo' }, secret, Date.now() - (SESSION_SECONDS + 60) * 1000);
    const foreign = await createSession({ email: OWNER.email, orgId: 'demo' }, 'another deployment secret');
    for (const token of [expired, foreign, 'garbage', `${expired.split('.')[0]}.`]) {
      expect((await k.call('GET', '/v1/sites', `${COOKIE}=${token}`)).status).toBe(401);
    }
    expect(await readSession(foreign, secret)).toBeNull();
  });

  it('refuses a suspended person even with the right password', async () => {
    const k = await fresh();
    const boss = await owner(k);
    const gm = await invite(k, boss, 'gm@ws.example', 'gm password long');
    await k.call('POST', `/v1/users/${gm.id}/suspend`, boss);
    expect((await signIn(k, 'gm@ws.example', 'gm password long')).location).toMatch(/error=suspended/);
    // A wrong password says only that it is wrong: suspension is not given away without it.
    expect((await signIn(k, 'gm@ws.example', 'not the password')).location).toMatch(/error=invalid/);
  });
});

describe('invitation and reset links', () => {
  it('lets the person set their own password, once, and greets them by name', async () => {
    const k = await fresh();
    const boss = await owner(k);
    const sent = await k.call('POST', '/v1/users', boss, { email: 'ama@ws.example', name: 'Ama Boateng', audience: 'operator', roleId: 'viewer' });
    expect(sent.body.inviteUrl).toMatch(/^\/login#invite=/);
    const token = tokenOf(sent.body.inviteUrl);
    expect((await k.call('POST', '/auth/link', null, { token })).body).toEqual({ name: 'Ama Boateng', email: 'ama@ws.example', kind: 'invite' });
    expect((await k.form('/auth/accept', { token, password: 'short', confirm: 'short' })).location).toMatch(/error=weak/);
    expect((await k.form('/auth/accept', { token, password: 'long enough password', confirm: 'something else' })).location).toMatch(/error=mismatch/);
    const ok = await k.form('/auth/accept', { token, password: 'long enough password', confirm: 'long enough password' });
    expect(ok.location).toBe('/app/');
    expect((await k.call('GET', '/v1/me', ok.cookie!)).body.user.status).toBe('active');
    expect((await k.form('/auth/accept', { token, password: 'another password!!', confirm: 'another password!!' })).location).toMatch(/error=badlink/);
    expect((await signIn(k, 'ama@ws.example', 'long enough password')).location).toBe('/app/');
  });

  it('ends the old password and every session when access resets it', async () => {
    const k = await fresh();
    const boss = await owner(k);
    const gm = await invite(k, boss, 'gm@ws.example', 'gm password long');
    const reset = await k.call('POST', `/v1/users/${gm.id}/reset-password`, boss);
    expect((await k.call('GET', '/v1/sites', gm.cookie)).status).toBe(401);
    expect((await signIn(k, 'gm@ws.example', 'gm password long')).location).toMatch(/error=invalid/);
    // The account's own reset link: checked by /auth/reset, the same as one from "Forgot your password?".
    expect(reset.body.inviteUrl).toMatch(/^\/login#reset=/);
    expect((await k.call('POST', '/auth/reset', null, { token: tokenOf(reset.body.inviteUrl) })).body).toEqual({ ok: true, email: 'gm@ws.example' });
  });

  it('refuses expired, forged and other-organisation links, without creating anything', async () => {
    const store = new MemoryStore([], TODAY);
    const k = await fresh(store);
    expect((await k.form('/auth/accept', { token: 'nowhere.forgedtoken12345', password: 'long enough password', confirm: 'long enough password' })).location).toMatch(/error=badlink/);
    expect(await store.orgIds()).not.toContain('nowhere');
    const boss = await owner(k);
    const sent = await k.call('POST', '/v1/users', boss, { email: 'late@ws.example', name: 'Late', audience: 'operator', roleId: 'viewer' });
    const org = await store.load('demo');
    for (const v of Object.values(org.inviteTokens)) v.expiresAt = '2020-01-01';
    expect((await k.form('/auth/accept', { token: tokenOf(sent.body.inviteUrl), password: 'long enough password', confirm: 'long enough password' })).location).toMatch(/error=expired/);
    // One email signs in to one organisation: an invitation elsewhere cannot take it over.
    await store.createUser(account('taken@acme.example', 'acme'));
    expect((await k.call('POST', '/v1/users', boss, { email: 'taken@acme.example', name: 'Taken', audience: 'operator', roleId: 'viewer' })).body.error).toBe('elsewhere');
  });
});

describe('managing people', () => {
  async function withTeam() {
    const k = await fresh();
    const boss = await owner(k);
    const gm = await invite(k, boss, 'gm@ws.example', 'gm password long');
    return { ...k, boss, gm };
  }

  it('gives a viewer the app but not access management, and never to an integration key', async () => {
    const t = await withTeam();
    expect((await t.call('GET', '/v1/sites', t.gm.cookie)).status).toBe(200);
    expect((await t.call('GET', '/v1/users', t.gm.cookie)).status).toBe(403);
    expect((await t.call('POST', '/v1/users', t.gm.cookie, { email: 'x@ws.example', name: 'X', audience: 'operator', roleId: 'viewer' })).status).toBe(403);
    expect((await t.call('GET', '/v1/users', { key: 'integration' })).status).toBe(403);
    expect((await t.call('POST', '/v1/users', { key: 'integration' }, { email: 'x@ws.example', name: 'X', audience: 'operator', roleId: 'owner' })).status).toBe(403);
  });

  it('ends access at once when someone is suspended', async () => {
    const t = await withTeam();
    expect((await t.call('POST', `/v1/users/${t.gm.id}/suspend`, t.boss)).status).toBe(200);
    expect((await t.call('GET', '/v1/sites', t.gm.cookie)).status).toBe(401);
  });

  it('never lets anyone change their own access, and never removes the last who manages it', async () => {
    const t = await withTeam();
    const ownerId = (await t.call('GET', '/v1/me', t.boss)).body.user.id;
    expect((await t.call('POST', `/v1/users/${ownerId}/suspend`, t.boss)).body.message).toMatch(/Somebody else/);
    // Someone signing in with no access record still acts organisation-wide, and still cannot remove the only owner.
    await t.store.createUser(account('norecord@ws.example'));
    const norecord = await t.as('norecord@ws.example');
    const res = await t.call('POST', `/v1/users/${ownerId}/suspend`, norecord);
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/nobody able to manage access/);
  });

  it('refuses duplicate emails and never returns password hashes', async () => {
    const t = await withTeam();
    expect((await t.call('POST', '/v1/users', t.boss, { email: 'GM@ws.example', name: 'Again', audience: 'operator', roleId: 'viewer' })).status).toBe(409);
    const listed = (await t.call('GET', '/v1/users', t.boss)).raw;
    expect(listed).not.toMatch(/"(hash|salt)"/);
  });

  it('lets people change their own password, signing out their other sessions', async () => {
    const t = await withTeam();
    const otherDevice = (await signIn(t, 'gm@ws.example', 'gm password long')).cookie!;
    expect((await t.call('POST', '/auth/password', t.gm.cookie, { currentPassword: 'wrong', newPassword: 'my own new password' })).status).toBe(400);
    const res = await t.call('POST', '/auth/password', t.gm.cookie, { currentPassword: 'gm password long', newPassword: 'my own new password' });
    expect(res.status).toBe(200);
    expect((await t.call('GET', '/v1/sites', res.cookie!)).status).toBe(200);
    expect((await t.call('GET', '/v1/sites', otherDevice)).status).toBe(401);
  });

  it('keeps each organisation to its own people', async () => {
    const t = await withTeam();
    await t.store.createUser(account('admin@acme.example', 'acme'));
    const acme = `${COOKIE}=${await createSession({ email: 'admin@acme.example', orgId: 'acme' }, await t.store.sessionSecret())}`;
    expect((await t.call('GET', '/v1/users', acme)).body).toEqual([]);
    expect((await t.call('POST', `/v1/users/${t.gm.id}/suspend`, acme)).status).toBe(404);
  });
});

describe('Claude key and the assistant', () => {
  const request = { model: 'claude-opus-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] };

  it('stores the key in the app, shows only its last four characters, and gates it on settings rights', async () => {
    const k = await fresh();
    const boss = await owner(k);
    expect((await k.call('POST', '/api/anthropic/v1/messages', null, request)).status).toBe(401);
    expect((await k.call('POST', '/api/anthropic/v1/messages', boss, request)).body.error.type).toBe('not_configured');

    expect((await k.call('PUT', '/v1/settings/claude-api-key', boss, { claudeApiKey: 'not a key' })).status).toBe(400);
    const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234';
    expect((await k.call('PUT', '/v1/settings/claude-api-key', boss, { claudeApiKey: key })).body).toEqual({ claudeApiKey: { set: true, endsWith: '1234' } });
    expect((await k.call('GET', '/v1/settings', boss)).raw).not.toContain('abcdefgh');
    const viewer = await invite(k, boss, 'v@ws.example', 'viewer password!');
    expect((await k.call('GET', '/v1/settings', viewer.cookie)).status).toBe(403);
    expect((await k.call('GET', '/v1/settings', { key: 'integration' })).status).toBe(403);

    expect((await k.call('POST', '/api/anthropic/v1/messages', boss, { ...request, model: 'claude-haiku-5-5' })).status).toBe(400);
    expect((await k.call('POST', '/api/anthropic/v1/messages', boss, { ...request, max_tokens: 99999 })).status).toBe(400);
  });
});

describe('the hosted app', () => {
  async function withApp() {
    const root = await mkdtemp(path.join(tmpdir(), 'app-'));
    const dir = path.join(root, 'app');
    await mkdir(path.join(dir, 'assets'), { recursive: true });
    await writeFile(path.join(dir, 'index.html'), '<html>app</html>');
    await writeFile(path.join(dir, 'assets', 'index-abc.js'), 'console.log(1)');
    await writeFile(path.join(root, 'secret.txt'), 'outside');
    const { buildApp } = await import('./app');
    const { TeamPaySimulator } = await import('./integrations/payroll/simulator');
    const store = new MemoryStore([], TODAY);
    const { app } = await buildApp({ apiKeys: [], store, provider: new TeamPaySimulator(), autoDispatch: false, appDir: dir });
    const get = (url: string, cookie?: string) => app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
    const owner = async () => {
      const res = await app.inject({ method: 'POST', url: '/auth/setup', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ email: OWNER.email, password: OWNER.password, confirm: OWNER.password }).toString() });
      return String(res.headers['set-cookie']).split(';')[0];
    };
    return { get, owner };
  }

  it('serves the sign-in page to anyone and the app only to signed-in people', async () => {
    const t = await withApp();
    const login = (await t.get('/login')).body;
    expect(login).toContain('Create the owner account');
    expect(login).toContain('Set your password');
    for (const url of ['/app/', '/app/assets/index-abc.js', '/app']) {
      const res = await t.get(url);
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe(`/login?next=${encodeURIComponent(url)}`);
    }
    const cookie = await t.owner();
    const page = await t.get('/app/', cookie);
    expect(page.body).toBe('<html>app</html>');
    expect(page.headers['cache-control']).toBe('private, no-store');
    expect((await t.get('/app/assets/index-abc.js', cookie)).headers['content-type']).toMatch(/javascript/);
    expect((await t.get('/app', cookie)).statusCode).toBe(308);
  });

  it('cannot be walked out of the app folder', async () => {
    const t = await withApp();
    const cookie = await t.owner();
    for (const url of ['/app/..%2fsecret.txt', '/app/%2e%2e/secret.txt', '/app/missing.js', '/app/%E0']) {
      // Fastify itself refuses a malformed address with 400; either way nothing is served.
      expect([400, 404]).toContain((await t.get(url, cookie)).statusCode);
    }
  });

  it('has no public key: the old demo key is refused', async () => {
    const k = await fresh();
    expect((await k.call('GET', '/v1/sites', { key: 'dev-key' })).status).toBe(401);
  });
});
