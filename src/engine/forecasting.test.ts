import { describe, expect, it } from 'vitest';
import { coversSource, DEFAULT_SPEND_PER_COVER, forecastFromTakings } from './forecasting';
import { seedState } from './seed';
import { addDays } from './time';
import type { DaySales, RotaState } from './types';

// Marylebone opens 11:00 to 23:00. Mondays below; 2026-10-19 is a Monday.
const MONDAY = '2026-10-26';
const state = (sales: DaySales[], forecast: RotaState['forecast'] = []): RotaState => ({ ...seedState('2026-10-21'), forecast, sales });
const day = (date: string, netSales: number, covers?: number): DaySales => ({ siteId: 'mar', date, netSales, covers, source: 'till' });
const mondaysBefore = (values: number[]) => values.map((v, i) => day(addDays(MONDAY, -7 * (i + 1)), v));

describe('a forecast from past takings', () => {
  it('averages the recent same weekdays, the latest counting most, and drops the highest and lowest', () => {
    // Latest first: 3000, then 2800, 2600, 9000 (a private hire), 2400, 200 (a burst pipe).
    const s = state(mondaysBefore([3000, 2800, 2600, 9000, 2400, 200]));
    const { days, rows } = forecastFromTakings(s, 'mar', [MONDAY]);
    const d = days[0];
    expect(d.basis).toBe('recent');
    // Kept: 3000 (weight 6), 2800 (5), 2600 (4), 2400 (2).
    expect(d.sales).toBe(Math.round((3000 * 6 + 2800 * 5 + 2600 * 4 + 2400 * 2) / 17));
    expect(d.from).not.toContain(addDays(MONDAY, -28));
    expect(d.from).not.toContain(addDays(MONDAY, -42));
    expect(d.note).toMatch(/last 4 Mondays/);
    // The hours add back to the day exactly, all within opening hours.
    expect(rows.reduce((a, r) => a + r.sales, 0)).toBe(d.sales);
    expect(rows.every((r) => r.hour >= 11 && r.hour < 23)).toBe(true);
  });

  it('uses the same day last year, scaled by how the last four weeks compare with a year earlier', () => {
    const sales: DaySales[] = [];
    // A year and a bit of trading, 10% up on the year before.
    for (let back = 1; back <= 400; back++) {
      const date = addDays(MONDAY, -back);
      const thisYear = back < 364;
      sales.push(day(date, thisYear ? 3300 : 3000));
    }
    const { days } = forecastFromTakings(state(sales), 'mar', [MONDAY]);
    expect(days[0].basis).toBe('last_year');
    expect(days[0].from).toEqual([addDays(MONDAY, -364)]);
    expect(days[0].trend).toBe(1.1);
    expect(days[0].sales).toBe(3300);
    expect(days[0].note).toMatch(/up 10%/);
  });

  it('says so, and makes no hours, for a day of the week with no takings', () => {
    const { days, rows } = forecastFromTakings(state([day(addDays(MONDAY, -6), 2000)]), 'mar', [MONDAY]);
    expect(days[0]).toMatchObject({ basis: 'none', sales: 0 });
    expect(rows).toEqual([]);
  });

  it('leaves out days with no takings, as closed, rather than averaging in a nought', () => {
    const s = state([...mondaysBefore([3000, 3000]), day(addDays(MONDAY, -21), 0)]);
    expect(forecastFromTakings(s, 'mar', [MONDAY]).days[0]).toMatchObject({ sales: 3000, from: [addDays(MONDAY, -7), addDays(MONDAY, -14)] });
  });

  it("turns sales into covers at the site's own spend per head", () => {
    const own = forecastFromTakings(state([day(addDays(MONDAY, -7), 3000, 100)]), 'mar', [MONDAY]).days[0];
    expect(own.covers).toBe(100);
    expect(own.note).toBe(`The last Monday with takings (${addDays(MONDAY, -7)}): one week only, so check it.`);
    const none = forecastFromTakings(state([day(addDays(MONDAY, -7), 3000)]), 'mar', [MONDAY]).days[0];
    expect(none.covers).toBe(Math.round(3000 / DEFAULT_SPEND_PER_COVER));
  });

  it("splits the day the way the site's own past Mondays went, where it has some", () => {
    const shape = [{ siteId: 'mar', date: addDays(MONDAY, -7), hour: 12, sales: 100, covers: 2 }, { siteId: 'mar', date: addDays(MONDAY, -7), hour: 19, sales: 300, covers: 6 }];
    const { days, rows } = forecastFromTakings(state(mondaysBefore([2000]), shape), 'mar', [MONDAY]);
    expect(days[0].shape).toBe('site');
    expect(rows.map((r) => [r.hour, r.sales])).toEqual([[12, 500], [19, 1500]]);
  });
});

describe('hourly shape from the till', () => {
  it("follows the till's own hours for that weekday, not the standard curve", () => {
    // Four Mondays of a lunch-only trade: everything between 12:00 and 14:00.
    const mondays = ['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19'].map((date): DaySales => ({
      siteId: 'mar', date, netSales: 1000, source: 'till', orders: 30,
      hours: [{ hour: 12, netSales: 600, orders: 18 }, { hour: 13, netSales: 400, orders: 12 }, { hour: 25, netSales: 50, orders: 1 }],
    }));
    const { days, rows } = forecastFromTakings(state(mondays), 'mar', ['2026-10-26']);
    expect(days[0].shape).toBe('till');
    const hours = rows.filter((r) => r.date === '2026-10-26');
    expect(hours.map((r) => r.hour)).toEqual([12, 13]);
    expect(hours.reduce((s, r) => s + r.sales, 0)).toBe(days[0].sales);
    expect(hours[0].sales / days[0].sales).toBeCloseTo(0.6, 2);
  });

  it('keeps the standard curve where the till reports no hours', () => {
    const days = forecastFromTakings(state([day('2026-10-19', 1000), day('2026-10-12', 1000)]), 'mar', ['2026-10-26']).days;
    expect(days[0].shape).not.toBe('till');
  });
});

describe('covers source', () => {
  it("uses the site's own spend per head from set-up before the standard figure", () => {
    const s = state([day('2026-10-19', 1000)]);
    s.sites = s.sites.map((x) => (x.id === 'mar' ? { ...x, salesProfile: { dailySales: [0, 0, 0, 0, 0, 0, 0], averageSpend: 25 } } : x));
    expect(coversSource(s, 'mar', '2026-10-21')).toMatchObject({ kind: 'estimated', spendPerCover: 25, spendFrom: 'setup' });
    expect(forecastFromTakings(s, 'mar', ['2026-10-26']).days[0].covers).toBe(40);
    const recorded = state([day('2026-10-19', 1000, 50)]);
    expect(coversSource(recorded, 'mar', '2026-10-21')).toMatchObject({ kind: 'recorded', spendPerCover: 20, spendFrom: 'takings' });
  });
});
