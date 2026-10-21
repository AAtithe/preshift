import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { PgStore, type Query } from './store';

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
    expect(run.body.payRun.variance.actual).toBeGreaterThan(0);
    expect(Math.abs(run.body.payRun.variance.variancePct)).toBeLessThan(0.01);
    const shifts = (await second.call('GET', `/v1/shifts?siteId=mar&from=${WEEK}&to=2026-10-25`)).body;
    expect(shifts.length).toBeGreaterThan(20);
    const status = (await second.call('GET', '/v1/integrations/payroll')).body;
    expect(status.employees.synced).toBe(status.employees.total);
    expect(status.lastPayRun.id).toBe(run.body.payRun.id);
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
});
