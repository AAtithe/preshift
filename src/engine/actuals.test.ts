import { describe, expect, it } from 'vitest';
import { actualCompliance, blendedShifts, entriesNeedingApproval, knownAge, loadedHourlyRate, weekFlash, weekVariance } from './actuals';
import { cutCall } from './cutcall';
import { addDays } from './time';
import type { DaySales, DemandRule, Employee, HourForecast, RotaState, Shift, Site, TimeEntry } from './types';

const WEEK = '2026-10-19'; // a Monday
const H = 60;

const site: Site = { id: 'mar', name: 'Marylebone', entityId: 'co', labourTargetPct: 0.28, trackingCode: 'Marylebone', openMinute: 11 * H, closeMinute: 23 * H };

const person = (id: string, over: Partial<Employee> = {}): Employee => ({
  id,
  name: id,
  siteId: 'mar',
  entityId: 'co',
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

const shift = (id: string, employeeId: string, date: string, start: number, end: number, brk = 0): Shift => ({
  id,
  employeeId,
  roleId: 'server',
  siteId: 'mar',
  date,
  startMinute: start,
  endMinute: end,
  breakMinutes: brk,
});

/** A clocking as main records it. Submitted unless said otherwise. */
const entry = (id: string, s: Shift | null, over: Partial<TimeEntry> = {}): TimeEntry => ({
  id,
  employeeId: s?.employeeId ?? 'a',
  siteId: 'mar',
  roleId: 'server',
  shiftId: s?.id,
  date: s?.date ?? WEEK,
  clockIn: s?.startMinute ?? 0,
  clockOut: s?.endMinute,
  breakMinutes: s?.breakMinutes ?? 0,
  status: 'submitted',
  source: 'clock',
  ...over,
});

const state = (over: Partial<RotaState>): RotaState => ({
  entities: [{ id: 'co', name: 'Co Ltd', companyNumber: '1', payeReference: '1/A', intercompanyCode: '1990' }],
  sites: [site],
  roles: [{ id: 'server', name: 'Server', department: 'FOH', nominalCode: '7000' }],
  employees: [person('a'), person('b')],
  shifts: [],
  forecast: [],
  demandRules: [],
  ...over,
});

describe('variance', () => {
  const asOf = addDays(WEEK, 1);
  const s1 = shift('s1', 'a', WEEK, 17 * H, 23 * H);
  const s2 = shift('s2', 'b', WEEK, 12 * H, 20 * H, 30);

  it('classifies and costs each difference to the rota', () => {
    const entries = [entry('c1', s1, { clockIn: 16 * H + 50, clockOut: 23 * H + 40 }), entry('c2', s2, { breakMinutes: 0, clockOut: 19 * H })];
    const v = weekVariance(state({ shifts: [s1, s2] }), entries, WEEK, asOf);
    const kinds = Object.fromEntries(v.items.map((i) => [`${i.entryId}:${i.kind}`, i.minutes]));
    expect(kinds).toEqual({ 'c1:early-start': 10, 'c1:overrun': 40, 'c2:early-finish': -60, 'c2:short-break': 30 });
    expect(v.byKind.overrun.cost).toBeCloseTo((40 / 60) * loadedHourlyRate(person('a')), 2);
  });

  it('reconciles the causes plus on-cost effect to the cost engine', () => {
    const st = state({ employees: [person('a', { contractedHours: 30 }), person('b')], shifts: [s1, s2] });
    const v = weekVariance(st, [entry('c1', s1, { clockOut: 21 * H }), entry('c2', s2, { clockIn: 11 * H + 45 })], WEEK, asOf);
    const explained = v.items.reduce((s, i) => s + i.cost, 0);
    expect(explained + v.onCostEffect).toBeCloseTo(v.total, 2);
    // Sending someone on guaranteed hours home early saves nothing: the on-cost effect gives it back.
    expect(v.onCostEffect).toBeGreaterThan(0);
  });

  it('records no-shows and unrostered shifts, and holds extra time until it is approved', () => {
    const entries = [entry('c9', null, { employeeId: 'b', clockIn: 18 * H, clockOut: 22 * H })];
    const v = weekVariance(state({ shifts: [s1] }), entries, WEEK, asOf);
    expect(v.byKind['no-show'].minutes).toBe(-6 * H);
    expect(v.byKind.unrostered.minutes).toBe(4 * H);
    expect(entriesNeedingApproval(v)).toEqual(['c9']);
    const approved = entries.map((e) => ({ ...e, status: 'approved' as const }));
    expect(weekVariance(state({ shifts: [s1] }), approved, WEEK, asOf).unapprovedCost).toBe(0);
  });

  it('ignores rejected entries and days that have not closed', () => {
    const rejected = [entry('c1', s1, { clockOut: 23 * H + 59, status: 'rejected' })];
    expect(weekVariance(state({ shifts: [s1] }), rejected, WEEK, asOf).byKind['no-show'].count).toBe(1);
    expect(weekVariance(state({ shifts: [s1] }), [], WEEK, WEEK).items).toEqual([]);
  });

  it('blends clocked days with the rota for days still to come', () => {
    const later = shift('s3', 'a', addDays(WEEK, 3), 17 * H, 23 * H);
    const ids = blendedShifts(state({ shifts: [s1, later] }), [entry('c1', s1, { clockOut: 22 * H })], asOf).map((s) => s.id);
    expect(ids).toEqual(['te:c1', 's3']);
  });
});

describe('labour flash', () => {
  it('reads actual takings from the day’s recorded sales', () => {
    const s1 = shift('s1', 'a', WEEK, 12 * H, 20 * H, 30);
    const sales: DaySales[] = [{ siteId: 'mar', date: WEEK, netSales: 1000, source: 'till' }];
    const flash = weekFlash(state({ shifts: [s1], sales }), [entry('c1', s1)], 'mar', WEEK, addDays(WEEK, 1));
    expect(flash.actualSales).toBe(1000);
    expect(flash.actualPct).toBeCloseTo(flash.actualCost / 1000, 5);
  });
});

describe('clocked compliance', () => {
  it('catches a break not taken even when the rota was legal', () => {
    const s1 = shift('s1', 'a', WEEK, 12 * H, 20 * H, 30);
    const issues = actualCompliance(state({ shifts: [s1] }), [entry('c1', s1, { breakMinutes: 0 })], WEEK, addDays(WEEK, 1));
    expect(issues.map((i) => i.code)).toContain('break');
    expect(issues[0].message.startsWith('Clocked:')).toBe(true);
  });

  it('never invents an age the reader may not see', () => {
    expect(knownAge({ dateOfBirth: '', under18: false }, WEEK)).toBeNull();
    expect(knownAge({ dateOfBirth: '', under18: true }, WEEK)).toBe(17);
    expect(knownAge({ dateOfBirth: '2000-10-19' }, WEEK)).toBe(26);
  });
});

describe('cut call', () => {
  const date = WEEK;
  const rule: DemandRule = { siteId: 'mar', roleId: 'server', coversPerHour: 10, minimumWhileOpen: 1, maximum: 6 };
  const forecast: HourForecast[] = Array.from({ length: 12 }, (_, i) => ({ siteId: 'mar', date, hour: 11 + i, sales: 1200, covers: 30 }));
  const till = (pace: number): DaySales[] => [
    {
      siteId: 'mar',
      date,
      netSales: 0,
      source: 'till',
      hours: forecast.filter((f) => f.hour < 17).map((f) => ({ hour: f.hour, netSales: f.sales * pace, orders: 0 })),
    },
  ];
  const team = [person('a'), person('b'), person('c', { hourlyRate: 16 })];
  const shifts = team.map((e) => shift(`s${e.id}`, e.id, date, 11 * H, 23 * H, 30));
  const base = state({ employees: team, shifts, forecast, demandRules: [rule] });

  it('sends the most expensive surplus person home on a slow day', () => {
    const call = cutCall({ ...base, sales: till(0.6) }, [], 'mar', date, 17 * H + 20);
    expect(call.pace).toBeCloseTo(0.6, 2);
    expect(call.confident).toBe(true);
    // 30 covers at 0.6 pace needs 2 servers, so one of three goes, the dearest first.
    expect(call.recommendations).toHaveLength(1);
    expect(call.recommendations[0]).toMatchObject({ employeeId: 'c', newEnd: 18 * H });
  });

  it('keeps everyone and reports the shortfall on a busy day', () => {
    const call = cutCall({ ...base, sales: till(1.3) }, [], 'mar', date, 17 * H);
    expect(call.recommendations).toEqual([]);
    expect(call.short.length).toBeGreaterThan(0);
  });

  it('keeps people on guaranteed hours because sending them home saves nothing', () => {
    const guaranteed = team.map((e) => ({ ...e, contractedHours: 40 }));
    const call = cutCall({ ...base, employees: guaranteed, sales: till(0.6) }, [], 'mar', date, 17 * H);
    expect(call.recommendations).toEqual([]);
    expect(call.keptAtNoCost.length).toBeGreaterThan(0);
  });

  it('makes no call without hourly till figures, rather than reading them as a dead day', () => {
    const manual: DaySales[] = [{ siteId: 'mar', date, netSales: 4000, source: 'manual' }];
    const call = cutCall({ ...base, sales: manual }, [], 'mar', date, 17 * H);
    expect(call.confident).toBe(false);
    expect(call.pace).toBe(1);
    expect(call.recommendations).toEqual([]);
    expect(call.reason).toMatch(/No hourly takings/);
  });

  it('makes no call before enough of the day has traded', () => {
    const call = cutCall({ ...base, sales: till(0.6) }, [], 'mar', date, 12 * H);
    expect(call.confident).toBe(false);
    expect(call.recommendations).toEqual([]);
  });
});
