import { describe, expect, it } from 'vitest';
import { newEmployee } from './employees';
import { averageWeeklyEarnings, sspEstimate, sspInPeriod } from './ssp';
import { addDays } from './time';
import type { Absence, Employee, Shift } from './types';

const TODAY = '2026-10-21';
const sick = (from: string, to?: string): Absence => ({ id: from, type: 'sickness', from, to });

function person(extra: Partial<Employee> = {}): Employee {
  return { ...newEmployee('mar', 'wdl', 'server', '2024-01-08'), id: 'p1', name: 'Test', dateOfBirth: '1995-01-01', hourlyRate: 12.71, ...extra };
}

/** Eight hours on each of the given weekdays (0 = Monday) for the eight weeks before a date. */
function rota(before: string, weekdays: number[], hours = 8): Shift[] {
  const out: Shift[] = [];
  for (let d = addDays(before, -56); d < before; d = addDays(d, 1)) {
    const wd = (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7;
    if (weekdays.includes(wd)) out.push({ id: d, employeeId: 'p1', roleId: 'server', siteId: 'mar', date: d, startMinute: 600, endMinute: 600 + hours * 60, breakMinutes: 0 });
  }
  return out;
}

describe('statutory sick pay', () => {
  it('pays from the first qualifying day at the flat rate, over the days usually worked', () => {
    // Monday to Friday, 40 hours at £12.71: £508.40 a week, well above the flat rate.
    const shifts = rota('2026-10-05', [0, 1, 2, 3, 4]);
    const e = person({ absences: [sick('2026-10-05', '2026-10-07')] });
    const est = sspEstimate(e, shifts, TODAY);
    expect(est.spells[0]).toMatchObject({ weeklyRate: 123.25, belowFlatRate: false, qualifyingDays: 3, dailyRate: 24.65, amount: 73.95, aweBasis: 'rota' });
    expect(est.total).toBe(73.95);
  });

  it('pays 80% of average earnings when that is lower, and counts only the days on their pattern', () => {
    // Saturdays only, 8 hours at £12.71: £101.68 a week, 80% is £81.34.
    const shifts = rota('2026-10-05', [5]);
    const e = person({ absences: [sick('2026-10-05', '2026-10-18')] });
    const [spell] = sspEstimate(e, shifts, TODAY).spells;
    expect(spell.awe).toBe(101.68);
    expect(spell).toMatchObject({ weeklyRate: 81.34, belowFlatRate: true, qualifyingDays: 2, amount: 162.68 });
  });

  it('links spells 56 days apart or fewer and stops at 28 weeks', () => {
    const shifts = rota('2026-04-13', [0, 1, 2, 3, 4]);
    // Off from Monday 6 April and still off: 28 weeks ran out on Friday 16 October.
    const long = person({ absences: [sick('2026-04-06')] });
    const [spell] = sspEstimate(long, shifts, TODAY).spells;
    expect(spell.days).toHaveLength(28 * 5);
    expect(spell.exhausted).toBe(true);
    expect(spell.days.at(-1)?.date).toBe('2026-10-16');
    expect(spell.amount).toBe(28 * 123.25);

    const linked = person({ absences: [sick('2026-04-13', '2026-04-14'), sick('2026-06-01', '2026-06-02'), sick('2026-09-14', '2026-09-15')] });
    const spells = sspEstimate(linked, shifts, TODAY).spells;
    expect(spells.map((s) => s.periodFrom)).toEqual(['2026-04-13', '2026-04-13', '2026-09-14']);
  });

  it('leaves spells before 6 April 2026 to payroll, and other absence types out', () => {
    const e = person({ absences: [sick('2026-03-02', '2026-03-03'), { id: 'u', type: 'unauthorised', from: '2026-10-05', to: '2026-10-05' }] });
    expect(sspEstimate(e, [], TODAY)).toEqual({ spells: [], total: 0, oldRules: 1 });
  });

  it('averages salary, and contracted hours for someone with no earnings yet', () => {
    expect(averageWeeklyEarnings(person({ payBasis: 'salaried', annualSalary: 31_200 }), [], TODAY)).toEqual({ awe: 600, basis: 'salary' });
    expect(averageWeeklyEarnings(person({ contractedHours: 16 }), [], TODAY)).toMatchObject({ awe: 16 * 12.71, basis: 'contract' });
  });

  it('splits what is due by pay period', () => {
    const shifts = rota('2026-10-05', [0, 1, 2, 3, 4]);
    const est = sspEstimate(person({ absences: [sick('2026-10-08', '2026-10-13')] }), shifts, TODAY);
    expect(sspInPeriod(est, '2026-10-05', '2026-10-11')).toBe(49.3);
    expect(sspInPeriod(est, '2026-10-12', '2026-10-18')).toBe(49.3);
  });
});
