import { describe, expect, it } from 'vitest';
import { allowanceClaimant, employmentAllowanceIssues, employmentAllowanceWeek } from './allowance';
import { autoSchedule, autoScheduleSites } from './autoschedule';
import { checkEmployeeWeek, checkWeek, requiredBreakMinutes } from './compliance';
import { employeeWeekCost, weekCost } from './cost';
import { holidayBalance, holidayHourlyRate, leaveYear, workedShifts } from './holiday';
import { employedShare, employeeStatus, newEmployee, reviewEmployee } from './employees';
import { dayDemand, headcountAt } from './demand';
import { intercompanyBalances, rotaJournal, toXeroCsv } from './journal';
import { scopeMetrics, weekMetrics } from './metrics';
import { seedState } from './seed';
import { payrollHours } from './timesheet';
import { addDays, ageOn, taxYearOf, weekStart } from './time';
import type { Employee, Entity, RotaState, Shift } from './types';

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
        l.trackingOption === site.trackingCode && l.amount > 0 && l.entityId === site.entityId && l.description !== 'Employment Allowance';
      expect(total(costLines)).toBeCloseTo(weekCost(filled, WEEK, site.id).total, 0);
    }
    const debitsInSites = total((l) => l.amount > 0 && l.trackingOption !== '' && l.description !== 'Employment Allowance');
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

  it('keeps the sites\' own target for a week with no forecast, rather than 0%', () => {
    const noForecast = { ...next, forecast: [] };
    const group = scopeMetrics(noForecast, all, WEEK);
    expect(group.forecastSales).toBe(0);
    expect(group.labourCost).toBeGreaterThan(0);
    const own = all.map((id) => noForecast.sites.find((s) => s.id === id)!.labourTargetPct);
    expect(group.targetPct).toBeCloseTo(own.reduce((a, b) => a + b, 0) / own.length, 6);
    expect(group.targetPct).toBeGreaterThan(0.2);
  });
});

describe('employment allowance', () => {
  const base = seedState('2026-10-21');
  const built = { ...base, shifts: autoScheduleSites(base, ['mar', 'fitz', 'shd'], WEEK).shifts };
  const claiming = (state: RotaState, remaining: number, asAt: string): RotaState => ({
    ...state,
    entities: state.entities.map((e): Entity => (e.id === 'wdl' ? { ...e, employmentAllowance: { remaining, asAt } } : { ...e, employmentAllowance: undefined })),
  });
  const sum = (lines: ReturnType<typeof rotaJournal>, pred: (l: ReturnType<typeof rotaJournal>[number]) => boolean) =>
    lines.filter(pred).reduce((s, l) => s + l.amount, 0);

  it('places weeks in the right tax year', () => {
    expect(taxYearOf('2026-04-05')).toBe('2025/26');
    expect(taxYearOf('2026-04-06')).toBe('2026/27');
    expect(taxYearOf('2027-01-10')).toBe('2026/27');
  });

  it('caps the week at what is left and posts it to the claimant only', () => {
    const state = claiming(built, 500, addDays(WEEK, -1));
    const ea = employmentAllowanceWeek(state, WEEK)!;
    expect(ea.employerNi).toBeGreaterThan(500);
    expect(ea.used).toBe(500);
    expect(ea.remainingAfter).toBe(0);
    const lines = rotaJournal(state, WEEK);
    expect(sum(lines, (l) => l.description === 'Employment Allowance' && l.accountCode === '7006')).toBeCloseTo(-500, 2);
    expect(lines.filter((l) => l.description === 'Employment Allowance').every((l) => l.entityId === 'wdl')).toBe(true);
    for (const entity of state.entities) expect(Math.abs(sum(lines, (l) => l.entityId === entity.id))).toBeLessThan(0.005);
    // Employer NI in the claimant's books falls by exactly the allowance used.
    const gross = rotaJournal(claiming(built, 0, addDays(WEEK, -1)), WEEK);
    const ni = (ls: typeof lines) => sum(ls, (l) => l.entityId === 'wdl' && l.accountCode === '7006');
    expect(ni(gross) - ni(lines)).toBeCloseTo(500, 2);
  });

  it('uses only this week’s NI when plenty is left, split across the claimant’s sites', () => {
    const state = claiming(built, 10_500, addDays(WEEK, -1));
    const ea = employmentAllowanceWeek(state, WEEK)!;
    expect(ea.used).toBe(ea.employerNi);
    const lines = rotaJournal(state, WEEK).filter((l) => l.description === 'Employment Allowance' && l.accountCode === '7006');
    expect(new Set(lines.map((l) => l.trackingOption))).toEqual(new Set(['Marylebone', 'Fitzrovia']));
    // Every penny of the claimant's NI is cleared, not left behind by rounding.
    const all = rotaJournal(state, WEEK);
    expect(Math.abs(sum(all, (l) => l.entityId === 'wdl' && l.accountCode === '7006'))).toBeLessThan(0.005);
  });

  it('carries usage forward through the rota from the last payroll', () => {
    const state = claiming(built, 10_500, addDays(WEEK, -1));
    const thisWeek = employmentAllowanceWeek(state, WEEK)!;
    const nextWeek = employmentAllowanceWeek(state, addDays(WEEK, 7))!;
    expect(nextWeek.available).toBeCloseTo(10_500 - thisWeek.used, 2);
  });

  it('leaves weeks payroll has already run alone', () => {
    const state = claiming(built, 500, addDays(WEEK, 6));
    expect(employmentAllowanceWeek(state, WEEK)!.coveredByPayroll).toBe(true);
    expect(rotaJournal(state, WEEK).some((l) => l.description === 'Employment Allowance')).toBe(false);
  });

  it('starts again from the full allowance in a new tax year', () => {
    const state = claiming(built, 0, '2026-03-29');
    const april = employmentAllowanceWeek(state, '2026-04-06')!;
    expect(april.taxYear).toBe('2026/27');
    expect(april.available).toBe(10_500);
  });

  it('applies one claim per group and flags a second', () => {
    const two = { ...base, entities: base.entities.map((e) => ({ ...e, employmentAllowance: { remaining: 10_500, asAt: addDays(WEEK, -1) } })) };
    expect(allowanceClaimant(two)!.id).toBe('wdl');
    expect(employmentAllowanceIssues(two)[0]).toContain('one claim');
    expect(employmentAllowanceIssues(base)).toEqual([]);
  });
});

describe('employees', () => {
  const TODAY = '2026-10-21';
  const copy = { id: 'd1', fileName: 'passport.pdf', contentType: 'application/pdf' as const, bytes: 1, sha256: '', uploadedAt: '', uploadedBy: '' };
  const ok = { rightToWork: { checked: true, checkedOn: '2026-01-05', documents: [copy] } };
  const codes = (e: Employee) => reviewEmployee(e, TODAY).map((c) => c.code);

  it('passes a complete, lawful record', () => {
    expect(codes(person(ok))).toEqual([]);
  });

  it('blocks a missing right to work check and an expired one', () => {
    expect(codes(person())).toContain('right-to-work');
    expect(codes(person({ rightToWork: { checked: true, expiry: '2026-10-01' } }))).toContain('right-to-work');
    expect(codes(person({ rightToWork: { checked: true, expiry: '2026-11-30' } }))).toContain('right-to-work-expiring');
  });

  it('warns when a check has no copy or no date', () => {
    expect(codes(person({ rightToWork: { ...ok.rightToWork, documents: [] } }))).toContain('right-to-work-copy');
    expect(codes(person({ rightToWork: { ...ok.rightToWork, checkedOn: undefined } }))).toContain('right-to-work-date');
  });

  it('warns ahead of a birthday that moves the minimum wage band', () => {
    // Turns 21 on 2026-11-15 on £10.85: must rise to the National Living Wage.
    expect(codes(person({ ...ok, dateOfBirth: '2005-11-15', hourlyRate: 10.85 }))).toContain('wage-step');
    expect(codes(person({ ...ok, dateOfBirth: '2005-11-15', hourlyRate: 12.71 }))).not.toContain('wage-step');
  });

  it('stops under 18s opting out of the 48 hour limit', () => {
    expect(codes(person({ ...ok, dateOfBirth: '2009-01-01', hourlyRate: 8, optedOutOf48: true }))).toContain('opt-out');
  });

  it('flags a salary that falls below minimum wage at maximum hours', () => {
    expect(codes(person({ ...ok, payBasis: 'salaried', annualSalary: 30_000, maxWeeklyHours: 55, optedOutOf48: true }))).toContain('salary-nmw');
  });

  it('flags an eligible jobholder who is not enrolled', () => {
    expect(codes(person({ ...ok, pensionEnrolled: false, contractedHours: 30 }))).toContain('pension');
    expect(codes(person({ ...ok, pensionEnrolled: false, contractedHours: 10 }))).not.toContain('pension');
  });

  it('knows starters, leavers and who has left', () => {
    expect(employeeStatus(person({ startDate: '2026-11-01' }), TODAY)).toBe('starter');
    expect(employeeStatus(person({ leaveDate: '2026-10-25' }), TODAY)).toBe('leaving');
    expect(employeeStatus(person({ leaveDate: '2026-10-01' }), TODAY)).toBe('left');
  });

  it('pro-rates guaranteed pay for a mid-week leaver and drops them after', () => {
    const leaver = person({ contractedHours: 35, leaveDate: addDays(WEEK, 2) });
    expect(employedShare(leaver, WEEK)).toBeCloseTo(3 / 7);
    expect(weekCost({ employees: [leaver], shifts: [] }, WEEK).employees.get('e1')!.gross).toBeCloseTo(15 * 13, 1);
    expect(weekCost({ employees: [leaver], shifts: [] }, addDays(WEEK, 7)).employees.has('e1')).toBe(false);
  });

  it('blocks shifts outside employment dates', () => {
    const starter = person({ ...ok, startDate: addDays(WEEK, 3) });
    const issues = checkEmployeeWeek(starter, WEEK, [shift(WEEK, 12, 16)]).map((i) => i.code);
    expect(issues).toContain('not-employed');
  });

  it('never auto-builds someone without a right to work check', () => {
    const state = seedState(WEEK);
    const id = state.employees.find((e) => e.siteId === 'mar' && e.roleIds[0] === 'server')!.id;
    state.employees = state.employees.map((e) => (e.id === id ? { ...e, rightToWork: { checked: false } } : e));
    expect(autoSchedule(state, 'mar', WEEK).shifts.some((s) => s.employeeId === id)).toBe(false);
  });

  it('never auto-builds someone before they start', () => {
    const state = seedState(WEEK);
    const starter = { ...state.employees.find((e) => e.siteId === 'mar' && e.roleIds[0] === 'server')!, startDate: addDays(WEEK, 7) };
    state.employees = state.employees.map((e) => (e.id === starter.id ? starter : e));
    const { shifts } = autoSchedule(state, 'mar', WEEK);
    expect(shifts.some((s) => s.employeeId === starter.id)).toBe(false);
  });
});

describe('starters in a group', () => {
  it('are employed by the company given, cover nowhere, and are not borrowed before they start', () => {
    const blank = newEmployee('shd', 'eck', 'bar', '2026-10-21');
    expect(blank).toMatchObject({ siteId: 'shd', entityId: 'eck', coverSiteIds: [] });
    const state = seedState('2026-10-21');
    const starter: Employee = {
      ...blank, name: 'Late Starter', dateOfBirth: '1995-01-01', hourlyRate: 12.71, coverSiteIds: ['mar'],
      startDate: '2026-11-30', rightToWork: { checked: true },
    };
    // Cheapest bartender in the group, but not on the books this week, so the build must not use them anywhere.
    const built = autoScheduleSites({ ...state, employees: [...state.employees, starter] }, ['mar', 'shd'], WEEK);
    expect(built.shifts.some((s) => s.employeeId === starter.id)).toBe(false);
    // Control: the same person already on the books does get used, so the start date is what kept them out.
    const onBooks = autoScheduleSites({ ...state, employees: [...state.employees, { ...starter, startDate: '2026-01-05' }] }, ['mar', 'shd'], WEEK);
    expect(onBooks.shifts.some((s) => s.employeeId === starter.id)).toBe(true);
  });
});

describe('holiday', () => {
  const TODAY = '2026-07-01'; // day 182 of a calendar leave year
  const fixed = (over: Partial<Employee> = {}) => person({ contractedHours: 40, irregularHours: false, hourlyRate: 15, ...over });

  it('finds the leave year for any start day', () => {
    expect(leaveYear('2026-07-01')).toEqual({ start: '2026-01-01', end: '2026-12-31' });
    expect(leaveYear('2026-03-31', '04-01')).toEqual({ start: '2025-04-01', end: '2026-03-31' });
    expect(leaveYear('2026-04-01', '04-01')).toEqual({ start: '2026-04-01', end: '2027-03-31' });
  });

  it('gives fixed hours staff 5.6 weeks, earned evenly through the year', () => {
    const b = holidayBalance(fixed(), [], TODAY);
    expect(b.basis).toBe('fixed');
    expect(b.entitlementHours).toBe(224);
    expect(b.accruedHours).toBeCloseTo((224 * 182) / 365, 1);
    expect(b.dayHours).toBe(8);
  });

  it('pro-rates a starter part way through the year', () => {
    const b = holidayBalance(fixed({ startDate: '2026-07-02' }), [], TODAY);
    expect(b.entitlementHours).toBeCloseTo((224 * 183) / 365, 1);
    expect(b.accruedHours).toBe(0);
  });

  it('accrues 12.07% of hours worked for irregular hours staff', () => {
    const worked = [shift('2026-06-01', 10, 20, 0), shift('2026-06-02', 10, 20, 0), shift('2026-07-10', 10, 20, 0)];
    const b = holidayBalance(person(), worked, TODAY);
    expect(b.basis).toBe('accrual');
    // Only the 20 hours worked by today count.
    expect(b.accruedHours).toBeCloseTo(20 * 0.1207, 2);
    expect(b.dayHours).toBe(10);
  });

  it('takes leave days off the balance, past as taken and future as booked', () => {
    const b = holidayBalance(fixed({ leave: ['2026-03-02', '2026-03-03', '2026-08-03'], holiday: { dayHours: { '2026-03-03': 4 } } }), [], TODAY);
    expect(b.takenHours).toBe(12);
    expect(b.bookedHours).toBe(8);
    expect(b.remainingHours).toBe(204);
  });

  it('values untaken holiday as a provision, with employer NI', () => {
    const b = holidayBalance(fixed({ holiday: { carriedOverHours: 16 } }), [], TODAY);
    expect(b.untakenHours).toBeCloseTo(b.accruedHours + 16, 2);
    expect(b.liability).toBeCloseTo(b.untakenHours * 15, 0);
    expect(b.liabilityWithNi).toBeCloseTo(b.liability * 1.15, 1);
  });

  it('prices salaried holiday at salary over contracted hours', () => {
    expect(holidayHourlyRate(person({ payBasis: 'salaried', annualSalary: 52_000, contractedHours: 50 }))).toBe(20);
  });

  it('warns about overbooking, unused leave near year end, and leavers', () => {
    const codes = (e: Employee, today = TODAY) => holidayBalance(e, [], today).checks.map((c) => c.code);
    const lots = Array.from({ length: 30 }, (_, i) => addDays('2026-08-03', i));
    expect(codes(fixed({ leave: lots }))).toContain('holiday-overbooked');
    expect(codes(fixed(), '2026-11-15')).toContain('holiday-unused');
    expect(codes(fixed({ leaveDate: '2026-07-31' }))).toContain('holiday-final-pay');
    expect(codes(fixed({ leaveDate: '2026-01-31', leave: lots.map((d) => d.replace('2026-08', '2026-01').replace('2026-09', '2026-01')).slice(0, 25) }), '2026-01-31'))
      .toContain('holiday-overtaken');
  });

  it('prefers clocked time to the rota for the same day', () => {
    const rota = [shift('2026-06-01', 10, 20), shift('2026-06-02', 10, 20)];
    const actual = [{ ...shift('2026-06-01', 10, 14), id: 'te:1' }];
    expect(workedShifts(rota, actual).map((s) => s.endMinute)).toEqual([14 * 60, 20 * 60]);
  });
});

describe('cross-site cost', () => {
  it('splits a person working at two sites by hours, and the parts tie to each site total', () => {
    const state = seedState(WEEK);
    const borrowed = state.employees.find((e) => e.siteId === 'shd' && e.payBasis === 'hourly' && e.contractedHours === 0)!;
    const at = (id: string, siteId: string, start: number) =>
      ({ id, employeeId: borrowed.id, roleId: borrowed.roleIds[0], siteId, date: WEEK, startMinute: start * 60, endMinute: (start + 4) * 60, breakMinutes: 0 }) as Shift;
    // Different days, so there is no travel between them and the split is by hours alone.
    state.shifts = [at('home', 'shd', 12), { ...at('away', 'mar', 18), date: '2026-10-20' }];
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

describe('paid travel between sites', () => {
  const state = () => seedState(WEEK);
  const person = (s: ReturnType<typeof seedState>) =>
    s.employees.find((e) => e.siteId === 'shd' && e.payBasis === 'hourly' && e.contractedHours === 0)!;
  const at = (employeeId: string, id: string, siteId: string, start: number, end: number) =>
    ({ id, employeeId, roleId: 'server', siteId, date: WEEK, startMinute: start * 60, endMinute: end * 60, breakMinutes: 0 }) as Shift;

  it('pays the journey as working time and charges it to the site travelled to', () => {
    const s = state();
    const p = person(s);
    s.shifts = [at(p.id, 'home', 'shd', 12, 16), at(p.id, 'away', 'mar', 17, 21)];
    const whole = employeeWeekCost(p, s.shifts, undefined, 1, s.sites);
    // Shoreditch to Marylebone is 43 minutes on the straight-line estimate.
    expect(whole.travelHours).toBeCloseTo(43 / 60, 2);
    expect(whole.paidHours).toBeCloseTo(8 + 43 / 60, 2);
    const noTravel = employeeWeekCost(p, s.shifts);
    expect(whole.gross - noTravel.gross).toBeCloseTo((43 / 60) * p.hourlyRate, 1);
    const mar = weekCost(s, WEEK, 'mar');
    const shd = weekCost(s, WEEK, 'shd');
    expect(mar.shifts.get('away')!.travelHours).toBeCloseTo(43 / 60, 2);
    expect(shd.shifts.get('home')!.travelHours).toBe(0);
    expect(mar.shifts.get('away')!.total + shd.shifts.get('home')!.total).toBeCloseTo(whole.total, 1);
    expect(mar.travel.hours).toBeCloseTo(43 / 60, 2);
    expect(mar.travel.cost).toBeGreaterThan(0);
    expect(shd.travel.cost).toBe(0);
  });

  it('uses a TfL time when one is held, and pays nothing for separate trips or unknown journeys', () => {
    const s = state();
    const p = person(s);
    s.sites = s.sites.map((x) => (x.id === 'mar' ? { ...x, travel: { shd: { minutes: 37, source: 'tfl' as const, checkedAt: WEEK } } } : x));
    s.shifts = [at(p.id, 'home', 'shd', 12, 16), at(p.id, 'away', 'mar', 17, 21)];
    expect(employeeWeekCost(p, s.shifts, undefined, 1, s.sites).travelHours).toBeCloseTo(37 / 60, 2);
    s.shifts = [at(p.id, 'home', 'shd', 8, 10), at(p.id, 'away', 'mar', 17, 21)];
    expect(employeeWeekCost(p, s.shifts, undefined, 1, s.sites).travelHours).toBe(0);
    const unlocated = s.sites.map(({ location: _l, travel: _t, ...x }) => x);
    s.shifts = [at(p.id, 'home', 'shd', 12, 16), at(p.id, 'away', 'mar', 17, 21)];
    expect(employeeWeekCost(p, s.shifts, undefined, 1, unlocated).travelHours).toBe(0);
  });

  it('adds paid travel to the hours sent to payroll, on the line for the site travelled to', () => {
    const s = state();
    const p = person(s);
    const entry = (id: string, siteId: string, start: number, end: number) => ({
      id, employeeId: p.id, siteId, roleId: 'server', date: WEEK, clockIn: start * 60, clockOut: end * 60, breakMinutes: 0, status: 'approved' as const,
    });
    const batch = payrollHours(s.employees, [entry('a', 'shd', 12, 16), entry('b', 'mar', 17, 21)] as never, WEEK, '2026-10-25', s.sites);
    const mar = batch.lines.find((l) => l.siteId === 'mar')!;
    const shd = batch.lines.find((l) => l.siteId === 'shd')!;
    expect(mar.travelHours).toBeCloseTo(0.72, 2);
    expect(mar.hours).toBeCloseTo(4.72, 2);
    expect(shd.hours).toBe(4);
    expect(batch.totalHours).toBeCloseTo(8.72, 2);
  });

  it('counts paid travel as hours worked for holiday accrual', () => {
    const s = state();
    const p = person(s);
    const worked = [at(p.id, 'home', 'shd', 12, 16), at(p.id, 'away', 'mar', 17, 21)];
    const today = addDays(WEEK, 1);
    const b = holidayBalance(p, worked, today, undefined, undefined, s.sites);
    expect(b.basis).toBe('accrual');
    expect(b.travelHours).toBeCloseTo(43 / 60, 2);
    expect(b.accruedHours - holidayBalance(p, worked, today).accruedHours).toBeCloseTo((43 / 60) * 0.1207, 1);
    // Fixed hours entitlement is set by the contract, so travel does not change it.
    const fixedHours = { ...p, contractedHours: 40, irregularHours: false };
    expect(holidayBalance(fixedHours, worked, today, undefined, undefined, s.sites).accruedHours).toBe(holidayBalance(fixedHours, worked, today).accruedHours);
  });
});
