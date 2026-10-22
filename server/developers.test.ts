import { createHmac } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { MemoryStore, PgStore, type Store } from './store';
import { codeAt, stepAt } from './totp';
import { checkWebhookUrl, signWebhook, type Fetch } from './webhooks';

const OWNER = { email: 'owner@ws.example', password: 'correct horse battery' };
const WEEK = '2026-10-19';
const SHIFT = { employeeId: 'mar-2', roleId: 'chef', siteId: 'mar', date: WEEK, startMinute: 600, endMinute: 900, breakMinutes: 0 };

type Sent = { url: string; headers: Record<string, string>; body: string };

async function boot(options: { store?: Store; answer?: number; demo?: boolean; rateLimit?: number; env?: NodeJS.ProcessEnv } = {}) {
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
    env: options.env ?? {},
    // The Marylebone GM's personal key, having entered their code: runs one site, holds no settings.
    apiKeys: [{ key: 'gm', orgId: 'demo', name: 'GM', scopes: ['*'], userId: 'usr_gm_mar', mfa: true }],
  });
  const res = await app.inject({
    method: 'POST',
    url: '/auth/setup',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ email: OWNER.email, password: OWNER.password, confirm: OWNER.password }).toString(),
  });
  const unproved = String(res.headers['set-cookie'] ?? '').split(';')[0];
  // Keys and webhooks need settings.manage, which needs the authenticator: the owner sets one up.
  let cookie = unproved;
  if (!options.demo) {
    const enrol = (url: string, body?: unknown) =>
      app.inject({ method: 'POST', url, headers: { cookie: unproved, ...(body ? { 'content-type': 'application/json' } : {}) }, payload: body ? JSON.stringify(body) : undefined });
    const secret = (await enrol('/v1/me/authenticator/start')).json().secret as string;
    const confirmed = await enrol('/v1/me/authenticator/confirm', { code: codeAt(secret, stepAt(Date.now())) });
    cookie = String(confirmed.headers['set-cookie']).split(';')[0];
  }
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
  return { app, ctx, cookie, unproved, call, makeKey, sent, setAnswer: (n: number) => (answer = n) };
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
    const full = await t.makeKey(['rota:read', 'rota:write', 'employees:read', 'webhooks:write'], 'Broad');
    expect((await t.call('POST', '/v1/api-keys', { key: full.key }, { name: 'Sneaky', scopes: ['rota:read'] })).status).toBe(403);
    expect((await t.call('GET', '/v1/api-keys', { key: full.key })).status).toBe(403);

    expect((await t.call('DELETE', `/v1/api-keys/${made.id}`)).status).toBe(204);
    const after = await t.call('GET', '/v1/sites', { key: made.key });
    expect(after.status).toBe(401);
    expect(after.body.message).toMatch(/revoked/);
  });

  it('is managed only by a person holding settings.manage with their authenticator', async () => {
    const t = await boot();
    expect((await t.call('POST', '/v1/api-keys', { cookie: t.unproved }, { name: 'X', scopes: ['rota:read'] })).status).toBe(403);
    expect((await t.call('GET', '/v1/api-keys', { cookie: t.unproved })).status).toBe(403);
    // A personal key acts as its person, but keys are made by people signed in, never by a key.
    expect((await t.call('POST', '/v1/api-keys', { key: 'gm' }, { name: 'X', scopes: ['rota:read'] })).status).toBe(403);
    // The GM holds no settings.manage, so cannot point the organisation's events anywhere either.
    expect((await t.call('POST', '/v1/webhooks', { key: 'gm' }, { url: 'https://a.example/h', events: ['*'] })).status).toBe(403);
  });

  it('never gives a key more than its maker holds across the organisation', async () => {
    const t = await boot();
    // The owner role holds settings but not payroll sending or approval: those are paired duties.
    for (const scopes of [['*'], ['payroll:write'], ['rota:read', 'time:approve']]) {
      const res = await t.call('POST', '/v1/api-keys', undefined, { name: 'Too much', scopes });
      expect(res.status, scopes.join()).toBe(403);
      expect(res.body.error).toBe('beyond_own_access');
    }
    expect((await t.call('GET', '/v1/api-keys')).body.keys).toEqual([]);
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

    for (const url of ['/v1/employees', '/v1/employees/mar-2', '/v1/payroll/submissions', '/v1/payroll/runs', '/v1/integrations/payroll/outbox']) {
      expect((await t.call('GET', url, { key: bi.key })).status, url).toBe(403);
      expect((await t.call('GET', url, { key: hr.key })).status, url).toBe(200);
    }
    // The retention schedule names people due for erasure: a person's job, never a key's.
    expect((await t.call('GET', '/v1/privacy/retention', { key: hr.key })).status).toBe(403);

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

  it('tells a partner when the rota assistant rewrites a week, without the instruction typed', async () => {
    const t = await boot();
    await t.call('POST', '/v1/webhooks', undefined, { url: 'https://epos.example/in', events: ['*'] });
    const week = '2026-12-07';
    const res = await t.call('PUT', '/v1/rota/week', undefined, {
      siteId: 'mar', weekStart: week, source: 'assistant', instruction: 'Ben is off sick Saturday, cover the bar',
      shifts: [{ ...SHIFT, date: week }],
    });
    expect(res.status).toBe(200);
    const events = t.sent.map((m) => JSON.parse(m.body));
    const applied = events.find((e) => e.type === 'rota.assistant_applied');
    expect(applied.data).toMatchObject({ siteId: 'mar', weekStart: week, shifts: 1 });
    expect(t.sent.map((m) => m.body).join()).not.toMatch(/Ben|sick/);
  });

  it('never puts personal data or pay in an event', async () => {
    const t = await boot();
    await t.call('POST', '/v1/webhooks', undefined, { url: 'https://hr.example/in', events: ['*'] });
    await t.call('PATCH', '/v1/employees/mar-2', undefined, { hourlyRate: 14.5 });
    // A person's rate change is a proposal for finance: the event says one is waiting, never the amount.
    expect(t.sent).toHaveLength(1);
    const event = JSON.parse(t.sent[0].body);
    expect(event.type).toBe('pay.change_proposed');
    expect(Object.keys(event.data).sort()).toEqual(['employeeId', 'id']);
    expect(event.data.employeeId).toBe('mar-2');
    expect(t.sent[0].body).not.toContain('14.5');
  });

  it('keeps a failed event queued and retries it with the next change, in order', async () => {
    const t = await boot({ answer: 500 });
    await t.call('POST', '/v1/webhooks', undefined, { url: 'https://down.example/hook', events: ['shift.created', 'shift.deleted'] });
    // A shift still to come: one that has started can no longer be removed.
    const shift = await t.call('POST', '/v1/shifts', undefined, { ...SHIFT, date: '2026-12-07' });
    expect(t.sent).toHaveLength(1);
    let log = await t.call('GET', '/v1/webhooks/deliveries');
    expect(log.body[0]).toMatchObject({ status: 'pending', attempts: 1, lastError: 'Answered 500' });

    t.setAnswer(200);
    await t.call('POST', `/v1/webhooks/deliveries/${log.body[0].id}/retry`);
    log = await t.call('GET', '/v1/webhooks/deliveries');
    expect(log.body[0].status).toBe('delivered');

    expect((await t.call('DELETE', `/v1/shifts/${shift.body.shift.id}`)).status).toBe(204);
    expect(t.sent.map((s) => JSON.parse(s.body).type)).toEqual(['shift.created', 'shift.created', 'shift.deleted']);
  });

  it('retries on the 15 minute cron when nothing else in the organisation changes', async () => {
    const t = await boot({ answer: 503, env: { CRON_SECRET: 'cron' } });
    await t.call('POST', '/v1/webhooks', undefined, { url: 'https://down.example/hook', events: ['shift.created'] });
    await t.call('POST', '/v1/shifts', undefined, SHIFT);
    expect(t.sent).toHaveLength(1);

    const cron = (auth?: string) => t.app.inject({ method: 'GET', url: '/internal/webhooks', headers: auth ? { authorization: auth } : {} });
    expect((await cron()).statusCode).toBe(401);
    expect((await cron('Bearer wrong')).statusCode).toBe(401);

    // Not due yet: the cron leaves it alone.
    expect((await cron('Bearer cron')).statusCode).toBe(200);
    expect(t.sent).toHaveLength(1);

    // Once its backoff has passed and the partner is back, the cron delivers it.
    t.setAnswer(200);
    const org = await t.ctx.store.load('demo');
    org.webhookDeliveries![0].nextAttemptAt = Date.now() - 1;
    expect((await cron('Bearer cron')).statusCode).toBe(200);
    expect(t.sent).toHaveLength(2);
    expect((await t.call('GET', '/v1/webhooks/deliveries')).body[0]).toMatchObject({ status: 'delivered', attempts: 1 });
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

describe('HR webhook events', () => {
  it('sends absence and personnel events only to an endpoint that names them, with ids and never the reason', async () => {
    const t = await boot();
    await t.call('POST', '/v1/webhooks', undefined, { url: 'https://bi.example/all', events: ['*'] });
    const hr = await t.call('POST', '/v1/webhooks', undefined, { url: 'https://hr.example/in', events: ['hr.absence.created', 'hr.record.created'] });
    expect(hr.status).toBe(201);

    const abs = await t.call('POST', '/v1/employees/mar-2/absences', undefined, { type: 'sickness', from: '2026-10-20', reason: 'Migraine' });
    expect(abs.status).toBe(201);
    const toHr = t.sent.filter((m) => m.url === 'https://hr.example/in');
    expect(t.sent.filter((m) => m.url === 'https://bi.example/all')).toEqual([]);
    expect(toHr).toHaveLength(1);
    const event = JSON.parse(toHr[0].body);
    expect(event.type).toBe('hr.absence.created');
    expect(Object.keys(event.data).sort()).toEqual(['absenceId', 'id']);
    expect(toHr[0].body).not.toMatch(/sickness|Migraine|2026-10-20/);
  });

  it('never sends a disciplinary, grievance or capability case, even to an endpoint that asks', async () => {
    const t = await boot();
    await t.call('POST', '/v1/webhooks', undefined, { url: 'https://hr.example/in', events: ['hr.record.created', 'hr.record.updated', 'hr.record.deleted'] });
    const note = await t.call('POST', '/v1/hr/records', undefined, { employeeId: 'mar-2', kind: 'training', date: '2026-10-21', title: 'Food hygiene' });
    expect(note.status).toBe(201);
    const opened = await t.call('POST', '/v1/hr/records', undefined, { employeeId: 'mar-2', kind: 'case', caseType: 'grievance', date: '2026-10-21', title: 'Rota' });
    expect(opened.status).toBe(201);
    await t.call('PATCH', `/v1/hr/records/${opened.body.id}`, undefined, { notes: 'Met' });
    await t.call('DELETE', `/v1/hr/records/${opened.body.id}`);
    expect(t.sent.map((m) => JSON.parse(m.body).data)).toEqual([{ id: note.body.id, employeeId: 'mar-2', kind: 'training' }]);
  });

  it('lets only a reader of personnel files send HR events anywhere, or redirect an endpoint that carries them', async () => {
    const t = await boot();
    const partner = await t.makeKey(['rota:read', 'webhooks:write'], 'Partner');
    const hrSystem = await t.makeKey(['hr:read', 'webhooks:write'], 'HR system');
    const body = { url: 'https://p.example/h', events: ['hr.absence.created'] };
    expect((await t.call('POST', '/v1/webhooks', { key: partner.key }, body)).status).toBe(403);
    // Adding HR events to an endpoint later is checked the same way.
    const plain = await t.call('POST', '/v1/webhooks', { key: partner.key }, { url: 'https://p.example/h', events: ['*'] });
    expect((await t.call('PATCH', `/v1/webhooks/${plain.body.id}`, { key: partner.key }, { events: ['*', 'hr.absence.created'] })).status).toBe(403);

    const hr = await t.call('POST', '/v1/webhooks', { key: hrSystem.key }, body);
    expect(hr.status).toBe(201);
    expect((await t.call('PATCH', `/v1/webhooks/${hr.body.id}`, { key: partner.key }, { url: 'https://evil.example/h' })).status).toBe(403);
    expect((await t.call('POST', `/v1/webhooks/${hr.body.id}/rotate-secret`, { key: partner.key })).status).toBe(403);
    expect((await t.call('PATCH', `/v1/webhooks/${hr.body.id}`, { key: hrSystem.key }, { url: 'https://hr2.example/h' })).status).toBe(200);
  });

  it('marks HR events in the catalogue', async () => {
    const t = await boot();
    const events = (await t.call('GET', '/v1/webhooks/events')).body as { type: string; hr: boolean }[];
    expect(events.find((e) => e.type === 'hr.absence.created')?.hr).toBe(true);
    expect(events.find((e) => e.type === 'employee.rtw_document.added')?.hr).toBe(true);
    expect(events.find((e) => e.type === 'shift.created')?.hr).toBe(false);
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
