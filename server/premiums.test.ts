import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { MemoryStore } from './store';

const WEEK = '2026-10-19';
// Each key stands for its person having entered their authenticator code.
const person = (key: string, userId: string) => ({ key, orgId: 'demo', name: `${key} key`, scopes: ['*' as const], userId, mfa: true });
const KEYS = [
  { key: 'system', orgId: 'demo', name: 'System', scopes: ['*' as const] },
  person('owner', 'usr_owner'),
  person('priya', 'usr_gm_mar'),
  person('nadia', 'usr_fd'),
];

async function setup() {
  const simulator = new TeamPaySimulator();
  const store = new MemoryStore(['demo'], '2026-10-21');
  const { app, ctx } = await buildApp({ apiKeys: KEYS, store, provider: simulator, autoDispatch: false });
  const call = async (method: string, url: string, body?: unknown, key = 'system') => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      payload: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  };
  return { call, ctx, simulator, store };
}

const SUNDAY = { name: 'Sunday', kind: 'day', multiplier: 1.5, weekdays: [6] };

describe('pay premiums API', () => {
  it('lets only someone who approves pay change premiums, and audits the change', async () => {
    const { call, store } = await setup();
    expect((await call('PUT', '/v1/entities/wdl/premiums', { premiums: [SUNDAY] }, 'priya')).status).toBe(403);
    expect((await call('PUT', '/v1/entities/wdl/premiums', { premiums: [SUNDAY] }, 'owner')).status).toBe(403);
    const ok = await call('PUT', '/v1/entities/wdl/premiums', { premiums: [SUNDAY] }, 'nadia');
    expect(ok.status).toBe(200);
    expect(ok.body.premiums).toEqual([expect.objectContaining({ name: 'Sunday', kind: 'day', multiplier: 1.5, weekdays: [6], id: expect.stringMatching(/^prem_/) })]);
    const org = await store.load('demo');
    expect(org.audit.at(-1)).toMatchObject({ action: 'entity.premiums_set', detail: { id: 'wdl', before: [], after: ['Sunday: Time and a half on Sundays'] } });
  });

  it('refuses rules that cannot be paid as written', async () => {
    const { call } = await setup();
    const put = (rule: object) => call('PUT', '/v1/entities/wdl/premiums', { premiums: [rule] }, 'nadia');
    expect((await put({ name: 'Both', kind: 'bank_holiday', multiplier: 2, perHour: 1 })).status).toBe(400);
    expect((await put({ name: 'Neither', kind: 'bank_holiday' })).status).toBe(400);
    expect((await put({ name: 'No days', kind: 'day', multiplier: 1.5 })).status).toBe(400);
    expect((await put({ name: 'No window', kind: 'night', perHour: 1 })).status).toBe(400);
    expect((await put({ name: 'Ghost role', kind: 'bank_holiday', multiplier: 2, roleIds: ['astronaut'] })).status).toBe(400);
    expect((await put({ name: 'Silly', kind: 'bank_holiday', multiplier: 10 })).status).toBe(400);
  });

  it('costs premiums into the week and pays them through TeamPay to match the accrual', async () => {
    const { call, ctx, simulator } = await setup();
    await call('POST', '/v1/rota/build', { siteId: 'mar', weekStart: WEEK });
    const before = (await call('GET', `/v1/rota/week?siteId=mar&weekStart=${WEEK}`)).body.metrics.labourCost;
    await call('PUT', '/v1/entities/wdl/premiums', { premiums: [SUNDAY, { name: 'Overtime', kind: 'overtime', multiplier: 1.5 }] }, 'nadia');
    const week = (await call('GET', `/v1/rota/week?siteId=mar&weekStart=${WEEK}`)).body;
    expect(week.metrics.labourCost).toBeGreaterThan(before);
    expect(week.metrics.cost.premium).toBeGreaterThan(0);

    await call('POST', '/v1/integrations/payroll/sync-employees', {});
    await call('POST', '/v1/dev/simulate-clocking', { siteId: 'mar', weekStart: WEEK });
    await call('POST', '/v1/time-entries/approve', { siteId: 'mar', from: WEEK, to: '2026-10-25' });
    expect((await call('POST', '/v1/payroll/submissions', { weekStart: WEEK, entityId: 'wdl' })).status).toBe(202);
    await ctx.dispatcher.processDue();

    const sent = simulator.submissions.find((s) => s.employerId === 'sim_er_wdl')!.batch;
    const premiumLines = sent.lines.filter((l) => l.premium);
    expect(premiumLines.length).toBeGreaterThan(0);
    expect(premiumLines.every((l) => l.premium!.name === 'Sunday' || l.premium!.name === 'Overtime')).toBe(true);
    expect(sent.totalHours).toBe(sent.lines.filter((l) => !l.premium).reduce((s, l) => Math.round((s + l.hours) * 100) / 100, 0));

    const run = await call('POST', '/v1/dev/teampay/run-payroll', { weekStart: WEEK });
    expect(run.status).toBe(200);
    const payRun = run.body.payRuns.find((r: { entityId: string }) => r.entityId === 'wdl');
    expect(Math.abs(payRun.variance.variancePct)).toBeLessThan(0.01);
  });
});
