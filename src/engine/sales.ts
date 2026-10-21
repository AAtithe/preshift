import type { HourForecast, HourSales } from './types';
import { addDays } from './time';

const key = (r: { siteId: string; date: string; hour: number }) => `${r.siteId}|${r.date}|${r.hour}`;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Incoming rows replace whatever was held for the same site, date and hour. */
export function upsertHourSales(held: HourSales[], incoming: HourSales[]): HourSales[] {
  const next = new Map(incoming.map((r) => [key(r), r]));
  return [...held.filter((r) => !next.has(key(r))), ...next.values()];
}

/**
 * A till sync is the whole truth for the days it covers: refunds and late-closed bills
 * can lower an hour or empty it, so those days are replaced outright, not merged.
 */
export function replaceDays(held: HourSales[], incoming: HourSales[], siteIds: string[], dates: string[]): HourSales[] {
  const sites = new Set(siteIds);
  const days = new Set(dates);
  return [...held.filter((r) => !(sites.has(r.siteId) && days.has(r.date))), ...incoming];
}

/** Drops anything older than `keepFrom`, so the history held stays bounded. */
export function pruneBefore(held: HourSales[], keepFrom: string): HourSales[] {
  return held.filter((r) => r.date >= keepFrom);
}

export interface DayVsForecast {
  date: string;
  /** Forecast for the hours compared: the whole day, or on the day still trading only the hours already closed. */
  forecast: number;
  /** Null when the till has nothing for the day yet. */
  actual: number | null;
  /** Actual less forecast. Null until there is an actual. */
  variance: number | null;
  /** Set on the day still trading: the hour the comparison runs up to, exclusive. */
  throughHour?: number;
}

/**
 * Till against forecast by day. On the day still trading (`now`), only the hours already
 * closed are compared, so a lunchtime read does not show the whole evening as a shortfall.
 */
export function salesVsForecast(
  forecast: HourForecast[],
  actuals: HourSales[],
  siteId: string,
  dates: string[],
  now?: { date: string; hour: number },
): DayVsForecast[] {
  return dates.map((date) => {
    const live = now?.date === date;
    const inScope = (hour: number) => !live || hour < now!.hour;
    const f = round2(forecast.filter((r) => r.siteId === siteId && r.date === date && inScope(r.hour)).reduce((s, r) => s + r.sales, 0));
    const rows = actuals.filter((r) => r.siteId === siteId && r.date === date && inScope(r.hour));
    const actual = rows.length ? round2(rows.reduce((s, r) => s + r.sales, 0)) : null;
    return { date, forecast: f, actual, variance: actual === null ? null : round2(actual - f), ...(live ? { throughHour: now!.hour } : {}) };
  });
}

export interface HistoryForecast {
  rows: HourForecast[];
  /** For each date forecast, how many earlier same weekdays it was built from. */
  days: { date: string; weeksUsed: number }[];
  /** Dates left alone because the till holds fewer than `minWeeks` of the same weekday. */
  skipped: string[];
}

export interface HistoryOptions {
  /** How many earlier same weekdays to look back over. */
  weeks?: number;
  /** Fewer than this many usable weeks and the date is skipped rather than guessed. */
  minWeeks?: number;
  /**
   * Net sales per cover for the site, used when the till does not record guests, so the
   * covers that drive kitchen headcount keep the site's own relationship to sales.
   */
  spendPerHead?: number;
}

/**
 * Forecasts each date from the same weekday in the weeks before it: a weighted average
 * hour by hour, the most recent week counting most (weights N, N-1 ... 1). A day the till
 * holds nothing for (closed, or before go-live) is left out rather than counted as zero,
 * but an hour with no sales inside a trading day does count as zero, because it was open
 * and took nothing.
 */
export function forecastFromHistory(actuals: HourSales[], siteId: string, dates: string[], options: HistoryOptions = {}): HistoryForecast {
  const weeks = options.weeks ?? 6;
  const minWeeks = options.minWeeks ?? 2;
  const byDay = new Map<string, HourSales[]>();
  for (const r of actuals) {
    if (r.siteId !== siteId) continue;
    const list = byDay.get(r.date) ?? [];
    list.push(r);
    byDay.set(r.date, list);
  }

  const rows: HourForecast[] = [];
  const days: HistoryForecast['days'] = [];
  const skipped: string[] = [];
  for (const date of dates) {
    const history = Array.from({ length: weeks }, (_, i) => ({ weight: weeks - i, rows: byDay.get(addDays(date, -7 * (i + 1))) }))
      .filter((h): h is { weight: number; rows: HourSales[] } => !!h.rows?.length);
    if (history.length < minWeeks) {
      skipped.push(date);
      continue;
    }
    const totalWeight = history.reduce((s, h) => s + h.weight, 0);
    const hours = new Set(history.flatMap((h) => h.rows.map((r) => r.hour)));
    for (const hour of [...hours].sort((a, b) => a - b)) {
      let sales = 0;
      let covers = 0;
      let coversKnown = true;
      for (const h of history) {
        const r = h.rows.find((x) => x.hour === hour);
        sales += (r?.sales ?? 0) * h.weight;
        if (r && r.covers === undefined) coversKnown = false;
        covers += (r?.covers ?? 0) * h.weight;
      }
      const s = round2(sales / totalWeight);
      const c = coversKnown ? covers / totalWeight : options.spendPerHead ? s / options.spendPerHead : 0;
      rows.push({ siteId, date, hour, sales: s, covers: Math.round(c) });
    }
    days.push({ date, weeksUsed: history.length });
  }
  return { rows, days, skipped };
}

/** Net sales per cover in a set of forecast rows, or undefined when there are no covers to divide by. */
export function spendPerHead(rows: HourForecast[]): number | undefined {
  const covers = rows.reduce((s, r) => s + r.covers, 0);
  return covers > 0 ? rows.reduce((s, r) => s + r.sales, 0) / covers : undefined;
}
