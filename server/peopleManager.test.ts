import { describe, expect, it } from 'vitest';
import type { HrRecord } from '../src/engine/types';
import { kit } from './testkit';

// Kate Morgan is the people manager: every personnel file, every case, pay rates and staff data requests.
// Like most people managers she is on the payroll too, so these tests link her to a staff record (mar-5).
// Before them she could read the investigation into herself through a data request, change her own holiday
// carried over and sign off her own right to work, and rewrite, move or delete a grievance leaving no trace.
const KEYS = [
  { key: 'kate', orgId: 'demo', name: 'Kate', scopes: ['*'] as ['*'], userId: 'usr_people', mfa: true },
  { key: 'olivia', orgId: 'demo', name: 'Olivia', scopes: ['*'] as ['*'], userId: 'usr_owner', mfa: true },
  { key: 'priya', orgId: 'demo', name: 'Priya', scopes: ['*'] as ['*'], userId: 'usr_gm_mar' }, // GM, staff record mar-1
];
const kate = { key: 'kate' };
const olivia = { key: 'olivia' };
const priya = { key: 'priya' };
const CASE = { kind: 'case', caseType: 'grievance', date: '2026-10-20', title: 'Grievance: bullying in the kitchen', notes: 'Three witnesses' };

async function boot() {
  const k = await kit({ keys: KEYS });
  const org = await k.store.load('demo');
  org.users.find((u) => u.id === 'usr_people')!.employeeId = 'mar-5';
  await k.store.save(org);
  return k;
}

describe('a data request about yourself', () => {
  it('is answered by somebody else, so an investigation is not read by the person it is about', async () => {
    const k = await boot();
    const opened = await k.call('POST', '/v1/hr/records', olivia, { ...CASE, employeeId: 'mar-5', caseType: 'investigation', title: 'Investigation: expenses' });
    expect(opened.status).toBe(201);
    const own = await k.call('POST', '/v1/privacy/subjects/mar-5/export', kate);
    expect(own.status).toBe(403);
    expect(own.raw).not.toContain('Investigation: expenses');
    // The owner can answer it, and decides what to release.
    const answered = await k.call('POST', '/v1/privacy/subjects/mar-5/export', olivia);
    expect(answered.status).toBe(200);
    expect(answered.body.hrRecords.map((r: HrRecord) => r.title)).toContain('Investigation: expenses');
    // Kate still answers everyone else's.
    expect((await k.call('POST', '/v1/privacy/subjects/mar-3/export', kate)).status).toBe(200);
  });
});

describe('your own staff record', () => {
  it('is kept by somebody else: holiday, hours, right to work and leaving', async () => {
    const k = await boot();
    for (const body of [
      { holiday: { carriedOverHours: 200 } },
      { contractedHours: 40 },
      { rightToWork: { checked: true, checkedOn: '2026-10-01', evidence: 'British passport' } },
    ]) {
      const r = await k.call('PATCH', '/v1/employees/mar-5', kate, body);
      expect(r.status).toBe(403);
      expect(r.body.message).toBe('Somebody else keeps your own staff record.');
    }
    expect((await k.call('POST', '/v1/employees/mar-5/leaver', kate, { leaveDate: '2026-11-30' })).status).toBe(403);
    // The same for a GM, and nothing changed.
    expect((await k.call('PATCH', '/v1/employees/mar-1', priya, { holiday: { carriedOverHours: 200 } })).status).toBe(403);
    const org = await k.store.load('demo');
    expect(org.state.employees.find((e) => e.id === 'mar-5')!.contractedHours).not.toBe(40);
    // Everyone else's record is still theirs to keep.
    expect((await k.call('PATCH', '/v1/employees/mar-3', kate, { contractedHours: 20 })).status).toBe(200);
    expect((await k.call('PATCH', '/v1/employees/mar-5', olivia, { contractedHours: 30 })).status).toBe(200);
  });
});

describe('a case', () => {
  it('keeps what every change replaced, and who made it', async () => {
    const k = await boot();
    const { id } = (await k.call('POST', '/v1/hr/records', olivia, { ...CASE, employeeId: 'mar-3' })).body;
    const closed = await k.call('PATCH', `/v1/hr/records/${id}`, kate, { notes: 'Resolved informally', caseStatus: 'closed' });
    expect(closed.status).toBe(200);
    expect(closed.body.history).toEqual([
      { at: expect.any(String), by: 'Kate Morgan', before: { notes: 'Three witnesses', caseStatus: 'open' } },
    ]);
    // The history is the server's: a change that sends its own is ignored.
    expect((await k.call('PATCH', `/v1/hr/records/${id}`, kate, { history: [] })).body.history).toHaveLength(1);
    const listed = (await k.call('GET', '/v1/hr/records?kind=case', olivia)).body.find((r: HrRecord) => r.id === id);
    expect(listed.history[0].before.notes).toBe('Three witnesses');
  });

  it('stays with the person it is about', async () => {
    const k = await boot();
    const { id } = (await k.call('POST', '/v1/hr/records', olivia, { ...CASE, employeeId: 'mar-3' })).body;
    const moved = await k.call('PATCH', `/v1/hr/records/${id}`, kate, { employeeId: 'mar-4' });
    expect(moved.status).toBe(422);
    expect(moved.body.error).toBe('person_fixed');
  });

  it('is closed, never deleted, even by the owner', async () => {
    const k = await boot();
    const { id } = (await k.call('POST', '/v1/hr/records', olivia, { ...CASE, employeeId: 'mar-3' })).body;
    for (const who of [kate, olivia]) {
      const del = await k.call('DELETE', `/v1/hr/records/${id}`, who);
      expect(del.status).toBe(409);
      expect(del.body.error).toBe('case_kept');
    }
    expect((await k.call('GET', '/v1/hr/records?kind=case', kate)).body.some((r: HrRecord) => r.id === id)).toBe(true);
    // A training record entered in error can still go.
    const course = (await k.call('POST', '/v1/hr/records', kate, { employeeId: 'mar-3', kind: 'training', date: '2026-10-01', title: 'Food hygiene' })).body;
    expect((await k.call('DELETE', `/v1/hr/records/${course.id}`, kate)).status).toBe(204);
  });
});
