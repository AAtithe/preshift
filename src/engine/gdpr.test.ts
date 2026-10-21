import { describe, expect, it } from 'vitest';
import {
  addMonths,
  applyRetention,
  DEFAULT_RETENTION,
  erasureRefusal,
  processingRegister,
  requestDueOn,
  requestOverdue,
  retentionPolicyProblem,
  retentionSchedule,
  taxYearEnd,
  type SubjectRequest,
} from './gdpr';
import { seedState } from './seed';
import type { Employee, RotaState, TimeEntry } from './types';

const TODAY = '2026-10-21';

const person = (over: Partial<Employee> = {}): Employee => ({
  id: 'emp_abc123456',
  name: 'Sam Leaver',
  siteId: 'mar',
  entityId: 'wdl',
  coverSiteIds: [],
  roleIds: ['server'],
  payBasis: 'hourly',
  hourlyRate: 13,
  annualSalary: 0,
  dateOfBirth: '1995-07-14',
  contractedHours: 0,
  maxWeeklyHours: 48,
  optedOutOf48: false,
  irregularHours: true,
  pensionEnrolled: true,
  availability: [{ weekday: 0, fromMinute: 600, toMinute: 1200 }],
  leave: [],
  email: 'sam@example.com',
  phone: '07700 900000',
  badgeId: 'AB12CD34',
  rightToWork: { checked: true, checkedOn: '2019-01-02', evidence: 'British passport' },
  ...over,
});

const entry = (id: string, date: string, located = true): TimeEntry => ({
  id,
  employeeId: 'emp_abc123456',
  siteId: 'mar',
  roleId: 'server',
  date,
  clockIn: 600,
  clockOut: 900,
  breakMinutes: 0,
  status: 'approved',
  source: 'clock',
  ...(located ? { clockInLocation: { lat: 51.52, lng: -0.15, accuracyMetres: 12 } } : {}),
});

const stateWith = (employees: Employee[]): RotaState => ({ ...seedState(TODAY), employees });

describe('dates', () => {
  it('adds calendar months, holding to the month end when the day does not exist', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-10-21', 1)).toBe('2026-11-21');
    expect(addMonths('2026-12-15', 3)).toBe('2027-03-15');
  });

  it('finds the 5 April that ends the tax year', () => {
    expect(taxYearEnd('2026-04-05')).toBe('2026-04-05');
    expect(taxYearEnd('2026-04-06')).toBe('2027-04-05');
    expect(taxYearEnd('2027-01-10')).toBe('2027-04-05');
  });

  it('gives a request one month, or three when extended, and flags it once late', () => {
    const r: SubjectRequest = { id: 'r', kind: 'access', subject: 'Sam', receivedOn: '2026-09-10', status: 'open', loggedBy: 'gm' };
    expect(requestDueOn(r)).toBe('2026-10-10');
    expect(requestOverdue(r, TODAY)).toBe(true);
    expect(requestOverdue({ ...r, extended: true }, TODAY)).toBe(false);
    expect(requestDueOn({ ...r, extended: true })).toBe('2026-12-10');
    expect(requestOverdue({ ...r, status: 'closed' }, TODAY)).toBe(false);
  });
});

describe('retention', () => {
  it('schedules each kind of data from the leaving date, and nothing for current staff beyond location', () => {
    const current = person({ id: 'emp_current0001', name: 'Still Here', leaveDate: undefined });
    const leaver = person({ leaveDate: '2024-03-01', status: 'leaver' });
    const items = retentionSchedule(stateWith([current, leaver]), [], TODAY);
    expect(items.map((i) => [i.code, i.dueOn, i.due])).toEqual([
      ['contact', '2024-06-01', true],
      ['right-to-work', '2026-03-01', true],
    ]);
    // Left in the 2023/24 tax year, which ends 5 April 2024: anonymised from 6 April 2030, outside the 60 day view.
    const later = retentionSchedule(stateWith([leaver]), [], '2030-03-01');
    expect(later.find((i) => i.code === 'anonymise')).toMatchObject({ dueOn: '2030-04-06', due: false });
  });

  it('removes location from old clocks only, grouped per person', () => {
    const entries = [entry('t1', '2026-06-01'), entry('t2', '2026-07-01'), entry('t3', '2026-10-01'), entry('t4', '2026-05-01', false)];
    const items = retentionSchedule(stateWith([person()]), entries, TODAY);
    const loc = items.find((i) => i.code === 'location')!;
    expect(loc).toMatchObject({ dueOn: '2026-09-01', due: true, entryIds: ['t1', 't2'] });
  });

  it('applies only what is due, keeping pay data and the birth year when anonymising', () => {
    const leaver = person({ leaveDate: '2019-03-01', status: 'leaver' });
    const entries = [entry('t1', '2019-02-01'), entry('t2', TODAY)];
    const items = retentionSchedule(stateWith([leaver]), entries, TODAY);
    const result = applyRetention([leaver], entries, items, TODAY);
    const after = result.employees[0];
    expect(after).toMatchObject({ name: 'Former employee 123456', dateOfBirth: '1995-01-01', hourlyRate: 13, anonymisedOn: TODAY, availability: [] });
    expect(after.email).toBeUndefined();
    expect(after.badgeId).toBeUndefined();
    expect(after.rightToWork).toEqual({ checked: true });
    expect(result.timeEntries[0].clockInLocation).toBeUndefined();
    expect(result.timeEntries[0].clockOut).toBe(900);
    expect(result.timeEntries[1].clockInLocation).toBeDefined();
    expect(result.closeLoginsFor).toEqual([leaver.id]);
    // Done once: nothing is left to schedule for an anonymised person.
    expect(retentionSchedule(stateWith(result.employees), result.timeEntries, TODAY).filter((i) => i.due)).toEqual([]);
  });

  it('refuses periods below the statutory minimums', () => {
    expect(retentionPolicyProblem(DEFAULT_RETENTION)).toBeNull();
    expect(retentionPolicyProblem({ ...DEFAULT_RETENTION, rightToWorkYearsAfterLeaving: 1 })).toMatch(/two years/);
    expect(retentionPolicyProblem({ ...DEFAULT_RETENTION, payrollYearsAfterTaxYear: 2 })).toMatch(/HMRC/);
  });
});

describe('requests and register', () => {
  it('refuses erasure for someone still employed', () => {
    expect(erasureRefusal(person(), TODAY)).toMatch(/still works here/);
    expect(erasureRefusal(person({ leaveDate: '2026-11-01' }), TODAY)).toMatch(/still works here/);
    expect(erasureRefusal(person({ leaveDate: '2026-10-01' }), TODAY)).toBeNull();
  });

  it('builds the record of processing from what is held and which processors are switched on', () => {
    const entries = [entry('t1', '2026-10-01'), entry('t2', '2026-10-02', false)];
    const off = processingRegister(stateWith([person()]), entries, 1, { assistant: false, email: false, payrollLive: false });
    expect(off.activities.find((a) => a.activity === 'Clocking location')?.held).toBe(1);
    expect(off.activities.find((a) => a.activity === 'Rota assistant')?.recipients).toBe('Not in use');
    expect(off.processors.find((p) => p.name === 'Anthropic')?.active).toBe(false);
    const on = processingRegister(stateWith([person()]), entries, 1, { assistant: true, email: true, payrollLive: true });
    expect(on.processors.filter((p) => p.active).map((p) => p.name)).toEqual(['TeamPay', 'Anthropic', 'Resend', 'Vercel and Neon']);
  });
});
