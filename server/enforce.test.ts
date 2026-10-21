import { describe, expect, it } from 'vitest';
import { checkWeek } from '../src/engine/compliance';
import { seedState } from '../src/engine/seed';
import type { Employee } from '../src/engine/types';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { MemoryStore } from './store';

const WEEK = '2026-10-19';
const person = (key: string, userId: string) => ({ key, orgId: 'demo', name: `${key} key`, scopes: ['*' as const], userId });
const KEYS = [
  { key: 'system', orgId: 'demo', name: 'System', scopes: ['*' as const] },
  person('owner', 'usr_owner'),
  person('priya', 'usr_gm_mar'),
  person('grace', 'usr_sup'),
  person('nadia', 'usr_fd'),
  person('ravi', 'usr_ws_payroll'),
  person('leah', 'usr_ws_ma'),
  person('chris', 'usr_viewer'),
];

async function setup() {
  const { app } = await buildApp({ apiKeys: KEYS, store: new MemoryStore(['demo'], '2026-10-21'), provider: new TeamPaySimulator(), autoDispatch: false });
  return async (method: string, url: string, body?: unknown, key = 'system') => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      payload: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.statusCode, body: res.body ? (res.headers['content-type']?.includes('json') ? res.json() : res.body) : undefined };
  };
}

const shift = (siteId: string, employeeId: string) => ({ employeeId, roleId: 'server', siteId, date: WEEK, startMinute: 660, endMinute: 900 });

describe('access on the rota', () => {
  it('keeps a GM to their own site, in what they see and what they change', async () => {
    const call = await setup();
    await call('POST', '/v1/rota/build', { siteId: 'mar', weekStart: WEEK });
    await call('POST', '/v1/rota/build', { siteId: 'shd', weekStart: WEEK });
    expect((await call('GET', '/v1/sites', undefined, 'priya')).body.map((s: { id: string }) => s.id)).toEqual(['mar']);
    const shifts = (await call('GET', '/v1/shifts', undefined, 'priya')).body as { siteId: string }[];
    expect(shifts.length).toBeGreaterThan(0);
    expect(shifts.every((s) => s.siteId === 'mar')).toBe(true);
    expect((await call('POST', '/v1/shifts', shift('mar', 'mar-8'), 'priya')).status).toBe(201);
    const other = await call('POST', '/v1/shifts', shift('shd', 'shd-2'), 'priya');
    expect(other.status).toBe(403);
    expect(other.body.message).toMatch(/at Shoreditch/);
    expect((await call('POST', '/v1/rota/publish', { siteId: 'shd', weekStart: WEEK }, 'priya')).status).toBe(403);
    expect((await call('GET', `/v1/rota/week?siteId=shd&weekStart=${WEEK}`, undefined, 'priya')).status).toBe(403);
  });

  it('refuses a group action unless every site in it is theirs, all or nothing', async () => {
    const call = await setup();
    const group = await call('POST', '/v1/rota/build', { siteIds: ['mar', 'shd'], weekStart: WEEK }, 'priya');
    expect(group.status).toBe(403);
    expect(group.body.message).toMatch(/at Shoreditch/);
    // Nothing was built at Marylebone either: the refusal comes before any change.
    expect((await call('GET', `/v1/shifts?siteId=mar&from=${WEEK}`, undefined, 'priya')).body).toEqual([]);
    expect((await call('POST', '/v1/rota/publish', { siteIds: ['mar', 'fitz'], weekStart: WEEK }, 'priya')).status).toBe(403);
    expect((await call('POST', '/v1/rota/build', { siteIds: ['mar'], weekStart: WEEK }, 'priya')).status).toBe(200);
  });

  it('shows a GM the people from other sites who cover theirs, with pay, and not the rest', async () => {
    const call = await setup();
    const staff = (await call('GET', '/v1/employees', undefined, 'priya')).body as { id: string; hourlyRate: number; payHidden?: boolean }[];
    const ids = staff.map((e) => e.id);
    expect(ids).toContain('shd-12'); // Shoreditch, covers Marylebone
    expect(ids).toContain('fitz-3'); // Fitzrovia, covers Marylebone
    expect(ids).not.toContain('shd-2');
    expect(staff.find((e) => e.id === 'shd-12')!.payHidden).toBeUndefined();
  });

  it('treats a change of employing company as a pay change', async () => {
    const call = await setup();
    const res = await call('PATCH', '/v1/employees/mar-8', { entityId: 'eck' }, 'priya');
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/pay rates/);
  });

  it('lets a supervisor see the rota but not change it, cost it, or see pay', async () => {
    const call = await setup();
    expect((await call('POST', '/v1/shifts', shift('mar', 'mar-8'), 'grace')).status).toBe(403);
    const rota = await call('GET', `/v1/rota/week?siteId=mar&weekStart=${WEEK}`, undefined, 'grace');
    expect(rota.status).toBe(200);
    expect(rota.body.metrics).toBeNull();
    const staff = (await call('GET', '/v1/employees', undefined, 'grace')).body as { hourlyRate: number; payHidden?: boolean }[];
    expect(staff.every((e) => e.hourlyRate === 0 && e.payHidden)).toBe(true);
    const priyaSees = (await call('GET', '/v1/employees', undefined, 'priya')).body as { hourlyRate: number }[];
    expect(priyaSees.some((e) => e.hourlyRate > 0)).toBe(true);
    // The browser runs compliance on what it received: withheld pay must not read as a minimum wage breach.
    const week = { ...seedState('2026-10-21'), employees: staff as Employee[], shifts: [{ id: 'x', ...shift('mar', 'mar-8'), breakMinutes: 0 }] };
    expect(checkWeek(week, WEEK, 'mar').some((i) => i.code === 'minimum-wage')).toBe(false);
  });

  it('refuses a suspended person whatever their key', async () => {
    const call = await setup();
    const res = await call('GET', '/v1/shifts', undefined, 'chris');
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/suspended/);
  });
});

describe('access on the team and pay', () => {
  it('lets a GM add starters at their site but not set pay', async () => {
    const call = await setup();
    const starter = { name: 'New Starter', siteId: 'mar', roleIds: ['server'], payBasis: 'hourly', dateOfBirth: '2000-01-01' };
    expect((await call('POST', '/v1/employees', starter, 'priya')).status).toBe(201);
    expect((await call('POST', '/v1/employees', { ...starter, hourlyRate: 14 }, 'priya')).status).toBe(403);
    expect((await call('PATCH', '/v1/employees/mar-8', { hourlyRate: 20 }, 'priya')).status).toBe(403);
    expect((await call('PATCH', '/v1/employees/mar-8', { contractedHours: 16 }, 'priya')).status).toBe(200);
    expect((await call('PATCH', '/v1/employees/shd-3', { contractedHours: 16 }, 'priya')).status).toBe(403);
  });

  it('never lets someone change their own pay', async () => {
    const call = await setup();
    expect((await call('PATCH', '/v1/employees/mar-3', { hourlyRate: 15.5 }, 'owner')).status).toBe(200);
    await call('PATCH', '/v1/users/usr_owner', { employeeId: 'mar-3' });
    const own = await call('PATCH', '/v1/employees/mar-3', { hourlyRate: 30 }, 'owner');
    expect(own.status).toBe(403);
    expect(own.body.message).toMatch(/your own pay/);
  });
});

describe('access on time and payroll', () => {
  it('stops a manager approving their own hours, and keeps them to their site', async () => {
    const call = await setup();
    await call('POST', '/v1/shifts', { ...shift('mar', 'mar-1'), roleId: 'gm' });
    await call('POST', '/v1/shifts', shift('mar', 'mar-8'));
    await call('POST', '/v1/shifts', shift('shd', 'shd-4'));
    await call('POST', '/v1/dev/simulate-clocking', { siteId: 'mar', weekStart: WEEK });
    await call('POST', '/v1/dev/simulate-clocking', { siteId: 'shd', weekStart: WEEK });
    const entries = (await call('GET', `/v1/time-entries?from=${WEEK}`, undefined, 'priya')).body as { id: string; employeeId: string; siteId: string }[];
    expect(entries.every((t) => t.siteId === 'mar')).toBe(true);
    const mine = entries.find((t) => t.employeeId === 'mar-1')!;
    expect((await call('POST', '/v1/time-entries/approve', { ids: [mine.id] }, 'priya')).body.message).toMatch(/your own hours/);
    const range = await call('POST', '/v1/time-entries/approve', { siteId: 'mar', from: WEEK, to: '2026-10-25' }, 'priya');
    expect(range.body).toMatchObject({ approved: 1, ownSkipped: 1 });
    expect((await call('POST', '/v1/time-entries/approve', { siteId: 'shd', from: WEEK, to: '2026-10-25' }, 'priya')).status).toBe(403);
  });

  it('keeps sending pay to payroll roles with an authenticator, and the journal to finance', async () => {
    const call = await setup();
    expect((await call('POST', '/v1/payroll/submissions', { weekStart: WEEK }, 'priya')).status).toBe(403);
    const nadia = await call('POST', '/v1/payroll/submissions', { weekStart: WEEK }, 'nadia');
    expect(nadia.status).toBe(403);
    expect(nadia.body.message).toMatch(/authenticator/);
    // Ravi may send; this week has no approved hours, which is the next thing to stop him.
    expect((await call('POST', '/v1/payroll/submissions', { weekStart: WEEK }, 'ravi')).status).toBe(422);
    expect((await call('GET', '/v1/payroll/runs', undefined, 'priya')).status).toBe(403);
    expect((await call('GET', `/v1/journal?weekStart=${WEEK}`, undefined, 'priya')).status).toBe(403);
    expect((await call('GET', `/v1/journal?weekStart=${WEEK}`, undefined, 'leah')).status).toBe(200);
  });
});
