import { describe, expect, it } from 'vitest';
import { newEmployee } from './employees';
import { isNewStarter, onboardingFor, onboardingList } from './onboarding';
import { seedState } from './seed';
import type { Employee, HrRecord } from './types';

const TODAY = '2026-10-21';
const roles = seedState(TODAY).roles;
const ALL = { hr: true, pay: true };

function starter(extra: Partial<Employee> = {}): Employee {
  return { ...newEmployee('mar', 'wdl', 'server', '2026-11-02'), id: 'p1', name: 'New Person', dateOfBirth: '1998-03-01', hourlyRate: 13, ...extra };
}

const state = (e: Employee, code: string, sight = ALL, records: HrRecord[] = []) => onboardingFor(e, records, roles, TODAY, sight).steps.find((s) => s.code === code)?.state;

describe('onboarding', () => {
  it('counts someone starting soon or started recently as new, never a leaver or someone long in post', () => {
    expect(isNewStarter(starter(), TODAY)).toBe(true);
    expect(isNewStarter(starter({ startDate: '2026-08-01' }), TODAY)).toBe(true);
    expect(isNewStarter(starter({ startDate: '2026-06-01' }), TODAY)).toBe(false);
    expect(isNewStarter(starter({ startDate: '2027-03-01' }), TODAY)).toBe(false);
    expect(isNewStarter(starter({ startDate: '2026-09-01', leaveDate: '2026-10-01' }), TODAY)).toBe(false);
    expect(isNewStarter(starter({ startDate: undefined }), TODAY)).toBe(false);
  });

  it('puts right to work first and blocks until it is done', () => {
    const o = onboardingFor(starter(), [], roles, TODAY, ALL);
    expect(o.steps[0]).toMatchObject({ code: 'right-to-work', state: 'todo', blocking: true, due: '2026-11-02' });
    expect(o.blocked).toBe(true);
    expect(state(starter({ rightToWork: { checked: true } }), 'right-to-work')).toBe('done');
  });

  it('marks a step late once its date has passed', () => {
    const started = starter({ startDate: '2026-10-01', rightToWork: { checked: true, checkedOn: '2026-09-28' } });
    const o = onboardingFor(started, [], roles, TODAY, ALL);
    expect(o.steps.find((s) => s.code === 'statement')!.state).toBe('late');
    expect(o.steps.find((s) => s.code === 'payroll')!.state).toBe('late');
    // The first month's training is not due yet on day 21.
    expect(o.steps.find((s) => s.code === 'training:Allergen awareness')!.state).toBe('todo');
    expect(o.late).toBeGreaterThan(0);
    expect(o.blocked).toBe(true);
  });

  it('checks pay against the minimum wage band through the record check', () => {
    expect(state(starter({ hourlyRate: 5 }), 'details')).toBe('todo');
    expect(state(starter(), 'details')).toBe('done');
  });

  it('hides what the reader may not see rather than calling it missing', () => {
    const o = onboardingFor(starter(), [], roles, TODAY, { hr: false, pay: false });
    expect(o.steps.filter((s) => s.state === 'hidden').map((s) => s.code)).toEqual(
      expect.arrayContaining(['details', 'statement', 'ni-number', 'training:Allergen awareness']),
    );
    expect(o.total).toBe(o.steps.filter((s) => s.state !== 'hidden').length);
  });

  it('says where a document sent to sign in the staff app stands', () => {
    const doc = (kind: 'statement' | 'handbook', extra = {}): HrRecord => ({
      id: kind, employeeId: 'p1', kind: 'document', title: kind, date: TODAY, createdBy: 't', createdAt: TODAY,
      signing: { kind, fileId: 'f', sha256: 'x', sentAt: `${TODAY}T09:00:00Z`, sentBy: 'GM', ...extra },
    });
    const step = (o: ReturnType<typeof onboardingFor>, code: string) => o.steps.find((s) => s.code === code)!;
    const sent = onboardingFor(starter(), [doc('statement'), doc('handbook', { openedAt: `${TODAY}T09:05:00Z` })], roles, TODAY, ALL);
    expect(step(sent, 'contract-signed').detail).toMatch(/Sent to sign in the staff app on .*not yet opened/);
    expect(step(sent, 'handbook').detail).toMatch(/opened, not yet signed/);
    const signed = onboardingFor(starter({ hr: { contractSignedOn: TODAY } }), [doc('statement', { signedAt: `${TODAY}T09:10:00Z` })], roles, TODAY, ALL);
    expect(step(signed, 'contract-signed')).toMatchObject({ state: 'done', detail: `Signed on ${TODAY} in the staff app` });
    expect(step(signed, 'handbook').state).not.toBe('done');
  });

  it('is complete once every step is done, and clocking counts the card or the staff app', () => {
    const done = starter({
      rightToWork: { checked: true, checkedOn: '2026-10-20', evidence: 'British passport', documents: [{ id: 'd', fileName: 'p.pdf', contentType: 'application/pdf', bytes: 1, sha256: 'x', uploadedAt: TODAY, uploadedBy: 't' }] },
      payrollId: 'tp-1',
      hr: { contractIssuedOn: '2026-10-15', contractSignedOn: '2026-10-16', handbookAcknowledgedOn: '2026-10-16', niNumber: 'QQ123456C', address: '1 High St', emergencyContact: { name: 'Kin', phone: '07700 900000' }, probationEnd: '2027-02-02' },
    });
    const training: HrRecord = { id: 't', employeeId: 'p1', kind: 'training', title: 'Allergen awareness', date: '2026-10-10', expiresOn: '2029-10-10', createdBy: 't', createdAt: TODAY };
    expect(onboardingFor(done, [training], roles, TODAY, ALL, { staffApp: 'invited' }).complete).toBe(false);
    expect(onboardingFor(done, [training], roles, TODAY, ALL, { staffApp: 'active' }).complete).toBe(true);
    expect(onboardingFor({ ...done, badgeId: 'ABC' }, [training], roles, TODAY, ALL).complete).toBe(true);
  });

  it('lists the stuck before the finished, then by first day', () => {
    const later = starter({ id: 'p2', name: 'Later', startDate: '2026-12-01' });
    const sooner = starter({ id: 'p3', name: 'Sooner', startDate: '2026-10-25' });
    const list = onboardingList([later, sooner], [], roles, TODAY, () => ALL);
    expect(list.map((o) => o.employee.name)).toEqual(['Sooner', 'Later']);
  });
});
