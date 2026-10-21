import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { MemoryStore, PgStore, type Query, type Store } from './store';

const OWNER = { email: 'owner@ws.example', password: 'correct horse battery' };
const MEMBER = { email: 'gm@ws.example', password: 'members own password' };
const EMAIL = { resendApiKey: 're_test_1234567890abcd', from: 'Preshift <rota@ws.example>', appUrl: 'https://rota.ws.example' };

function pglite(): Query {
  const db = new PGlite();
  return async (text, params) => (await db.query(text, params)).rows as Record<string, unknown>[];
}

let sent: { to: string[]; text: string; auth: string }[] = [];

beforeEach(() => {
  sent = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url !== 'https://api.resend.com/emails') throw new Error(`unexpected fetch ${url}`);
    sent.push({ ...JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>).authorization });
    return new Response('{}', { status: 200 });
  });
});
afterEach(() => vi.unstubAllGlobals());

async function boot(store: Store = new MemoryStore(['demo'], '2026-10-21'), { email = true } = {}) {
  const { app } = await buildApp({ apiKeys: [], store, provider: new TeamPaySimulator(), autoDispatch: false });
  const form = (url: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, payload: new URLSearchParams(fields).toString() });
  const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie'] ?? '').split(';')[0];
  const call = (method: string, url: string, cookie?: string, body?: unknown) =>
    app.inject({
      method: method as 'GET',
      url,
      headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      payload: body !== undefined ? JSON.stringify(body) : undefined,
    });
  const signIn = (email: string, password: string) => form('/auth/login', { email, password, next: '/app/' });

  const owner = cookieOf(await form('/auth/setup', { email: OWNER.email, password: OWNER.password, confirm: OWNER.password }));
  await call('POST', '/v1/users', owner, { ...MEMBER, role: 'member' });
  if (email) expect((await call('PUT', '/v1/settings/email', owner, EMAIL)).statusCode).toBe(200);
  const forgot = (address: string, headers?: Record<string, string>) => form('/auth/forgot', { email: address }, headers);
  const tokenFrom = (text: string) => /#reset=([A-Za-z0-9_-]+)/.exec(text)![1];
  return { app, owner, form, call, cookieOf, signIn, forgot, tokenFrom };
}

describe('forgot password', () => {
  it('answers the same whether or not the email has an account, and emails only a real one', async () => {
    const t = await boot();
    const unknown = await t.forgot('nobody@ws.example');
    const known = await t.forgot(' GM@ws.example ');
    expect(unknown.statusCode).toBe(303);
    expect(known.statusCode).toBe(303);
    expect(unknown.headers.location).toBe('/login?sent=1');
    expect(known.headers.location).toBe(unknown.headers.location);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual([MEMBER.email]);
    expect(sent[0].auth).toBe(`Bearer ${EMAIL.resendApiKey}`);
  });

  it('builds the link from the saved app address, never the request, with the token after #', async () => {
    const t = await boot();
    await t.forgot(MEMBER.email, { host: 'evil.example', 'x-forwarded-host': 'evil.example' });
    expect(sent[0].text).toContain('https://rota.ws.example/login#reset=');
    expect(sent[0].text).not.toContain('evil.example');
  });

  it('sends one account at most three emails an hour', async () => {
    const t = await boot();
    for (let i = 0; i < 5; i++) expect((await t.forgot(MEMBER.email)).headers.location).toBe('/login?sent=1');
    expect(sent).toHaveLength(3);
  });

  it('sends nothing until email is set up, and says the same', async () => {
    const t = await boot(undefined, { email: false });
    expect((await t.forgot(MEMBER.email)).headers.location).toBe('/login?sent=1');
    expect(sent).toHaveLength(0);
  });
});

describe('choosing a new password from a link', () => {
  it('checks the link, sets the password, signs out other devices and signs this one in', async () => {
    const t = await boot();
    const before = t.cookieOf(await t.signIn(MEMBER.email, MEMBER.password));
    await t.forgot(MEMBER.email);
    const token = t.tokenFrom(sent[0].text);

    expect((await t.call('POST', '/auth/reset', undefined, { token })).json()).toEqual({ ok: true, email: MEMBER.email });
    expect((await t.call('POST', '/auth/reset', undefined, { token, password: 'short' })).statusCode).toBe(400);

    const done = await t.call('POST', '/auth/reset', undefined, { token, password: 'a brand new passphrase' });
    expect(done.statusCode).toBe(200);
    expect(String(done.headers['set-cookie'])).toMatch(/HttpOnly/);
    expect((await t.call('GET', '/auth/me', t.cookieOf(done))).statusCode).toBe(200);
    expect((await t.call('GET', '/auth/me', before)).statusCode).toBe(401);
    expect((await t.signIn(MEMBER.email, MEMBER.password)).headers.location).toMatch(/error=invalid/);
    expect((await t.signIn(MEMBER.email, 'a brand new passphrase')).headers.location).toBe('/app/');
  });

  it('works once, and an earlier link stops working when a new one is sent', async () => {
    const t = await boot();
    await t.forgot(MEMBER.email);
    await t.forgot(MEMBER.email);
    const [first, second] = sent.map((m) => t.tokenFrom(m.text));
    expect((await t.call('POST', '/auth/reset', undefined, { token: first })).statusCode).toBe(410);
    expect((await t.call('POST', '/auth/reset', undefined, { token: second, password: 'a brand new passphrase' })).statusCode).toBe(200);
    expect((await t.call('POST', '/auth/reset', undefined, { token: second, password: 'and another passphrase' })).statusCode).toBe(410);
  });

  it('refuses a link after 30 minutes, or an invented one', async () => {
    const t = await boot();
    await t.forgot(MEMBER.email);
    const token = t.tokenFrom(sent[0].text);
    vi.useFakeTimers({ now: Date.now() + 31 * 60 * 1000, toFake: ['Date'] });
    try {
      expect((await t.call('POST', '/auth/reset', undefined, { token })).statusCode).toBe(410);
    } finally {
      vi.useRealTimers();
    }
    expect((await t.call('POST', '/auth/reset', undefined, { token: 'made-up' })).statusCode).toBe(410);
  });

  it('clears a lockout, since the person has proved they hold the inbox', async () => {
    const t = await boot();
    for (let i = 0; i < 5; i++) await t.signIn(MEMBER.email, 'wrong password here');
    expect((await t.signIn(MEMBER.email, MEMBER.password)).headers.location).toMatch(/error=locked/);
    await t.forgot(MEMBER.email);
    await t.call('POST', '/auth/reset', undefined, { token: t.tokenFrom(sent[0].text), password: 'a brand new passphrase' });
    expect((await t.signIn(MEMBER.email, 'a brand new passphrase')).headers.location).toBe('/app/');
  });

  it('lets only one of two simultaneous uses of a link change the password, in Postgres', async () => {
    const t = await boot(new PgStore(pglite(), ['demo'], '2026-10-21'));
    await t.forgot(MEMBER.email);
    const token = t.tokenFrom(sent[0].text);
    const results = await Promise.all([
      t.call('POST', '/auth/reset', undefined, { token, password: 'first new passphrase' }),
      t.call('POST', '/auth/reset', undefined, { token, password: 'second new passphrase' }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 410]);
  });
});

describe('admin reset links and email settings', () => {
  it('lets an admin, and only an admin, make a 24 hour link to hand over', async () => {
    const t = await boot(undefined, { email: false });
    const member = t.cookieOf(await t.signIn(MEMBER.email, MEMBER.password));
    expect((await t.call('POST', `/v1/users/${OWNER.email}/reset-link`, member)).statusCode).toBe(403);

    const res = await t.call('POST', `/v1/users/${MEMBER.email}/reset-link`, t.owner);
    expect(res.json().expiresInHours).toBe(24);
    vi.useFakeTimers({ now: Date.now() + 23 * 3600 * 1000, toFake: ['Date'] });
    try {
      expect((await t.call('POST', '/auth/reset', undefined, { token: res.json().token, password: 'set from a handed link' })).statusCode).toBe(200);
    } finally {
      vi.useRealTimers();
    }
    expect(sent).toHaveLength(0);
  });

  it('never returns the Resend key, keeps it when only the address changes, and refuses bad values', async () => {
    const t = await boot();
    const view = (await t.call('GET', '/v1/settings', t.owner)).json().email;
    expect(view).toEqual({ set: true, from: EMAIL.from, appUrl: EMAIL.appUrl, keyEndsWith: 'abcd' });
    expect(JSON.stringify(view)).not.toContain(EMAIL.resendApiKey);

    const moved = await t.call('PUT', '/v1/settings/email', t.owner, { from: EMAIL.from, appUrl: 'https://new.ws.example/app/' });
    expect(moved.json().email).toMatchObject({ appUrl: 'https://new.ws.example', keyEndsWith: 'abcd' });

    expect((await t.call('PUT', '/v1/settings/email', t.owner, { ...EMAIL, appUrl: 'http://rota.ws.example' })).statusCode).toBe(400);
    expect((await t.call('PUT', '/v1/settings/email', t.owner, { ...EMAIL, resendApiKey: 'sk-nope' })).statusCode).toBe(400);
    expect((await t.call('PUT', '/v1/settings/email', t.owner, { ...EMAIL, from: 'not an address' })).statusCode).toBe(400);

    expect((await t.call('DELETE', '/v1/settings/email', t.owner)).json()).toEqual({ email: { set: false } });
    await t.forgot(MEMBER.email);
    expect(sent).toHaveLength(0);
  });
});
