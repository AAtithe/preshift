import { describe, expect, it } from 'vitest';
import { newEmployee } from './employees';
import { annualImpact, sameTerms, weeklyHours } from './payChanges';
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
});
