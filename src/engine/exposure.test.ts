import { describe, expect, it } from 'vitest';
import { checkEmployeeWeek, isTermTimeWeek } from './compliance';
import { nmwPay } from './cost';
import { cutCall } from './cutcall';
import { compensationOnEarlyFinishes, ERA_ASSUMPTIONS, guaranteedHoursOffers } from './era';
import { complianceExposure } from './exposure';
import { nmwCheck, payPeriodFor } from './nmw';
import { workingTimeAverages } from './wtr';
import { seedDemo } from './simulate';
import { addDays, weekDates } from './time';
import type { ClockRecord, DemandRule, Employee, HourActual, HourForecast, RotaState, Shift, TroncScheme } from './types';
import { actualCompliance, weekVariance } from './actuals';

const WEEK = '2026-10-19'; // a Monday
const NEXT = addDays(WEEK, 7);
const H = 60;

const person = (id: string, over: Partial<Employee> = {}): Employee => ({
  id,
  name: id,
  siteId: 'mar',
  roleIds: ['server'],
  payBasis: 'hourly',
  hourlyRate: 13,
  annualSalary: 0,
  dateOfBirth: '1995-01-01',
  contractedHours: 0,
  maxWeeklyHours: 60,
  optedOutOf48: true,
  irregularHours: true,
  pensionEnrolled: true,
  availability: [],
  leave: [],
  rightToWork: { basis: 'unlimited', checkedOn: '2025-01-01' },
  ...over,
});

let n = 0;
const shift = (employeeId: string, date: string, start: number, end: number, brk = 0): Shift => ({
  id: `s${n++}`,
  employeeId,
  roleId: 'server',
  siteId: 'mar',
  date,
  startMinute: start * H,
  endMinute: end * H,
  breakMinutes: brk,
});

const clocked = (s: Shift, over: Partial<ClockRecord> = {}): ClockRecord => ({
  id: `c-${s.id}`,
  employeeId: s.employeeId,
  siteId: s.siteId,
  roleId: s.roleId,
  shiftId: s.id,
  date: s.date,
  clockIn: s.startMinute,
  clockOut: s.endMinute,
  breakMinutes: s.breakMinutes,
  source: 'geofence',
  ...over,
});

const state = (over: Partial<RotaState>): RotaState => ({
  sites: [{ id: 'mar', name: 'Marylebone', labourTargetPct: 0.28, trackingCode: 'Marylebone', openMinute: 11 * H, closeMinute: 23 * H }],
  roles: [{ id: 'server', name: 'Server', department: 'FOH', nominalCode: '7000' }],
  employees: [],
  shifts: [],
  forecast: [],
  demandRules: [],
  clocks: [],
  actuals: [],
  tips: [],
  troncSchemes: [],
  ...over,
});

/** Five ten-hour days with a 30 minute break: 47.5 paid hours. */
const longWeek = (employeeId: string, week = WEEK) =>
  weekDates(week).slice(0, 5).map((d) => shift(employeeId, d, 11, 21, 30));

const codes = (e: Employee, shifts: Shift[], week = WEEK) => checkEmployeeWeek(e, week, shifts).map((i) => i.code);

describe('minimum wage on hours worked', () => {
  const chef = person('chef', { payBasis: 'salaried', annualSalary: 30_000, hourlyRate: 0, nmwReducingDeductionsWeekly: 6 });

  it('takes deductions for the employer’s benefit off minimum wage pay', () => {
    expect(nmwPay(chef, 40)).toBeCloseTo(30_000 / 52 - 6, 2);
    expect(nmwPay(person('a'), 10)).toBe(130);
  });

  it('finds arrears on a salaried long week and prices the penalty', () => {
    const shifts = longWeek('chef');
    const st = state({ employees: [chef], shifts, clocks: shifts.map((s) => clocked(s)) });
    const [row] = nmwCheck(st, WEEK, NEXT);
    expect(row.basis).toBe('clocked');
    expect(row.hoursWorked).toBe(47.5);
    const pay = 30_000 / 52 - 6;
    expect(row.arrears).toBeCloseTo(12.71 * 47.5 - pay, 2);
    expect(row.penalty).toBeCloseTo(row.arrears * 2, 2);
    expect(row.headroomHours).toBeCloseTo(pay / 12.71 - 47.5, 2);
  });

  it('caps the penalty per worker', () => {
    const st = state({
      employees: [person('a', { payBasis: 'salaried', annualSalary: 1, hourlyRate: 0 })],
      shifts: [],
      clocks: Array.from({ length: 7 }, (_, i) => clocked(shift('a', addDays(WEEK, i), 0, 23))),
    });
    const rates = { penalty: nmwCheck(st, WEEK, NEXT)[0].penalty };
    expect(rates.penalty).toBeLessThanOrEqual(20_000);
  });

  it('projects an open week from clocked days plus the rota still to come', () => {
    const shifts = longWeek('chef');
    const st = state({ employees: [chef], shifts, clocks: [clocked(shifts[0])] });
    expect(nmwCheck(st, WEEK, addDays(WEEK, 1))[0].basis).toBe('projected');
  });

  it('warns on the rota before a salaried week breaches', () => {
    expect(codes(chef, longWeek('chef'))).toContain('nmw-salaried');
    expect(codes(chef, longWeek('chef').slice(0, 4))).not.toContain('nmw-salaried');
  });
});

describe('right to work', () => {
  const student = person('st', {
    rightToWork: {
      basis: 'student',
      checkedOn: '2025-09-01',
      expires: '2027-09-30',
      weeklyHourLimit: 20,
      vacations: [{ from: '2026-12-12', to: '2027-01-10' }],
    },
  });
  const twentyFour = (week: string) => weekDates(week).slice(0, 4).map((d) => shift('st', d, 17, 23));

  it('blocks a student over 20 hours in term time but not in the vacation', () => {
    expect(codes(student, twentyFour(WEEK))).toContain('rtw-student-hours');
    const christmas = '2026-12-21';
    expect(isTermTimeWeek(weekDates(christmas), student.rightToWork!.vacations)).toBe(false);
    expect(codes(student, twentyFour(christmas), christmas)).not.toContain('rtw-student-hours');
  });

  it('keeps a buffer under the student limit because clocked hours decide the breach', () => {
    const nineteen = weekDates(WEEK).slice(0, 4).map((d) => shift('st', d, 17, 21)).concat(shift('st', addDays(WEEK, 4), 17, 20));
    expect(codes(student, nineteen)).toContain('rtw-student-buffer');
    expect(codes(student, nineteen.slice(0, 4))).not.toContain('rtw-student-buffer');
  });

  it('blocks shifts after permission ends and warns ahead of it', () => {
    const e = person('v', { rightToWork: { basis: 'time-limited', checkedOn: '2025-01-01', expires: addDays(WEEK, 2) } });
    const c = codes(e, [shift('v', addDays(WEEK, 1), 12, 16), shift('v', addDays(WEEK, 3), 12, 16)]);
    expect(c.filter((x) => x === 'rtw-expired')).toHaveLength(1);
    expect(c).toContain('rtw-expiring');
  });

  it('blocks rostering anyone with no check on file', () => {
    expect(codes(person('x', { rightToWork: undefined }), [shift('x', WEEK, 12, 16)])).toContain('rtw-missing');
  });

  it('prices illegal working once per worker at the civil penalty ceiling', () => {
    const shifts = twentyFour(WEEK);
    const st = state({ employees: [student], shifts, clocks: shifts.map((s) => clocked(s)) });
    const r = complianceExposure(st, 'mar', WEEK, NEXT);
    const priced = r.rightToWork.filter((l) => l.penaltyCeiling > 0);
    expect(priced).toHaveLength(1);
    expect(priced[0]).toMatchObject({ source: 'clocked', penaltyCeiling: 45_000 });
    expect(r.penaltyCeiling).toBe(45_000);
  });
});

describe('Employment Rights Act assumptions', () => {
  it('turns regularly worked hours into a guaranteed hours offer and its fixed cost', () => {
    const last = addDays(WEEK, -7);
    const shifts = longWeek('z', last);
    const st = state({ employees: [person('z')], shifts, clocks: shifts.map((s) => clocked(s)) });
    const [offer] = guaranteedHoursOffers(st, 'mar', WEEK);
    expect(offer).toMatchObject({ employeeId: 'z', weeksUsed: 1, averageHours: 47.5, extraGuaranteedHours: 47.5 });
    expect(offer.weeklyFixedCost).toBeGreaterThan(47.5 * 13);
    // Someone contracted at or above the threshold is not in scope.
    const contracted = { ...st, employees: [person('z', { contractedHours: ERA_ASSUMPTIONS.lowHoursThreshold })] };
    expect(guaranteedHoursOffers(contracted, 'mar', WEEK)).toEqual([]);
  });

  it('gives back the saving from early finishes as compensation', () => {
    const s = shift('z', WEEK, 12, 22, 30);
    const st = state({ employees: [person('z')], shifts: [s], clocks: [clocked(s, { clockOut: 19 * H })] });
    const r = compensationOnEarlyFinishes(st, weekVariance(st, WEEK, NEXT));
    expect(r.count).toBe(1);
    expect(r.compensation).toBeCloseTo(r.saved, 2);
  });

  it('stops the cut call sending people home when compensation is due', () => {
    const date = WEEK;
    const rule: DemandRule = { siteId: 'mar', roleId: 'server', coversPerHour: 10, minimumWhileOpen: 1, maximum: 6 };
    const forecast: HourForecast[] = Array.from({ length: 12 }, (_, i) => ({ siteId: 'mar', date, hour: 11 + i, sales: 1200, covers: 30 }));
    const actuals: HourActual[] = forecast.filter((f) => f.hour < 17).map((f) => ({ ...f, sales: f.sales * 0.6, covers: f.covers * 0.6 }));
    const team = ['a', 'b', 'c'].map((id) => person(id));
    const shifts = team.map((e) => shift(e.id, date, 11, 23, 30));
    const st = state({ employees: team, shifts, forecast, actuals, demandRules: [rule] });
    expect(cutCall(st, 'mar', date, 17 * H).recommendations.length).toBeGreaterThan(0);
    const priced = cutCall(st, 'mar', date, 17 * H, { era: ERA_ASSUMPTIONS });
    expect(priced.recommendations).toEqual([]);
    expect(priced.keptAtNoCost.length).toBeGreaterThan(0);
  });
});

describe('demo exposure', () => {
  const demo = seedDemo('2026-10-21');
  const last = addDays(WEEK, -7);

  it('finds the salaried minimum wage breach and the student over the term-time limit', () => {
    const r = complianceExposure(demo, 'mar', last, WEEK);
    expect(r.nmw.some((row) => row.arrears > 0)).toBe(true);
    expect(r.rightToWork.some((l) => l.code === 'rtw-student-hours' && l.source === 'clocked')).toBe(true);
    expect(r.owedNow).toBeGreaterThan(0);
    expect(r.penaltyCeiling).toBeGreaterThanOrEqual(45_000);
  });

  it('flags the visa running out at Shoreditch', () => {
    const r = complianceExposure(demo, 'shd', WEEK, '2026-10-21');
    expect(r.rightToWork.some((l) => l.code === 'rtw-expiring')).toBe(true);
  });
});

describe('monthly pay reference periods', () => {
  const monthly = person('chef', {
    payBasis: 'salaried',
    annualSalary: 30_000,
    hourlyRate: 0,
    nmwReducingDeductionsWeekly: 6,
    payFrequency: 'monthly',
  });
  const october = Array.from({ length: 31 }, (_, i) => addDays('2026-10-01', i));
  // Ten hour days with a 30 minute break on every weekday of the month.
  const weekdays = october.filter((d) => new Date(`${d}T00:00:00Z`).getUTCDay() % 6 !== 0);

  it('uses the month that holds most of the week', () => {
    expect(payPeriodFor('monthly', '2026-10-26')).toMatchObject({ from: '2026-10-01', to: '2026-10-31' });
    expect(payPeriodFor('monthly', '2026-09-28')).toMatchObject({ from: '2026-10-01', to: '2026-10-31' });
    expect(payPeriodFor('weekly', WEEK)).toMatchObject({ from: WEEK, to: addDays(WEEK, 6) });
  });

  it('tests a whole month of clocked hours against a twelfth of the salary', () => {
    const shifts = weekdays.map((d) => shift('chef', d, 11, 21, 30));
    const st = state({ employees: [monthly], shifts, clocks: shifts.map((s) => clocked(s)) });
    const [row] = nmwCheck(st, WEEK, '2026-11-02');
    expect(row).toMatchObject({ basis: 'clocked', coverage: 1, hoursWorked: 9.5 * 22 });
    const pay = 30_000 / 12 - (6 * 52) / 12;
    expect(row.arrears).toBeCloseTo(12.71 * 209 - pay, 2);
    expect(row.annualisedArrears).toBeCloseTo(row.arrears * 12, 2);
    // A 22 weekday month costs more than the same pattern tested weekly.
    const weekly = nmwCheck({ ...st, employees: [{ ...monthly, payFrequency: 'weekly' }] }, WEEK, '2026-11-02')[0];
    expect(row.arrears).toBeGreaterThan((weekly.arrears * 52) / 12);
  });

  it('projects the rest of the month at the same daily rate when the rota runs out', () => {
    const firstHalf = weekdays.filter((d) => d < '2026-10-16').map((d) => shift('chef', d, 11, 21, 30));
    const st = state({ employees: [monthly], shifts: firstHalf, clocks: firstHalf.map((s) => clocked(s)) });
    const [row] = nmwCheck(st, '2026-10-12', '2026-10-16');
    expect(row.basis).toBe('projected');
    expect(row.coverage).toBeLessThan(1);
    expect(row.hoursWorked).toBeCloseTo((9.5 * firstHalf.length * 31) / 15, 1);
  });
});

describe('17 week Working Time average', () => {
  const worker = person('w', { optedOutOf48: false });
  const weeks = (count: number, hoursPerDay: number) =>
    Array.from({ length: count }, (_, i) => addDays(WEEK, -7 * (i + 1))).flatMap((w) =>
      weekDates(w).slice(0, 5).map((d) => shift('w', d, 10, 10 + hoursPerDay)),
    );
  const run = (shifts: Shift[]) => workingTimeAverages(state({ employees: [worker], shifts, clocks: shifts.map((s) => clocked(s)) }), 'mar', WEEK)[0];

  it('treats one long week as legal and a steady 50 as a breach', () => {
    expect(run(weeks(1, 12))).toMatchObject({ breach: false, onCourseToBreach: false, average: 60 });
    expect(run(weeks(17, 10))).toMatchObject({ breach: true, average: 50 });
  });

  it('calls the trend after four weeks and says what hours are left', () => {
    const r = run(weeks(4, 10));
    expect(r.onCourseToBreach).toBe(true);
    expect(r.allowedAverageAhead).toBeCloseTo((48 * 17 - 200) / 13, 2);
  });

  it('no longer reports a single clocked week over 48 as a breach', () => {
    const shifts = weeks(1, 12);
    const st = state({ employees: [worker], shifts, clocks: shifts.map((s) => clocked(s)) });
    expect(actualCompliance(st, addDays(WEEK, -7), WEEK).map((i) => i.code)).not.toContain('wtr-48');
  });
});

describe('tips in the register', () => {
  const sept = '2026-09-07';
  const team = [person('a'), person('b')];
  const shifts = team.map((e) => shift(e.id, sept, 12, 20, 30));
  const scheme: TroncScheme = {
    siteId: 'mar',
    troncmaster: 'Head server',
    independent: true,
    pointsPerHour: { server: 10 },
    serviceCharge: 'discretionary',
    policyPublishedOn: '2025-01-01',
    lastReviewedOn: '2025-01-01',
  };
  const tips = [{ id: 't1', siteId: 'mar', date: sept, source: 'service-charge' as const, amount: 200 }];
  const base = state({ employees: team, shifts, clocks: shifts.map((s) => clocked(s)), tips, troncSchemes: [scheme] });

  it('counts tips past the deadline as owed, with a tribunal award per worker', () => {
    expect(complianceExposure(base, 'mar', '2026-10-26', '2026-10-31').tronc.overdue).toBe(0);
    const r = complianceExposure(base, 'mar', '2026-10-26', '2026-11-01');
    expect(r.tronc).toMatchObject({ overdue: 200, overdueWorkers: 2, tribunalCeiling: 10_000 });
    expect(r.owedNow).toBe(200);
  });

  it('shows the NI that rests on the troncmaster’s independence', () => {
    const r = complianceExposure(base, 'mar', sept, '2026-09-14');
    expect(r.tronc.niAtStakeAnnual).toBeGreaterThan(0);
    const employerRun = { ...base, troncSchemes: [{ ...scheme, independent: false }] };
    expect(complianceExposure(employerRun, 'mar', sept, '2026-09-14').tronc.niAtStakeAnnual).toBe(0);
  });
});
