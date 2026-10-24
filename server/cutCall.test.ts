import { describe, expect, it } from 'vitest';
import type { Shift } from '../src/engine/types';
import { buildApp } from './app';
import { cutCallAlerts } from './cutCall';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { MemoryStore } from './store';

// Wednesday 3 March 2027, after the real clock so nothing here has started for the rota's own guards.
const DATE = '2027-03-03';
const AT = '2027-03-03T17:20:00Z'; // 17:20 in London (GMT)
const person = (key: string, userId: string) => ({ key, orgId: 'demo', name: `${key} key`, scopes: ['*' as const], userId, mfa: true });
const KEYS = [{ key: 'system', orgId: 'demo', name: 'System', scopes: ['*' as const] }, person('priya', 'usr_gm_mar')];

async function setup(now = AT, pace = 0.6) {
  const store = new MemoryStore(['demo'], '2026-10-21');
  let clock = new Date(now);
  const { app } = await buildApp({ apiKeys: KEYS, store, provider: new TeamPaySimulator(), autoDispatch: false, now: () => clock });
  const call = async (method: string, url: string, body?: unknown, key = 'priya') => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      payload: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  };
  // Three zero hours servers on 11:00 to 23:00, published and clocked in; trading at `pace` of forecast.
  const org = await store.load('demo');
  const servers = org.state.employees.filter((e) => e.siteId === 'mar' && e.payBasis === 'hourly' && e.contractedHours === 0 && e.roleIds.includes('server')).slice(0, 3);
  expect(servers).toHaveLength(3);
  org.state.shifts = org.state.shifts.filter((s) => s.date !== DATE);
  const shifts: Shift[] = servers.map((e, i) => ({ id: `cc${i}`, employeeId: e.id, roleId: 'server', siteId: 'mar', date: DATE, startMinute: 660, endMinute: 1380, breakMinutes: 30, published: true }));
  org.state.shifts.push(...shifts);
  for (const s of shifts) org.timeEntries.push({ id: `te-${s.id}`, employeeId: s.employeeId, siteId: 'mar', roleId: 'server', shiftId: s.id, date: DATE, clockIn: 660, breakMinutes: 0, status: 'open', source: 'clock' });
  org.state.forecast = org.state.forecast.filter((f) => !(f.siteId === 'mar' && f.date === DATE));
  for (let hour = 11; hour < 23; hour++) org.state.forecast.push({ siteId: 'mar', date: DATE, hour, sales: 1200, covers: 30 });
  org.state.sales = [
    ...(org.state.sales ?? []).filter((d) => !(d.siteId === 'mar' && d.date === DATE)),
    { siteId: 'mar', date: DATE, netSales: 0, source: 'till', hours: Array.from({ length: 6 }, (_, i) => ({ hour: 11 + i, netSales: 1200 * pace, orders: 0 })) },
  ];
  return { call, store, org, setClock: (iso: string) => (clock = new Date(iso)) };
}

describe('cut call API', () => {
  it("gives today's call and labour flash for the site", async () => {
    const { call } = await setup();
    const res = await call('GET', '/v1/cut-call?siteId=mar');
    expect(res.status).toBe(200);
    expect(res.body.date).toBe(DATE);
    expect(res.body.call).toMatchObject({ confident: true });
    expect(res.body.call.pace).toBeCloseTo(0.6, 2);
    expect(res.body.call.recommendations).toHaveLength(1);
    expect(res.body.flash).toMatchObject({ onShift: 3 });
    expect(res.body.flash.labourPctAfterCuts).toBeLessThan(res.body.flash.labourPctDay);
    // Not started: the cut would owe short notice pay under the Act, shown and not deducted.
    expect(res.body.call.recommendations[0].wouldOwe).toBeGreaterThan(0);
  });

  it('applies a cut, keeps the shift published, tells the person at once, and logs the short notice', async () => {
    const { call, store } = await setup();
    const rec = (await call('GET', '/v1/cut-call?siteId=mar')).body.call.recommendations[0];
    const res = await call('POST', '/v1/cut-call/apply', { siteId: 'mar', cuts: [{ shiftId: rec.shiftId, endMinute: rec.newEnd, breakMinutes: rec.newBreakMinutes }] });
    expect(res.status).toBe(200);
    expect(res.body.told).toBe(1);
    const org = await store.load('demo');
    const shift = org.state.shifts.find((s) => s.id === rec.shiftId)!;
    expect(shift).toMatchObject({ endMinute: rec.newEnd, published: true });
    expect(org.notifications?.some((n) => n.employeeId === rec.employeeId && n.kind === 'rota_changed' && /finish at 18:00/.test(n.title))).toBe(true);
    expect(org.era?.shortNotice).toEqual([expect.objectContaining({ shiftId: rec.shiftId, change: 'cut', minutesLost: rec.minutesSaved, owed: false })]);
  });

  it('refuses a cut that is not today, not earlier, or in the past, and changes nothing', async () => {
    const { call, store } = await setup();
    const bad = await call('POST', '/v1/cut-call/apply', { siteId: 'mar', cuts: [{ shiftId: 'cc0', endMinute: 1080, breakMinutes: 30 }, { shiftId: 'cc1', endMinute: 1000, breakMinutes: 30 }] });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toBe('in_the_past');
    expect((await store.load('demo')).state.shifts.find((s) => s.id === 'cc0')!.endMinute).toBe(1380);
    expect((await call('POST', '/v1/cut-call/apply', { siteId: 'mar', cuts: [{ shiftId: 'cc0', endMinute: 1380, breakMinutes: 30 }] })).body.error).toBe('not_a_cut');
  });
});

describe('cut call alerts', () => {
  it('raises one alert a day when trading falls behind with a real saving, only while the site trades', async () => {
    const { store, org } = await setup();
    const first = await cutCallAlerts(store, org, new Date(AT));
    expect(first).toMatchObject({ alerts: 1 });
    expect(org.cutAlerts?.[`mar|${DATE}`]?.behind).toBeDefined();
    expect(org.audit.some((a) => a.action === 'cutcall.alert_behind')).toBe(true);
    expect(await cutCallAlerts(store, org, new Date('2027-03-03T17:40:00Z'))).toBeNull();

    const early = await setup('2027-03-03T09:00:00Z');
    expect(await cutCallAlerts(early.store, early.org, new Date('2027-03-03T09:00:00Z'))).toBeNull();
  });

  it('stays quiet when trading is on forecast', async () => {
    const { store, org } = await setup(AT, 1);
    expect(await cutCallAlerts(store, org, new Date(AT))).toBeNull();
  });
});
