import { describe, expect, it } from 'vitest';
import { actualCompliance, weekVariance } from './actuals';
import { cutCall } from './cutcall';
import { complianceExposure } from './exposure';
import { menuEngineering, weekPrime } from './prime';
import { retentionScores } from './retention';
import { seedState } from './seed';
import { isSampleEntry, seedHistory, seedLiveDay } from './seedHistory';
import { addDays, weekStart } from './time';
import { troncCompliance } from './tronc';

const TODAY = '2026-10-22'; // a Thursday
const THIS_WEEK = weekStart(TODAY);
const LAST_WEEK = addDays(THIS_WEEK, -7);
const { state, timeEntries } = seedHistory(seedState(TODAY), TODAY);

describe('demo trading history', () => {
  it('writes only closed days, the same way every time, and marks every clocking as sample', () => {
    expect(state.shifts.every((s) => s.date < TODAY && s.published)).toBe(true);
    expect(timeEntries.every((e) => e.date < TODAY && isSampleEntry(e))).toBe(true);
    expect([...(state.tips ?? []), ...(state.purchases ?? []), ...(state.dishSales ?? []), ...(state.stockCounts ?? [])].every((x) => x.date < TODAY)).toBe(true);
    expect(seedHistory(seedState(TODAY), TODAY)).toEqual({ state, timeEntries });
    // The plain seed is untouched: the rota tests and the assistant still start from an empty rota.
    expect(seedState(TODAY).shifts).toEqual([]);
  });

  it('approves the weeks gone and leaves this week waiting for the manager', () => {
    expect(timeEntries.filter((e) => e.date < THIS_WEEK).every((e) => e.status === 'approved')).toBe(true);
    expect(timeEntries.filter((e) => e.date >= THIS_WEEK).every((e) => e.status === 'submitted')).toBe(true);
    expect(weekVariance(state, timeEntries, THIS_WEEK, TODAY, 'mar').unapprovedCost).toBeGreaterThan(0);
  });

  it('gives clocked against rota overruns, a no-show and someone called in', () => {
    const v = weekVariance(state, timeEntries, LAST_WEEK, TODAY, 'mar');
    expect(v.byKind.overrun.count).toBeGreaterThan(10);
    expect(v.byKind['no-show'].count).toBeGreaterThan(0);
    expect(v.byKind.unrostered.count).toBeGreaterThan(0);
    expect(v.total).toBeGreaterThan(0);
  });

  it('puts the casual sent home on every quiet night at the top of the flight risks', () => {
    const top = retentionScores(state, timeEntries, 'mar', TODAY).scores[0];
    expect(top).toMatchObject({ employeeId: 'mar-8', band: 'high' });
    expect(top.signals.map((s) => s.id)).toEqual(expect.arrayContaining(['sent-home', 'hours-drop', 'volatile-hours']));
  });

  it('prices Marylebone: a deduction under the wage floor, a student over term-time hours, a chef closing and opening', () => {
    const ex = complianceExposure(state, timeEntries, 'mar', LAST_WEEK, TODAY);
    expect(ex.nmw.find((r) => r.employeeId === 'mar-6')?.arrears).toBeGreaterThan(0);
    expect(ex.rightToWork).toEqual([expect.objectContaining({ employeeId: 'mar-17', source: 'clocked', penaltyCeiling: 45_000 })]);
    const breaches = actualCompliance(state, timeEntries, LAST_WEEK, TODAY, 'mar').map((i) => `${i.code}:${i.employeeId}`);
    expect(breaches).toContain('daily-rest:mar-4');
    expect(ex.workingTimeAverages.map((a) => a.employeeId)).toContain('mar-2');
    // In the summer vacation the same hours were allowed.
    expect(complianceExposure(state, timeEntries, 'mar', addDays(THIS_WEEK, -7 * 10), TODAY).rightToWork).toEqual([]);
  });

  it('runs one tronc properly, one through the business on a mandatory charge, and one with no policy', () => {
    const codes = (site: string) => troncCompliance(state, timeEntries, site, THIS_WEEK, TODAY).map((i) => i.code);
    expect(codes('mar')).toEqual([]);
    expect(codes('shd')).toEqual(expect.arrayContaining(['tronc-not-independent', 'service-charge-vat', 'tips-overdue']));
    expect(codes('fitz')).toEqual(expect.arrayContaining(['tips-no-policy', 'tronc-department-gap']));
  });

  it.each(['2026-10-01', '2026-11-30', '2026-12-31', '2027-03-01', '2027-03-15'])('always has Shoreditch tips overdue, whatever the day (%s)', (today) => {
    const h = seedHistory(seedState(today), today);
    const ex = complianceExposure(h.state, h.timeEntries, 'shd', weekStart(today), today);
    expect(ex.tronc.overdue).toBeGreaterThan(0);
    expect(ex.tronc.overdueWorkers).toBeGreaterThan(0);
  });

  it('shows Fitzrovia’s bar losing stock and a menu with all four classes', () => {
    const drink = weekPrime(state, timeEntries, 'fitz', LAST_WEEK, TODAY).drink;
    expect(drink.actualCost).not.toBeNull();
    expect(drink.actualCost!).toBeGreaterThan(drink.theoreticalCost * 1.1);
    const classes = new Set(menuEngineering(state, 'mar', LAST_WEEK, TODAY).map((m) => m.menuClass));
    expect([...classes].sort()).toEqual(['Dog', 'Plowhorse', 'Puzzle', 'Star']);
  });

  it('trades Marylebone slowly on the live day, so the cut call has someone to send home', () => {
    const now = 17 * 60 + 20;
    const live = seedLiveDay(state, TODAY, now);
    expect(live.shifts.some((s) => s.date === TODAY)).toBe(true);
    const day = live.sales?.find((s) => s.siteId === 'mar' && s.date === TODAY);
    expect(day?.hours?.every((h) => (h.hour + 1) * 60 <= now)).toBe(true);
    const call = cutCall(live, timeEntries, 'mar', TODAY, now);
    expect(call.confident).toBe(true);
    expect(call.pace).toBeLessThan(0.8);
    expect(call.recommendations.length).toBeGreaterThan(0);
  });
});
