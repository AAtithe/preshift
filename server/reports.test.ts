import { describe, expect, it } from 'vitest';
import { allDimensions } from '../src/engine/reportBuilder';
import { STANDARD_REPORTS } from '../src/engine/standardReports';
import { datasetsFor } from './reports/datasets';
import { MemoryStore } from './store';
import { kit, TODAY } from './testkit';

const OLIVIA = 'olivia@marylebonegroup.example'; // Owner
const OLIVIA_MFA = 'demo-usr_owner';
const PRIYA = 'priya@marylebonegroup.example'; // General Manager at Marylebone only
const GRACE = 'grace@marylebonegroup.example'; // Floor Supervisor at Marylebone

const TURNOVER = { dataset: 'movements', groupBy: ['site'], measures: ['headcount', 'leavers', 'turnover'], range: 'last-12-months' };

describe('reports across the app', () => {
  it('every standard report names a dataset and fields that exist', async () => {
    const store = new MemoryStore(['demo'], TODAY);
    const org = await store.load('demo');
    const sets = new Map(datasetsFor(org).map((d) => [d.id, d]));
    for (const r of STANDARD_REPORTS) {
      const ds = sets.get(r.definition.dataset);
      expect(ds, `${r.id}: dataset ${r.definition.dataset}`).toBeDefined();
      const dims = new Set(allDimensions(ds!).map((d) => d.id));
      const measures = new Set(ds!.measures.map((m) => m.id));
      for (const g of r.definition.groupBy) expect(dims.has(g), `${r.id}: group by ${g}`).toBe(true);
      for (const m of r.definition.measures) expect(measures.has(m), `${r.id}: measure ${m}`).toBe(true);
      for (const f of r.definition.filters ?? []) expect(dims.has(f.field), `${r.id}: filter ${f.field}`).toBe(true);
      if (r.definition.sort) expect(dims.has(r.definition.sort.by) || measures.has(r.definition.sort.by), `${r.id}: sort ${r.definition.sort.by}`).toBe(true);
    }
  });

  it('every standard report runs for the owner', async () => {
    const k = await kit();
    const owner = await k.as(OLIVIA, OLIVIA_MFA);
    const cat = await k.call('GET', '/v1/reports/catalogue', owner);
    expect(cat.status).toBe(200);
    expect(cat.body.standard.length).toBe(STANDARD_REPORTS.length);
    for (const r of STANDARD_REPORTS) {
      const res = await k.call('POST', '/v1/reports/run', owner, r.definition);
      expect(res.status, `${r.id}: ${res.raw}`).toBe(200);
      expect(res.body.withheld, r.id).toEqual([]);
    }
  });

  it('shows each person only the data their role opens', async () => {
    const k = await kit();
    const ids = async (email: string, mfa?: string) => ((await k.call('GET', '/v1/reports/catalogue', await k.as(email, mfa))).body.datasets as { id: string }[]).map((d) => d.id);
    const owner = await ids(OLIVIA, OLIVIA_MFA);
    const gm = await ids(PRIYA);
    const sup = await ids(GRACE);
    expect(owner).toEqual(expect.arrayContaining(['movements', 'labour', 'payRuns', 'cases', 'access']));
    // A supervisor reads the rota but not costs, pay, people records or HR cases.
    expect(sup).toContain('shifts');
    for (const id of ['labour', 'payRuns', 'cases', 'access', 'movements']) expect(sup).not.toContain(id);
    expect(gm.length).toBeLessThan(owner.length);
    expect(gm.length).toBeGreaterThan(sup.length);
  });

  it('runs turnover by site, keeping a GM to their own site', async () => {
    const k = await kit();
    const owner = await k.call('POST', '/v1/reports/run', await k.as(OLIVIA, OLIVIA_MFA), TURNOVER);
    expect(owner.status).toBe(200);
    expect(owner.body.columns.map((c: { id: string }) => c.id)).toEqual(['site', 'headcount', 'leavers', 'turnover']);
    expect(owner.body.rows.length).toBeGreaterThan(1);
    const gm = await k.call('POST', '/v1/reports/run', await k.as(PRIYA), TURNOVER);
    if (gm.status === 200) expect(gm.body.rows.length).toBeLessThanOrEqual(1);
    else expect(gm.status).toBe(404);
  });

  it('withholds cost from a supervisor, and refuses data they cannot read at all', async () => {
    const k = await kit();
    const grace = await k.as(GRACE);
    const shifts = await k.call('POST', '/v1/reports/run', grace, { dataset: 'shifts', groupBy: ['role'], measures: ['hours', 'cost'], range: 'last-4-weeks' });
    expect(shifts.status).toBe(200);
    expect(shifts.body.withheld).toContain('cost');
    expect(shifts.body.columns.map((c: { id: string }) => c.id)).not.toContain('cost');
    expect((await k.call('POST', '/v1/reports/run', grace, { dataset: 'cases', groupBy: [], measures: ['cases'] })).status).toBe(404);
    expect((await k.call('POST', '/v1/reports/run', grace, { dataset: 'labour', groupBy: [], measures: ['sales'] })).status).toBe(404);
  });

  it('writes CSV and refuses ranges that are back to front or too long', async () => {
    const k = await kit();
    const owner = await k.as(OLIVIA, OLIVIA_MFA);
    const csv = await k.call('POST', '/v1/reports/run?format=csv', owner, TURNOVER);
    expect(csv.status).toBe(200);
    expect(csv.raw.split('\n')[0]).toMatch(/^"Site",/);
    expect((await k.call('POST', '/v1/reports/run', owner, { ...TURNOVER, range: undefined, from: '2026-10-01', to: '2026-09-01' })).status).toBe(400);
    expect((await k.call('POST', '/v1/reports/run', owner, { ...TURNOVER, range: undefined, from: '2020-01-01', to: '2026-01-01' })).status).toBe(400);
  });

  it('saves reports privately or shared, and only the author or a settings manager changes them', async () => {
    const k = await kit();
    const priya = await k.as(PRIYA);
    const owner = await k.as(OLIVIA, OLIVIA_MFA);
    const shifts = { dataset: 'shifts', groupBy: ['role'], measures: ['hours'], range: 'last-4-weeks' };

    const mine = await k.call('POST', '/v1/reports/saved', priya, { name: 'Hours by role', definition: shifts });
    expect(mine.status).toBe(201);
    const shared = await k.call('POST', '/v1/reports/saved', priya, { name: 'Shared hours', shared: true, definition: shifts });
    expect(shared.status).toBe(201);

    // The owner sees only the shared one, and may change it as a settings manager.
    const list = await k.call('GET', '/v1/reports/saved', owner);
    expect(list.body.map((r: { name: string }) => r.name)).toEqual(['Shared hours']);
    expect(list.body[0]).toMatchObject({ mine: false, canEdit: true });
    expect((await k.call('PUT', `/v1/reports/saved/${mine.body.id}`, owner, { name: 'x', definition: shifts })).status).toBe(404);

    // A supervisor sees the shared report but cannot change or delete it.
    const grace = await k.as(GRACE);
    const theirs = await k.call('GET', '/v1/reports/saved', grace);
    expect(theirs.body[0]).toMatchObject({ name: 'Shared hours', canEdit: false });
    expect((await k.call('DELETE', `/v1/reports/saved/${shared.body.id}`, grace)).status).toBe(403);

    // Nobody saves a report on data they cannot read.
    expect((await k.call('POST', '/v1/reports/saved', grace, { name: 'Pay', definition: { dataset: 'payRuns', groupBy: [], measures: ['runs'] } })).status).toBe(404);

    expect((await k.call('PUT', `/v1/reports/saved/${shared.body.id}`, owner, { name: 'Hours by role, all sites', shared: true, definition: shifts })).status).toBe(200);
    expect((await k.call('DELETE', `/v1/reports/saved/${mine.body.id}`, priya)).status).toBe(204);
    expect((await k.call('GET', '/v1/reports/saved', priya)).body.map((r: { name: string }) => r.name)).toEqual(['Hours by role, all sites']);
  });

  it('reports the rota and clocking once there is data: hours, lateness and no-shows', async () => {
    const store = new MemoryStore(['demo'], TODAY);
    const org = await store.load('demo');
    const staff = org.state.employees.filter((e) => e.siteId === 'mar').slice(0, 3);
    const shift = (i: number, date: string) => ({ id: `s${i}`, employeeId: staff[i].id, roleId: staff[i].roleIds[0], siteId: 'mar', date, startMinute: 600, endMinute: 1080, breakMinutes: 30, published: true });
    // Monday 12 October: one on time, one 25 minutes late, one never clocked in.
    org.state.shifts.push(shift(0, '2026-10-12'), shift(1, '2026-10-12'), shift(2, '2026-10-12'));
    const entry = (i: number, clockIn: number) => ({ id: `t${i}`, employeeId: staff[i].id, siteId: 'mar', roleId: shift(i, '').roleId, shiftId: `s${i}`, date: '2026-10-12', clockIn, clockOut: 1080, breakMinutes: 30, status: 'approved' as const, source: 'clock' as const, method: 'card' as const });
    org.timeEntries.push(entry(0, 598), entry(1, 625));
    // The memory store hands back the same organisation, so the app reads these.
    const k = await kit({ store });
    const owner = await k.as(OLIVIA, OLIVIA_MFA);
    const run = async (def: object) => (await k.call('POST', '/v1/reports/run', owner, { from: '2026-10-12', to: '2026-10-18', ...def })).body;

    expect((await run({ dataset: 'shifts', groupBy: ['weekday'], measures: ['shifts', 'hours'] })).rows).toEqual([['Monday', 3, 22.5]]);
    expect((await run({ dataset: 'time', groupBy: [], measures: ['onRota', 'late', 'lateRate'] })).totals).toEqual([2, 1, 0.5]);
    const noShows = await run({ dataset: 'attendance', groupBy: [], measures: ['shifts', 'noShows'] });
    expect(noShows.totals).toEqual([3, 1]);
  });

  it('keeps saving to people, not keys', async () => {
    const k = await kit({ keys: [{ key: 'sys', orgId: 'demo', name: 'System', scopes: ['*'] }] });
    expect((await k.call('GET', '/v1/reports/catalogue', { key: 'sys' })).status).toBe(200);
    expect((await k.call('POST', '/v1/reports/saved', { key: 'sys' }, { name: 'x', definition: TURNOVER })).status).toBe(403);
  });
});
