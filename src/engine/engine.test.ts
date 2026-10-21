import { describe, expect, it } from 'vitest';
import { autoSchedule, autoScheduleSites } from './autoschedule';
import { checkEmployeeWeek, checkWeek, requiredBreakMinutes } from './compliance';
import { employeeWeekCost, weekCost } from './cost';
import { dayDemand, headcountAt } from './demand';
import { intercompanyBalances, rotaJournal, toXeroCsv } from './journal';
import { scopeMetrics, weekMetrics } from './metrics';
import { seedState } from './seed';
import { addDays, ageOn, weekStart } from './time';
import type { Employee, Shift } from './types';

const WEEK = '2026-10-19'; // a Monday

const person = (over: Partial<Employee> = {}): Employee => ({
  id: 'e1',
  name: 'Test',
  siteId: 'mar',
  entityId: 'wdl',
  coverSiteIds: [],
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
  const state = seedState('2026-10-21');
  const filled = { ...state, shifts: autoScheduleSites(state, ['mar', 'fitz', 'shd'], WEEK).shifts };
  const lines = rotaJournal(filled, WEEK);
  const total = (pred: (l: (typeof lines)[number]) => boolean) =>
    lines.filter(pred).reduce((s, l) => s + l.amount, 0);

  it('balances to zero in every entity and exports Xero CSV', () => {
    for (const entity of state.entities) {
      expect(lines.some((l) => l.entityId === entity.id)).toBe(true);
      expect(Math.abs(total((l) => l.entityId === entity.id))).toBeLessThan(0.005);
    }
    const csv = toXeroCsv(lines.filter((l) => l.entityId === 'wdl'));
    expect(csv.split('\n')[0]).toContain('*AccountCode');
    expect(csv).toContain('25/10/2026');
  });

  it('posts cost to the site it was worked at, so labour per site matches the rota', () => {
    for (const site of state.sites) {
      const costLines = (l: (typeof lines)[number]) =>
        l.trackingOption === site.trackingCode && l.amount > 0 && l.entityId === site.entityId;
      expect(total(costLines)).toBeCloseTo(weekCost(filled, WEEK, site.id).total, 0);
    }
    const debitsInSites = total((l) => l.amount > 0 && l.trackingOption !== '');
    // Each shift's cost is rounded by component, so a few pence of drift across a group's week is expected.
    expect(Math.abs(debitsInSites - weekCost(filled, WEEK).total)).toBeLessThan(1);
  });

  it('recharges cross-entity work and both sides agree', () => {
    // Dev Kapoor is employed by East Canteen & Kitchen and covers Marylebone, which trades in West End Dining.
    const dev = state.employees.find((e) => e.name === 'Dev Kapoor')!;
    const borrowed: Shift = shift(addDays(WEEK, 2), 17, 23, 0, { id: 'x1', employeeId: dev.id, roleId: 'bar', siteId: 'mar' });
    const recharge = rotaJournal({ ...state, shifts: [borrowed] }, WEEK);
    const [ic] = intercompanyBalances(state, recharge);
    expect(ic.entityId).toBe('eck');
    expect(ic.counterpartyId).toBe('wdl');
    expect(ic.inOwnBooks).toBeGreaterThan(0);
    expect(ic.inOwnBooks).toBeCloseTo(ic.inCounterpartyBooks, 2);
    // West End carries the wages; East Canteen carries the accrual it will pay through PAYE.
    expect(recharge.some((l) => l.entityId === 'wdl' && l.accountCode === '7002' && l.trackingOption === 'Marylebone')).toBe(true);
    expect(recharge.some((l) => l.entityId === 'eck' && l.accountCode === '2210' && l.amount < 0)).toBe(true);
    for (const entity of state.entities) {
      expect(Math.abs(recharge.filter((l) => l.entityId === entity.id).reduce((s, l) => s + l.amount, 0))).toBeLessThan(0.005);
    }
  });

  it('recharges a central employing company with no sites of its own', () => {
    const group = {
      ...state,
      entities: [...state.entities, { id: 'emp', name: 'Group Staffing Ltd', companyNumber: '1', payeReference: '120/GS1', intercompanyCode: '1359' }],
      employees: state.employees.map((e) => (e.siteId === 'fitz' ? { ...e, entityId: 'emp' } : e)),
    };
    const out = rotaJournal(group, WEEK);
    const ic = intercompanyBalances(group, out).find((b) => b.entityId === 'emp')!;
    // Salaried GM at Fitzrovia is paid whether rostered or not, so there is always something to recharge.
    expect(ic.counterpartyId).toBe('wdl');
    expect(ic.inOwnBooks).toBeGreaterThan(800);
    expect(ic.inOwnBooks).toBeCloseTo(ic.inCounterpartyBooks, 2);
  });
});

describe('multi-site', () => {
  const state = seedState('2026-10-21');
  const all = ['mar', 'fitz', 'shd'];
  const result = autoScheduleSites(state, all, WEEK);
  const next = { ...state, shifts: result.shifts };

  it('builds every site without blocking breaches, including across sites', () => {
    for (const siteId of all) expect(result.shifts.some((s) => s.siteId === siteId)).toBe(true);
    expect(checkWeek(next, WEEK, all).filter((i) => i.severity === 'block')).toEqual([]);
  });

  it('only borrows people who have said they will cover', () => {
    for (const s of result.added) {
      const e = state.employees.find((x) => x.id === s.employeeId)!;
      expect(e.siteId === s.siteId || e.coverSiteIds.includes(s.siteId)).toBe(true);
    }
  });

  it('gives each site first call on its own team', () => {
    const homeOnly = autoScheduleSites(state, all, WEEK, { allowCover: false });
    // Cover only fills what the home teams could not, so it never leaves a site worse off.
    const unfilledHours = (gaps: typeof result.unfilled) => gaps.reduce((s, g) => s + g.toHour - g.fromHour, 0);
    expect(unfilledHours(result.unfilled)).toBeLessThanOrEqual(unfilledHours(homeOnly.unfilled));
    const homeShifts = (shifts: Shift[]) =>
      shifts.filter((s) => state.employees.find((e) => e.id === s.employeeId)?.siteId === s.siteId).length;
    expect(homeShifts(result.added)).toBeGreaterThanOrEqual(homeShifts(homeOnly.added) * 0.95);
  });

  it('consolidates sites into entity and group figures that reconcile', () => {
    const group = scopeMetrics(next, all, WEEK);
    const parts = all.map((id) => weekMetrics(next, id, WEEK));
    expect(group.labourCost).toBeCloseTo(parts.reduce((s, m) => s + m.labourCost, 0), 2);
    expect(group.forecastSales).toBeCloseTo(parts.reduce((s, m) => s + m.forecastSales, 0), 2);
    expect(group.labourCost).toBeCloseTo(weekCost(next, WEEK).total, 0);
    // Target is weighted by sales, so it sits between the sites' own targets.
    expect(group.targetPct).toBeGreaterThan(0.27);
    expect(group.targetPct).toBeLessThan(0.29);
    const wdl = scopeMetrics(next, ['mar', 'fitz'], WEEK);
    expect(wdl.sites.map((m) => m.siteId)).toEqual(['mar', 'fitz']);
  });
});
