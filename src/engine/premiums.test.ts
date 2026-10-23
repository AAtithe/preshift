import { describe, expect, it } from 'vitest';
import { employeeWeekCost, weekCost } from './cost';
import { describeRule, weekPremiums } from './premiums';
import { payrollHours } from './timesheet';
import { addDays } from './time';
import type { Employee, Entity, PremiumRule, Shift, TimeEntry } from './types';

const WEEK = '2026-10-19'; // Monday
const SUNDAY = '2026-10-25';
const SATURDAY = '2026-10-24';

const person = (over: Partial<Employee> = {}): Employee => ({
  id: 'e1',
  name: 'Test',
  siteId: 'mar',
  entityId: 'co',
  coverSiteIds: [],
  roleIds: ['server'],
  payBasis: 'hourly',
  hourlyRate: 12,
  annualSalary: 0,
  dateOfBirth: '1995-01-01',
  contractedHours: 0,
  maxWeeklyHours: 60,
  optedOutOf48: true,
  irregularHours: true,
  pensionEnrolled: true,
  availability: [],
  leave: [],
  ...over,
});

let n = 0;
const shift = (date: string, start: number, end: number, brk = 0, over: Partial<Shift> = {}): Shift => ({
  id: `s${n++}`,
  employeeId: 'e1',
  roleId: 'server',
  siteId: 'mar',
  date,
  startMinute: start * 60,
  endMinute: end * 60,
  breakMinutes: brk,
  ...over,
});

const company = (premiums: PremiumRule[]): Entity => ({
  id: 'co',
  name: 'Company',
  companyNumber: '1',
  payeReference: '123/A',
  intercompanyCode: '1100',
  premiums,
});

const sunday: PremiumRule = { id: 'sun', name: 'Sunday', kind: 'day', multiplier: 1.5, weekdays: [6] };
const bankHoliday: PremiumRule = { id: 'bh', name: 'Bank holiday', kind: 'bank_holiday', multiplier: 2 };
const nights: PremiumRule = { id: 'night', name: 'Nights', kind: 'night', perHour: 1.5, fromMinute: 22 * 60, toMinute: 6 * 60 };
const overtime: PremiumRule = { id: 'ot', name: 'Overtime', kind: 'overtime', multiplier: 1.5 };

describe('pay premiums', () => {
  it('pays time and a half on Sunday hours only', () => {
    const lines = weekPremiums(person(), [shift(SATURDAY, 12, 20), shift(SUNDAY, 12, 20)], [sunday]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ ruleId: 'sun', hours: 8, uplift: 6, amount: 48 });
  });

  it('gives a Saturday night shift its Sunday premium after midnight', () => {
    const [line] = weekPremiums(person(), [shift(SATURDAY, 20, 26)], [sunday]);
    expect(line.hours).toBe(2);
  });

  it('pays on bank holidays, England and Wales', () => {
    const [line] = weekPremiums(person(), [shift('2026-12-25', 10, 16)], [bankHoliday]);
    expect(line).toMatchObject({ hours: 6, uplift: 12, amount: 72 });
    expect(weekPremiums(person(), [shift('2026-12-24', 10, 16)], [bankHoliday])).toEqual([]);
  });

  it('pays night hours in a window that runs past midnight', () => {
    const [line] = weekPremiums(person(), [shift(WEEK, 18, 26)], [nights]);
    expect(line).toMatchObject({ hours: 4, uplift: 1.5, amount: 6 });
  });

  it('pays overtime on the last hours of the week past contracted hours, or a set threshold', () => {
    const week = [0, 1, 2, 3].map((d) => shift(addDays(WEEK, d), 9, 19)); // 40 hours
    const contracted = weekPremiums(person({ contractedHours: 36 }), week, [overtime]);
    expect(contracted.map((l) => [l.shiftId, l.hours])).toEqual([[week[3].id, 4]]);
    expect(weekPremiums(person({ contractedHours: 0 }), week, [overtime])).toEqual([]);
    const fixed = weekPremiums(person(), week, [{ ...overtime, afterHours: 39 }]);
    expect(fixed[0].hours).toBe(1);
  });

  it('pays only the highest premium on an hour where several apply', () => {
    const lines = weekPremiums(person(), [shift(SUNDAY, 18, 24)], [sunday, nights]);
    // Sunday adds £6 an hour, nights £1.50: Sunday wins every hour, nights pays nothing.
    expect(lines.map((l) => [l.ruleId, l.hours])).toEqual([['sun', 6]]);
    const big = weekPremiums(person(), [shift('2026-12-25', 18, 24)], [sunday, bankHoliday, nights]);
    expect(big.map((l) => l.ruleId)).toEqual(['bh']);
  });

  it('spreads an unpaid break across the shift and limits rules to roles', () => {
    const [line] = weekPremiums(person(), [shift(SUNDAY, 12, 20, 60)], [sunday]);
    expect(line.hours).toBe(7);
    const barOnly = { ...sunday, roleIds: ['bar'] };
    expect(weekPremiums(person(), [shift(SUNDAY, 12, 20)], [barOnly])).toEqual([]);
  });

  it('pays salaried people no premiums', () => {
    expect(weekPremiums(person({ payBasis: 'salaried', annualSalary: 40000 }), [shift(SUNDAY, 12, 20)], [sunday])).toEqual([]);
  });

  it('describes rules in plain English', () => {
    expect(describeRule(sunday)).toBe('Time and a half on Sundays');
    expect(describeRule(nights)).toBe('£1.50 an hour extra between 22:00 and 06:00');
    expect(describeRule(overtime)).toBe('Time and a half after contracted hours in a week');
  });
});

describe('premiums in the cost engine', () => {
  const entities = [company([sunday])];

  it('adds premiums to gross on top of the guaranteed hours floor', () => {
    const e = person({ contractedHours: 30 });
    const without = employeeWeekCost(e, [shift(SUNDAY, 12, 20)], undefined, 1, [], []);
    const withPremium = employeeWeekCost(e, [shift(SUNDAY, 12, 20)], undefined, 1, [], entities);
    expect(without.gross).toBe(360); // 30 guaranteed hours at £12
    expect(withPremium.premium).toBe(48);
    expect(withPremium.gross).toBe(408);
    expect(withPremium.holiday).toBeGreaterThan(without.holiday); // holiday accrues on premium pay too
  });

  it('puts each premium, and its share of on-costs, on the shift that earned it', () => {
    const shifts = [shift(SATURDAY, 12, 20), shift(SUNDAY, 12, 20)];
    const wc = weekCost({ employees: [person()], shifts, entities }, WEEK);
    const sat = wc.shifts.get(shifts[0].id)!;
    const sun = wc.shifts.get(shifts[1].id)!;
    expect(sat.premium).toBe(0);
    expect(sun.premium).toBe(48);
    expect(sun.gross).toBeCloseTo(96 + 48, 1);
    expect(sat.gross).toBeCloseTo(96, 1);
    expect(sun.total / sat.total).toBeCloseTo(1.5, 1);
    expect(sat.total + sun.total).toBeCloseTo(wc.employees.get('e1')!.total, 1);
    expect(wc.premium).toBe(48);
  });
});

describe('premiums sent to payroll', () => {
  const entry = (date: string, from: number, to: number, id: string): TimeEntry => ({
    id,
    employeeId: 'e1',
    siteId: 'mar',
    roleId: 'server',
    date,
    clockIn: from * 60,
    clockOut: to * 60,
    breakMinutes: 0,
    status: 'approved',
    source: 'clock',
  });

  it('adds a premium line on top of the normal hours, left out of total hours', () => {
    const batch = payrollHours([person()], [entry(SATURDAY, 12, 20, 'a'), entry(SUNDAY, 12, 20, 'b')], WEEK, SUNDAY, [], [company([sunday])]);
    const normal = batch.lines.filter((l) => !l.premium);
    const premium = batch.lines.filter((l) => l.premium);
    expect(normal).toHaveLength(1);
    expect(normal[0]).toMatchObject({ hours: 16, rate: 12 });
    expect(premium).toEqual([expect.objectContaining({ hours: 8, rate: 6, premium: { ruleId: 'sun', name: 'Sunday' }, entryIds: ['b'] })]);
    expect(batch.totalHours).toBe(16);
  });

  it('pays what the cost engine accrued', () => {
    const entries = [entry(SATURDAY, 12, 20, 'a'), entry(SUNDAY, 12, 20, 'b')];
    const entities = [company([sunday, nights])];
    const batch = payrollHours([person()], entries, WEEK, SUNDAY, [], entities);
    const paid = batch.lines.reduce((s, l) => s + l.hours * l.rate, 0);
    const accrued = employeeWeekCost(person(), entries.map((e) => shift(e.date, e.clockIn / 60, e.clockOut! / 60)), undefined, 1, [], entities);
    expect(paid).toBeCloseTo(accrued.gross, 2);
  });
});
