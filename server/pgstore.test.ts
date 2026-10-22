import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { buildApp, storeFromEnv } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { MemoryStore, PgStore, type Query } from './store';
import { account } from './testkit';

const WEEK = '2026-10-19';
const KEYS = [{ key: 'admin', orgId: 'demo', name: 'Admin', scopes: ['*' as const] }];

function pglite(): Query {
  const db = new PGlite();
  return async (text, params) => (await db.query(text, params)).rows as Record<string, unknown>[];
}

async function boot(query: Query, simulator = new TeamPaySimulator()) {
  const { app } = await buildApp({ apiKeys: KEYS, store: new PgStore(query, ['demo'], '2026-10-21'), provider: simulator });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: { authorization: 'Bearer admin', ...(body ? { 'content-type': 'application/json' } : {}) },
      payload: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  };
  return { app, call };
}

describe('Postgres store', () => {
  it('runs the whole rota to TeamPay flow and keeps it across a cold start', async () => {
    const query = pglite();
    const first = await boot(query);
    await first.call('POST', '/v1/rota/build', { siteId: 'mar', weekStart: WEEK });
    await first.call('POST', '/v1/integrations/payroll/sync-employees', {});
    await first.call('POST', '/v1/dev/simulate-clocking', { siteId: 'mar', weekStart: WEEK });
    await first.call('POST', '/v1/time-entries/approve', { siteId: 'mar', from: WEEK, to: '2026-10-25' });
    expect((await first.call('POST', '/v1/payroll/submissions', { weekStart: WEEK })).status).toBe(202);

    // A new process (a fresh serverless instance, with an empty simulator) carries on where the last stopped.
    const second = await boot(query, new TeamPaySimulator());
    const run = await second.call('POST', '/v1/dev/teampay/run-payroll', { weekStart: WEEK });
    expect(run.status).toBe(200);
    for (const payRun of run.body.payRuns) {
      expect(payRun.variance.actual).toBeGreaterThan(0);
      expect(Math.abs(payRun.variance.variancePct)).toBeLessThan(0.01);
    }
    const shifts = (await second.call('GET', `/v1/shifts?siteId=mar&from=${WEEK}&to=2026-10-25`)).body;
    expect(shifts.length).toBeGreaterThan(20);
    const status = (await second.call('GET', '/v1/integrations/payroll')).body;
    expect(status.employees.synced).toBe(status.employees.total);
    expect(status.lastPayRun.id).toBe(run.body.payRuns.at(-1).id);
    expect((await second.call('GET', '/v1/payroll/submissions')).body[0].status).toBe('sent');
  });

  it('refuses a save that would overwrite a concurrent change', async () => {
    const store = new PgStore(pglite(), ['demo'], '2026-10-21');
    const a = await store.load('demo');
    const b = await store.load('demo');
    a.state.shifts.push({ id: 'x', employeeId: 'mar-2', roleId: 'chef', siteId: 'mar', date: WEEK, startMinute: 600, endMinute: 900, breakMinutes: 0 });
    await store.save(a);
    await expect(store.save(b)).rejects.toMatchObject({ statusCode: 409 });
    expect((await store.load('demo')).state.shifts.map((s) => s.id)).toContain('x');
  });

  it('does not save a request that failed', async () => {
    const { call } = await boot(pglite());
    const bad = await call('POST', '/v1/rota/publish', { siteId: 'nowhere', weekStart: WEEK });
    expect(bad.status).toBe(200); // no shifts and no breaches: publishing nothing is allowed
    const conflict = await call('POST', '/v1/payroll/submissions', { weekStart: WEEK });
    expect(conflict.status).toBe(422);
    expect((await call('GET', '/v1/payroll/submissions')).body).toEqual([]);
  });

  it('retries setup after a failure instead of failing every later request', async () => {
    const db = pglite();
    let failures = 1;
    const flaky: Query = async (text, params) => {
      if (failures > 0 && text.startsWith('create schema')) {
        failures--;
        throw new Error('duplicate key value violates unique constraint "pg_namespace_nspname_index"');
      }
      return db(text, params);
    };
    const store = new PgStore(flaky, ['demo'], '2026-10-21');
    await expect(store.load('demo')).rejects.toThrow('duplicate key');
    expect((await store.load('demo')).orgId).toBe('demo');
  });

  it('refuses a database that already holds another system\'s tables', async () => {
    const db = new PGlite();
    await db.query('create table public.aml_assessments (id int)');
    const store = new PgStore(async (t, p) => (await db.query(t, p)).rows as Record<string, unknown>[], ['demo'], '2026-10-21');
    await expect(store.load('demo')).rejects.toMatchObject({ statusCode: 503, code: 'database_not_dedicated' });
    expect(await store.status()).toBe('database_not_dedicated');
    const created = await db.query("select 1 from information_schema.schemata where schema_name = 'preshift'");
    expect(created.rows).toHaveLength(0);
  });

  it('reads a generic DATABASE_URL only on Vercel', () => {
    const url = 'postgres://u:p@ep-x.neon.tech/neondb';
    expect(storeFromEnv({ DATABASE_URL: url })).toBeInstanceOf(MemoryStore);
    expect(storeFromEnv({ DATABASE_URL: url, VERCEL: '1' })).toBeInstanceOf(PgStore);
    expect(storeFromEnv({ PRESHIFT_DATABASE_URL: url })).toBeInstanceOf(PgStore);
  });
});

describe('Postgres store: coaching and programme data', () => {
  it('keeps moves, publications, programmes and settings across a cold start, and defaults them on old rows', async () => {
    const query = pglite();
    const keys = [...KEYS, { key: 'ws', orgId: 'demo', name: 'WS lead', scopes: ['rota:read' as const, 'rota:write' as const, 'programme:lead' as const] }];
    const boot2 = async () => {
      const { app } = await buildApp({ apiKeys: keys, store: new PgStore(query, ['demo'], '2026-10-21'), provider: new TeamPaySimulator(), now: () => new Date('2026-10-21T10:00:00Z') });
      return async (method: string, url: string, body?: unknown, key = 'admin') => {
        const res = await app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) }, payload: body ? JSON.stringify(body) : undefined });
        return { status: res.statusCode, body: res.body ? res.json() : undefined };
      };
    };
    const first = await boot2();
    await first('POST', '/v1/rota/build', { siteId: 'mar', weekStart: '2026-10-26' });
    await first('POST', '/v1/rota/publish', { siteId: 'mar', weekStart: '2026-10-26' });
    await first('POST', '/v1/coach/moves', { siteId: 'mar', weekStart: '2026-10-26' });
    await first('PUT', '/v1/programmes/mar', { startWeek: '2026-10-05' }, 'ws');
    await first('PUT', '/v1/settings/benchmarking', { benchmarking: true });

    const second = await boot2();
    expect((await second('GET', '/v1/coach/history?siteId=mar')).body.length).toBeGreaterThan(0);
    expect((await second('GET', '/v1/programmes')).body[0].programme.startWeek).toBe('2026-10-05');
    expect((await second('GET', '/v1/benchmarks')).body.optedIn).toBe(true);
    const card = (await second('GET', '/v1/scorecard?siteId=mar&weeks=1')).body;
    expect(card.weeks).toHaveLength(1);

    // A row saved before these fields existed loads with empty defaults.
    const rows = await query('select data from preshift.orgs where org_id = $1', ['demo']);
    const data = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data as string) : (rows[0].data as Record<string, unknown>);
    delete data.moves;
    delete data.publications;
    delete data.programmes;
    delete data.settings;
    delete data.eventFeeds;
    delete data.reminderStates;
    delete data.state.weather;
    delete data.state.localEvents;
    await query('update preshift.orgs set data = $2 where org_id = $1', ['demo', JSON.stringify(data)]);
    const third = await boot2();
    expect((await third('GET', '/v1/programmes')).body).toEqual([]);
    expect((await third('GET', '/v1/benchmarks')).body.optedIn).toBe(false);
    expect((await third('GET', '/v1/event-feeds')).body).toEqual([]);
    expect((await third('GET', '/v1/calendar?siteId=mar')).status).toBe(200);
  });
});

describe('the daily refresh against a busy organisation', () => {
  it('keeps a GM’s change made while the refresh was fetching', async () => {
    const query = pglite();
    let app: Awaited<ReturnType<typeof buildApp>>['app'] | null = null;
    let raced = false;
    const daily = (from: string, n: number) => {
      const time = Array.from({ length: n }, (_, i) => {
        const d = new Date(`${from}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + i);
        return d.toISOString().slice(0, 10);
      });
      return { daily: { time, temperature_2m_max: time.map(() => 15), temperature_2m_min: time.map(() => 8), precipitation_sum: time.map(() => 0), weather_code: time.map(() => 1) } };
    };
    const slowFetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (!raced) {
        // While the refresh is out fetching, the GM overrides Thursday's 19:00 and saves.
        raced = true;
        const res = await app!.inject({
          method: 'PATCH',
          url: '/v1/forecast/hour',
          headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
          payload: JSON.stringify({ siteId: 'mar', date: '2026-10-22', hour: 19, sales: 4321, covers: 99, reason: 'Party of 60' }),
        });
        expect(res.statusCode).toBe(200);
      }
      const start = url.searchParams.get('start_date') ?? '2026-10-14';
      return new Response(JSON.stringify(daily(start, url.pathname.endsWith('/archive') ? 30 : 23)), { status: 200 });
    }) as typeof fetch;
    ({ app } = await buildApp({
      apiKeys: KEYS,
      store: new PgStore(query, ['demo'], '2026-10-21'),
      provider: new TeamPaySimulator(),
      now: () => new Date('2026-10-21T07:00:00Z'),
      fetch: slowFetch,
      env: { CRON_SECRET: 'tick' },
    }));
    const call = (method: string, url: string, body?: unknown) =>
      app!.inject({ method: method as 'GET', url, headers: { authorization: 'Bearer admin', ...(body ? { 'content-type': 'application/json' } : {}) }, payload: body ? JSON.stringify(body) : undefined });
    await call('PUT', '/v1/sites/mar/location', { lat: 51.52, lng: -0.15 });
    const tick = await app.inject({ method: 'GET', url: '/internal/dispatch', headers: { authorization: 'Bearer tick' } });
    expect(tick.json()).toMatchObject({ refreshed: 1, failed: 0 });
    const rows = (await call('GET', '/v1/forecast?siteId=mar&from=2026-10-22&to=2026-10-22')).json() as { hour: number; sales: number; overriddenBy?: string }[];
    expect(rows.find((r) => r.hour === 19)).toMatchObject({ sales: 4321, overriddenBy: 'Admin' });
    const weather = (await call('GET', '/v1/weather?siteId=mar')).json() as unknown[];
    expect(weather.length).toBeGreaterThan(20);
  });
  it('moves an account to a new email, never onto one already taken', async () => {
    const store = new PgStore(pglite(), ['demo'], '2026-10-21');
    await store.createUser({ ...account('old@example.com'), lastOrgId: 'demo' });
    await store.createUser(account('taken@example.com'));
    expect(await store.renameUser('old@example.com', 'taken@example.com')).toBe(false);
    expect(await store.renameUser('old@example.com', 'new@example.com')).toBe(true);
    expect(await store.getUser('old@example.com')).toBeNull();
    expect(await store.getUser('new@example.com')).toMatchObject({ email: 'new@example.com', lastOrgId: 'demo' });
    expect(await store.renameUser('gone@example.com', 'other@example.com')).toBe(false);
  });
});
