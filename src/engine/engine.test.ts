import { describe, expect, it } from 'vitest';
import { autoSchedule } from './autoschedule';
import { checkEmployeeWeek, checkWeek, requiredBreakMinutes } from './compliance';
import { employeeWeekCost, weekCost } from './cost';
import { dayDemand, headcountAt } from './demand';
import { rotaJournal, toXeroCsv } from './journal';
import { weekMetrics } from './metrics';
import { seedState } from './seed';
import { addDays, ageOn, weekStart } from './time';
import type { Employee, Shift } from './types';

const WEEK = '2026-10-19'; // a Monday

const person = (over: Partial<Employee> = {}): Employee => ({
  id: 'e1',
  name: 'Test',
  siteId: 'mar',
  roleIds: ['server'],
  payBasis: 'hourly',
  hourlyRate: 13,
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

describe('time', () => {
  it('finds the Monday of the week', () => {
    expect(weekStart('2026-10-21')).toBe(WEEK);
    expect(weekStart('2026-10-25')).toBe(WEEK);
  });
  it('works out age on a date', () => {
    expect(ageOn('2009-04-21', '2026-04-20')).toBe(16);
    expect(ageOn('2009-04-21', '2026-04-21')).toBe(17);
  });
});

describe('cost', () => {
  it('loads hourly pay with holiday, employer NI and pension', () => {
    const shifts = [shift(WEEK, 10, 18, 30), shift(addDays(WEEK, 1), 10, 18, 30)];
    const c = employeeWeekCost(person(), shifts);
    expect(c.paidHours).toBe(15);
    expect(c.gross).toBe(195);
    expect(c.holiday).toBeCloseTo(23.54, 2);
    // (195 + 23.54 - 96) * 15%
    expect(c.employerNi).toBeCloseTo(18.38, 2);
    // (218.54 - 120) * 3%
    expect(c.pension).toBeCloseTo(2.96, 2);
    expect(c.total).toBeCloseTo(195 + 23.54 + 18.38 + 2.96, 1);
  });

  it('charges no NI or pension below the thresholds', () => {
    const c = employeeWeekCost(person(), [shift(WEEK, 12, 17)]);
    expect(c.employerNi).toBe(0);
    expect(c.pension).toBe(0);
  });

  it('pays guaranteed hours even when not rostered', () => {
    const c = employeeWeekCost(person({ contractedHours: 30 }), [shift(WEEK, 10, 18, 30)]);
    expect(c.gross).toBe(30 * 13);
  });

  it('spreads on-costs over shifts so the week reconciles', () => {
    const shifts = [shift(WEEK, 10, 18, 30), shift(addDays(WEEK, 2), 17, 23, 0)];
    const wc = weekCost({ employees: [person()], shifts }, WEEK);
    const sum = [...wc.shifts.values()].reduce((s, x) => s + x.total, 0);
    expect(sum).toBeCloseTo(wc.employees.get('e1')!.total, 1);
  });

  it('costs salaried staff weekly whether or not they are rostered', () => {
    const gm = person({ payBasis: 'salaried', annualSalary: 52_000, hourlyRate: 0 });
    const wc = weekCost({ employees: [gm], shifts: [] }, WEEK);
    expect(wc.unallocated).toBeGreaterThan(1000);
  });
});

describe('compliance', () => {
  const codes = (e: Employee, shifts: Shift[]) => checkEmployeeWeek(e, WEEK, shifts).map((i) => i.code);

  it('requires a 20 minute break over 6 hours, 30 over 4.5 for under 18s', () => {
    expect(requiredBreakMinutes(6 * 60, 30)).toBe(0);
    expect(requiredBreakMinutes(6 * 60 + 1, 30)).toBe(20);
    expect(requiredBreakMinutes(5 * 60, 17)).toBe(30);
    expect(codes(person(), [shift(WEEK, 10, 18, 0)])).toContain('break');
  });

  it('flags less than 11 hours rest, including across the week boundary', () => {
    expect(codes(person(), [shift(WEEK, 15, 24, 30), shift(addDays(WEEK, 1), 9, 15, 0)])).toContain('daily-rest');
    expect(codes(person(), [shift(addDays(WEEK, -1), 15, 24, 30), shift(WEEK, 8, 12, 0)])).toContain('daily-rest');
  });

  it('flags double booking', () => {
    expect(codes(person(), [shift(WEEK, 10, 14), shift(WEEK, 13, 17)])).toContain('double-booked');
  });

  it('blocks pay below the minimum wage for the person’s age', () => {
    expect(codes(person({ hourlyRate: 12.5 }), [shift(WEEK, 12, 16)])).toContain('minimum-wage');
    expect(codes(person({ hourlyRate: 10.85, dateOfBirth: '2007-06-01' }), [shift(WEEK, 12, 16)])).not.toContain('minimum-wage');
  });

  it('applies young worker limits', () => {
    const teen = person({ dateOfBirth: '2009-06-01', hourlyRate: 8 });
    const c = codes(teen, [shift(WEEK, 14, 23, 30)]);
    expect(c).toContain('young-daily');
    expect(c).toContain('young-night');
  });

  it('flags no day off and hours over 48 without opt-out', () => {
    const week = Array.from({ length: 7 }, (_, i) => shift(addDays(WEEK, i), 10, 18, 30));
    const c = codes(person(), week);
    expect(c).toContain('weekly-rest');
    expect(c).toContain('wtr-48');
    expect(codes(person({ optedOutOf48: true, maxWeeklyHours: 60 }), week)).not.toContain('wtr-48');
  });

  it('flags leave, availability and training', () => {
    const e = person({ leave: [WEEK], availability: [{ weekday: 0, fromMinute: 17 * 60, toMinute: 23 * 60 }] });
    const c = codes(e, [shift(WEEK, 12, 16, 0, { roleId: 'chef' })]);
    expect(c).toEqual(expect.arrayContaining(['on-leave', 'availability', 'not-trained']));
  });
});

describe('demand', () => {
  it('counts shifts that run over midnight into the next day', () => {
    const s = [shift(WEEK, 20, 26)];
    expect(headcountAt(s, addDays(WEEK, 1), 1, 'server', 'mar')).toBe(1);
    expect(headcountAt(s, addDays(WEEK, 1), 2, 'server', 'mar')).toBe(0);
  });

  it('turns the forecast into headcount within the rule limits', () => {
    const state = seedState('2026-10-21');
    const sat = addDays(WEEK, 5);
    const servers = dayDemand(state, 'mar', 'server', sat);
    expect(servers[9].required).toBe(0); // closed
    expect(Math.max(...servers.map((h) => h.required))).toBeGreaterThan(1);
    expect(Math.max(...servers.map((h) => h.required))).toBeLessThanOrEqual(6);
  });
});

describe('auto-schedule', () => {
  const state = seedState('2026-10-21');
  const result = autoSchedule(state, 'mar', WEEK);
  const next = { ...state, shifts: result.shifts };

  it('fills demand without creating blocking breaches', () => {
    expect(result.added.length).toBeGreaterThan(20);
    const blocks = checkWeek(next, WEEK, 'mar').filter((i) => i.severity === 'block');
    expect(blocks).toEqual([]);
  });

  it('never rosters someone on leave', () => {
    const chloe = state.employees.find((e) => e.name === 'Chloe Dubois')!;
    expect(result.shifts.some((s) => s.employeeId === chloe.id && chloe.leave.includes(s.date))).toBe(false);
  });

  it('lands the week near the labour target', () => {
    const m = weekMetrics(next, 'mar', WEEK);
    expect(m.labourPct).toBeGreaterThan(0.15);
    expect(m.labourPct).toBeLessThan(0.4);
  });
});

describe('journal', () => {
  it('balances to zero per site and exports Xero CSV', () => {
    const state = seedState('2026-10-21');
    const filled = { ...state, shifts: autoSchedule(state, 'mar', WEEK).shifts };
    const lines = rotaJournal(filled, WEEK);
    for (const site of ['Marylebone', 'Shoreditch']) {
      const total = lines.filter((l) => l.trackingOption === site).reduce((s, l) => s + l.amount, 0);
      expect(Math.abs(total)).toBeLessThan(0.005);
    }
    const debit = lines.filter((l) => l.amount > 0).reduce((s, l) => s + l.amount, 0);
    expect(debit).toBeCloseTo(weekCost(filled, WEEK).total, 0);
    const csv = toXeroCsv(lines);
    expect(csv.split('\n')[0]).toContain('*AccountCode');
    expect(csv).toContain('25/10/2026');
  });
});

describe('cross-site cost', () => {
  it('splits a person working at two sites by hours, and the parts tie to each site total', () => {
    const state = seedState(WEEK);
    const borrowed = state.employees.find((e) => e.siteId === 'shd' && e.payBasis === 'hourly' && e.contractedHours === 0)!;
    const at = (id: string, siteId: string, start: number) =>
      ({ id, employeeId: borrowed.id, roleId: borrowed.roleIds[0], siteId, date: WEEK, startMinute: start * 60, endMinute: (start + 4) * 60, breakMinutes: 0 }) as Shift;
    state.shifts = [at('home', 'shd', 12), at('away', 'mar', 18)];
    const mar = weekCost(state, WEEK, 'mar');
    const shd = weekCost(state, WEEK, 'shd');
    const whole = employeeWeekCost(borrowed, state.shifts).total;
    expect(mar.shifts.get('away')!.total + shd.shifts.get('home')!.total).toBeCloseTo(whole, 1);
    for (const c of [mar, shd]) {
      const sum = c.parts.gross + c.parts.holiday + c.parts.employerNi + c.parts.pension;
      expect(sum).toBeCloseTo(c.total, 0);
    }
    // Marylebone carries half of the borrowed person's week, not all of it.
    const p = mar.parts;
    const marOwn = weekCost({ ...state, shifts: [] }, WEEK, 'mar').total;
    expect(p.gross + p.holiday + p.employerNi + p.pension - marOwn).toBeCloseTo(whole / 2, 0);
  });
});
