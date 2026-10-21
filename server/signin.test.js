import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { POST as anthropic } from '../api/anthropic/v1/messages.js';
import { POST as login } from '../api/auth/login.js';
import { GET as logout } from '../api/auth/logout.js';
import { GET as me } from '../api/auth/me.js';
import { buildApp } from './app';
import { createAppGate } from './appGate';
import { loadApiKeys } from './auth';
import { hashPassword, parseUsers, verifyLogin } from './passwords';
import { COOKIE, createSession, readSession, safeNext, SESSION_SECONDS } from './session';
import { MemoryStore } from './store';

const SECRET = 'x'.repeat(40);
const ORIGIN = 'https://preshift.example';
const GM = { email: 'gm@site.co.uk', orgId: 'demo' };
let users = '';

beforeEach(async () => {
  users ||= `gm@site.co.uk:${await hashPassword('correct horse battery')}`;
  process.env.APP_USERS = users;
  process.env.SESSION_SECRET = SECRET;
});

const form = (fields) => new Request(`${ORIGIN}/api/auth/login`, { method: 'POST', body: new URLSearchParams(fields) });
const withCookie = (url, token, init = {}) =>
  new Request(`${ORIGIN}${url}`, { ...init, headers: { ...(init.headers ?? {}), cookie: `${COOKIE}=${token}` } });

describe('sessions', () => {
  it('round-trip with the organisation, expire, and reject tampering or the wrong secret', async () => {
    const token = await createSession(GM, SECRET, 0);
    expect(await readSession(token, SECRET, 1000)).toEqual(GM);
    expect(await readSession(token, SECRET, SESSION_SECONDS * 1000 + 1)).toBeNull();
    expect(await readSession(token, 'y'.repeat(40), 1000)).toBeNull();
    const [payload, sig] = token.split('.');
    const forged = btoa(JSON.stringify({ sub: 'owner@ws.co', org: 'acme', exp: 9e9 })).replace(/=+$/, '');
    expect(await readSession(`${forged}.${sig}`, SECRET, 1000)).toBeNull();
    expect(await readSession(`${payload}.`, SECRET, 1000)).toBeNull();
    expect(await readSession('garbage', SECRET, 1000)).toBeNull();
  });

  it('only allow same-site redirects after sign in', () => {
    expect(safeNext('/app/?site=mar', '/app/')).toBe('/app/?site=mar');
    expect(safeNext('//evil.example', '/app/')).toBe('/app/');
    expect(safeNext('https://evil.example', '/app/')).toBe('/app/');
    expect(safeNext('/\\evil.example', '/app/')).toBe('/app/');
  });
});

describe('passwords', () => {
  it('verify case-insensitively, carry the organisation, and ignore malformed entries', async () => {
    const parsed = parseUsers(`${users},${users.replace('gm@', 'fd@')}:acme,broken:entry, :`);
    expect(parsed.size).toBe(2);
    expect(await verifyLogin(parsed, ' GM@Site.co.uk ', 'correct horse battery')).toEqual(GM);
    expect(await verifyLogin(parsed, 'fd@site.co.uk', 'correct horse battery')).toEqual({ email: 'fd@site.co.uk', orgId: 'acme' });
    expect(await verifyLogin(parsed, 'gm@site.co.uk', 'wrong')).toBeNull();
    expect(await verifyLogin(parsed, 'nobody@site.co.uk', 'correct horse battery')).toBeNull();
  });
});

describe('sign in flow', () => {
  it('signs in, sets a secure HttpOnly cookie and returns to the page asked for', async () => {
    const res = await login(form({ email: 'gm@site.co.uk', password: 'correct horse battery', next: '/app/?w=1' }));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/app/?w=1');
    const cookie = res.headers.get('set-cookie');
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    const token = cookie.split(';')[0].split('=').slice(1).join('=');
    expect(await (await me(withCookie('/api/auth/me', token))).json()).toEqual(GM);
  });

  it('sends a wrong password back to the form without a cookie', async () => {
    const res = await login(form({ email: 'gm@site.co.uk', password: 'nope', next: '//evil.example' }));
    expect(res.headers.get('location')).toBe('/login?next=%2Fapp%2F&error=invalid');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('fails closed when sign-in is not configured', async () => {
    delete process.env.SESSION_SECRET;
    const res = await login(form({ email: 'gm@site.co.uk', password: 'correct horse battery' }));
    expect(res.headers.get('location')).toMatch(/error=setup/);
  });

  it('signs out by expiring the cookie', () => {
    const res = logout(new Request(`${ORIGIN}/api/auth/logout`));
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=0/);
    expect(res.headers.get('location')).toBe('/login?signedout=1');
  });
});

describe('app gate', () => {
  let gate;
  beforeEach(async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'gate-'));
    await mkdir(path.join(root, 'assets'));
    await writeFile(path.join(root, 'index.html'), '<html>app</html>');
    await writeFile(path.join(root, 'assets', 'index-abc.js'), 'console.log(1)');
    await writeFile(path.join(path.dirname(root), 'secret.txt'), 'outside');
    gate = createAppGate(root);
  });

  it('sends anyone without a session to sign in, for pages and assets alike', async () => {
    for (const url of ['/app/', '/app/assets/index-abc.js']) {
      const res = await gate(new Request(`${ORIGIN}${url}`));
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe(`/login?next=${encodeURIComponent(url)}`);
    }
  });

  it('serves the app to a signed-in user, without caching the HTML', async () => {
    const token = await createSession(GM, SECRET);
    const page = await gate(withCookie('/app/', token));
    expect(await page.text()).toBe('<html>app</html>');
    expect(page.headers.get('cache-control')).toBe('private, no-store');
    const asset = await gate(withCookie('/app/assets/index-abc.js', token));
    expect(asset.headers.get('content-type')).toMatch(/javascript/);
    expect((await gate(withCookie('/app', token))).status).toBe(308);
  });

  it('cannot be walked out of its folder', async () => {
    const token = await createSession(GM, SECRET);
    for (const url of ['/app/..%2fsecret.txt', '/app/%2e%2e/secret.txt', '/app/missing.js', '/app/%E0']) {
      expect((await gate(withCookie(url, token))).status).toBe(404);
    }
  });
});

describe('Preshift API', () => {
  const setup = async () => {
    const { app } = await buildApp({ apiKeys: [], store: new MemoryStore(['demo'], '2026-10-21'), autoDispatch: false });
    return (headers) => app.inject({ method: 'GET', url: '/v1/employees', headers });
  };

  it('accepts a signed-in session scoped to its own organisation, and nothing else', async () => {
    const get = await setup();
    expect((await get({})).statusCode).toBe(401);
    expect((await get({ authorization: 'Bearer dev-key' })).statusCode).toBe(401);
    expect((await get({ cookie: `${COOKIE}=forged.token` })).statusCode).toBe(401);
    const demo = await get({ cookie: `${COOKIE}=${await createSession(GM, SECRET)}` });
    const acme = await get({ cookie: `${COOKIE}=${await createSession({ email: 'fd@acme.co', orgId: 'acme' }, SECRET)}` });
    expect(demo.statusCode).toBe(200);
    expect(demo.json().length).toBeGreaterThan(0);
    // Only the demo organisation is seeded, so a user from another one sees none of its people.
    expect(acme.statusCode).toBe(200);
    expect(acme.json()).toEqual([]);
  });

  it('has no public fallback key in production', () => {
    expect(loadApiKeys({ NODE_ENV: 'production' })).toEqual([]);
  });

  it('keeps the Claude key behind sign in', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const body = JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 10, messages: [] });
    const res = await anthropic(new Request(`${ORIGIN}/api/anthropic/v1/messages`, { method: 'POST', body }));
    expect(res.status).toBe(401);
    expect((await res.json()).error.type).toBe('session_expired');
  });
});
