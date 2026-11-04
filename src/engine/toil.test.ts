import { describe, expect, it } from 'vitest';
import { toilBalance, toilEntryProblems } from './toil';
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
