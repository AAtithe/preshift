// A sales forecast from a site's own past takings, for a site with no forecasting feed. Simple
// enough for a GM to check by hand: each day says what it was worked from.

import { addDays } from './time';
import type { DaySales, HourForecast, RotaState, Site } from './types';

/** Same weekdays averaged when there is no year of history. */
export const RECENT_WEEKS = 6;
/** Weeks compared with the same weeks a year earlier, to scale last year's day. */
export const TREND_WEEKS = 4;
/** The fewest matched days in both years before last year's figures are trusted. */
const MIN_TREND_DAYS = 6;
/** A year-on-year change outside this is more likely a closure or a data gap than trade. */
const TREND_LIMITS = [0.5, 2] as const;
/** Spend per head when no takings record covers: only used to turn sales into covers. */
export const DEFAULT_SPEND_PER_COVER = 40;

/** Share of the day's sales by hour, a lunch and a dinner service, used when the site has no shape of its own. */
const DEFAULT_CURVE: Record<number, number> = {
  11: 0.02, 12: 0.09, 13: 0.11, 14: 0.06, 15: 0.03, 16: 0.03, 17: 0.06,
  18: 0.11, 19: 0.15, 20: 0.15, 21: 0.1, 22: 0.06, 23: 0.03,
};

export type ForecastBasis = 'last_year' | 'recent' | 'none';

export interface DayForecast {
  siteId: string;
  date: string;
  /** Net sales for the day, in pounds. Nought when there was nothing to work from. */
  sales: number;
  covers: number;
  basis: ForecastBasis;
  /** The takings days it was worked from, so it can be checked. */
  from: string[];
  /** Last year's figure is scaled by this: the last four weeks against the same weeks a year earlier. */
  trend?: number;
  /** Where the hourly split came from: the till's own hours, the site's past forecasts, or the standard curve. */
  shape: 'till' | 'site' | 'standard';
  /** In plain words, for the screen. */
  note: string;
}

const weekdayOf = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();
const weekday = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Takings for one site, by date, trading days only: a day with no takings was closed or not recorded. */
function takingsBy(state: RotaState, siteId: string): Map<string, DaySales> {
  return new Map((state.sales ?? []).filter((s) => s.siteId === siteId && s.netSales > 0).map((s) => [s.date, s]));
}

/** The day from last year: the same weekday 52 weeks back, scaled by the recent trend. */
function fromLastYear(takings: Map<string, DaySales>, date: string, latest: string) {
  const lastYear = takings.get(addDays(date, -364));
  if (!lastYear) return null;
  let now = 0;
  let before = 0;
  let matched = 0;
  for (let d = 0; d < TREND_WEEKS * 7; d++) {
    const day = addDays(latest, -d);
    const a = takings.get(day);
    const b = takings.get(addDays(day, -364));
    if (a && b) {
      now += a.netSales;
      before += b.netSales;
      matched++;
    }
  }
  if (matched < MIN_TREND_DAYS || before <= 0) return null;
  const trend = now / before;
  if (trend < TREND_LIMITS[0] || trend > TREND_LIMITS[1]) return null;
  return { sales: lastYear.netSales * trend, from: [lastYear.date], trend };
}

/**
 * The recent same weekdays, the latest counting most. With five or more, the highest and lowest
 * are dropped, so one unusual night (a private hire, a burst pipe) does not set next week.
 */
function fromRecent(takings: Map<string, DaySales>, date: string, latest: string) {
  const days: DaySales[] = [];
  for (let back = 0; back < 52 * 7 && days.length < RECENT_WEEKS; back++) {
    const day = addDays(latest, -back);
    if (day >= date || weekdayOf(day) !== weekdayOf(date)) continue;
    const t = takings.get(day);
    if (t) days.push(t);
  }
  if (days.length === 0) return null;
  // Most recent first; weight 6 for the latest down to 1.
  let kept = days.map((t, i) => ({ t, weight: days.length - i }));
  if (kept.length >= 5) {
    const sorted = [...kept].sort((a, b) => a.t.netSales - b.t.netSales);
    const drop = new Set([sorted[0].t.date, sorted[sorted.length - 1].t.date]);
    kept = kept.filter((k) => !drop.has(k.t.date));
  }
  const weights = kept.reduce((s, k) => s + k.weight, 0);
  const sales = kept.reduce((s, k) => s + k.t.netSales * k.weight, 0) / weights;
  return { sales, from: kept.map((k) => k.t.date), trend: undefined };
}

/** Spend per head from the takings that record covers, else the site's own figure from set-up, else the default. */
function spendPerCover(takings: Map<string, DaySales>, site?: Site): number {
  let sales = 0;
  let covers = 0;
  for (const t of takings.values()) {
    if (t.covers && t.covers > 0) {
      sales += t.netSales;
      covers += t.covers;
    }
  }
  return covers > 0 ? sales / covers : site?.salesProfile?.averageSpend || DEFAULT_SPEND_PER_COVER;
}

/** Same weekdays of till hours averaged for the shape: two months, recent enough to follow a change of hours. */
export const SHAPE_WEEKS = 8;

/**
 * How the day's sales fall by hour: what the till rang by hour on the same weekday in recent weeks
 * where it reports hours, else the site's own past forecasts for that weekday, else the standard
 * curve, always only within opening hours. The till's is the real shape of trade; a forecast's is
 * only someone's guess at it.
 */
function hourShape(state: RotaState, site: Site, date: string): { shares: Map<number, number>; shape: DayForecast['shape'] } {
  const open = (h: number) => h * 60 >= site.openMinute && h * 60 < site.closeMinute;
  const till = new Map<number, number>();
  const sameDays = (state.sales ?? [])
    .filter((s) => s.siteId === site.id && s.date < date && weekdayOf(s.date) === weekdayOf(date) && s.hours?.length && s.netSales > 0)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, SHAPE_WEEKS);
  // Hours past midnight run on as 24, 25...; a forecast hour is 0 to 23 on its own day, so only those are shaped.
  for (const s of sameDays) for (const h of s.hours!) if (h.hour < 24 && open(h.hour) && h.netSales > 0) till.set(h.hour, (till.get(h.hour) ?? 0) + h.netSales);
  if (till.size > 0) {
    const total = [...till.values()].reduce((a, b) => a + b, 0);
    return { shares: new Map([...till].map(([h, v]) => [h, v / total])), shape: 'till' };
  }
  const own = new Map<number, number>();
  for (const f of state.forecast) {
    if (f.siteId !== site.id || f.date >= date || weekdayOf(f.date) !== weekdayOf(date) || !open(f.hour)) continue;
    own.set(f.hour, (own.get(f.hour) ?? 0) + f.sales);
  }
  const source = [...own.values()].some((v) => v > 0) ? own : new Map(Object.entries(DEFAULT_CURVE).map(([h, s]) => [Number(h), s]));
  const total = [...source.entries()].filter(([h]) => open(h)).reduce((s, [, v]) => s + v, 0);
  const shares = new Map<number, number>();
  if (total > 0) for (const [h, v] of source) if (open(h) && v > 0) shares.set(h, v / total);
  return { shares, shape: source === own ? 'site' : 'standard' };
}

/** Splits a day's sales over its hours in whole pounds that add back to the day exactly. */
function splitByHour(siteId: string, date: string, sales: number, covers: number, shares: Map<number, number>): HourForecast[] {
  const hours = [...shares.keys()].sort((a, b) => a - b);
  const total = Math.round(sales);
  const raw = hours.map((h) => total * shares.get(h)!);
  const whole = raw.map(Math.floor);
  // Largest remainders take the pounds left over, so the hours sum to the day.
  let left = total - whole.reduce((s, v) => s + v, 0);
  for (const i of raw.map((v, i) => [v - Math.floor(v), i] as const).sort((a, b) => b[0] - a[0]).map(([, i]) => i)) {
    if (left <= 0) break;
    whole[i]++;
    left--;
  }
  return hours.map((hour, i) => ({ siteId, date, hour, sales: whole[i], covers: total > 0 ? Math.round((covers * whole[i]) / total) : 0 }));
}

/**
 * A forecast for each date at the site, from its takings. Days with nothing to go on come back
 * with basis 'none' and no hours, rather than a guess.
 */
export function forecastFromTakings(state: RotaState, siteId: string, dates: string[]): { days: DayForecast[]; rows: HourForecast[] } {
  const site = state.sites.find((s) => s.id === siteId);
  if (!site) throw new Error(`No site ${siteId}`);
  const takings = takingsBy(state, siteId);
  const latest = [...takings.keys()].sort().pop();
  const spend = spendPerCover(takings, site);
  const days: DayForecast[] = [];
  const rows: HourForecast[] = [];
  for (const date of dates) {
    const { shares, shape } = hourShape(state, site, date);
    const worked = latest ? fromLastYear(takings, date, latest) ?? fromRecent(takings, date, latest) : null;
    if (!worked || shares.size === 0) {
      days.push({ siteId, date, sales: 0, covers: 0, basis: 'none', from: [], shape, note: 'No takings to work from for this day of the week.' });
      continue;
    }
    const sales = Math.round(worked.sales);
    const covers = Math.round(sales / spend);
    const { trend } = worked;
    const basis: ForecastBasis = trend !== undefined ? 'last_year' : 'recent';
    const note =
      trend !== undefined
        ? `Same day last year (${worked.from[0]}), ${trend >= 1 ? 'up' : 'down'} ${Math.abs(Math.round((trend - 1) * 100))}% on the last four weeks' trend.`
        : worked.from.length === 1
          ? `The last ${weekday(date)} with takings (${worked.from[0]}): one week only, so check it.`
          : `Average of the last ${worked.from.length} ${weekday(date)}s with takings, the latest counting most.`;
    days.push({ siteId, date, sales, covers, basis, from: worked.from, ...(trend !== undefined ? { trend: round2(trend) } : {}), shape, note });
    rows.push(...splitByHour(siteId, date, sales, covers, shares));
  }
  return { days, rows };
}

export interface CoversSource {
  /** Where covers come from: the till or a booking system, or an estimate from sales. */
  kind: 'recorded' | 'estimated';
  /** Spend per head used for the estimate, and where that figure came from. */
  spendPerCover: number;
  spendFrom: 'takings' | 'setup' | 'default';
  /** Takings days in the last eight weeks that record covers. */
  daysWithCovers: number;
}

/**
 * Whether a site's covers are real or estimated, for the Demand screen: a staffing rule of so many
 * covers an hour is only as good as the covers it runs on.
 */
export function coversSource(state: RotaState, siteId: string, today: string): CoversSource {
  const site = state.sites.find((s) => s.id === siteId);
  const since = addDays(today, -56);
  const recent = (state.sales ?? []).filter((s) => s.siteId === siteId && s.date >= since && s.date < today && s.netSales > 0);
  const daysWithCovers = recent.filter((s) => s.covers && s.covers > 0).length;
  const takings = takingsBy(state, siteId);
  const recorded = [...takings.values()].some((t) => t.covers && t.covers > 0);
  return {
    kind: daysWithCovers > 0 ? 'recorded' : 'estimated',
    spendPerCover: Math.round(spendPerCover(takings, site) * 100) / 100,
    spendFrom: recorded ? 'takings' : site?.salesProfile?.averageSpend ? 'setup' : 'default',
    daysWithCovers,
  };
}
