import { beforeEach, describe, expect, it } from 'vitest';
import { POST as anthropic } from '../api/anthropic/v1/messages.js';
import { POST as login } from '../api/auth/login.js';
import { GET as logout } from '../api/auth/logout.js';
import { GET as me } from '../api/auth/me.js';
import middleware from '../middleware.js';
import { hashPassword, parseUsers, verifyLogin } from './passwords.js';
import { COOKIE, createSession, readSession, safeNext, SESSION_SECONDS } from './session.js';

const SECRET = 'x'.repeat(40);
const ORIGIN = 'https://preshift.example';
let users = '';

beforeEach(async () => {
  users ||= `gm@site.co.uk:${await hashPassword('correct horse battery')}`;
  process.env.APP_USERS = users;
  process.env.SESSION_SECRET = SECRET;
});

const form = (fields) =>
  new Request(`${ORIGIN}/api/auth/login`, { method: 'POST', body: new URLSearchParams(fields) });
const withCookie = (path, token, init = {}) =>
  new Request(`${ORIGIN}${path}`, { ...init, headers: { ...(init.headers ?? {}), cookie: `${COOKIE}=${token}` } });

describe('sessions', () => {
  it('round-trips, expires, and rejects tampering or the wrong secret', async () => {
    const token = await createSession('gm@site.co.uk', SECRET, 0);
    expect(await readSession(token, SECRET, 1000)).toBe('gm@site.co.uk');
    expect(await readSession(token, SECRET, SESSION_SECONDS * 1000 + 1)).toBeNull();
    expect(await readSession(token, 'y'.repeat(40), 1000)).toBeNull();
    const [payload, sig] = token.split('.');
    const forged = btoa(JSON.stringify({ sub: 'owner@ws.co', exp: 9e9 })).replace(/=+$/, '');
    expect(await readSession(`${forged}.${sig}`, SECRET, 1000)).toBeNull();
    expect(await readSession(`${payload}.`, SECRET, 1000)).toBeNull();
    expect(await readSession('garbage', SECRET, 1000)).toBeNull();
  });

  it('only allows same-site redirects after sign in', () => {
    expect(safeNext('/app/?site=mar', '/app/')).toBe('/app/?site=mar');
    expect(safeNext('//evil.example', '/app/')).toBe('/app/');
    expect(safeNext('https://evil.example', '/app/')).toBe('/app/');
    expect(safeNext('/\\evil.example', '/app/')).toBe('/app/');
  });
});

describe('passwords', () => {
  it('verifies case-insensitively on email and ignores malformed user entries', async () => {
    const parsed = parseUsers(`${users},broken:entry, :`);
    expect(parsed.size).toBe(1);
    expect(await verifyLogin(parsed, ' GM@Site.co.uk ', 'correct horse battery')).toBe('gm@site.co.uk');
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
    expect(await (await me(withCookie('/api/auth/me', token))).json()).toEqual({ email: 'gm@site.co.uk' });
  });

  it('sends a wrong password back to the form without a cookie', async () => {
    const res = await login(form({ email: 'gm@site.co.uk', password: 'nope', next: '//evil.example' }));
    expect(res.headers.get('location')).toBe(`${ORIGIN}/login?next=%2Fapp%2F&error=invalid`);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('fails closed when sign-in is not configured', async () => {
    delete process.env.SESSION_SECRET;
    const res = await login(form({ email: 'gm@site.co.uk', password: 'correct horse battery' }));
    expect(res.headers.get('location')).toMatch(/error=setup/);
    expect(await middleware(new Request(`${ORIGIN}/app/`))).toBeInstanceOf(Response);
  });

  it('signs out by expiring the cookie', () => {
    const res = logout(new Request(`${ORIGIN}/api/auth/logout`));
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=0/);
    expect(res.headers.get('location')).toBe('/login?signedout=1');
  });
});

describe('guard', () => {
  it('redirects pages to sign in and lets a signed-in user through', async () => {
    const out = await middleware(new Request(`${ORIGIN}/app/?site=mar`));
    expect(out.status).toBe(303);
    expect(out.headers.get('location')).toBe(`${ORIGIN}/login?next=%2Fapp%2F%3Fsite%3Dmar`);
    const token = await createSession('gm@site.co.uk', SECRET);
    expect(await middleware(withCookie('/app/', token))).toBeUndefined();
  });

  it('keeps the Claude key behind sign in even if the middleware is bypassed', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const body = JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 10, messages: [] });
    const res = await anthropic(new Request(`${ORIGIN}/api/anthropic/v1/messages`, { method: 'POST', body }));
    expect(res.status).toBe(401);
    expect((await res.json()).error.type).toBe('session_expired');
  });
});
