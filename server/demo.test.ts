import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { addDays, toISODate, weekStart } from '../src/engine/time';
import { buildApp } from './app';
import { SANDBOX_HOURS, sandboxCreatedAt, sweepSandboxes } from './demo';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { MemoryStore, PgStore, type Query, type Store } from './store';

function pglite(): Query {
  const db = new PGlite();
  return async (text, params) => (await db.query(text, params)).rows as Record<string, unknown>[];
}

async function boot(store: Store = new MemoryStore(['demo'], '2026-10-21'), env: NodeJS.ProcessEnv = {}) {
  const { app } = await buildApp({ apiKeys: [], store, provider: new TeamPaySimulator(), autoDispatch: false, demo: true, env });
  const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie'] ?? '').split(';')[0];
  const call = (method: string, url: string, cookie?: string, body?: unknown) =>
    app.inject({
      method: method as 'GET',
      url,
      headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      payload: body !== undefined ? JSON.stringify(body) : undefined,
    });
  async function visit() {
    const res = await call('GET', '/demo');
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/app/');
    return cookieOf(res);
  }
  return { app, store, call, visit, cookieOf };
}

describe('public demo', () => {
  it('gives each visitor a seeded sandbox of their own, signed in as its admin', async () => {
    const t = await boot();
    const a = await t.visit();
    const b = await t.visit();
    const meA = (await t.call('GET', '/auth/me', a)).json();
    const meB = (await t.call('GET', '/auth/me', b)).json();
    expect(meA).toMatchObject({ role: 'admin', demo: true });
    expect(meA.orgId).toMatch(/^sandbox-/);
    expect(meA.orgId).not.toBe(meB.orgId);

    const sites = (await t.call('GET', '/v1/sites', a)).json();
    expect(sites.length).toBe(3);
    // The HR screens have the same demo files as the seeded organisation, cases included for the visitor admin.
    const cases = (await t.call('GET', '/v1/hr/records?kind=case', a)).json();
    expect(cases.length).toBe(3);

    // What one visitor does stays in their sandbox. Sandboxes are seeded around today's week.
    const week = weekStart(toISODate(new Date()));
    const to = addDays(week, 6);
    const build = await t.call('POST', '/v1/rota/build', a, { siteIds: sites.map((s: { id: string }) => s.id), weekStart: week });
    expect(build.statusCode).toBe(200);
    const shiftsA = (await t.call('GET', `/v1/shifts?from=${week}&to=${to}`, a)).json();
    const shiftsB = (await t.call('GET', `/v1/shifts?from=${week}&to=${to}`, b)).json();
    expect(shiftsA.length).toBeGreaterThan(shiftsB.length);
  });

  it('takes a returning visitor back to their sandbox, and starts afresh on request', async () => {
    const t = await boot();
    const cookie = await t.visit();
    const again = await t.call('GET', '/demo', cookie);
    expect(again.headers.location).toBe('/app/');
    expect(again.headers['set-cookie']).toBeUndefined();
    const fresh = await t.call('GET', '/demo?fresh=1', cookie);
    const before = (await t.call('GET', '/auth/me', cookie)).json().orgId;
    const after = (await t.call('GET', '/auth/me', t.cookieOf(fresh))).json().orgId;
    expect(after).not.toBe(before);
  });

  it('refuses account, password, key and owner changes', async () => {
    const t = await boot();
    const cookie = await t.visit();
    const refused = [
      await t.call('POST', '/v1/users', cookie, { email: 'x@example.com', password: 'a long enough password', role: 'admin' }),
      await t.call('PUT', '/v1/settings/claude-api-key', cookie, { claudeApiKey: 'sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa' }),
      await t.call('POST', '/auth/password', cookie, { currentPassword: 'x', newPassword: 'a long enough password' }),
      await t.call('POST', '/auth/setup', undefined, {}),
      await t.call('POST', '/auth/forgot', undefined, { email: 'x@example.com' }),
      await t.call('POST', '/auth/reset', undefined, { token: 'x' }),
      await t.call('PUT', '/v1/settings/email', cookie, { resendApiKey: 're_x', from: 'a@example.com', appUrl: 'https://example.com' }),
    ];
    for (const res of refused) expect(res.json()).toMatchObject({ error: 'demo' });
    expect((await t.call('GET', '/auth/status')).json()).toEqual({ setupNeeded: false, demo: true });
  });

  it('explains the assistant is off when the demo has no Claude key', async () => {
    const t = await boot();
    const cookie = await t.visit();
    const res = await t.call('POST', '/api/anthropic/v1/messages', cookie, { model: 'claude-opus-5-5', max_tokens: 100, messages: [] });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.type).toBe('demo');
  });

  it('greets visitors with the demo page rather than sign-in', async () => {
    const t = await boot();
    const res = await t.call('GET', '/login');
    expect(res.body).toContain('Start the demo');
  });

  it('deletes sandboxes after they expire, with their visitor and staff logins, in Postgres', async () => {
    const store = new PgStore(pglite(), ['demo'], '2026-10-21');
    const t = await boot(store);
    const cookie = await t.visit();
    const orgId = (await t.call('GET', '/auth/me', cookie)).json().orgId;
    const created = sandboxCreatedAt(orgId)!;
    // The staff app works in the demo, so a sandbox can hold staff logins too.
    const person = (await t.call('GET', '/v1/employees', cookie)).json()[0].id;
    expect((await t.call('POST', `/v1/staff-logins/${person}/invite`, cookie, {})).statusCode).toBe(201);
    expect(await store.listStaffLogins(orgId)).toHaveLength(1);

    expect(await sweepSandboxes(store, created + 60_000)).toBe(0);
    expect(await sweepSandboxes(store, created + SANDBOX_HOURS * 3600_000)).toBe(1);
    expect(await store.orgIds()).not.toContain(orgId);
    expect(await store.listUsers(orgId)).toEqual([]);
    expect(await store.listStaffLogins(orgId)).toEqual([]);
    expect((await t.call('GET', '/auth/me', cookie)).statusCode).toBe(401);
  });
});

describe('outside the demo', () => {
  it('sends /demo to the demo deployment', async () => {
    const { app } = await buildApp({ apiKeys: [], store: new MemoryStore(), provider: new TeamPaySimulator(), env: { PRESHIFT_DEMO_URL: 'https://demo.example/demo' } });
    const res = await app.inject({ method: 'GET', url: '/demo' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://demo.example/demo');
  });
});
