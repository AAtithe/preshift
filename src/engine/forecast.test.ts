import { describe, expect, it } from 'vitest';
import { dayDemand } from './demand';
import { seedState } from './seed';
import { baselineForecast, daypartOf, forecastAccuracy, mergeModelForecast, overrideForecast } from './forecast';
import { addDays, weekDates, weekday } from './time';
import type { HourActual, HourForecast } from './types';

const WEEK = '2026-10-19'; // a Monday

/** Weeks of history before WEEK: every weekday trades `base * (weekday + 1)` at noon and 19:00. */
function history(weeks: number, base = 100, growth = 1): HourActual[] {
  const rows: HourActual[] = [];
  for (let w = weeks; w >= 1; w--) {
    const scale = growth ** (weeks - w);
    for (const date of weekDates(addDays(WEEK, -7 * w))) {
      for (const hour of [12, 19]) {
        const sales = Math.round(base * (weekday(date) + 1) * scale);
        rows.push({ siteId: 'mar', date, hour, sales, covers: Math.round(sales / 40) });
      }
    }
  }
  return rows;
}

describe('baseline forecast', () => {
  it('reproduces a steady pattern by weekday and hour', () => {
    const result = baselineForecast(history(8), 'mar', weekDates(WEEK), { bankHolidays: [] });
    expect(result.trend).toBe(1);
    const tue = result.rows.filter((r) => r.date === addDays(WEEK, 1));
    expect(tue.map((r) => [r.hour, r.sales])).toEqual([[12, 200], [19, 200]]);
    expect(tue[0].modelSales).toBe(200);
    expect(result.skipped).toEqual([]);
  });

  it('ignores history from other sites and from the dates being forecast', () => {
    const rows = [...history(4), { siteId: 'shd', date: addDays(WEEK, -7), hour: 12, sales: 99_999, covers: 1 }, { siteId: 'mar', date: WEEK, hour: 12, sales: 99_999, covers: 1 }];
    const result = baselineForecast(rows, 'mar', weekDates(WEEK), { bankHolidays: [] });
    expect(result.rows.find((r) => r.date === WEEK && r.hour === 12)?.sales).toBe(100);
  });

  it('carries a damped, capped trend', () => {
    const result = baselineForecast(history(8, 100, 1.05), 'mar', weekDates(WEEK), { bankHolidays: [] });
    expect(result.trend).toBeGreaterThan(1);
    expect(result.trend).toBeLessThanOrEqual(1.1);
  });

  it('trades a bank holiday like a Sunday when there is no bank holiday history', () => {
    const result = baselineForecast(history(8), 'mar', weekDates(WEEK), { bankHolidays: [WEEK] });
    expect(result.bankHolidayFactor).toBeNull();
    // Sunday trades 700 an hour in this history.
    expect(result.rows.find((r) => r.date === WEEK && r.hour === 12)?.sales).toBe(700);
  });

  it('learns a bank holiday uplift from past bank holidays and leaves them out of normal training', () => {
    const rows = history(8);
    const pastHoliday = addDays(WEEK, -14); // a Monday
    for (const r of rows) if (r.date === pastHoliday) r.sales *= 2;
    const result = baselineForecast(rows, 'mar', weekDates(WEEK), { bankHolidays: [pastHoliday, WEEK] });
    expect(result.bankHolidayFactor).toBeCloseTo(2, 5);
    expect(result.rows.find((r) => r.date === WEEK && r.hour === 12)?.sales).toBe(200);
    // An ordinary Monday the week after is not dragged up by the holiday.
    const next = baselineForecast(rows, 'mar', weekDates(addDays(WEEK, 7)), { bankHolidays: [pastHoliday] });
    expect(next.rows.find((r) => r.date === addDays(WEEK, 7) && r.hour === 12)?.sales).toBe(100);
  });

  it('applies weather, event and closure adjustments to the hours they cover', () => {
    const adjustments = [
      { id: 'a1', siteId: 'mar', date: addDays(WEEK, 2), factor: 1.2, reason: 'event' as const, fromHour: 17 },
      { id: 'a2', siteId: 'mar', date: addDays(WEEK, 3), factor: 0, reason: 'closure' as const },
    ];
    const result = baselineForecast(history(8), 'mar', weekDates(WEEK), { bankHolidays: [], adjustments });
    const wed = result.rows.filter((r) => r.date === addDays(WEEK, 2));
    expect(wed.map((r) => r.sales)).toEqual([300, 360]);
    // A closed day is forecast at zero rather than skipped, so a merge clears the old figures.
    const thu = result.rows.filter((r) => r.date === addDays(WEEK, 3));
    expect(thu.length).toBe(2);
    expect(thu.every((r) => r.sales === 0 && r.covers === 0)).toBe(true);
    expect(result.skipped).toEqual([]);
    const old: HourForecast = { siteId: 'mar', date: addDays(WEEK, 3), hour: 12, sales: 400, covers: 10 };
    const merged = mergeModelForecast([old], result.rows);
    expect(merged.filter((r) => r.date === addDays(WEEK, 3)).every((r) => r.sales === 0)).toBe(true);
  });

  it('closes the floor as well as the forecast, so a closed day is not staffed', () => {
    const state = seedState('2026-10-21');
    const closed = { ...state, forecastAdjustments: [{ id: 'c', siteId: 'mar', date: WEEK, factor: 0, reason: 'closure' as const }] };
    expect(dayDemand(state, 'mar', 'server', WEEK).some((h) => h.required > 0)).toBe(true);
    expect(dayDemand(closed, 'mar', 'server', WEEK).every((h) => h.required === 0)).toBe(true);
  });

  it('finds full history for dates several weeks ahead', () => {
    const later = addDays(WEEK, 21);
    const result = baselineForecast(history(8), 'mar', [WEEK, later], { bankHolidays: [] });
    expect(result.rows.find((r) => r.date === later && r.hour === 12)?.sales).toBe(100);
  });

  it('skips days with no history rather than inventing them', () => {
    const result = baselineForecast([], 'mar', weekDates(WEEK));
    expect(result.rows).toEqual([]);
    expect(result.skipped).toHaveLength(7);
  });
});

describe('overrides', () => {
  const row: HourForecast = { siteId: 'mar', date: WEEK, hour: 12, sales: 100, covers: 3, modelSales: 100, modelCovers: 3 };

  it('treats the figure already there as the model when overriding a row with no model', () => {
    const plain: HourForecast = { siteId: 'mar', date: WEEK, hour: 12, sales: 80, covers: 2 };
    expect(overrideForecast(plain, 120, 3, 'gm')).toMatchObject({ sales: 120, modelSales: 80, overriddenBy: 'gm' });
  });

  it('keeps the model figure under an override and clears it when set back', () => {
    const over = overrideForecast(row, 150, 4, 'priya@site', 'Office party booked');
    expect(over).toMatchObject({ sales: 150, modelSales: 100, overriddenBy: 'priya@site', overrideReason: 'Office party booked' });
    const back = overrideForecast(over, 100, 3, 'priya@site');
    expect(back.overriddenBy).toBeUndefined();
    expect(back.sales).toBe(100);
  });

  it('a new model run keeps overrides but refreshes the model underneath', () => {
    const over = overrideForecast(row, 150, 4, 'priya@site');
    const plain: HourForecast = { ...row, hour: 13 };
    const stale: HourForecast = { ...row, hour: 14 };
    const merged = mergeModelForecast([over, plain, stale], [
      { ...row, sales: 120, modelSales: 120 },
      { ...row, hour: 13, sales: 90, modelSales: 90 },
    ]);
    expect(merged.find((r) => r.hour === 12)).toMatchObject({ sales: 150, modelSales: 120, overriddenBy: 'priya@site' });
    expect(merged.find((r) => r.hour === 13)?.sales).toBe(90);
    expect(merged.some((r) => r.hour === 14)).toBe(false);
  });
});

describe('forecast accuracy', () => {
  const f = (hour: number, sales: number, extra: Partial<HourForecast> = {}): HourForecast => ({ siteId: 'mar', date: WEEK, hour, sales, covers: 0, ...extra });
  const a = (hour: number, sales: number, date = WEEK): HourActual => ({ siteId: 'mar', date, hour, sales, covers: 0 });

  it('measures hourly error, day error, bias and dayparts on days that traded', () => {
    const acc = forecastAccuracy(
      [f(12, 100), f(19, 300), f(12, 500, { date: addDays(WEEK, 1) })],
      [a(12, 150), a(19, 250)],
      'mar',
      WEEK,
      addDays(WEEK, 6),
    );
    expect(acc.measuredDays).toBe(1);
    expect(acc.forecast).toBe(400);
    expect(acc.actual).toBe(400);
    expect(acc.wape).toBeCloseTo(100 / 400);
    expect(acc.dayWape).toBe(0); // the day was right even though the hours were wrong
    expect(acc.bias).toBe(0);
    expect(acc.dayparts.map((d) => [d.id, d.bias])).toEqual([['lunch', -50 / 150], ['dinner', 50 / 250]]);
  });

  it('leaves a day nobody forecast unmeasured rather than calling it a total miss', () => {
    const acc = forecastAccuracy([f(12, 100)], [a(12, 100), a(12, 500, addDays(WEEK, 1))], 'mar', WEEK, addDays(WEEK, 1));
    expect(acc.measuredDays).toBe(1);
    expect(acc.wape).toBe(0);
  });

  it('counts sales in an hour nobody forecast as a miss', () => {
    const acc = forecastAccuracy([f(12, 100)], [a(12, 100), a(22, 40)], 'mar', WEEK, WEEK);
    expect(acc.wape).toBeCloseTo(40 / 140);
  });

  it('scores each person’s overrides against the model', () => {
    const acc = forecastAccuracy(
      [
        f(12, 150, { modelSales: 100, overriddenBy: 'gm' }), // actual 140: override helped by 30
        f(19, 200, { modelSales: 300, overriddenBy: 'gm' }), // actual 310: override hurt by 100
        f(20, 100, { modelSales: 100 }),
      ],
      [a(12, 140), a(19, 310), a(20, 100)],
      'mar',
      WEEK,
      WEEK,
    );
    expect(acc.overrides).toMatchObject({ hours: 2, helped: 1, hurt: 1, errorRemoved: -70 });
    expect(acc.modelWape).toBeCloseTo((40 + 10 + 0) / 550);
    expect(acc.wape).toBeCloseTo((10 + 110 + 0) / 550);
  });

  it('puts hours into dayparts', () => {
    expect(daypartOf(8).id).toBe('breakfast');
    expect(daypartOf(13).id).toBe('lunch');
    expect(daypartOf(16).id).toBe('afternoon');
    expect(daypartOf(20).id).toBe('dinner');
    expect(daypartOf(23).id).toBe('late');
    expect(daypartOf(1).id).toBe('late');
  });
});
