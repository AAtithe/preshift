import { describe, expect, it } from 'vitest';
import { seedDemo } from './simulate';
import { addDays } from './time';
import { employeeNi, employerNi, markWeekPaid, tipsPayBy, troncCompliance, troncRun } from './tronc';
import type { ClockRecord, Employee, RotaState, TipsTaken, TroncScheme } from './types';

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
  ...over,
});

let n = 0;
const clock = (employeeId: string, roleId: string, hours: number, date = WEEK): ClockRecord => ({
  id: `c${n++}`,
  employeeId,
  siteId: 'mar',
  roleId,
  date,
  clockIn: 12 * H,
  clockOut: 12 * H + hours * H,
  breakMinutes: 0,
  source: 'geofence',
});

const tip = (amount: number, over: Partial<TipsTaken> = {}): TipsTaken => ({
  id: `t${n++}`,
  siteId: 'mar',
  date: WEEK,
  source: 'service-charge',
  amount,
  ...over,
});

const scheme = (over: Partial<TroncScheme> = {}): TroncScheme => ({
  siteId: 'mar',
  troncmaster: 'Head server',
  independent: true,
  pointsPerHour: { server: 10, chef: 5, gm: 0 },
  serviceCharge: 'discretionary',
  policyPublishedOn: '2025-01-01',
  lastReviewedOn: '2025-01-01',
  ...over,
});

const state = (over: Partial<RotaState>): RotaState => ({
  sites: [{ id: 'mar', name: 'Marylebone', labourTargetPct: 0.28, trackingCode: 'Marylebone', openMinute: 11 * H, closeMinute: 23 * H }],
  roles: [
    { id: 'server', name: 'Server', department: 'FOH', nominalCode: '7000' },
    { id: 'chef', name: 'Chef', department: 'BOH', nominalCode: '7001' },
    { id: 'gm', name: 'General Manager', department: 'MGMT', nominalCode: '7003' },
  ],
  employees: [person('a'), person('b'), person('c', { roleIds: ['chef'] }), person('m', { roleIds: ['gm'] })],
  shifts: [],
  forecast: [],
  demandRules: [],
  clocks: [],
  actuals: [],
  tips: [],
  troncSchemes: [scheme()],
  ...over,
});

describe('rules', () => {
  it('pays tips by the end of the month after they were taken', () => {
    expect(tipsPayBy('2026-10-15')).toBe('2026-11-30');
    expect(tipsPayBy('2026-12-03')).toBe('2027-01-31');
    expect(tipsPayBy('2027-01-31')).toBe('2027-02-28');
  });

  it('works employee NI across the thresholds', () => {
    expect(employeeNi(242)).toBe(0);
    expect(employeeNi(342)).toBeCloseTo(8, 5);
    expect(employeeNi(1067)).toBeCloseTo((967 - 242) * 0.08 + 100 * 0.02, 5);
    expect(employerNi(196)).toBeCloseTo(15, 5);
  });
});

describe('allocation', () => {
  it('splits on clocked hours times points and passes on every penny', () => {
    const st = state({
      clocks: [clock('a', 'server', 8), clock('b', 'server', 4), clock('c', 'chef', 8), clock('m', 'gm', 10)],
      tips: [tip(100), tip(0.01, { source: 'card-tip' })],
    });
    const run = troncRun(st, 'mar', WEEK, NEXT);
    // Points: a 80, b 40, c 40. The manager is on zero points and gets nothing.
    const by = Object.fromEntries(run.shares.map((s) => [s.employeeId, s.amount]));
    expect(by).toEqual({ a: 50.01, b: 25, c: 25 });
    expect(run.allocated).toBe(run.received);
    expect(run.unallocated).toBe(0);
  });

  it('splits by department first and gives an absent department’s share to those who worked', () => {
    const departmentShares = { FOH: 0.6, BOH: 0.3, BAR: 0.1 };
    const st = state({
      troncSchemes: [scheme({ departmentShares })],
      clocks: [clock('a', 'server', 2), clock('c', 'chef', 20)],
      tips: [tip(90)],
    });
    const by = Object.fromEntries(troncRun(st, 'mar', WEEK, NEXT).shares.map((s) => [s.employeeId, s.amount]));
    // No bar hours, so FOH and BOH split 60:30 of the whole pool.
    expect(by).toEqual({ a: 60, c: 30 });
  });

  it('only counts days that have traded', () => {
    const st = state({ clocks: [clock('a', 'server', 8)], tips: [tip(50), tip(70, { date: addDays(WEEK, 3) })] });
    expect(troncRun(st, 'mar', WEEK, addDays(WEEK, 2)).received).toBe(50);
  });

  it('holds tips with no clocked hours to go to rather than losing them', () => {
    const run = troncRun(state({ tips: [tip(40)] }), 'mar', WEEK, NEXT);
    expect(run.unallocated).toBe(40);
    expect(troncCompliance(state({ tips: [tip(40)] }), 'mar', WEEK, NEXT).map((i) => i.code)).toContain('tronc-unallocated');
  });
});

describe('tax', () => {
  const base = { clocks: [clock('a', 'server', 30), clock('b', 'server', 10)], tips: [tip(300)] };

  it('charges no NI through an independent tronc and reports the saving', () => {
    const run = troncRun(state(base), 'mar', WEEK, NEXT);
    expect(run.niDue).toEqual({ employer: 0, employee: 0 });
    // a earns 30h x £13 plus holiday, already over both thresholds: the full rate applies to the tips.
    const a = run.shares.find((s) => s.employeeId === 'a')!;
    expect(a.employerNi).toBeCloseTo(a.amount * 0.15, 2);
    expect(run.niSaving.employer).toBeGreaterThan(0);
  });

  it('charges NI when the employer allocates, worked on each person’s whole week', () => {
    const run = troncRun(state({ ...base, troncSchemes: [scheme({ independent: false })] }), 'mar', WEEK, NEXT);
    expect(run.niDue).toEqual(run.niSaving);
    // b's 10 hours are under the primary threshold, so part of b's tips carry no employee NI.
    const b = run.shares.find((s) => s.employeeId === 'b')!;
    expect(b.employeeNi).toBeLessThan(b.amount * 0.08);
  });

  it('takes VAT out of a mandatory service charge', () => {
    const run = troncRun(state({ ...base, troncSchemes: [scheme({ serviceCharge: 'mandatory' })] }), 'mar', WEEK, NEXT);
    expect(run.vatOnServiceCharge).toBeCloseTo(50, 2);
  });
});

describe('compliance', () => {
  const codes = (st: RotaState, asOf = NEXT) => troncCompliance(st, 'mar', WEEK, asOf).map((i) => i.code);

  it('needs a written policy and a review with staff', () => {
    const c = codes(state({ troncSchemes: [scheme({ policyPublishedOn: undefined, lastReviewedOn: '2022-01-01' })] }));
    expect(c).toEqual(expect.arrayContaining(['tips-no-policy', 'tips-review']));
    expect(codes(state({}))).toEqual([]);
  });

  it('flags tips unpaid after the deadline, and clears once paid', () => {
    const st = state({ clocks: [clock('a', 'server', 8)], tips: [tip(80)] });
    expect(codes(st, '2026-11-30')).not.toContain('tips-overdue');
    expect(codes(st, '2026-12-01')).toContain('tips-overdue');
    const paid = { ...st, tips: markWeekPaid(st.tips, 'mar', WEEK, '2026-10-30') };
    expect(codes(paid, '2026-12-01')).not.toContain('tips-overdue');
    expect(troncRun(paid, 'mar', WEEK, NEXT).paid).toBe(true);
  });

  it('flags tips taken with no scheme at all', () => {
    expect(codes(state({ troncSchemes: [], tips: [tip(10)] }))).toEqual(['tronc-no-scheme']);
  });
});

describe('demo', () => {
  const demo = seedDemo('2026-10-21');
  const last = addDays(WEEK, -7);

  it('passes every penny on at both sites', () => {
    for (const site of ['mar', 'shd']) {
      const run = troncRun(demo, site, last, WEEK);
      expect(run.received).toBeGreaterThan(1000);
      expect(run.allocated + run.unallocated).toBeCloseTo(run.received, 2);
    }
  });

  it('shows Shoreditch what an employer-run allocation and a mandatory charge cost', () => {
    const c = troncCompliance(demo, 'shd', last, WEEK).map((i) => i.code);
    expect(c).toEqual(expect.arrayContaining(['tips-no-policy', 'tronc-not-independent', 'service-charge-vat']));
    expect(troncRun(demo, 'shd', last, WEEK).niDue.employer).toBeGreaterThan(0);
    expect(troncRun(demo, 'mar', last, WEEK).niDue.employer).toBe(0);
  });
});

describe('scheme design', () => {
  it('flags a role with points that the department split leaves out', () => {
    const st = state({
      troncSchemes: [scheme({ departmentShares: { FOH: 0.7, BOH: 0.3 }, pointsPerHour: { server: 10, chef: 5, gm: 4 } })],
      clocks: [clock('a', 'server', 8), clock('m', 'gm', 8)],
      tips: [tip(100)],
    });
    expect(troncCompliance(st, 'mar', WEEK, NEXT).map((i) => i.code)).toContain('tronc-department-gap');
    expect(troncRun(st, 'mar', WEEK, NEXT).shares.map((s) => s.employeeId)).toEqual(['a']);
  });
});
