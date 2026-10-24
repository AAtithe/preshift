import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addDays, toISODate, weekStart } from '../src/engine/time';
import { buildApp } from './app';
import { loadApiKeys } from './auth';
import { ASSISTANT_CALLS, assistantCallsSetting, MAX_SANDBOXES_PER_ADDRESS, MAX_SANDBOXES_PER_DAY, SANDBOX_ROUTES, sandboxRouteAllowed, sweepSandboxes } from './demo';
import { signHmac, TeamPayProvider } from './integrations/payroll/teampay';
import { hashToken } from './routes/users';
import { londonDate, nextLondonMidnight, sandboxExpired } from './sandbox';
import { COOKIE, createSession } from './session';
import { MemoryStore, PgStore, type Query, type Store } from './store';

const OWNER = { email: 'owner@ws.example', password: 'correct horse battery' };

function pglite(): Query {
  const db = new PGlite();
  return async (text, params) => (await db.query(text, params)).rows as Record<string, unknown>[];
}

// A customer on real TeamPay. Never called: payroll changes are only queued, never dispatched.
const livePayroll = () => new TeamPayProvider({ baseUrl: 'http://127.0.0.1:9', apiKey: 'live', webhookSecret: 'live-secret', employerId: 'er_live' });

async function boot(options: { store?: Store; demo?: boolean; env?: NodeJS.ProcessEnv } = {}) {
  const store = options.store ?? new MemoryStore(['demo'], '2026-10-21');
  // Postcode and TfL lookups never leave the test.
  const offline = (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch;
  const { app, ctx, routes } = await buildApp({ apiKeys: [], store, provider: livePayroll(), autoDispatch: false, demo: options.demo ?? true, env: options.env ?? {}, fetch: offline, webhookFetch: offline });
  const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie'] ?? '').split(';')[0];
  const call = (method: string, url: string, cookie?: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method: method as 'GET',
      url,
      headers: { ...headers, ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      payload: body !== undefined ? JSON.stringify(body) : undefined,
    });
  const form = (url: string, fields: Record<string, string>, headers: Record<string, string> = {}, cookie?: string) =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...headers, ...(cookie ? { cookie } : {}), 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams(fields).toString(),
    });
  async function owner() {
    const res = await form('/auth/setup', { email: OWNER.email, password: OWNER.password, confirm: OWNER.password, next: '/app/' });
    expect(res.headers.location).toBe('/app/');
    return cookieOf(res);
  }
  async function visit(headers: Record<string, string> = {}, cookie?: string, fields: Record<string, string> = {}) {
    const res = await form('/demo/start', fields, headers, cookie);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/app/');
    return cookieOf(res);
  }
  const orgOf = async (cookie: string) => (await call('GET', '/auth/me', cookie)).json().orgId as string;
  return { app, ctx, routes, store, call, form, owner, visit, orgOf, cookieOf };
}

afterEach(() => vi.useRealTimers());

describe('demo route allowlist', () => {
  it('has a decision for every API route, so a new route cannot reach the demo by default', async () => {
    const { routes } = await boot();
    const api = routes.filter((r) => r.split(' ')[1].startsWith('/v1/'));
    expect(api.length).toBeGreaterThan(60);
    const undecided = api.filter((r) => !(r in SANDBOX_ROUTES));
    expect(undecided, `Add these to SANDBOX_ROUTES in server/demo.ts, true or false: ${undecided.join(', ')}`).toEqual([]);
    // And the list names no route that has gone, so it always reads as the system it guards.
    expect(Object.keys(SANDBOX_ROUTES).filter((r) => !api.includes(r))).toEqual([]);
  });

  it('refuses anything not listed', () => {
    expect(sandboxRouteAllowed('GET', '/v1/sites')).toBe(true);
    expect(sandboxRouteAllowed('POST', '/v1/users')).toBe(false);
    expect(sandboxRouteAllowed('POST', '/v1/something-new')).toBe(false);
    expect(sandboxRouteAllowed('GET', undefined)).toBe(false);
  });
});

describe('public demo on the live system', () => {
  it('gives each visitor a seeded sandbox of their own, apart from the customer and each other', async () => {
    const t = await boot();
    const customer = await t.owner();
    const a = await t.visit({ 'x-real-ip': '10.0.0.1' });
    const b = await t.visit({ 'x-real-ip': '10.0.0.2' });
    const [orgA, orgB] = [await t.orgOf(a), await t.orgOf(b)];
    expect(orgA).toMatch(/^sandbox-/);
    expect(orgA).not.toBe(orgB);
    expect((await t.call('GET', '/auth/me', a)).json()).toMatchObject({ demo: true });
    // No access record in their sandbox, so the visitor holds its full access; the Access screen
    // lists the demo's fictional team, none of whom has an account.
    expect((await t.call('GET', '/v1/me', a)).json()).toMatchObject({ withoutRecord: true });
    expect((await t.call('GET', '/v1/users', a)).json().length).toBeGreaterThan(5);
    expect((await t.call('GET', '/auth/me', customer)).json()).not.toHaveProperty('demo');

    const customerBefore = (await t.call('GET', '/v1/employees', customer)).json();
    const sites = (await t.call('GET', '/v1/sites', a)).json();
    const week = weekStart(toISODate(new Date()));
    const range = `?from=${week}&to=${addDays(week, 6)}`;
    // Each sandbox starts with the sample group's worked days; what one visitor builds stays in theirs.
    const bBefore = (await t.call('GET', `/v1/shifts${range}`, b)).json();
    expect((await t.call('POST', '/v1/rota/build', a, { siteIds: sites.map((s: { id: string }) => s.id), weekStart: week })).statusCode).toBe(200);
    const template = (await t.call('GET', '/v1/employees', a)).json()[0];
    const { id: _id, ...fields } = template;
    expect((await t.call('POST', '/v1/employees', a, { ...fields, name: 'Visitor Hire' })).statusCode).toBe(201);

    expect((await t.call('GET', `/v1/shifts${range}`, a)).json().length).toBeGreaterThan(bBefore.length);
    expect((await t.call('GET', `/v1/shifts${range}`, b)).json()).toEqual(bBefore);
    expect((await t.call('GET', `/v1/shifts${range}`, customer)).json()).toEqual([]);
    expect((await t.call('GET', '/v1/employees', customer)).json()).toEqual(customerBefore);
    expect((await t.call('GET', '/v1/employees', b)).json().some((e: { name: string }) => e.name === 'Visitor Hire')).toBe(false);
  });

  it('refuses visitors invitations, resets, keys, email, identity documents and staff logins, which customers keep', async () => {
    const t = await boot();
    const customer = await t.owner();
    const visitor = await t.visit();
    const person = (await t.call('GET', '/v1/employees', visitor)).json()[0].id;
    const denied: [string, string, unknown?][] = [
      ['POST', '/v1/users', { name: 'Real Person', email: 'someone@customer.example', roleId: 'viewer' }],
      ['POST', '/v1/users/usr_am_shd/resend-invite', {}],
      ['POST', '/v1/users/usr_viewer/reactivate', {}],
      ['POST', '/v1/users/usr_ops/reset-password', {}],
      ['POST', '/v1/users/usr_ops/reset-authenticator', {}],
      ['POST', '/v1/me/authenticator/start', {}],
      ['GET', '/v1/settings'],
      ['PUT', '/v1/settings/claude-api-key', { claudeApiKey: 'sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa' }],
      ['PUT', '/v1/settings/email', { resendApiKey: 're_x', from: 'a@example.com', appUrl: 'https://example.com' }],
      ['GET', '/v1/staff-logins'],
      ['POST', `/v1/staff-logins/${person}/invite`, {}],
      ['POST', `/v1/employees/${person}/right-to-work/documents`, {}],
      ['POST', '/v1/sites/travel/refresh', {}],
      ['POST', '/v1/api-keys', { name: 'mine' }],
      ['PUT', '/v1/integrations/epos', { accessToken: 'square-token', environment: 'production' }],
      ['POST', '/v1/webhooks', { url: 'http://169.254.169.254/latest/meta-data', events: ['shift.created'] }],
    ];
    for (const [method, url, body] of denied) {
      const res = await t.call(method, url, visitor, body);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error).toBe('demo');
    }
    // Customers answer to their own access rules, never the demo's.
    for (const [method, url, body] of denied) {
      const res = await t.call(method, url.replace(person, 'nobody'), customer, body);
      expect(res.statusCode === 403 ? res.json().error : 'not refused', `${method} ${url}`).not.toBe('demo');
    }
    expect((await t.call('GET', '/v1/users', customer)).statusCode).toBe(200);
    expect((await t.call('GET', '/v1/staff-logins', customer)).statusCode).toBe(200);
  });

  it('never opens a sandbox to a real account, or an invitation into one', async () => {
    const t = await boot();
    const customer = await t.owner();
    const visitor = await t.visit();
    const orgId = await t.orgOf(visitor);
    // Even with the sandbox in its memberships and a validly signed session for it.
    await t.store.updateUser(OWNER.email, { orgs: ['demo', orgId] });
    const forged = await createSession({ email: OWNER.email, orgId }, await t.store.sessionSecret());
    expect((await t.call('GET', '/v1/sites', `${COOKIE}=${forged}`)).statusCode).toBe(401);
    expect((await t.call('GET', '/v1/sites', customer)).statusCode).toBe(200);

    const org = await t.store.load(orgId);
    const token = `${orgId}.invitation`;
    org.inviteTokens[hashToken(token)] = { userId: 'usr_am_shd', expiresAt: '2099-01-01', kind: 'invite' };
    await t.store.save(org);
    const accept = await t.form('/auth/accept', { token, password: 'a long enough password', confirm: 'a long enough password' });
    expect(accept.headers.location).toMatch(/error=badlink/);
    expect(await t.store.getUser('zoe@marylebonegroup.example')).toBeNull();
  });

  it('never lets a visitor account sign in by password, change one or reset one', async () => {
    const t = await boot();
    const visitor = await t.visit();
    const email = (await t.call('GET', '/auth/me', visitor)).json().email;
    expect(email).toMatch(/\.invalid$/);
    expect((await t.form('/auth/login', { email, password: 'anything at all', next: '/app/' })).headers.location).toMatch(/error=invalid/);
    expect((await t.call('POST', '/auth/password', visitor, { currentPassword: 'x', newPassword: 'a long enough password' })).statusCode).toBe(403);
    expect((await t.form('/auth/forgot', { email })).headers.location).toMatch(/sent=1/);
    expect((await t.store.getUser(email))?.resetTokenHash).toBeUndefined();
  });

  it('does not stop the owner being created when visitors arrive first, in memory and Postgres', async () => {
    for (const store of [new MemoryStore(['demo'], '2026-10-21'), new PgStore(pglite(), ['demo'], '2026-10-21')]) {
      const t = await boot({ store });
      await t.visit();
      expect((await t.call('GET', '/auth/status')).json()).toEqual({ setupNeeded: true, demoAvailable: true });
      await t.owner();
      expect((await t.call('GET', '/auth/status')).json()).toEqual({ setupNeeded: false, demoAvailable: true });
    }
  });

  it('runs sandboxes on the simulator while the customer stays on real TeamPay', async () => {
    const t = await boot();
    const customer = await t.owner();
    const visitor = await t.visit();
    const orgId = await t.orgOf(visitor);
    expect(t.ctx.providerFor('demo').name).toBe('TeamPay');
    expect(t.ctx.providerFor(orgId).name).toBe('TeamPay (simulator)');
    expect((await t.call('GET', '/v1/integrations/payroll', customer)).json().provider).toBe('TeamPay');
    expect((await t.call('GET', '/v1/integrations/payroll', visitor)).json().provider).toBe('TeamPay (simulator)');

    const site = (await t.call('GET', '/v1/sites', visitor)).json()[0].id;
    const week = weekStart(toISODate(new Date()));
    expect((await t.call('POST', '/v1/dev/simulate-clocking', visitor, { siteId: site, weekStart: week })).statusCode).toBe(200);
    // Nobody can fake clocking on a customer's live payroll.
    expect((await t.call('POST', '/v1/dev/simulate-clocking', customer, { siteId: site, weekStart: week })).statusCode).toBe(404);
  });

  it('refuses webhooks signed with anything but the sandbox simulator secret, and never creates an organisation', async () => {
    const t = await boot();
    const visitor = await t.visit();
    const orgId = await t.orgOf(visitor);
    const body = JSON.stringify({ id: 'evt_1', type: 'payroll.run.completed', data: {} });
    const forged = await t.app.inject({
      method: 'POST',
      url: `/v1/integrations/teampay/webhook/${orgId}`,
      headers: { 'content-type': 'application/json', 'x-teampay-signature': signHmac('simulator-secret', body) },
      payload: body,
    });
    expect(forged.statusCode).toBe(401);
    // An unknown organisation answers exactly as a bad signature does, and is not created.
    const unknown = await t.app.inject({ method: 'POST', url: '/v1/integrations/teampay/webhook/made-up-org', headers: { 'content-type': 'application/json' }, payload: body });
    expect(unknown.statusCode).toBe(401);
    expect(await t.store.has('made-up-org')).toBe(false);
  });

  it('creates nothing on opening the page, and only from its own origin', async () => {
    const t = await boot();
    expect((await t.call('GET', '/demo')).body).toContain('Start the demo');
    const offsite = await t.form('/demo/start', {}, { origin: 'https://evil.example' });
    expect(offsite.headers.location).toBe('/demo?error=origin');
    expect(await t.store.sandboxIds()).toEqual([]);
    await t.visit({ origin: 'http://localhost:80', host: 'localhost:80' });
    expect(await t.store.sandboxIds()).toHaveLength(1);
  });

  it('takes a returning visitor back to their sandbox, and clears it when they start again', async () => {
    const t = await boot();
    const first = await t.visit();
    const again = await t.form('/demo/start', {}, {}, first);
    expect(again.headers.location).toBe('/app/');
    expect(again.headers['set-cookie']).toBeUndefined();
    const old = await t.orgOf(first);
    const fresh = await t.visit({}, first, { fresh: '1' });
    expect(await t.orgOf(fresh)).not.toBe(old);
    expect(await t.store.sandboxIds()).toEqual([await t.orgOf(fresh)]);
  });

  it('caps sandboxes per visitor address and per day', async () => {
    const t = await boot();
    for (let i = 0; i < MAX_SANDBOXES_PER_ADDRESS; i++) await t.visit({ 'x-real-ip': '10.1.1.1' });
    expect((await t.form('/demo/start', {}, { 'x-real-ip': '10.1.1.1' })).headers.location).toBe('/demo?error=busy');
    await t.visit({ 'x-real-ip': '10.1.1.2' });

    await t.store.setSetting(`demo_day:${londonDate(Date.now())}`, JSON.stringify({ sandboxes: MAX_SANDBOXES_PER_DAY, assistant: 0, addresses: {} }));
    expect((await t.form('/demo/start', {}, { 'x-real-ip': '10.1.1.3' })).headers.location).toBe('/demo?error=busy');
  });

  it('keeps the assistant off without a demo key, and to its allowance with one', async () => {
    const message = { model: 'claude-opus-5-5', max_tokens: 100, messages: [] };
    const off = await boot();
    const visitor = await off.visit();
    expect((await off.call('POST', '/api/anthropic/v1/messages', visitor, message)).json().error.type).toBe('demo');

    const on = await boot({ env: { PRESHIFT_DEMO_CLAUDE_KEY: 'sk-ant-demo' } });
    const capped = await on.visit();
    await on.store.setSetting(assistantCallsSetting(await on.orgOf(capped)), String(ASSISTANT_CALLS));
    const res = await on.call('POST', '/api/anthropic/v1/messages', capped, message);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/used its share/);
  });

  it('refuses integration keys that name a sandbox', () => {
    expect(() => loadApiKeys({ PRESHIFT_API_KEYS: JSON.stringify([{ key: 'k', orgId: 'sandbox-x', name: 'x', scopes: ['*'] }]) })).toThrow(/sandbox/);
  });
});

describe('midnight reset', () => {
  it('finds the next midnight in London in winter and in summer', () => {
    expect(new Date(nextLondonMidnight(Date.parse('2026-01-15T15:00:00Z'))).toISOString()).toBe('2026-01-16T00:00:00.000Z');
    expect(new Date(nextLondonMidnight(Date.parse('2026-07-15T15:00:00Z'))).toISOString()).toBe('2026-07-15T23:00:00.000Z');
    // 23:30 UTC in summer is already the next day in London.
    expect(londonDate(Date.parse('2026-07-15T23:30:00Z'))).toBe('2026-07-16');
  });

  it('ends a sandbox at midnight UK time, then deletes it and its visitor, leaving the customer', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 23:30 in London on a summer evening.
    vi.setSystemTime(new Date('2026-07-15T22:30:00Z'));
    const store = new PgStore(pglite(), ['demo'], '2026-07-15');
    const t = await boot({ store });
    const customer = await t.owner();
    const visitor = await t.visit();
    const orgId = await t.orgOf(visitor);
    const email = (await t.call('GET', '/auth/me', visitor)).json().email;

    vi.setSystemTime(new Date('2026-07-15T22:59:00Z'));
    expect((await t.call('GET', '/v1/sites', visitor)).statusCode).toBe(200);
    expect(await sweepSandboxes(store)).toBe(0);

    // 00:01 in London: the session has ended even before the reset runs.
    vi.setSystemTime(new Date('2026-07-15T23:01:00Z'));
    expect(sandboxExpired(orgId, Date.now())).toBe(true);
    expect((await t.call('GET', '/v1/sites', visitor)).statusCode).toBe(401);
    expect(await sweepSandboxes(store)).toBe(1);
    expect(await store.sandboxIds()).toEqual([]);
    expect(await store.getUser(email)).toBeNull();
    expect(await store.has('demo')).toBe(true);
    expect((await t.call('GET', '/v1/sites', customer)).statusCode).toBe(200);
  });

  it('keeps a sandbox opened before the sites open trading through the day, in memory and Postgres', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    for (const make of [() => new MemoryStore(['demo'], '2026-07-15'), () => new PgStore(pglite(), ['demo'], '2026-07-15')]) {
      // 09:00 in London, before any site opens.
      vi.setSystemTime(new Date('2026-07-15T08:00:00Z'));
      const t = await boot({ store: make() });
      const visitor = await t.visit();
      const today = async () => ((await t.call('GET', '/v1/sales', visitor)).json() as { siteId: string; date: string; hours?: { hour: number; netSales: number }[] }[])
        .find((d) => d.siteId === 'mar' && d.date === '2026-07-15');
      expect(await today()).toBeUndefined();

      // 16:30: lunch and the afternoon have traded, and only hours that have finished.
      vi.setSystemTime(new Date('2026-07-15T15:30:00Z'));
      const afternoon = await today();
      expect(afternoon?.hours?.map((h) => h.hour)).toEqual([11, 12, 13, 14, 15]);

      // 19:10: the evening adds to the day; the hours already taken are not rewritten.
      vi.setSystemTime(new Date('2026-07-15T18:10:00Z'));
      const evening = await today();
      expect(evening?.hours?.map((h) => h.hour)).toEqual([11, 12, 13, 14, 15, 16, 17, 18]);
      expect(evening?.hours?.slice(0, 5)).toEqual(afternoon?.hours);
      expect(await today()).toEqual(evening);
      vi.useRealTimers();
      vi.useFakeTimers({ toFake: ['Date'] });
    }
  });

  it('refuses to delete anything that is not a sandbox, in memory and Postgres', async () => {
    for (const store of [new MemoryStore(['demo'], '2026-10-21'), new PgStore(pglite(), ['demo'], '2026-10-21')]) {
      await store.load('demo');
      await expect(store.deleteSandbox('demo')).rejects.toThrow(/only demo sandboxes/);
      expect(await store.has('demo')).toBe(true);
    }
  });

  it('needs the cron secret to run the reset', async () => {
    const t = await boot({ env: { CRON_SECRET: 's3cret' } });
    expect((await t.call('GET', '/internal/demo-reset')).statusCode).toBe(401);
    expect((await t.call('GET', '/internal/demo-reset', undefined, undefined, { authorization: 'Bearer s3cret' })).json()).toEqual({ removed: 0 });
  });
});

describe('kill switch', () => {
  it('with the demo off, nothing starts and existing visitors are refused', async () => {
    const store = new MemoryStore(['demo'], '2026-10-21');
    const on = await boot({ store });
    const visitor = await on.visit();
    const off = await boot({ store, demo: false });
    expect((await off.call('GET', '/demo')).headers.location).toBe('/login');
    expect((await off.form('/demo/start', {})).statusCode).toBe(404);
    const res = await off.call('GET', '/v1/sites', visitor);
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/switched off/);
    expect((await off.call('GET', '/auth/status')).json()).not.toHaveProperty('demoAvailable');
    // The MCP connector works through the same API, so the switch holds there too.
    const viaMcp = await off.call('POST', '/mcp', visitor, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_sites', arguments: {} } });
    expect(viaMcp.json().result).toMatchObject({ isError: true });
    expect(viaMcp.json().result.content[0].text).toMatch(/switched off/);
  });
});
