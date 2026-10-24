import { describe, expect, it } from 'vitest';
import type { Shift } from '../src/engine/types';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { MemoryStore } from './store';

const WEEK = '2027-03-01';
const KEYS = [{ key: 'system', orgId: 'demo', name: 'System', scopes: ['*' as const] }];

async function setup() {
  const store = new MemoryStore(['demo'], '2026-10-21');
  const { app } = await buildApp({ apiKeys: KEYS, store, provider: new TeamPaySimulator(), autoDispatch: false, now: () => new Date('2027-02-25T10:00:00Z') });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.inject({ method: method as 'GET', url, headers: { authorization: 'Bearer system', ...(body ? { 'content-type': 'application/json' } : {}) }, payload: body ? JSON.stringify(body) : undefined });
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  };
  const org = await store.load('demo');
  const worker = org.state.employees.find((e) => e.siteId === 'mar' && e.payBasis === 'hourly' && e.dateOfBirth < '2000-01-01' && e.status !== 'leaver')!;
  // Four nights, 22:00 to 06:00, Monday to Thursday.
  const nights: Shift[] = [0, 1, 2, 3].map((d) => ({ id: `n${d}`, employeeId: worker.id, roleId: worker.roleIds[0], siteId: 'mar', date: `2027-03-0${d + 1}`, startMinute: 1320, endMinute: 1800, breakMinutes: 30 }));
  org.state.shifts = [...org.state.shifts.filter((s) => s.employeeId !== worker.id), ...nights];
  return { call, worker };
}

describe('night work on the rota and in the HR file', () => {
  it('warns until a health assessment offer is recorded, and records only the offer and outcome', async () => {
    const { call, worker } = await setup();
    const issues = async () => (await call('GET', `/v1/rota/week?siteId=mar&weekStart=${WEEK}`)).body.issues.filter((i: { code: string; employeeId: string }) => i.code === 'night-health' && i.employeeId === worker.id);
    expect(await issues()).toHaveLength(1);

    const noOutcome = await call('POST', '/v1/hr/records', { employeeId: worker.id, kind: 'health_assessment', date: '2027-02-20', title: 'Night work health assessment' });
    expect(noOutcome.status).toBe(422);
    const made = await call('POST', '/v1/hr/records', { employeeId: worker.id, kind: 'health_assessment', date: '2027-02-20', title: 'Night work health assessment', outcome: 'Declined', nextDue: '2028-02-20' });
    expect(made.status).toBe(201);
    expect(await issues()).toEqual([]);
  });
});
