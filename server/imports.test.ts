import { describe, expect, it } from 'vitest';
import { addDays } from '../src/engine/time';
import { kit } from './testkit';

// Imports: past hours that payroll never sends again, removing someone added in error, and each upload kept with its undo.

const KEYS = [
  { key: 'olivia', orgId: 'demo', name: 'Olivia', scopes: ['*'] as ['*'], userId: 'usr_owner', mfa: true },
  { key: 'priya', orgId: 'demo', name: 'Priya', scopes: ['*'] as ['*'], userId: 'usr_gm_mar' },
];
const olivia = { key: 'olivia' };

describe('past hours', () => {
  it('stores hours before today as approved and already paid, skips repeats, and refuses today on', async () => {
    const k = await kit({ keys: KEYS });
    const org = await k.store.load('demo');
    const e = org.state.employees.find((x) => x.siteId === 'mar' && x.status !== 'leaver')!;
    const today = k.store.todayISO();
    const entry = (date: string) => ({ employeeId: e.id, siteId: 'mar', roleId: e.roleIds[0], date, clockIn: 600, clockOut: 1080, breakMinutes: 30 });
    const past = addDays(today, -60);
    const res = await k.call('POST', '/v1/import/hours', olivia, { entries: [entry(past), entry(past), entry(today), entry(addDays(today, -500))] });
    expect(res.status).toBe(200);
    expect(res.body.added).toHaveLength(1);
    expect(res.body.skipped).toBe(1);
    expect(res.body.refused.map((r: { index: number }) => r.index)).toEqual([2, 3]);
    const saved = (await k.store.load('demo')).timeEntries.find((t) => t.id === res.body.added[0])!;
    expect(saved).toMatchObject({ status: 'approved', source: 'import', passedIn: 'previous-system' });

    // Imported hours come out only through the import route, and clocked hours never do.
    const live = await k.store.load('demo');
    live.timeEntries.push({ ...saved, id: 'te_clocked', source: 'clock', passedIn: undefined });
    await k.store.save(live);
    expect((await k.call('DELETE', '/v1/import/hours/te_clocked', olivia)).status).toBe(404);
    expect((await k.call('DELETE', `/v1/import/hours/${saved.id}`, olivia)).status).toBe(204);
  });

  it('is refused to a general manager: imports are made from Set-up', async () => {
    const k = await kit({ keys: KEYS });
    expect((await k.call('POST', '/v1/import/hours', { key: 'priya' }, { entries: [] })).status).toBe(403);
  });
});

describe('removing someone added in error', () => {
  it('removes a starter nothing depends on and withdraws their pay proposal, but never someone on the rota', async () => {
    const k = await kit({ keys: KEYS });
    const made = await k.call('POST', '/v1/employees', olivia, { name: 'Wrong Row', siteId: 'mar', roleIds: ['server'], payBasis: 'hourly', hourlyRate: 13, dateOfBirth: '1990-01-01' });
    expect(made.status).toBe(201);
    const id = made.body.id;
    const org = await k.store.load('demo');
    // Payroll may already have picked them up in the test kit's simulator: a person in payroll stays.
    const inPayroll = !!org.state.employees.find((e) => e.id === id)!.payrollId;
    const res = await k.call('DELETE', `/v1/import/people/${id}`, olivia);
    if (inPayroll) {
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/already set up in payroll/);
      return;
    }
    expect(res.status).toBe(204);
    const after = await k.store.load('demo');
    expect(after.state.employees.some((e) => e.id === id)).toBe(false);
    expect(after.payChanges.filter((c) => c.employeeId === id).every((c) => c.status !== 'pending')).toBe(true);

    const other = await k.call('POST', '/v1/employees', olivia, { name: 'On The Rota', siteId: 'mar', roleIds: ['server'], payBasis: 'hourly', dateOfBirth: '1990-01-01' });
    const day = addDays(k.store.todayISO(), 9);
    expect((await k.call('POST', '/v1/shifts', olivia, { employeeId: other.body.id, roleId: 'server', siteId: 'mar', date: day, startMinute: 600, endMinute: 900 })).status).toBe(201);
    const refused = await k.call('DELETE', `/v1/import/people/${other.body.id}`, olivia);
    expect(refused.status).toBe(409);
  });
});

describe('upload batches', () => {
  it('keeps an upload with its undo calls, refuses calls an import never makes, and is undone once', async () => {
    const k = await kit({ keys: KEYS });
    const ok = await k.call('POST', '/v1/import/batches', olivia, { kind: 'training', file: 'training.xlsx', items: [{ label: 'Pat, Allergens', undo: { method: 'DELETE', path: '/v1/hr/records/hr_123' } }] });
    expect(ok.status).toBe(201);
    const bad = await k.call('POST', '/v1/import/batches', olivia, { kind: 'team', file: 'x', items: [{ label: 'x', undo: { method: 'DELETE', path: '/v1/users/usr_owner' } }] });
    expect(bad.status).toBe(422);
    expect((await k.call('GET', '/v1/import/batches', olivia)).body).toHaveLength(1);
    expect((await k.call('POST', `/v1/import/batches/${ok.body.id}/undone`, olivia, { failed: [] })).status).toBe(200);
    expect((await k.call('POST', `/v1/import/batches/${ok.body.id}/undone`, olivia, {})).status).toBe(409);
  });
});
