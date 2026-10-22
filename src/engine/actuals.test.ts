import { describe, expect, it } from 'vitest';
import { actualCompliance, blendedShifts, liveBoard, loadedHourlyRate, weekFlash, weekVariance } from './actuals';
import { checkClockIn, distanceMetres, endClock, startClock } from './clocking';
import { cutCall } from './cutcall';
import { actualsJournal } from './journal';
import { seedDemo } from './simulate';
import { addDays } from './time';
import type { ClockRecord, DemandRule, Employee, HourActual, HourForecast, RotaState, Shift, Site } from './types';

const WEEK = '2026-10-19'; // a Monday
const NEXT = addDays(WEEK, 7);

const site: Site = {
  id: 'mar',
  name: 'Marylebone',
  labourTargetPct: 0.28,
  trackingCode: 'Marylebone',
  openMinute: 11 * 60,
  closeMinute: 23 * 60,
  location: { lat: 51.5203, lng: -0.1515 },
  geofenceMetres: 150,
};

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

const clock = (id: string, s: Shift | null, over: Partial<ClockRecord>): ClockRecord => ({
  id,
  employeeId: s?.employeeId ?? 'a',
  siteId: 'mar',
  roleId: 'server',
  shiftId: s?.id,
  date: s?.date ?? WEEK,
  clockIn: s?.startMinute ?? 0,
  clockOut: s?.endMinute,
  breakMinutes: s?.breakMinutes ?? 0,
  source: 'geofence',
  ...over,
});

const state = (over: Partial<RotaState>): RotaState => ({
  sites: [site],
  roles: [{ id: 'server', name: 'Server', department: 'FOH', nominalCode: '7000' }],
  employees: [person('a'), person('b')],
  shifts: [],
  forecast: [],
  demandRules: [],
  clocks: [],
  actuals: [],
  tips: [],
  troncSchemes: [],
  dishes: [],
  dishSales: [],
  purchases: [],
  stockCounts: [],
  ...over,
});

const H = 60;

describe('clocking', () => {
  const s1 = shift('s1', 'a', WEEK, 17 * H, 23 * H);
  const base = state({ shifts: [s1] });

  it('measures distance on the ground', () => {
    // Marylebone to Shoreditch is roughly five kilometres.
    expect(distanceMetres(site.location!, { lat: 51.5246, lng: -0.0794 })).toBeGreaterThan(4500);
    expect(distanceMetres(site.location!, site.location!)).toBe(0);
  });

  it('refuses a clock-in off site', () => {
    const r = checkClockIn(base, 'a', 'mar', WEEK, 17 * H, { lat: 51.5246, lng: -0.0794 });
    expect(r.ok).toBe(false);
  });

  it('matches the shift inside the early window and refuses earlier', () => {
    const ok = checkClockIn(base, 'a', 'mar', WEEK, 17 * H - 10, site.location);
    expect(ok.ok && ok.shift?.id).toBe('s1');
    const early = checkClockIn(base, 'a', 'mar', WEEK, 17 * H - 25, site.location);
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.reason).toContain('16:50');
  });

  it('allows an unrostered clock-in but flags it for approval', () => {
    const r = checkClockIn(base, 'b', 'mar', WEEK, 18 * H, site.location);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.join(' ')).toContain('Not on the rota');
  });

  it('stops a second clock-in and anyone on leave', () => {
    const open = startClock('a', 'mar', 'server', WEEK, 17 * H, s1, 'geofence');
    expect(checkClockIn({ ...base, clocks: [open] }, 'a', 'mar', WEEK, 18 * H, site.location).ok).toBe(false);
    const away = state({ employees: [person('a', { leave: [WEEK] })], shifts: [s1] });
    expect(checkClockIn(away, 'a', 'mar', WEEK, 17 * H, site.location).ok).toBe(false);
  });

  it('pays exactly what is clocked, across midnight', () => {
    const open = startClock('a', 'mar', 'server', WEEK, 22 * H + 7, undefined, 'manager');
    const closed = endClock(open, 1 * H + 3, 0);
    expect(closed.clockOut).toBe(25 * H + 3);
  });
});

describe('variance', () => {
  const asOf = addDays(WEEK, 1);
  const s1 = shift('s1', 'a', WEEK, 17 * H, 23 * H);
  const s2 = shift('s2', 'b', WEEK, 12 * H, 20 * H, 30);

  it('classifies and costs each difference to the rota', () => {
    const st = state({
      shifts: [s1, s2],
      clocks: [
        clock('c1', s1, { clockIn: 16 * H + 50, clockOut: 23 * H + 40 }),
        clock('c2', s2, { breakMinutes: 0, clockOut: 19 * H }),
      ],
    });
    const v = weekVariance(st, WEEK, asOf);
    const kinds = Object.fromEntries(v.items.map((i) => [`${i.clockId}:${i.kind}`, i.minutes]));
    expect(kinds).toEqual({ 'c1:early-start': 10, 'c1:overrun': 40, 'c2:early-finish': -60, 'c2:short-break': 30 });
    const rate = loadedHourlyRate(person('a'));
    expect(v.byKind.overrun.cost).toBeCloseTo((40 / 60) * rate, 2);
  });

  it('reconciles the causes plus on-cost effect to the cost engine', () => {
    const gh = person('a', { contractedHours: 30 });
    const st = state({
      employees: [gh, person('b')],
      shifts: [s1, s2],
      clocks: [clock('c1', s1, { clockOut: 21 * H }), clock('c2', s2, { clockIn: 11 * H + 45 })],
    });
    const v = weekVariance(st, WEEK, asOf);
    const explained = v.items.reduce((s, i) => s + i.cost, 0);
    expect(explained + v.onCostEffect).toBeCloseTo(v.total, 2);
    // Sending someone on guaranteed hours home early saves nothing: the on-cost effect gives it back.
    expect(v.onCostEffect).toBeGreaterThan(0);
  });

  it('records no-shows and unrostered shifts, and holds extra time for approval', () => {
    const st = state({
      shifts: [s1],
      clocks: [clock('c9', null, { employeeId: 'b', clockIn: 18 * H, clockOut: 22 * H })],
    });
    const v = weekVariance(st, WEEK, asOf);
    expect(v.byKind['no-show'].minutes).toBe(-6 * H);
    expect(v.byKind.unrostered.minutes).toBe(4 * H);
    expect(v.unapprovedCost).toBeGreaterThan(0);
    const approved = { ...st, clocks: st.clocks.map((c) => ({ ...c, approved: true })) };
    expect(weekVariance(approved, WEEK, asOf).unapprovedCost).toBe(0);
  });

  it('ignores days that have not closed', () => {
    const st = state({ shifts: [s1], clocks: [] });
    expect(weekVariance(st, WEEK, WEEK).items).toEqual([]);
  });

  it('blends clocked days with the rota for days still to come', () => {
    const later = shift('s3', 'a', addDays(WEEK, 3), 17 * H, 23 * H);
    const st = state({ shifts: [s1, later], clocks: [clock('c1', s1, { clockOut: 22 * H })] });
    const ids = blendedShifts(st, asOf).map((s) => s.id);
    expect(ids).toEqual(['c1', 's3']);
  });
});

describe('clocked compliance', () => {
  it('catches a break not taken even when the rota was legal', () => {
    const s1 = shift('s1', 'a', WEEK, 12 * H, 20 * H, 30);
    const st = state({ shifts: [s1], clocks: [clock('c1', s1, { breakMinutes: 0 })] });
    const issues = actualCompliance(st, WEEK, addDays(WEEK, 1));
    expect(issues.map((i) => i.code)).toContain('break');
    expect(issues[0].message.startsWith('Clocked:')).toBe(true);
  });
});

describe('cut call', () => {
  const date = WEEK;
  const rule: DemandRule = { siteId: 'mar', roleId: 'server', coversPerHour: 10, minimumWhileOpen: 1, maximum: 6 };
  const forecast: HourForecast[] = Array.from({ length: 12 }, (_, i) => ({ siteId: 'mar', date, hour: 11 + i, sales: 1200, covers: 30 }));
  const traded = (pace: number): HourActual[] =>
    forecast.filter((f) => f.hour < 17).map((f) => ({ ...f, sales: f.sales * pace, covers: f.covers * pace }));
  const team = [person('a'), person('b'), person('c', { hourlyRate: 16 })];
  const shifts = [
    shift('sa', 'a', date, 11 * H, 23 * H, 30),
    shift('sb', 'b', date, 11 * H, 23 * H, 30),
    shift('sc', 'c', date, 11 * H, 23 * H, 30),
  ];
  const base = state({ employees: team, shifts, forecast, demandRules: [rule] });

  it('sends the most expensive surplus person home on a slow day', () => {
    const call = cutCall({ ...base, actuals: traded(0.6) }, 'mar', date, 17 * H + 20);
    expect(call.pace).toBeCloseTo(0.6, 2);
    expect(call.confident).toBe(true);
    // 30 covers at 0.6 pace needs 2 servers, so one of three goes, the dearest first.
    expect(call.recommendations).toHaveLength(1);
    expect(call.recommendations[0]).toMatchObject({ employeeId: 'c', newEnd: 18 * H });
    expect(call.totalSaving).toBeGreaterThan(5 * 16);
  });

  it('keeps everyone and reports the shortfall on a busy day', () => {
    const call = cutCall({ ...base, actuals: traded(1.3) }, 'mar', date, 17 * H);
    expect(call.recommendations).toEqual([]);
    expect(call.short.length).toBeGreaterThan(0);
  });

  it('keeps people on guaranteed hours because sending them home saves nothing', () => {
    const guaranteed = team.map((e) => ({ ...e, contractedHours: 40 }));
    const call = cutCall({ ...base, employees: guaranteed, actuals: traded(0.6) }, 'mar', date, 17 * H);
    expect(call.recommendations).toEqual([]);
    expect(call.keptAtNoCost.length).toBeGreaterThan(0);
  });

  it('makes no call before enough of the day has traded', () => {
    const call = cutCall({ ...base, actuals: traded(0.6) }, 'mar', date, 12 * H);
    expect(call.confident).toBe(false);
    expect(call.recommendations).toEqual([]);
  });
});

describe('demo week', () => {
  const demo = seedDemo('2026-10-21');

  it('trades last week and today up to the demo clock', () => {
    expect(demo.clocks.length).toBeGreaterThan(100);
    expect(demo.clocks.some((c) => c.clockOut === undefined)).toBe(true);
    expect(demo.actuals.some((a) => a.date === '2026-10-21' && a.hour >= 18)).toBe(false);
    const board = liveBoard(demo, 'mar', '2026-10-21', 18 * H);
    expect(board.some((r) => r.status === 'on')).toBe(true);
  });

  it('produces a flash and a balanced clocked accrual', () => {
    const last = addDays(WEEK, -7);
    const flash = weekFlash(demo, 'mar', last, WEEK);
    expect(flash.days.every((d) => d.closed)).toBe(true);
    expect(flash.actualSales).toBeGreaterThan(0);
    expect(flash.variance.total).toBeCloseTo(flash.actualCost - flash.rotaCost, 0);
    const lines = actualsJournal(demo, last, WEEK);
    for (const s of ['Marylebone', 'Shoreditch']) {
      const total = lines.filter((l) => l.trackingOption === s).reduce((sum, l) => sum + l.amount, 0);
      expect(Math.abs(total)).toBeLessThan(0.005);
    }
    expect(lines[0].narration).toContain('clocked');
  });

  it('has nothing to compare for a week not yet traded', () => {
    expect(weekFlash(demo, 'mar', NEXT, '2026-10-21').variance.items).toEqual([]);
  });
});
