import { describe, expect, it } from 'vitest';
import { accuracyReport, ACCURACY_THRESHOLD } from './forecastreport';
import { seedState } from './seed';
import { addDays } from './time';
import type { DaySales, HourActual, HourForecast, RotaState } from './types';

// Weeks commencing 2026-09-28, 10-05, 10-12; today is Wednesday 2026-10-21, in the week after.
const TODAY = '2026-10-21';
const END = '2026-10-12';
const fc = (siteId: string, date: string, sales: number, source?: 'profile'): HourForecast[] => [
  { siteId, date, hour: 12, sales: sales / 2, covers: 0, ...(source ? { source } : {}) },
  { siteId, date, hour: 19, sales: sales / 2, covers: 0, ...(source ? { source } : {}) },
];
const took = (siteId: string, date: string, netSales: number): DaySales => ({ siteId, date, netSales, source: 'till' });
const state = (forecast: HourForecast[], sales: DaySales[]): RotaState => ({ ...seedState(TODAY), forecast, sales, actuals: [] });
const target = (s: RotaState, id: string) => s.sites.find((x) => x.id === id)!.labourTargetPct;

describe('the forecast accuracy report', () => {
  it('measures each day against its takings, and turns the error into labour at the site target', () => {
    // Monday forecast 1000, took 800; Tuesday forecast 1000, took 1100.
    const s = state([...fc('mar', END, 1000), ...fc('mar', addDays(END, 1), 1000)], [took('mar', END, 800), took('mar', addDays(END, 1), 1100)]);
    const r = accuracyReport(s, [], ['mar'], END, 1, TODAY);
    const w = r.weeks[0].sites[0];
    expect(w).toMatchObject({ measuredDays: 2, forecast: 2000, actual: 1900, over: 200, under: 100, hourWape: null });
    // Day error is |200| + |100| over 1900, not the week's net 100.
    expect(w.dayWape).toBeCloseTo(300 / 1900);
    expect(w.bias).toBeCloseTo(100 / 1900);
    expect(w.labourOver).toBeCloseTo(200 * target(s, 'mar'));
    expect(w.labourUnder).toBeCloseTo(100 * target(s, 'mar'));
  });

  it('leaves out a day nobody forecast, a day with no takings, and today', () => {
    const s = state(
      [...fc('mar', addDays(END, 1), 1000), ...fc('mar', addDays(END, 2), 1000), ...fc('mar', TODAY, 1000)],
      [took('mar', END, 900), took('mar', addDays(END, 1), 1000), took('mar', TODAY, 400)],
    );
    const r = accuracyReport(s, [], ['mar'], '2026-10-19', 2, TODAY);
    expect(r.total).toMatchObject({ measuredDays: 1, forecast: 1000, actual: 1000, dayWape: 0 });
    expect(r.weeks[1].total.measuredDays).toBe(0);
    expect(r.weeks[1].total.dayWape).toBeNull();
  });

  it('falls back on the till’s hours where no daily takings were keyed, and gives the hourly error', () => {
    // The day totals agree, so the day error is nought; the hours do not, which is what staffing feels.
    const actuals: HourActual[] = [
      { siteId: 'mar', date: END, hour: 12, sales: 300, covers: 0 },
      { siteId: 'mar', date: END, hour: 19, sales: 700, covers: 0 },
    ];
    const r = accuracyReport(state(fc('mar', END, 1000), []), actuals, ['mar'], END, 1, TODAY);
    const w = r.weeks[0].sites[0];
    expect(w).toMatchObject({ measuredDays: 1, actual: 1000, dayWape: 0 });
    expect(w.hourWape).toBeCloseTo(400 / 1000);
  });

  it('adds sites and weeks up from the days, not by averaging percentages', () => {
    // A small site badly wrong and a big site nearly right: the estate is nearer the big site.
    const s = state([...fc('mar', END, 1000), ...fc('shd', END, 10000)], [took('mar', END, 500), took('shd', END, 10100)]);
    const r = accuracyReport(s, [], ['mar', 'shd'], END, 1, TODAY);
    expect(r.total.dayWape).toBeCloseTo(600 / 10600);
    expect(r.weeks[0].sites.map((x) => x.siteId)).toEqual(['mar', 'shd']);
  });

  it('names a day of the week that is wrong the same way week after week, and counts typical-week days', () => {
    const forecast: HourForecast[] = [];
    const sales: DaySales[] = [];
    for (let w = 0; w < 3; w++) {
      const sat = addDays(END, 5 - 7 * w);
      const mon = addDays(END, -7 * w);
      forecast.push(...fc('mar', sat, 5000), ...fc('mar', mon, 1000, 'profile'));
      sales.push(took('mar', sat, 4400), took('mar', mon, 1000));
    }
    const site = accuracyReport(state(forecast, sales), [], ['mar'], END, 3, TODAY).sites[0];
    expect(site.patterns).toEqual(['Saturdays are forecast 14% too high across 3 weeks.']);
    expect(site.weekdays.find((d) => d.label === 'Monday')).toMatchObject({ measuredDays: 3, bias: 0 });
    expect(site.total.typicalDays).toBe(3);
  });

  it('calls no pattern on two weeks, however wrong', () => {
    const sats = [5, -2].map((d) => addDays(END, d));
    const s = state(sats.flatMap((d) => fc('mar', d, 5000)), sats.map((d) => took('mar', d, 3000)));
    expect(accuracyReport(s, [], ['mar'], END, 2, TODAY).sites[0].patterns).toEqual([]);
  });

  it('holds sites to the scorecard’s own line', () => {
    expect(accuracyReport(state([], []), [], ['mar'], END, 1, TODAY).threshold).toBe(ACCURACY_THRESHOLD);
    expect(ACCURACY_THRESHOLD).toBe(0.12);
  });
});
