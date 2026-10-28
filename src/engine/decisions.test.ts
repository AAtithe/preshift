import { describe, expect, it } from 'vitest';
import type { Issue } from './compliance';
import { nameDays, weekBrief } from './decisions';
import type { DayMetrics, WeekMetrics } from './metrics';
import { addDays, weekDates } from './time';
import type { Employee, Shift } from './types';

const WEEK = '2026-10-26';
const DATES = weekDates(WEEK);
const MON = DATES[0];

const person = (id: string, over: Partial<Employee> = {}): Employee => ({
  id,
  name: `${id[0].toUpperCase()}${id.slice(1)} Test`,
  siteId: 'mar',
  entityId: 'wdl',
  coverSiteIds: [],
  roleIds: ['server'],
  payBasis: 'hourly',
  hourlyRate: 12,
  annualSalary: 0,
  dateOfBirth: '1995-01-01',
  contractedHours: 0,
  maxWeeklyHours: 48,
  optedOutOf48: false,
  irregularHours: true,
  pensionEnrolled: true,
  availability: [],
  leave: [],
  ...over,
});

const shift = (id: string, date: string): Shift => ({
  id,
  employeeId: 'ellie',
  roleId: 'server',
  siteId: 'mar',
  date,
  startMinute: 16 * 60,
  endMinute: 23 * 60,
  breakMinutes: 20,
  published: true,
});

/** A week at a 28% target: Monday staffed and over, the rest forecast with nobody on. */
function week(days: Partial<DayMetrics>[] = []): WeekMetrics {
  const all = DATES.map((date, i) => ({ date, forecastSales: 4000, labourCost: 480, paidHours: 0, labourPct: 0.12, splh: 0, ...days[i] }));
  const forecastSales = all.reduce((s, d) => s + d.forecastSales, 0);
  const labourCost = all.reduce((s, d) => s + d.labourCost, 0);
  return {
    days: all,
    forecastSales,
    labourCost,
    paidHours: 0,
    labourPct: labourCost / forecastSales,
    splh: 0,
    targetPct: 0.28,
    targetCost: forecastSales * 0.28,
    varianceToTarget: labourCost - forecastSales * 0.28,
    cost: {} as WeekMetrics['cost'],
  };
}

const MONDAY_OVER = { forecastSales: 3298, labourCost: 2367, labourPct: 2367 / 3298 };
const employees = [person('ellie'), person('marco', { contractedHours: 40 }), person('aisha', { contractedHours: 40 })];
const base = { employees, dates: DATES, showCost: true, today: MON };

describe('naming days', () => {
  it('says one day, a run, or a list', () => {
    expect(nameDays([DATES[1]], DATES)).toBe('Tuesday');
    expect(nameDays(DATES.slice(1), DATES)).toBe('Tuesday to Sunday');
    expect(nameDays([DATES[1], DATES[2]], DATES)).toBe('Tuesday and Wednesday');
    expect(nameDays([DATES[5], DATES[1], DATES[3]], DATES)).toBe('Tuesday, Thursday and Saturday');
  });
});

describe('the week brief', () => {
  it('puts days with nobody on first, then the overspend, then hours paid for nothing', () => {
    const issues: Issue[] = [
      { code: 'under-contract', severity: 'warn', employeeId: 'marco', message: '8.5h is below 40 contracted hours.', gapHours: 31.5 },
      { code: 'under-contract', severity: 'warn', employeeId: 'aisha', message: '0.0h is below 40 contracted hours.', gapHours: 40 },
    ];
    const { decisions } = weekBrief({ ...base, shifts: [shift('a', MON)], metrics: week([MONDAY_OVER]), issues });
    expect(decisions.map((d) => d.kind)).toEqual(['empty-days', 'over-target', 'under-contract']);

    const [empty, over, under] = decisions;
    expect(empty.title).toBe('Tuesday to Sunday have no shifts');
    expect(empty.detail).toBe('£24,000 of forecast sales with nobody rostered.');
    expect(empty.action).toEqual({ kind: 'build' });
    expect(empty.dates).toEqual(DATES.slice(1));

    expect(over.title).toBe('Monday labour is 71.8% of sales');
    // £2,367 less 28% of £3,298.
    expect(over.amount).toBeCloseTo(2367 - 0.28 * 3298);
    expect(over.detail).toBe('£2,367 of labour against £3,298 of sales: £1,444 over the 28.0% target.');
    expect(over.action).toEqual({ kind: 'day', date: MON });

    expect(under.title).toBe('2 people are below contracted hours');
    expect(under.detail).toBe('Marco 8.5 of 40, Aisha 0 of 40. £858 paid either way, so give them hours first.');
    expect(under.action).toEqual({ kind: 'people' });
  });

  it('puts a blocking issue above everything, since the week cannot go out', () => {
    const issues: Issue[] = [{ code: 'daily-rest', severity: 'block', employeeId: 'ellie', date: MON, message: 'has 9h rest between shifts, under the 11h minimum.' }];
    const { decisions } = weekBrief({ ...base, shifts: [shift('a', MON)], metrics: week([MONDAY_OVER]), issues });
    expect(decisions[0].kind).toBe('blocking');
    expect(decisions[0].title).toBe('1 blocking issue stops this week being published');
    expect(decisions[0].detail).toBe('Ellie: has 9h rest between shifts, under the 11h minimum.');
  });

  it('orders days over target by the money over', () => {
    const shifts = DATES.map((d, i) => shift(String(i), d));
    const metrics = week([
      { forecastSales: 4000, labourCost: 1400, labourPct: 0.35 },
      { forecastSales: 2000, labourCost: 1800, labourPct: 0.9 },
    ]);
    const { decisions } = weekBrief({ ...base, shifts, metrics, issues: [] });
    expect(decisions.map((d) => d.dates[0])).toEqual([DATES[1], DATES[0]]);
  });

  it('tells nobody about money who does not see cost', () => {
    const issues: Issue[] = [{ code: 'under-contract', severity: 'warn', employeeId: 'marco', message: '', gapHours: 10 }];
    const { decisions } = weekBrief({ ...base, showCost: false, shifts: [shift('a', MON)], metrics: week([MONDAY_OVER]), issues });
    expect(decisions.map((d) => d.kind)).toEqual(['empty-days', 'under-contract']);
    expect(decisions[1].detail).toBe('Marco 30 of 40. You pay the gap either way, so give them hours first.');
    expect(decisions[1].amount).toBeUndefined();
  });

  it('leaves past days alone', () => {
    const { decisions } = weekBrief({ ...base, today: DATES[5], shifts: [shift('a', MON)], metrics: week([MONDAY_OVER]), issues: [] });
    expect(decisions).toHaveLength(1);
    expect(decisions[0].title).toBe('Saturday and Sunday have no shifts');
  });

  it('has nothing to decide about a week that is over', () => {
    const issues: Issue[] = [
      { code: 'daily-rest', severity: 'block', employeeId: 'ellie', date: MON, message: 'has 9h rest between shifts.' },
      { code: 'under-contract', severity: 'warn', employeeId: 'marco', message: '', gapHours: 10 },
    ];
    expect(weekBrief({ ...base, today: addDays(DATES[6], 1), shifts: [shift('a', MON)], metrics: week([MONDAY_OVER]), issues })).toEqual({ decisions: [], keep: null });
  });

  it('turns hours the build could not fill into one decision, after the empty days', () => {
    const shifts = DATES.slice(0, 3).map((d, i) => shift(String(i), d));
    const unfilled = [
      { role: 'Host', date: DATES[2], fromHour: 19, toHour: 23 },
      { role: 'Host', date: DATES[3], fromHour: 19, toHour: 23 },
      { role: 'Bartender', date: DATES[4], fromHour: 19, toHour: 23 },
      { role: 'Bartender', date: DATES[5], fromHour: 19, toHour: 23 },
      // Yesterday's gap is past deciding about.
      { role: 'Host', date: DATES[0], fromHour: 12, toHour: 14 },
    ];
    const { decisions } = weekBrief({ ...base, today: DATES[1], shifts, metrics: week(), issues: [], unfilled });
    expect(decisions.map((d) => d.kind)).toEqual(['empty-days', 'unfillable']);
    expect(decisions[1].title).toBe('4 gaps cannot be filled legally with the current team');
    expect(decisions[1].detail).toBe('Host Wed 19:00-23:00, Host Thu 19:00-23:00, Bartender Fri 19:00-23:00 and 1 more. That is a hiring or cross-training signal, not a rota problem.');
    expect(decisions[1].dates).toEqual(DATES.slice(2, 6));
  });

  it('praises only what is plainly true', () => {
    const shifts = DATES.map((d, i) => shift(String(i), d));
    expect(weekBrief({ ...base, shifts, metrics: week(), issues: [] }).keep).toBe('Nothing to decide: the week is staffed, legal and inside the labour target.');
    expect(weekBrief({ ...base, showCost: false, shifts, metrics: week(), issues: [] }).keep).toBe('Nothing to decide: the week is staffed and legal.');
    // Work still to do: whether the week is published is the heading's to say, not this line's.
    expect(weekBrief({ ...base, shifts: [shift('a', MON)], metrics: week([MONDAY_OVER]), issues: [] }).keep).toBeNull();
    // No forecast: nothing to judge the week against.
    const none = week(DATES.map(() => ({ forecastSales: 0, labourPct: 0 })));
    expect(weekBrief({ ...base, shifts: [], metrics: none, issues: [] })).toEqual({ decisions: [], keep: null });
  });
});
