import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { shiftsGoingFor } from './cover';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { LOCKED_FOR_PAYROLL } from './payPeriods';
import { slotOf } from '../src/engine/cover';
import { eligibleNow } from './routes/requests';
import { MemoryStore } from './store';

const WEEKLY = '/v1/pay-periods/wdl/weekly/2026-10-19';

async function setup() {
  const store = new MemoryStore(['demo'], '2026-10-21');
  const { app, ctx } = await buildApp({ apiKeys: [{ key: 'admin', orgId: 'demo', name: 'Admin', scopes: ['*'] }], store, provider: new TeamPaySimulator(), autoDispatch: false, now: () => new Date('2026-10-21T09:00:00Z') });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.inject({ method: method as 'GET', url, headers: { authorization: 'Bearer admin', ...(body ? { 'content-type': 'application/json' } : {}) }, payload: body ? JSON.stringify(body) : undefined });
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  };
  const org = await store.load('demo');
  // Only Marylebone's own team can cover it, so everyone who could take its shifts is paid by the one locked payroll.
  for (const e of org.state.employees) e.coverSiteIds = e.coverSiteIds.filter((s) => s !== 'mar');
  return { call, ctx, org };
}

const shift = (date: string, extra: Record<string, unknown> = {}) => ({ siteId: 'mar', roleId: 'bar', date, startMinute: 18 * 60, endMinute: 23 * 60, ...extra });

describe('open shifts in a pay period locked for payroll', () => {
  it('is not put out when everyone who could take it is locked, and nobody locked is offered it', async () => {
    const { call, org } = await setup();
    const before = await call('POST', '/v1/open-shifts/preview', shift('2026-10-23'));
    const could = before.body.candidates.filter((c: { eligible: boolean }) => c.eligible);
    expect(could.length).toBeGreaterThan(0);

    expect((await call('POST', `${WEEKLY}/lock-rota`)).status).toBe(200);
    const after = (await call('POST', '/v1/open-shifts/preview', shift('2026-10-23'))).body.candidates;
    expect(after.filter((c: { eligible: boolean }) => c.eligible)).toEqual([]);
    expect(after.find((c: { employeeId: string }) => c.employeeId === could[0].employeeId)).toMatchObject({ eligible: false, reason: LOCKED_FOR_PAYROLL });

    const refused = await call('POST', '/v1/open-shifts', shift('2026-10-23'));
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('rota_locked');
    expect(refused.body.message).toMatch(/Unlock the pay period first/);
    expect((await call('POST', '/v1/open-shifts', shift('2026-10-23', { employeeIds: [could[0].employeeId] }))).body.error).toBe('rota_locked');
    expect(org.openShifts ?? []).toEqual([]);

    // The week after is a period of its own, still open: the same shift there goes out as normal.
    const next = await call('POST', '/v1/open-shifts', shift('2026-10-27'));
    expect(next.status).toBe(201);
    expect(next.body.eligible.length).toBeGreaterThan(0);
  });

  it('stops offering a shift already out once its period is locked', async () => {
    const { call, org } = await setup();
    const posted = await call('POST', '/v1/open-shifts', shift('2026-10-23', { everyone: true }));
    expect(posted.status).toBe(201);
    const o = org.openShifts!.find((x) => x.id === posted.body.id)!;
    const person = org.state.employees.find((e) => e.id === o.offer!.told[0])!;
    expect(shiftsGoingFor(org, person, new Date('2026-10-21T09:00:00Z')).map((x) => x.open.id)).toContain(o.id);

    expect((await call('POST', `${WEEKLY}/lock-rota`)).status).toBe(200);
    expect(eligibleNow(org, slotOf(o))).toEqual([]);
    expect(shiftsGoingFor(org, person, new Date('2026-10-21T09:00:00Z'))).toEqual([]);
    expect((await call('GET', '/v1/open-shifts?siteId=mar')).body.find((x: { id: string }) => x.id === o.id).eligible).toEqual([]);
  });

  it('passes over anyone asked by name whose rota has been locked since', async () => {
    const { call, org } = await setup();
    const could = (await call('POST', '/v1/open-shifts/preview', shift('2026-10-23'))).body.candidates.filter((c: { eligible: boolean }) => c.eligible);
    expect(could.length).toBeGreaterThan(1);
    const posted = await call('POST', '/v1/open-shifts', shift('2026-10-23', { employeeIds: could.map((c: { employeeId: string }) => c.employeeId), rounds: { size: 1, everyMinutes: 60 } }));
    expect(posted.status).toBe(201);
    expect((await call('POST', `${WEEKLY}/lock-rota`)).status).toBe(200);
    const next = await call('POST', `/v1/open-shifts/${posted.body.id}/next`, { everyone: true });
    expect(next.status).toBe(200);
    const o = org.openShifts!.find((x) => x.id === posted.body.id)!;
    const later = o.offers!.filter((x) => x.round > 1);
    expect(later.length).toBeGreaterThan(0);
    expect(later.every((x) => x.skipped === LOCKED_FOR_PAYROLL && !x.offeredAt)).toBe(true);
  });
});
