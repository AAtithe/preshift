import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { COOKIE, createSession, readSession, safeNext, SESSION_SECONDS } from './session';
import { MemoryStore, PgStore, type Query, type Store } from './store';

const OWNER = { email: 'owner@ws.example', password: 'correct horse battery' };

function pglite(): Query {
  const db = new PGlite();
  return async (text, params) => (await db.query(text, params)).rows as Record<string, unknown>[];
}

async function boot(store: Store = new MemoryStore(['demo'], '2026-10-21'), appDir?: string) {
  const { app } = await buildApp({ apiKeys: [{ key: 'integration', orgId: 'demo', name: 'Integration', scopes: ['*'] }], store, provider: new TeamPaySimulator(), autoDispatch: false, appDir });

  const form = (url: string, fields: Record<string, string>) =>
    app.inject({ method: 'POST', url, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(fields).toString() });
  const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie'] ?? '').split(';')[0];

  async function setup(fields: Partial<Record<string, string>> = {}) {
    return form('/auth/setup', { email: OWNER.email, password: OWNER.password, confirm: OWNER.password, next: '/app/', ...fields });
  }
  async function signIn(email: string, password: string) {
    return form('/auth/login', { email, password, next: '/app/' });
  }
  const call = (method: string, url: string, cookie?: string, body?: unknown) =>
    app.inject({
      method: method as 'GET',
      url,
      headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      payload: body !== undefined ? JSON.stringify(body) : undefined,
    });

  return { app, store, form, setup, signIn, call, cookieOf };
}

describe('first-run owner setup', () => {
  it('creates the owner once, signs them in, and then closes for good', async () => {
    const t = await boot();
    expect((await t.call('GET', '/auth/status')).json()).toEqual({ setupNeeded: true });
    const res = await t.setup();
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/app/');
    expect(String(res.headers['set-cookie'])).toMatch(/HttpOnly.*SameSite=Lax/);
    expect((await t.call('GET', '/auth/me', t.cookieOf(res))).json()).toEqual({ email: OWNER.email, orgId: 'demo', role: 'admin', lead: false });

    expect((await t.call('GET', '/auth/status')).json()).toEqual({ setupNeeded: false });
    const again = await t.setup({ email: 'intruder@evil.example' });
    expect(again.headers.location).toMatch(/error=taken/);
    expect(again.headers['set-cookie']).toBeUndefined();
  });

  it('lets only one of two simultaneous attempts become owner, in Postgres', async () => {
    const t = await boot(new PgStore(pglite(), ['demo'], '2026-10-21'));
    const [a, b] = await Promise.all([t.setup(), t.setup({ email: 'second@ws.example' })]);
    const won = [a, b].filter((r) => r.headers['set-cookie']);
    expect(won).toHaveLength(1);
  });

  it('rejects a weak or mistyped password and a bad email', async () => {
    const t = await boot();
    expect((await t.setup({ password: 'short', confirm: 'short' })).headers.location).toMatch(/error=weak/);
    expect((await t.setup({ confirm: 'something else entirely' })).headers.location).toMatch(/error=mismatch/);
    expect((await t.setup({ email: 'not-an-email' })).headers.location).toMatch(/error=email/);
    expect((await t.call('GET', '/auth/status')).json()).toEqual({ setupNeeded: true });
  });
});

describe('signing in', () => {
  it('signs in case-insensitively, refuses wrong details, and only redirects on-site', async () => {
    const t = await boot();
    await t.setup();
    const ok = await t.signIn('  OWNER@ws.example ', OWNER.password);
    expect(ok.headers.location).toBe('/app/');
    const bad = await t.signIn(OWNER.email, 'wrong password here');
    expect(bad.headers.location).toBe('/login?next=%2Fapp%2F&error=invalid');
    expect((await t.signIn('nobody@ws.example', OWNER.password)).headers.location).toMatch(/error=invalid/);
    const evil = await t.form('/auth/login', { email: OWNER.email, password: OWNER.password, next: '//evil.example' });
    expect(evil.headers.location).toBe('/app/');
    expect(safeNext('/\\evil.example', '/app/')).toBe('/app/');
  });

  it('locks an account after five failures, and an admin reset unlocks it', async () => {
    const t = await boot();
    const owner = t.cookieOf(await t.setup());
    await t.call('POST', '/v1/users', owner, { email: 'gm@ws.example', password: 'gm password long', role: 'member' });
    for (let i = 0; i < 5; i++) await t.signIn('gm@ws.example', 'wrong password here');
    expect((await t.signIn('gm@ws.example', 'gm password long')).headers.location).toMatch(/error=locked/);
    expect((await t.call('GET', '/v1/users', owner)).json().find((u: { email: string }) => u.email === 'gm@ws.example').locked).toBe(true);
    await t.call('PATCH', '/v1/users/gm%40ws.example', owner, { password: 'a brand new password' });
    expect((await t.signIn('gm@ws.example', 'a brand new password')).headers.location).toBe('/app/');
  });

  it('keeps sessions across a cold start, because the signing key is in the database', async () => {
    const query = pglite();
    const first = await boot(new PgStore(query, ['demo'], '2026-10-21'));
    const cookie = first.cookieOf(await first.setup());
    const second = await boot(new PgStore(query, ['demo'], '2026-10-21'));
    expect((await second.call('GET', '/v1/sites', cookie)).statusCode).toBe(200);
  });

  it('refuses forged, expired and other-deployment sessions', async () => {
    const t = await boot();
    await t.setup();
    const secret = await t.store.sessionSecret();
    const expired = await createSession({ email: OWNER.email, orgId: 'demo' }, secret, Date.now() - (SESSION_SECONDS + 60) * 1000);
    const foreign = await createSession({ email: OWNER.email, orgId: 'demo' }, 'another deployment secret');
    for (const token of [expired, foreign, 'garbage', `${expired.split('.')[0]}.`]) {
      expect((await t.call('GET', '/v1/sites', `${COOKIE}=${token}`)).statusCode).toBe(401);
    }
    expect(await readSession(foreign, secret)).toBeNull();
  });
});

describe('managing people', () => {
  async function withTeam() {
    const t = await boot();
    const owner = t.cookieOf(await t.setup());
    await t.call('POST', '/v1/users', owner, { email: 'gm@ws.example', password: 'gm password long', role: 'member' });
    const gm = t.cookieOf(await t.signIn('gm@ws.example', 'gm password long'));
    return { ...t, owner, gm };
  }

  it('gives a member the app but not access management, and never to an integration key', async () => {
    const t = await withTeam();
    expect((await t.call('GET', '/v1/sites', t.gm)).statusCode).toBe(200);
    expect((await t.call('GET', '/v1/users', t.gm)).statusCode).toBe(403);
    expect((await t.call('POST', '/v1/users', t.gm, { email: 'x@ws.example', password: 'long enough pass', role: 'admin' })).statusCode).toBe(403);
    const keyed = await t.app.inject({ method: 'GET', url: '/v1/users', headers: { authorization: 'Bearer integration' } });
    expect(keyed.statusCode).toBe(403);
  });

  it('ends access immediately when someone is removed or their password is reset', async () => {
    const t = await withTeam();
    await t.call('PATCH', '/v1/users/gm%40ws.example', t.owner, { password: 'reset by the owner' });
    expect((await t.call('GET', '/v1/sites', t.gm)).statusCode).toBe(401);
    const again = t.cookieOf(await t.signIn('gm@ws.example', 'reset by the owner'));
    expect((await t.call('DELETE', '/v1/users/gm%40ws.example', t.owner)).statusCode).toBe(204);
    expect((await t.call('GET', '/v1/sites', again)).statusCode).toBe(401);
  });

  it('never leaves an organisation without an admin, and admins cannot remove themselves', async () => {
    const t = await withTeam();
    expect((await t.call('DELETE', `/v1/users/${encodeURIComponent(OWNER.email)}`, t.owner)).statusCode).toBe(409);
    expect((await t.call('PATCH', `/v1/users/${encodeURIComponent(OWNER.email)}`, t.owner, { role: 'member' })).json().error).toBe('last_admin');
    await t.call('PATCH', '/v1/users/gm%40ws.example', t.owner, { role: 'admin' });
    expect((await t.call('PATCH', `/v1/users/${encodeURIComponent(OWNER.email)}`, t.owner, { role: 'member' })).statusCode).toBe(200);
  });

  it('refuses duplicate emails and weak passwords, and never returns password hashes', async () => {
    const t = await withTeam();
    expect((await t.call('POST', '/v1/users', t.owner, { email: 'GM@ws.example', password: 'another long one', role: 'member' })).statusCode).toBe(409);
    expect((await t.call('POST', '/v1/users', t.owner, { email: 'new@ws.example', password: 'short', role: 'member' })).statusCode).toBe(400);
    const listed = (await t.call('GET', '/v1/users', t.owner)).body;
    expect(listed).not.toMatch(/hash|salt/);
  });

  it('lets people change their own password, signing out their other sessions', async () => {
    const t = await withTeam();
    const otherDevice = t.cookieOf(await t.signIn('gm@ws.example', 'gm password long'));
    expect((await t.call('POST', '/auth/password', t.gm, { currentPassword: 'wrong', newPassword: 'my own new password' })).statusCode).toBe(400);
    const res = await t.call('POST', '/auth/password', t.gm, { currentPassword: 'gm password long', newPassword: 'my own new password' });
    expect(res.statusCode).toBe(200);
    expect((await t.call('GET', '/v1/sites', t.cookieOf(res))).statusCode).toBe(200);
    expect((await t.call('GET', '/v1/sites', otherDevice)).statusCode).toBe(401);
  });

  it('keeps each organisation to its own people', async () => {
    const t = await withTeam();
    const acmeAdmin = { email: 'admin@acme.example', orgId: 'acme', role: 'admin' as const, salt: '0'.repeat(32), hash: '0'.repeat(128), createdAt: '', sessionsValidFrom: 0, failedAttempts: 0, lockedUntil: 0 };
    await t.store.createUser(acmeAdmin);
    const acme = `${COOKIE}=${await createSession(acmeAdmin, await t.store.sessionSecret())}`;
    expect((await t.call('GET', '/v1/users', acme)).json().map((u: { email: string }) => u.email)).toEqual(['admin@acme.example']);
    expect((await t.call('DELETE', '/v1/users/gm%40ws.example', acme)).statusCode).toBe(404);
  });
});

describe('Claude key and the assistant', () => {
  const request = { model: 'claude-opus-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] };

  it('stores the key in the app, shows only its last four characters, and gates the assistant', async () => {
    const t = await boot();
    const owner = t.cookieOf(await t.setup());
    expect((await t.call('POST', '/api/anthropic/v1/messages', undefined, request)).statusCode).toBe(401);
    expect((await t.call('POST', '/api/anthropic/v1/messages', owner, request)).json().error.type).toBe('not_configured');

    expect((await t.call('PUT', '/v1/settings/claude-api-key', owner, { claudeApiKey: 'not a key' })).statusCode).toBe(400);
    const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234';
    const saved = await t.call('PUT', '/v1/settings/claude-api-key', owner, { claudeApiKey: key });
    expect(saved.json()).toEqual({ claudeApiKey: { set: true, endsWith: '1234' } });
    expect((await t.call('GET', '/v1/settings', owner)).body).not.toContain('abcdefgh');

    expect((await t.call('POST', '/api/anthropic/v1/messages', owner, { ...request, model: 'claude-haiku-5-5' })).statusCode).toBe(400);
    expect((await t.call('POST', '/api/anthropic/v1/messages', owner, { ...request, max_tokens: 99999 })).statusCode).toBe(400);
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
    return boot(new MemoryStore(['demo'], '2026-10-21'), dir);
  }

  it('serves the sign-in page to anyone and the app only to signed-in people', async () => {
    const t = await withApp();
    expect((await t.call('GET', '/login')).body).toContain('Create the owner account');
    for (const url of ['/app/', '/app/assets/index-abc.js', '/app']) {
      const res = await t.call('GET', url);
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe(`/login?next=${encodeURIComponent(url)}`);
    }
    const owner = t.cookieOf(await t.setup());
    const page = await t.call('GET', '/app/', owner);
    expect(page.body).toBe('<html>app</html>');
    expect(page.headers['cache-control']).toBe('private, no-store');
    expect((await t.call('GET', '/app/assets/index-abc.js', owner)).headers['content-type']).toMatch(/javascript/);
    expect((await t.call('GET', '/app', owner)).statusCode).toBe(308);
  });

  it('cannot be walked out of the app folder', async () => {
    const t = await withApp();
    const owner = t.cookieOf(await t.setup());
    for (const url of ['/app/..%2fsecret.txt', '/app/%2e%2e/secret.txt', '/app/missing.js', '/app/%E0']) {
      // Fastify itself refuses a malformed address with 400; either way nothing is served.
      expect([400, 404]).toContain((await t.call('GET', url, owner)).statusCode);
    }
  });

  it('has no public key: the old demo key is refused', async () => {
    const t = await boot();
    const res = await t.app.inject({ method: 'GET', url: '/v1/sites', headers: { authorization: 'Bearer dev-key' } });
    expect(res.statusCode).toBe(401);
  });
});

describe('the WS lead account', () => {
  it('cannot be reset, demoted or removed by the operator’s admin, and is named only by a WS key', async () => {
    const store = new MemoryStore(['demo'], '2026-10-21');
    const { app } = await buildApp({
      apiKeys: [
        { key: 'integration', orgId: 'demo', name: 'Integration', scopes: ['*'] },
        { key: 'ws', orgId: 'demo', name: 'WS', scopes: ['programme:lead'] },
      ],
      store,
      provider: new TeamPaySimulator(),
      autoDispatch: false,
    });
    const form = (url: string, fields: Record<string, string>) =>
      app.inject({ method: 'POST', url, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(fields).toString() });
    const owner = await form('/auth/setup', { email: OWNER.email, password: OWNER.password, confirm: OWNER.password, next: '/app/' });
    const cookie = String(owner.headers['set-cookie'] ?? '').split(';')[0];
    const asOwner = (method: string, url: string, body?: unknown) =>
      app.inject({ method: method as 'GET', url, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, payload: body ? JSON.stringify(body) : undefined });
    const withKey = (key: string, method: string, url: string, body?: unknown) =>
      app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) }, payload: body ? JSON.stringify(body) : undefined });

    expect((await asOwner('POST', '/v1/users', { email: 'lead@ws.example', password: 'another long password', role: 'member' })).statusCode).toBe(201);
    // Neither the owner nor the operator's own full-access key can make someone the lead.
    expect((await asOwner('PUT', '/v1/programme-leads/lead@ws.example', { lead: true })).statusCode).toBe(403);
    expect((await withKey('integration', 'PUT', '/v1/programme-leads/lead@ws.example', { lead: true })).statusCode).toBe(403);
    expect((await withKey('ws', 'PUT', '/v1/programme-leads/lead@ws.example', { lead: true })).statusCode).toBe(200);

    expect((await asOwner('PATCH', '/v1/users/lead@ws.example', { password: 'owner chose this one' })).json().error).toBe('lead_account');
    expect((await asOwner('PATCH', '/v1/users/lead@ws.example', { role: 'admin' })).json().error).toBe('lead_account');
    expect((await asOwner('DELETE', '/v1/users/lead@ws.example')).json().error).toBe('lead_account');
    expect((await store.getUser('lead@ws.example'))?.lead).toBe(true);
  });
});
