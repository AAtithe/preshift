import { describe, expect, it } from 'vitest';
import { newEmployee } from './employees';
import { currentRates, nextApril, uprating, upratingRatesProblem, type UpratingRates } from './uprating';
import type { Employee } from './types';

const TODAY = '2026-10-23';
const person = (id: string, dateOfBirth: string, hourlyRate: number, extra: Partial<Employee> = {}): Employee => ({
  ...newEmployee('mar', 'wdl', 'server', '2024-01-08'), id, name: id, dateOfBirth, hourlyRate, contractedHours: 30, ...extra,
});
// Illustrative April 2027 rates for the tests: the real ones are entered once announced.
const rates: UpratingRates = {
  effectiveFrom: '2027-04-01',
  bands: [
    { minAge: 21, hourly: 13.3, label: 'National Living Wage (21+)' },
    { minAge: 18, hourly: 11.5, label: 'NMW 18-20' },
    { minAge: 16, hourly: 8.5, label: 'NMW 16-17' },
  ],
  apprentice: 8.5,
};

describe('the April minimum wage uprating', () => {
  it('lifts everyone below the new rate for their age on the day onto it', () => {
    const team = [
      person('on-nlw', '1995-01-01', 12.71),
      person('above', '1995-01-01', 14),
      person('turns-21', '2006-03-20', 10.85), // 21 on 20 March 2027: the 21+ rate applies from 1 April
      person('salaried', '1990-01-01', 0, { payBasis: 'salaried', annualSalary: 25_000, maxWeeklyHours: 45 }),
      person('leaves', '1995-01-01', 12.71, { leaveDate: '2027-03-31' }),
    ];
    const r = uprating(team, [], rates, 'floor', TODAY);
    expect(r.lines.map((l) => [l.employeeId, l.proposed, l.band])).toEqual([
      ['on-nlw', 13.3, 'National Living Wage (21+)'],
      ['turns-21', 13.3, 'National Living Wage (21+)'],
    ]);
    expect(r.lines[0].fullCostAYear).toBeGreaterThan(0.59 * 30 * 52);
    // £25,000 over 45 hours is £10.68 an hour: a salary to put right by hand.
    expect(r.salaryChecks).toEqual([{ employeeId: 'salaried', name: 'salaried', effectiveHourly: 10.68, newMinimum: 13.3 }]);
  });

  it('keeps differentials near the floor, so the ladder does not collapse or invert', () => {
    const team = [person('floor', '1995-01-01', 12.71), person('supervisor', '1995-01-01', 13.01), person('well-above', '1995-01-01', 14)];
    const r = uprating(team, [], rates, 'differential', TODAY);
    expect(r.lines.map((l) => [l.employeeId, l.proposed])).toEqual([['floor', 13.3], ['supervisor', 13.6]]);
  });

  it('pays apprentices under 19 the apprentice rate, and holds back anyone with pay already moving', () => {
    const team = [person('apprentice', '2009-06-01', 8, { hr: { contractType: 'apprentice' } }), person('waiting', '1995-01-01', 12.71)];
    const r = uprating(team, [], rates, 'floor', TODAY, [{ employeeId: 'waiting', status: 'pending' }]);
    expect(r.lines.find((l) => l.employeeId === 'apprentice')).toMatchObject({ band: 'Apprentice rate', proposed: 8.5 });
    expect(r.lines.find((l) => l.employeeId === 'waiting')?.blocked).toMatch(/already waiting/);
    expect(r.total).toBe(r.lines.find((l) => l.employeeId === 'apprentice')!.fullCostAYear);
  });

  it('starts from today\'s rates and the next 1 April, and refuses rates that fall', () => {
    expect(nextApril('2026-10-23')).toBe('2027-04-01');
    expect(nextApril('2027-04-01')).toBe('2027-04-01');
    expect(currentRates(TODAY)).toMatchObject({ effectiveFrom: '2027-04-01', apprentice: 8 });
    expect(upratingRatesProblem(rates, TODAY)).toBeNull();
    expect(upratingRatesProblem({ ...rates, bands: [{ ...rates.bands[0], hourly: 12 }] }, TODAY)).toMatch(/do not fall/);
    expect(upratingRatesProblem({ ...rates, effectiveFrom: TODAY }, TODAY)).toMatch(/still to come/);
  });
});
