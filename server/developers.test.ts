import { createHmac } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { MemoryStore, PgStore, type Store } from './store';
import { checkWebhookUrl, signWebhook, type Fetch } from './webhooks';

const OWNER = { email: 'owner@ws.example', password: 'correct horse battery' };
const WEEK = '2026-10-19';
const SHIFT = { employeeId: 'mar-2', roleId: 'chef', siteId: 'mar', date: WEEK, startMinute: 600, endMinute: 900, breakMinutes: 0 };

type Sent = { url: string; headers: Record<string, string>; body: string };

async function boot(options: { store?: Store; answer?: number; demo?: boolean; rateLimit?: number } = {}) {
  const sent: Sent[] = [];
  let answer = options.answer ?? 200;
  const webhookFetch: Fetch = async (url, init) => {
    sent.push({ url, headers: init.headers, body: init.body });
    return { status: answer };
  };
  const { app, ctx } = await buildApp({
    store: options.store ?? new MemoryStore(['demo'], '2026-10-21'),
    provider: new TeamPaySimulator(),
    autoDispatch: true,
    webhookFetch,
    demo: options.demo,
    rateLimit: options.rateLimit,
    env: {},
  });
  const res = await app.inject({
    method: 'POST',
    url: '/auth/setup',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ email: OWNER.email, password: OWNER.password, confirm: OWNER.password }).toString(),
  });
  const cookie = String(res.headers['set-cookie'] ?? '').split(';')[0];
  const call = async (method: string, url: string, auth: { cookie?: string; key?: string } = { cookie }, body?: unknown) => {
    const r = await app.inject({
      method: method as 'GET',
      url,
      headers: {
        ...(auth.cookie ? { cookie: auth.cookie } : {}),
        ...(auth.key ? { authorization: `Bearer ${auth.key}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      payload: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: r.statusCode, headers: r.headers, body: r.body ? r.json() : undefined };
  };
  const makeKey = async (scopes: string[], name = 'Tevalis EPOS') => (await call('POST', '/v1/api-keys', { cookie }, { name, scopes })).body;
  return { app, ctx, cookie, call, makeKey, sent, setAnswer: (n: number) => (answer = n) };
}

describe('API keys made in the app', () => {
  it('shows a new key once, keeps only its hash, and lets it reach its own organisation', async () => {
    const store = new MemoryStore(['demo'], '2026-10-21');
    const t = await boot({ store });
    const made = await t.makeKey(['rota:read']);
    expect(made.key).toMatch(/^psk_[A-Za-z0-9_-]{40,}$/);
    expect(made.endsWith).toBe(made.key.slice(-4));

    const listed = await t.call('GET', '/v1/api-keys');
    expect(listed.body.keys).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(made.key);
    expect(JSON.stringify(await store.listApiKeys('demo'))).not.toContain(made.key);

    const sites = await t.call('GET', '/v1/sites', { key: made.key });
    expect(sites.status).toBe(200);
    expect(sites.body.length).toBeGreaterThan(0);
    expect(sites.headers['x-ratelimit-limit']).toBe('300');
    expect((await t.call('GET', '/v1/api-keys')).body.keys[0].lastUsedAt).toBeTruthy();
  });

  it('holds a key to its scopes, never lets it manage keys, and stops it the moment it is revoked', async () => {
    const t = await boot();
    const made = await t.makeKey(['rota:read']);
    expect((await t.call('POST', '/v1/shifts', { key: made.key }, SHIFT)).status).toBe(403);
    const full = await t.makeKey(['*'], 'Everything');
    expect((await t.call('POST', '/v1/api-keys', { key: full.key }, { name: 'Sneaky', scopes: ['*'] })).status).toBe(403);
    expect((await t.call('GET', '/v1/api-keys', { key: full.key })).status).toBe(403);

    expect((await t.call('DELETE', `/v1/api-keys/${made.id}`)).status).toBe(204);
    const after = await t.call('GET', '/v1/sites', { key: made.key });
    expect(after.status).toBe(401);
    expect(after.body.message).toMatch(/revoked/);
  });

  it('refuses unknown scopes and a nameless key', async () => {
    const t = await boot();
    expect((await t.call('POST', '/v1/api-keys', undefined, { name: 'X', scopes: ['payroll:everything'] })).status).toBe(400);
    expect((await t.call('POST', '/v1/api-keys', undefined, { name: ' ', scopes: ['rota:read'] })).status).toBe(400);
  });

  it('slows a runaway key down with 429', async () => {
    const t = await boot({ rateLimit: 3 });
    const made = await t.makeKey(['rota:read']);
    for (let i = 0; i < 3; i++) expect((await t.call('GET', '/v1/sites', { key: made.key })).status).toBe(200);
    const fourth = await t.call('GET', '/v1/sites', { key: made.key });
    expect(fourth.status).toBe(429);
    expect(fourth.headers['retry-after']).toBeTruthy();
  });

  it('keeps keys in Postgres across restarts', async () => {
    const db = new PGlite();
    const query = async (text: string, params: unknown[]) => (await db.query(text, params)).rows as Record<string, unknown>[];
    const t = await boot({ store: new PgStore(query, ['demo'], '2026-10-21') });
    const made = await t.makeKey(['rota:read']);
    const again = await buildApp({ store: new PgStore(query, ['demo'], '2026-10-21'), provider: new TeamPaySimulator(), autoDispatch: false, env: {} });
    const res = await again.app.inject({ method: 'GET', url: '/v1/sites', headers: { authorization: `Bearer ${made.key}` } });
    expect(res.statusCode).toBe(200);
  });
});

describe('staff records and pay need employees:read', () => {
  it('keeps people, pay by person and clock locations from a rota:read key, and gives them to one with employees:read', async () => {
    const t = await boot();
    const bi = await t.makeKey(['rota:read'], 'Group BI');
    const hr = await t.makeKey(['rota:read', 'employees:read'], 'HR system');
    await t.call('POST', '/v1/rota/build', undefined, { siteId: 'mar', weekStart: WEEK });
    await t.call('POST', '/v1/time-entries', undefined, {
      employeeId: 'mar-2', siteId: 'mar', roleId: 'chef', date: WEEK, clockIn: 600, clockOut: 900, breakMinutes: 0,
    });
    const org = await t.ctx.store.load('demo');
    org.timeEntries[0].clockInLocation = { lat: 51.52, lng: -0.15, accuracyMetres: 10 } as never;

    for (const url of ['/v1/employees', '/v1/employees/mar-2', '/v1/payroll/submissions', '/v1/payroll/runs', '/v1/integrations/payroll/outbox', '/v1/privacy/retention']) {
      expect((await t.call('GET', url, { key: bi.key })).status, url).toBe(403);
      expect((await t.call('GET', url, { key: hr.key })).status, url).toBe(200);
    }

    const week = (key: string) => t.call('GET', `/v1/rota/week?siteId=mar&weekStart=${WEEK}`, { key });
    const biWeek = (await week(bi.key)).body.metrics.cost;
    expect(biWeek.total).toBeGreaterThan(0);
    expect(biWeek.employees).toEqual({});
    expect(biWeek.shifts).toEqual({});
    expect(Object.keys((await week(hr.key)).body.metrics.cost.employees).length).toBeGreaterThan(0);

    const entries = (key: string) => t.call('GET', `/v1/time-entries?siteId=mar`, { key });
    expect((await entries(bi.key)).body[0].clockInLocation).toBeUndefined();
    expect((await entries(hr.key)).body[0].clockInLocation).toMatchObject({ lat: 51.52 });
  });

  it('lets deployment keys made before the split keep reading staff records', async () => {
    const { loadApiKeys } = await import('./auth');
    const [old] = loadApiKeys({ PRESHIFT_API_KEYS: JSON.stringify([{ key: 'k', orgId: 'demo', name: 'Old', scopes: ['rota:read'] }]) });
    expect(old.scopes).toEqual(['rota:read', 'employees:read']);
  });
});

describe('webhooks', () => {
  it('sends a signed, thin event when a shift is added', async () => {
    const t = await boot();
    const hook = await t.call('POST', '/v1/webhooks', undefined, { url: 'https://epos.example/preshift', events: ['shift.created'] });
    expect(hook.status).toBe(201);
    expect(hook.body.secret).toMatch(/^whsec_/);
    expect(JSON.stringify((await t.call('GET', '/v1/webhooks')).body)).not.toContain(hook.body.secret);

    const shift = await t.call('POST', '/v1/shifts', undefined, SHIFT);
    expect(shift.status).toBe(201);
    expect(t.sent).toHaveLength(1);
    const [msg] = t.sent;
    expect(msg.url).toBe('https://epos.example/preshift');
    const event = JSON.parse(msg.body);
    expect(event).toMatchObject({ type: 'shift.created', orgId: 'demo', data: { id: shift.body.shift.id } });
    expect(msg.headers['preshift-event-type']).toBe('shift.created');

    const [, t1, v1] = /^t=(\d+),v1=([0-9a-f]+)$/.exec(msg.headers['preshift-signature'])!;
    expect(v1).toBe(createHmac('sha256', hook.body.secret).update(`${t1}.${msg.body}`).digest('hex'));

    // Not subscribed, so nothing is sent.
    await t.call('POST', '/v1/rota/clear', undefined, { siteId: 'mar', weekStart: WEEK });
    expect(t.sent).toHaveLength(1);
    const log = await t.call('GET', '/v1/webhooks/deliveries');
    expect(log.body[0]).toMatchObject({ type: 'shift.created', status: 'delivered', lastStatus: 200 });
  });

  it('never puts personal data or pay in an event', async () => {
    const t = await boot();
    await t.call('POST', '/v1/webhooks', undefined, { url: 'https://hr.example/in', events: ['*'] });
    await t.call('PATCH', '/v1/employees/mar-2', undefined, { hourlyRate: 14.5 });
    expect(t.sent).toHaveLength(1);
    const event = JSON.parse(t.sent[0].body);
    expect(event.type).toBe('employee.updated');
    expect(event.data).toEqual({ id: 'mar-2', fields: ['hourlyRate'] });
    expect(t.sent[0].body).not.toContain('14.5');
  });

  it('keeps a failed event queued and retries it with the next change, in order', async () => {
    const t = await boot({ answer: 500 });
    await t.call('POST', '/v1/webhooks', undefined, { url: 'https://down.example/hook', events: ['shift.created', 'shift.deleted'] });
    const shift = await t.call('POST', '/v1/shifts', undefined, SHIFT);
    expect(t.sent).toHaveLength(1);
    let log = await t.call('GET', '/v1/webhooks/deliveries');
    expect(log.body[0]).toMatchObject({ status: 'pending', attempts: 1, lastError: 'Answered 500' });

    t.setAnswer(200);
    await t.call('POST', `/v1/webhooks/deliveries/${log.body[0].id}/retry`);
    log = await t.call('GET', '/v1/webhooks/deliveries');
    expect(log.body[0].status).toBe('delivered');

    await t.call('DELETE', `/v1/shifts/${shift.body.shift.id}`);
    expect(t.sent.map((s) => JSON.parse(s.body).type)).toEqual(['shift.created', 'shift.created', 'shift.deleted']);
  });

  it('lets a partner register its own endpoint with a webhooks:write key, and send a test', async () => {
    const t = await boot();
    const ro = await t.makeKey(['rota:read']);
    expect((await t.call('POST', '/v1/webhooks', { key: ro.key }, { url: 'https://p.example/h', events: ['*'] })).status).toBe(403);
    const key = await t.makeKey(['rota:read', 'webhooks:write'], 'Partner');
    const hook = await t.call('POST', '/v1/webhooks', { key: key.key }, { url: 'https://p.example/h', events: ['rota.published'] });
    expect(hook.status).toBe(201);
    const test = await t.call('POST', `/v1/webhooks/${hook.body.id}/test`, { key: key.key });
    expect(test.body).toEqual({ delivered: true, status: 200, error: null });
    expect(JSON.parse(t.sent[0].body).type).toBe('webhook.test');
    // The test is not part of the queue.
    expect((await t.call('GET', '/v1/webhooks/deliveries', { key: key.key })).body).toEqual([]);
  });

  it('refuses unknown events, and addresses that are not public https', async () => {
    const t = await boot();
    expect((await t.call('POST', '/v1/webhooks', undefined, { url: 'https://a.example/h', events: ['payroll.everything'] })).status).toBe(400);
    for (const url of ['http://a.example/h', 'https://10.0.0.4/h', 'https://169.254.169.254/latest', 'https://192.168.1.2/', 'https://[::1]/', 'https://user:pw@a.example/', 'ftp://a.example/']) {
      expect(() => checkWebhookUrl(url, true), url).toThrow();
    }
    expect(checkWebhookUrl('http://localhost:4000/hook', false)).toBe('http://localhost:4000/hook');
    expect(() => checkWebhookUrl('http://localhost:4000/hook', true)).toThrow();
  });

  it('signs with a timestamp so receivers can refuse a replay', () => {
    expect(signWebhook('whsec_x', '{}', 1_700_000_000)).toBe(`t=1700000000,v1=${createHmac('sha256', 'whsec_x').update('1700000000.{}').digest('hex')}`);
  });
});

describe('in the public demo', () => {
  it('refuses keys and webhooks but keeps the docs open', async () => {
    const t = await boot({ demo: true });
    expect((await t.call('POST', '/v1/api-keys', undefined, { name: 'X', scopes: ['*'] })).status).toBe(403);
    expect((await t.call('POST', '/v1/webhooks', undefined, { url: 'https://a.example/h', events: ['*'] })).status).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: '/docs/json' })).statusCode).toBe(200);
  });
});
