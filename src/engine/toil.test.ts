import { describe, expect, it } from 'vitest';
import { onToilDay, overtimeWeeks, toilBalance, toilEntryProblems } from './toil';
import type { Employee, ToilEntry } from './types';

// Time off in lieu: a ledger of hours banked and taken, the balance owed, and what it is worth.

const entry = (date: string, hours: number, kind: ToilEntry['kind'] = hours > 0 ? 'earned' : 'taken'): ToilEntry => ({ id: `${date}${hours}`, kind, date, hours, by: 't', at: `${date}T12:00:00Z` });
const person = (toil: ToilEntry[]) => ({ id: 'e1', payBasis: 'hourly', hourlyRate: 14, annualSalary: 0, contractedHours: 40, toil } as unknown as Employee);

describe('TOIL balance', () => {
  it('owes earned less taken, valued at the rate with employer NI', () => {
    const b = toilBalance(person([entry('2026-10-01', 12, 'opening'), entry('2026-10-10', 4), entry('2026-10-20', -6)]), '2026-11-04');
    expect(b).toMatchObject({ hours: 10, earned: 16, taken: 6, staleHours: 0, value: 140, liability: 161, warnings: [] });
  });

  it('flags hours banked over three months ago and not yet taken, oldest used first', () => {
    const b = toilBalance(person([entry('2026-06-01', 8), entry('2026-10-01', 8), entry('2026-10-15', -5)]), '2026-11-04');
    expect(b.staleHours).toBe(3);
    expect(b.warnings[0]).toMatch(/3h banked more than 90 days ago/);
  });

  it('ignores entries dated after today, and warns when more is taken than earned', () => {
    const b = toilBalance(person([entry('2026-10-01', 2), entry('2026-10-02', -5), entry('2026-12-01', 20)]), '2026-11-04');
    expect(b.hours).toBe(0);
    expect(b.warnings[0]).toMatch(/3h more TOIL taken than earned/);
  });

  it('checks an entry before it is saved', () => {
    expect(toilEntryProblems({ kind: 'earned', hours: -2, date: '2026-11-01' }, '2026-11-04')).toHaveLength(1);
    expect(toilEntryProblems({ kind: 'taken', hours: 3, date: '2026-11-01' }, '2026-11-04')).toHaveLength(1);
    expect(toilEntryProblems({ kind: 'earned', hours: 3, date: '2026-11-10' }, '2026-11-04')).toHaveLength(1);
    expect(toilEntryProblems({ kind: 'taken', hours: -3, date: '2026-11-10' }, '2026-11-04')).toEqual([]);
  });
});

describe('overtime offered as TOIL', () => {
  const entry = (date: string, hours: number, extra: object = {}) => ({ id: date + hours, employeeId: 'e1', siteId: 's', roleId: 'r', date, clockIn: 540, clockOut: 540 + hours * 60, breakMinutes: 0, status: 'approved', source: 'clock', ...extra }) as never;
  const salaried = { id: 'e1', payBasis: 'salaried', annualSalary: 30000, hourlyRate: 0, contractedHours: 40, toil: [] } as unknown as Employee;
  const entries = [0, 1, 2, 3, 4].map((d) => entry(`2026-10-${String(26 + d).padStart(2, '0')}`, 9)).concat([entry('2026-10-19', 45), entry('2026-10-12', 50, { source: 'import' })]);

  it('offers whole weeks over contract for salaried staff, once each, never imported hours or this week', () => {
    const weeks = overtimeWeeks(salaried, [...entries, entry('2026-11-03', 60)], '2026-11-04');
    expect(weeks).toEqual([{ weekStart: '2026-10-26', workedHours: 45, overHours: 5 }, { weekStart: '2026-10-19', workedHours: 45, overHours: 5 }]);
    const banked = { ...salaried, toil: [{ id: 'x', kind: 'earned', date: '2026-11-01', hours: 5, fromWeek: '2026-10-26', by: 'x', at: 'x' }] } as unknown as Employee;
    expect(overtimeWeeks(banked, entries, '2026-11-04').map((w) => w.weekStart)).toEqual(['2026-10-19']);
  });

  it('never offers an hourly worker\'s paid hours, which would pay them twice', () => {
    expect(overtimeWeeks({ ...salaried, payBasis: 'hourly', hourlyRate: 12 }, entries, '2026-11-04')).toEqual([]);
  });

  it('treats TOIL taken as a day off like leave, and warns on leaving with TOIL owed', () => {
    const e = { ...salaried, leaveDate: '2026-11-30', toil: [{ id: 'a', kind: 'opening', date: '2026-10-01', hours: 8, by: 'x', at: 'x' }, { id: 'b', kind: 'taken', date: '2026-11-10', hours: -8, dayOff: true, by: 'x', at: 'x' }] } as unknown as Employee;
    expect(onToilDay(e, '2026-11-10')).toBe(true);
    expect(onToilDay(e, '2026-11-11')).toBe(false);
    expect(toilBalance(e, '2026-11-04').warnings.join(' ')).toMatch(/Leaving on 2026-11-30 with 8h TOIL owed/);
  });
});
