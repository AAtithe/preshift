import { describe, expect, it } from 'vitest';
import { loadedHourlyRate } from './actuals';
import { cutCall } from './cutcall';
import { DEFAULT_ERA_SETTINGS } from './employmentRights';
import { intradayFlash } from './labourFlash';
import type { DaySales, DemandRule, Employee, HourForecast, RotaState, Shift, Site, TimeEntry } from './types';

const DATE = '2026-10-19'; // a Monday, British Summer Time
const H = 60;
const site: Site = { id: 'mar', name: 'Marylebone', entityId: 'co', labourTargetPct: 0.28, trackingCode: 'Marylebone', openMinute: 11 * H, closeMinute: 23 * H };

const person = (id: string, over: Partial<Employee> = {}): Employee => ({
  id, name: id, siteId: 'mar', entityId: 'co', coverSiteIds: [], roleIds: ['server'], payBasis: 'hourly', hourlyRate: 13, annualSalary: 0,
  dateOfBirth: '1995-01-01', contractedHours: 0, maxWeeklyHours: 48, optedOutOf48: false, irregularHours: true, pensionEnrolled: true,
  availability: [], leave: [], ...over,
});
const shift = (id: string, employeeId: string, start: number, end: number, brk = 0): Shift => ({
  id, employeeId, roleId: 'server', siteId: 'mar', date: DATE, startMinute: start, endMinute: end, breakMinutes: brk, published: true,
});
const clockedIn = (s: Shift): TimeEntry => ({
  id: `te-${s.id}`, employeeId: s.employeeId, siteId: 'mar', roleId: 'server', shiftId: s.id, date: DATE, clockIn: s.startMinute, breakMinutes: 0, status: 'open', source: 'clock',
});

const rule: DemandRule = { siteId: 'mar', roleId: 'server', coversPerHour: 10, minimumWhileOpen: 1, maximum: 6 };
const forecast: HourForecast[] = Array.from({ length: 12 }, (_, i) => ({ siteId: 'mar', date: DATE, hour: 11 + i, sales: 1200, covers: 30 }));
const till = (pace: number): DaySales[] => [
  { siteId: 'mar', date: DATE, netSales: 0, source: 'till', hours: forecast.filter((f) => f.hour < 17).map((f) => ({ hour: f.hour, netSales: f.sales * pace, orders: 0 })) },
];
const team = [person('a'), person('b'), person('c', { hourlyRate: 16 })];
const shifts = team.map((e) => shift(`s${e.id}`, e.id, 11 * H, 23 * H, 30));
const state = (over: Partial<RotaState> = {}) =>
  ({ sites: [site], roles: [], employees: team, shifts, forecast, demandRules: [rule], entities: [], sales: till(0.6), ...over }) as unknown as RotaState;
const NOW = 17 * H;

describe('intraday labour flash', () => {
  it('prices labour so far from the clock and the rest of the day from the rota', () => {
    const entries = shifts.map(clockedIn);
    const call = cutCall(state(), entries, 'mar', DATE, NOW);
    const flash = intradayFlash(state(), entries, 'mar', DATE, NOW, call);
    const loaded = team.reduce((s, e) => s + loadedHourlyRate(e), 0);
    expect(flash.onShift).toBe(3);
    expect(flash.labourSoFar).toBeCloseTo(6 * loaded, 1);
    expect(flash.salesSoFar).toBe(1200 * 6 * 0.6);
    expect(flash.labourPctNow).toBeCloseTo(flash.labourSoFar / flash.salesSoFar, 6);
    // The rest of each 11.5 paid hour shift: half of it is still to come at 17:00.
    expect(flash.labourDay).toBeCloseTo(6 * loaded + 5.75 * loaded, 1);
    expect(flash.labourPctDay).toBeCloseTo(flash.labourDay / flash.reforecastDay, 6);
    expect(flash.labourPctAfterCuts!).toBeLessThan(flash.labourPctDay!);
    expect(flash.headroom).toBeCloseTo(flash.reforecastDay * flash.targetPct - flash.labourDay, 1);
  });

  it('does not count a shift nobody turned up for', () => {
    const entries = shifts.slice(0, 2).map(clockedIn);
    const call = cutCall(state(), entries, 'mar', DATE, NOW);
    const flash = intradayFlash(state(), entries, 'mar', DATE, NOW, call);
    expect(flash.onShift).toBe(2);
    const twoLoaded = loadedHourlyRate(team[0]) + loadedHourlyRate(team[1]);
    expect(flash.labourDay).toBeCloseTo(6 * twoLoaded + 5.75 * twoLoaded, 1);
  });
});

describe('cut call priced on the Employment Rights Act settings', () => {
  const at = new Date('2026-10-19T16:20:00Z'); // 17:20 in London
  it('deducts short notice pay once the measure has started, and shows it before then', () => {
    const plain = cutCall(state(), [], 'mar', DATE, 17 * H + 20);
    const before = cutCall(state(), [], 'mar', DATE, 17 * H + 20, { rights: { settings: DEFAULT_ERA_SETTINGS, at } });
    expect(before.recommendations[0].saving).toBe(plain.recommendations[0].saving);
    expect(before.recommendations[0].wouldOwe).toBe(5 * 16); // five hours lost at £16
    const started = cutCall(state(), [], 'mar', DATE, 17 * H + 20, { rights: { settings: { ...DEFAULT_ERA_SETTINGS, shortNoticeFrom: '2026-10-01' }, at } });
    // A full share of pay owed on every hour cut: the early finish now saves nothing, so nobody goes.
    expect(started.recommendations).toEqual([]);
    expect(started.keptAtNoCost).toContain('c');
  });

  it('owes nothing for people on enough hours, or shifts never published', () => {
    const contracted = team.map((e) => ({ ...e, contractedHours: 20 }));
    const call = cutCall(state({ employees: contracted }), [], 'mar', DATE, 17 * H + 20, { rights: { settings: { ...DEFAULT_ERA_SETTINGS, shortNoticeFrom: '2026-10-01' }, at } });
    expect(call.recommendations.every((r) => r.compensation === 0 && !r.wouldOwe)).toBe(true);
    const unpublished = shifts.map((s) => ({ ...s, published: false }));
    const quiet = cutCall(state({ shifts: unpublished }), [], 'mar', DATE, 17 * H + 20, { rights: { settings: { ...DEFAULT_ERA_SETTINGS, shortNoticeFrom: '2026-10-01' }, at } });
    expect(quiet.recommendations[0].compensation).toBe(0);
  });
});
