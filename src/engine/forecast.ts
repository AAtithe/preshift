import type { ForecastAdjustment, HourActual, HourForecast } from './types';
import { bankHolidays } from './calendar';
import { addDays, weekday } from './time';

// The sales forecast drives every rota. This module builds a baseline forecast
// from a site's own till history, measures how good the forecast was once the
// week has traded, and scores the overrides people made to it, so a GM learns
// whether their instinct beats the model.

export interface Daypart {
  id: 'breakfast' | 'lunch' | 'afternoon' | 'dinner' | 'late';
  label: string;
  /** First hour in the daypart, inclusive. */
  from: number;
  /** Hour the daypart ends, exclusive. */
  to: number;
}

export const DAYPARTS: Daypart[] = [
  { id: 'breakfast', label: 'Breakfast', from: 5, to: 11 },
  { id: 'lunch', label: 'Lunch', from: 11, to: 15 },
  { id: 'afternoon', label: 'Afternoon', from: 15, to: 17 },
  { id: 'dinner', label: 'Dinner', from: 17, to: 21 },
  { id: 'late', label: 'Late', from: 21, to: 24 },
];

/** After-midnight trade belongs to the late daypart of the night before, not to breakfast. */
export function daypartOf(hour: number): Daypart {
  return DAYPARTS.find((d) => hour >= d.from && hour < d.to) ?? DAYPARTS[DAYPARTS.length - 1];
}

/** England and Wales bank holidays 2025 to 2028, as published on gov.uk. The model computes them for any year (calendar.ts); this list checks that. */
export const BANK_HOLIDAYS_ENGLAND_WALES: string[] = [
  '2025-01-01', '2025-04-18', '2025-04-21', '2025-05-05', '2025-05-26', '2025-08-25', '2025-12-25', '2025-12-26',
  '2026-01-01', '2026-04-03', '2026-04-06', '2026-05-04', '2026-05-25', '2026-08-31', '2026-12-25', '2026-12-28',
  '2027-01-01', '2027-03-26', '2027-03-29', '2027-05-03', '2027-05-31', '2027-08-30', '2027-12-27', '2027-12-28',
  '2028-01-03', '2028-04-14', '2028-04-17', '2028-05-01', '2028-05-29', '2028-08-28', '2028-12-25', '2028-12-26',
];

export interface BaselineOptions {
  /** How many past same weekdays to learn from. */
  weeks?: number;
  /** Weight of each older week relative to the one after it. */
  decay?: number;
  adjustments?: ForecastAdjustment[];
  /** Defaults to England and Wales bank holidays, computed for every year in play. */
  bankHolidays?: string[];
  /** Days that were not normal trade (occasions, events) and should not be learnt from. */
  unusualDays?: Set<string>;
  /**
   * What the weather did to each past day. Training figures are divided by it, so the model learns
   * normal trade and a hot fortnight does not make next week's forecast hot.
   */
  historyFactors?: Map<string, number>;
}

export interface BaselineResult {
  rows: HourForecast[];
  /** Days with no usable history, left for someone to forecast by hand. Christmas week should always be set by hand. */
  skipped: string[];
  /** Applied to every hour: recent four weeks against the four before, damped. */
  trend: number;
  /** Learnt from past bank holidays, or null when there were none and Sunday's pattern stood in. */
  bankHolidayFactor: number | null;
}

type Totals = { sales: number; covers: number };
const key = (date: string, hour: number) => `${date}|${hour}`;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
/** The most the model's own adjustments may move an hour, all together. */
export const AUTO_MIN = 0.5;
export const AUTO_MAX = 2.5;
const festive = (date: string) => date.slice(5) >= '12-24' || date.slice(5) <= '01-03';

/**
 * Builds the baseline forecast for the given dates from hourly till history.
 * Each hour is a recency-weighted average of the same weekday and hour over the
 * last few weeks, with a damped trend on top. Bank holidays and adjusted days
 * are left out of the training data because they are not normal trade; a bank
 * holiday is forecast from what past bank holidays did against a normal day,
 * or from the Sunday pattern when there is no such history. Known one-offs
 * (weather, events, closures) are applied last, as multipliers.
 */
export function baselineForecast(history: HourActual[], siteId: string, dates: string[], options: BaselineOptions = {}): BaselineResult {
  const weeks = options.weeks ?? 8;
  const decay = options.decay ?? 0.8;
  const years = [...new Set([...history.map((a) => a.date), ...dates].map((d) => Number(d.slice(0, 4))))];
  const holidays = new Set(options.bankHolidays ?? years.flatMap((y) => bankHolidays(y).map((b) => b.date)));
  const unusualDays = options.unusualDays ?? new Set<string>();
  const historyFactors = options.historyFactors ?? new Map<string, number>();
  const adjustments = (options.adjustments ?? []).filter((a) => a.siteId === siteId);
  // Days people adjusted were not normal trade; the model's own adjustments are all for dates ahead.
  const adjustedDays = new Set(adjustments.filter((a) => a.source !== 'auto').map((a) => a.date));

  const byHour = new Map<string, Totals>();
  const tradedDays = new Set<string>();
  for (const a of history) {
    if (a.siteId !== siteId) continue;
    const f = historyFactors.get(a.date) ?? 1;
    byHour.set(key(a.date, a.hour), { sales: a.sales / f, covers: a.covers / f });
    tradedDays.add(a.date);
  }
  // Only learn from the past: the earliest date being forecast is "today".
  const asOf = [...dates].sort()[0] ?? '';
  const usable = (date: string) => date < asOf && tradedDays.has(date) && !holidays.has(date) && !adjustedDays.has(date) && !unusualDays.has(date);

  /** Recency-weighted level for one weekday and hour, looking back from `date`. */
  const level = (date: string, hour: number, profileWeekday = weekday(date)): Totals | null => {
    let w = 1;
    let weight = 0;
    let sales = 0;
    let covers = 0;
    // Walk back week by week from the most recent matching weekday before `date`.
    const offset = ((weekday(date) - profileWeekday + 7) % 7) || 7;
    let found = 0;
    // The look-back is bounded from the last day with history, so dates further ahead still find full weeks.
    const oldest = addDays(asOf, -7 * (weeks + 4));
    for (let d = addDays(date, -offset); found < weeks && d >= oldest; d = addDays(d, -7)) {
      if (!usable(d)) continue;
      const row = byHour.get(key(d, hour)) ?? { sales: 0, covers: 0 };
      sales += row.sales * w;
      covers += row.covers * w;
      weight += w;
      w *= decay;
      found++;
    }
    return weight > 0 ? { sales: sales / weight, covers: covers / weight } : null;
  };

  const daySales = (date: string) => {
    let total = 0;
    for (let h = 0; h < 24; h++) total += byHour.get(key(date, h))?.sales ?? 0;
    return total;
  };
  // Average sales per weekday over a window, so a missing Saturday is not mistaken for decline.
  const weekdayAverages = (from: string, days: number) => {
    const sums = new Map<number, { total: number; n: number }>();
    for (let i = 0; i < days; i++) {
      const d = addDays(from, i);
      if (!usable(d)) continue;
      const s = sums.get(weekday(d)) ?? { total: 0, n: 0 };
      s.total += daySales(d);
      s.n++;
      sums.set(weekday(d), s);
    }
    return new Map([...sums].map(([wd, s]) => [wd, s.total / s.n]));
  };
  // Growth or decline of the last four weeks over the four before, on the weekdays both windows
  // traded, damped by half and capped, so a single good month nudges the forecast rather than running away with it.
  const recentAvg = weekdayAverages(addDays(asOf, -28), 28);
  const priorAvg = weekdayAverages(addDays(asOf, -56), 28);
  const shared = [...recentAvg.keys()].filter((wd) => priorAvg.has(wd));
  const recent = shared.reduce((s, wd) => s + recentAvg.get(wd)!, 0);
  const prior = shared.reduce((s, wd) => s + priorAvg.get(wd)!, 0);
  const trend = recent > 0 && prior > 0 ? clamp(1 + (recent / prior - 1) / 2, 0.9, 1.1) : 1;

  // What past bank holidays took against the normal level for their weekday.
  const ratios: number[] = [];
  for (const day of holidays) {
    // Christmas and New Year trade like nothing else; learning from them would skew every other bank holiday.
    if (day >= asOf || !tradedDays.has(day) || festive(day)) continue;
    let expected = 0;
    for (let h = 0; h < 24; h++) expected += level(day, h)?.sales ?? 0;
    if (expected > 0) ratios.push(daySales(day) / expected);
  }
  const bankHolidayFactor = ratios.length ? clamp(ratios.reduce((a, b) => a + b, 0) / ratios.length, 0.3, 2.5) : null;

  const rows: HourForecast[] = [];
  const skipped: string[] = [];
  for (const date of dates) {
    const holiday = holidays.has(date);
    // With no bank holiday history, trade it like a Sunday: the usual operator rule of thumb.
    const profile = holiday && bankHolidayFactor === null ? 6 : weekday(date);
    const factor = holiday && bankHolidayFactor !== null ? bankHolidayFactor : 1;
    const dayRows: HourForecast[] = [];
    for (let hour = 0; hour < 24; hour++) {
      const base = level(date, hour, profile);
      if (!base) continue;
      const here = adjustments.filter((a) => a.date === date && (a.fromHour === undefined || hour >= a.fromHour) && (a.toHour === undefined || hour < a.toHour));
      // What people set applies as given. What the model added by itself is held to a range in total,
      // so an occasion, an event and the weather on the same hours cannot compound into nonsense.
      const people = here.filter((a) => a.source !== 'auto').reduce((m, a) => m * a.factor, 1);
      const automatic = clamp(here.filter((a) => a.source === 'auto').reduce((m, a) => m * a.factor, 1), AUTO_MIN, AUTO_MAX);
      const adj = people * automatic;
      const sales = Math.round(base.sales * trend * factor * adj);
      const covers = Math.round(base.covers * trend * factor * adj);
      // An hour an adjustment closes is kept at zero, so a merge clears what was forecast before.
      if (sales === 0 && covers === 0 && !(adj === 0 && (base.sales > 0 || base.covers > 0))) continue;
      dayRows.push({ siteId, date, hour, sales, covers, modelSales: sales, modelCovers: covers });
    }
    if (dayRows.length === 0) skipped.push(date);
    rows.push(...dayRows);
  }
  return { rows, skipped, trend, bankHolidayFactor };
}

/**
 * Lays a fresh model run over the forecast already held. Hours someone has
 * overridden keep their figure, but the model's figure underneath is updated so
 * the override is scored against the latest model. Everything else is replaced.
 */
export function mergeModelForecast(existing: HourForecast[], model: HourForecast[]): HourForecast[] {
  const incoming = new Map(model.map((r) => [`${r.siteId}|${key(r.date, r.hour)}`, r]));
  const out: HourForecast[] = [];
  for (const row of existing) {
    const k = `${row.siteId}|${key(row.date, row.hour)}`;
    const next = incoming.get(k);
    if (!next) {
      // A day the model now covers loses hours it no longer forecasts, unless someone set them.
      const modelCoversDay = model.some((m) => m.siteId === row.siteId && m.date === row.date);
      if (!modelCoversDay || row.overriddenBy) out.push(row);
      continue;
    }
    incoming.delete(k);
    out.push(row.overriddenBy ? { ...row, modelSales: next.modelSales, modelCovers: next.modelCovers } : next);
  }
  return [...out, ...incoming.values()];
}

/** A person's change to one hour of the forecast. The model's figure is kept underneath. */
export function overrideForecast(row: HourForecast, sales: number, covers: number, by: string, reason?: string): HourForecast {
  const modelSales = row.modelSales ?? row.sales;
  const modelCovers = row.modelCovers ?? row.covers;
  if (sales === modelSales && covers === modelCovers) {
    // Setting it back to the model clears the override.
    const { overriddenBy: _b, overrideReason: _r, ...rest } = row;
    return { ...rest, sales, covers, modelSales, modelCovers };
  }
  return { ...row, sales, covers, modelSales, modelCovers, overriddenBy: by, overrideReason: reason };
}

export interface AccuracySlice {
  forecast: number;
  actual: number;
  /** Sum of hourly absolute errors over actual sales: the error that matters for staffing. */
  wape: number;
  /** Positive means the forecast was too high, so the rota was too heavy. */
  bias: number;
}

export interface OverrideScore {
  by: string;
  hours: number;
  helped: number;
  hurt: number;
  /** Pounds of hourly error the overrides removed. Negative means the model was better left alone. */
  errorRemoved: number;
}

export interface ForecastAccuracy extends AccuracySlice {
  siteId: string;
  from: string;
  to: string;
  /** The same measure for the untouched model, where the model figure is known. */
  modelWape: number | null;
  /** Error on whole-day totals, which hides timing errors inside the day. */
  dayWape: number;
  days: (AccuracySlice & { date: string })[];
  dayparts: (AccuracySlice & { id: Daypart['id']; label: string })[];
  overrides: { hours: number; helped: number; hurt: number; errorRemoved: number; byPerson: OverrideScore[] };
  /** Days in the range that had a forecast and have till actuals, and so were measured. */
  measuredDays: number;
}

function slice(forecast: number, actual: number, absError: number): AccuracySlice {
  return { forecast, actual, wape: actual > 0 ? absError / actual : 0, bias: actual > 0 ? (forecast - actual) / actual : 0 };
}

/**
 * How good the forecast was, once the days have traded. Only days with a
 * forecast and till actuals are measured; an hour with a forecast and no sales counts as a miss,
 * as does an hour that traded with nothing forecast.
 */
export function forecastAccuracy(
  forecast: HourForecast[],
  actuals: HourActual[],
  siteId: string,
  from: string,
  to: string,
): ForecastAccuracy {
  const inRange = (r: { siteId: string; date: string }) => r.siteId === siteId && r.date >= from && r.date <= to;
  // A day is measured when it both traded and had a forecast: a day nobody forecast is not a 100% miss, it is unmeasured.
  const forecastDays = new Set(forecast.filter(inRange).map((f) => f.date));
  const actual = new Map(actuals.filter((a) => inRange(a) && forecastDays.has(a.date)).map((a) => [key(a.date, a.hour), a]));
  const measured = new Set([...actual.values()].map((a) => a.date));
  const fc = new Map(forecast.filter((f) => inRange(f) && measured.has(f.date)).map((f) => [key(f.date, f.hour), f]));
  const keys = new Set([...actual.keys(), ...fc.keys()]);

  let fTotal = 0;
  let aTotal = 0;
  let err = 0;
  let modelErr = 0;
  let modelKnown = 0;
  const days = new Map<string, { f: number; a: number; e: number }>();
  const parts = new Map<Daypart['id'], { f: number; a: number; e: number }>();
  const people = new Map<string, OverrideScore>();

  for (const k of keys) {
    const [date, h] = k.split('|');
    const hour = Number(h);
    const f = fc.get(k);
    const a = actual.get(k)?.sales ?? 0;
    const fs = f?.sales ?? 0;
    const e = Math.abs(fs - a);
    fTotal += fs;
    aTotal += a;
    err += e;
    const model = f?.modelSales ?? (f && !f.overriddenBy ? f.sales : undefined);
    if (model !== undefined || !f) {
      modelErr += Math.abs((model ?? 0) - a);
      modelKnown++;
    }
    const day = days.get(date) ?? { f: 0, a: 0, e: 0 };
    day.f += fs;
    day.a += a;
    day.e += e;
    days.set(date, day);
    const part = daypartOf(hour).id;
    const p = parts.get(part) ?? { f: 0, a: 0, e: 0 };
    p.f += fs;
    p.a += a;
    p.e += e;
    parts.set(part, p);

    if (f?.overriddenBy && f.modelSales !== undefined) {
      const score = people.get(f.overriddenBy) ?? { by: f.overriddenBy, hours: 0, helped: 0, hurt: 0, errorRemoved: 0 };
      const delta = Math.abs(f.modelSales - a) - e;
      score.hours++;
      if (delta > 0) score.helped++;
      if (delta < 0) score.hurt++;
      score.errorRemoved += delta;
      people.set(f.overriddenBy, score);
    }
  }

  const dayList = [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, d]) => ({ date, ...slice(d.f, d.a, d.e) }));
  const dayErr = [...days.values()].reduce((s, d) => s + Math.abs(d.f - d.a), 0);
  const byPerson = [...people.values()].sort((a, b) => a.errorRemoved - b.errorRemoved);
  const sum = (pick: (s: OverrideScore) => number) => byPerson.reduce((s, p) => s + pick(p), 0);
  return {
    siteId,
    from,
    to,
    ...slice(fTotal, aTotal, err),
    modelWape: modelKnown === keys.size && aTotal > 0 ? modelErr / aTotal : null,
    dayWape: aTotal > 0 ? dayErr / aTotal : 0,
    days: dayList,
    dayparts: DAYPARTS.filter((d) => parts.has(d.id)).map((d) => {
      const p = parts.get(d.id)!;
      return { id: d.id, label: d.label, ...slice(p.f, p.a, p.e) };
    }),
    overrides: { hours: sum((p) => p.hours), helped: sum((p) => p.helped), hurt: sum((p) => p.hurt), errorRemoved: sum((p) => p.errorRemoved), byPerson },
    measuredDays: measured.size,
  };
}
