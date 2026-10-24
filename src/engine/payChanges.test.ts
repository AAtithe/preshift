import { describe, expect, it } from 'vitest';
import { newEmployee } from './employees';
import { annualImpact, backPayFor, sameTerms, weeklyHours } from './payChanges';
import type { Shift } from './types';

const TODAY = '2026-10-21';
const person = (contractedHours: number) => ({ ...newEmployee('mar', 'wdl', 'server', '2024-01-01'), id: 'p1', contractedHours, hourlyRate: 12.71 });
const shift = (date: string, start: number, end: number, breakMinutes = 0): Shift => ({
  id: date, employeeId: 'p1', roleId: 'server', siteId: 'mar', date, startMinute: start, endMinute: end, breakMinutes,
});

describe('pay change impact', () => {
  it('prices a rise on contracted hours over a year, before on-costs', () => {
    const e = person(30);
    const impact = annualImpact({ before: { payBasis: 'hourly', hourlyRate: 12.71, annualSalary: 0 }, after: { payBasis: 'hourly', hourlyRate: 13.25, annualSalary: 0 } }, e, [], TODAY);
    expect(impact.hoursPerWeek).toBe(30);
    expect(impact.difference).toBeCloseTo(0.54 * 30 * 52);
    expect(impact.pct).toBeCloseTo(0.54 / 12.71);
  });

  it('uses the last four weeks of paid rota hours for someone on flexible hours', () => {
    // Two 8.5 hour shifts with a 30 minute break, so 16 paid hours over four weeks: 4 a week.
    const shifts = [shift('2026-10-05', 600, 1110, 30), shift('2026-10-12', 600, 1110, 30), shift('2026-08-01', 600, 1200)];
    expect(weeklyHours(person(0), shifts, TODAY)).toBeCloseTo(4);
  });

  it('prices a salary change on the salary, and compares terms field by field', () => {
    const e = { ...person(45), payBasis: 'salaried' as const, annualSalary: 40_000 };
    const impact = annualImpact({ before: { payBasis: 'salaried', hourlyRate: 0, annualSalary: 40_000 }, after: { payBasis: 'salaried', hourlyRate: 0, annualSalary: 42_000 } }, e, [], TODAY);
    expect(impact.difference).toBe(2000);
    expect(sameTerms({ payBasis: 'hourly', hourlyRate: 13, annualSalary: 0 }, { payBasis: 'hourly', hourlyRate: 13, annualSalary: 0 })).toBe(true);
    expect(sameTerms({ payBasis: 'hourly', hourlyRate: 13, annualSalary: 0 }, { payBasis: 'salaried', hourlyRate: 13, annualSalary: 0 })).toBe(false);
  });

  it('adds holiday, employer NI and pension to give the full cost finance approves on', () => {
    // 30 hours at £12.71 to £13.25: £842.40 a year gross.
    const e = person(30);
    const impact = annualImpact({ before: { payBasis: 'hourly', hourlyRate: 12.71, annualSalary: 0 }, after: { payBasis: 'hourly', hourlyRate: 13.25, annualSalary: 0 } }, e, [], TODAY);
    // Holiday at 12.07% of gross, NI at 15% and pension at 3% of the rise with holiday, all above their thresholds.
    expect(impact.onCosts.holiday).toBeCloseTo(842.4 * 0.1207, 0);
    expect(impact.onCosts.employerNi).toBeCloseTo(842.4 * 1.1207 * 0.15, 0);
    expect(impact.onCosts.pension).toBeCloseTo(842.4 * 1.1207 * 0.03, 0);
    expect(impact.fullDifference).toBeCloseTo(impact.difference + impact.onCosts.holiday + impact.onCosts.employerNi + impact.onCosts.pension, 0);
    // A salary carries its holiday already: only NI and pension go on top.
    const salaried = { ...person(45), payBasis: 'salaried' as const, annualSalary: 40_000 };
    const raise = annualImpact({ before: { payBasis: 'salaried', hourlyRate: 0, annualSalary: 40_000 }, after: { payBasis: 'salaried', hourlyRate: 0, annualSalary: 42_000 } }, salaried, [], TODAY);
    expect(raise.onCosts.holiday).toBe(0);
    expect(raise.fullDifference).toBeCloseTo(2000 * 1.15 + 2000 * 0.03, 0);
  });
});

describe('back pay', () => {
  const change = { employeeId: 'p1', before: { payBasis: 'hourly' as const, hourlyRate: 12.71, annualSalary: 0 }, after: { payBasis: 'hourly' as const, hourlyRate: 13.25, annualSalary: 0 } };

  it('pays the difference on hours clocked between the agreed date and the day it applied, else the rota', () => {
    const clocked = [shift('2026-10-13', 600, 1080), shift('2026-10-20', 600, 1080), shift('2026-10-21', 600, 1080)];
    expect(backPayFor(change, '2026-10-12', '2026-10-21', clocked, [])).toEqual({ from: '2026-10-12', to: '2026-10-20', hours: 16, amount: 8.64, basis: 'clocked' });
    expect(backPayFor(change, '2026-10-12', '2026-10-21', [], clocked)?.basis).toBe('rota');
    expect(backPayFor(change, '2026-10-21', '2026-10-21', clocked, [])).toBeNull();
    // A cut is never clawed back here.
    expect(backPayFor({ ...change, before: change.after, after: change.before }, '2026-10-12', '2026-10-21', clocked, [])).toBeNull();
  });

  it('pays a salary rise by the day', () => {
    const salary = { employeeId: 'p1', before: { payBasis: 'salaried' as const, hourlyRate: 0, annualSalary: 36_500 }, after: { payBasis: 'salaried' as const, hourlyRate: 0, annualSalary: 40_150 } };
    expect(backPayFor(salary, '2026-10-01', '2026-10-21', [], [])).toMatchObject({ amount: 200, basis: 'salary' });
  });
});
