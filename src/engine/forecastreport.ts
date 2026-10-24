// Forecast accuracy across sites and weeks, for the Reports screen. The Forecast screen's panel
// reads one site's week by the hour; this reads the estate over a quarter by the day, so a site
// that only keys in its daily takings is measured too.

import { tradingDate } from './demand';
import { forecastAccuracy } from './forecast';
import { DEFAULT_THRESHOLDS } from './scorecard';
import { addDays, weekDates, weekday } from './time';
import type { HourActual, RotaState } from './types';

/** Above this the forecast is not good enough to staff from: the scorecard's own line. */
export const ACCURACY_THRESHOLD = DEFAULT_THRESHOLDS.forecastWape;
/** A day of the week wrong by this much, the same way, is a pattern rather than noise. */
export const PATTERN_BIAS = 0.1;
/** Fewest measured days of one weekday before a pattern is called. */
export const PATTERN_DAYS = 3;

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export interface AccuracyFigures {
  /** Days that had a forecast and traded, before today. Only these are measured. */
  measuredDays: number;
  /** Forecast and actual sales over the measured days only. */
  forecast: number;
  actual: number;
  /** Sum of each day's absolute error over actual sales. Null when nothing was measured. */
  dayWape: number | null;
  /** The same by the hour, where the till sends hours: what staffing feels. Null where it does not. */
  hourWape: number | null;
  /** Positive: forecast too high, so the rota was too heavy. */
  bias: number | null;
  /** Sales forecast that did not come, summed by day. */
  over: number;
  /** Sales that came and were not forecast, summed by day. */
  under: number;
  /** `over` at the site's labour target: labour planned for sales that did not come. */
  labourOver: number;
  /** `under` at the site's labour target: labour the extra sales would have paid for. */
  labourUnder: number;
  /** Measured days whose forecast was set-up's typical week alone. */
  typicalDays: number;
}

export interface WeekdayPattern {
  weekday: number;
  label: string;
  measuredDays: number;
  bias: number;
}

export interface AccuracyReport {
  weeks: { weekStart: string; sites: (AccuracyFigures & { siteId: string })[]; total: AccuracyFigures }[];
  sites: { siteId: string; total: AccuracyFigures; weekdays: WeekdayPattern[]; patterns: string[] }[];
  total: AccuracyFigures;
  threshold: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Running sums, so totals over sites and weeks are worked from the days, never averaged averages. */
interface Acc {
  days: number;
  f: number;
  a: number;
  e: number;
  over: number;
  under: number;
  lOver: number;
  lUnder: number;
  typical: number;
  hourErr: number;
  hourActual: number;
}

const empty = (): Acc => ({ days: 0, f: 0, a: 0, e: 0, over: 0, under: 0, lOver: 0, lUnder: 0, typical: 0, hourErr: 0, hourActual: 0 });

function add(into: Acc, from: Acc) {
  for (const k of Object.keys(into) as (keyof Acc)[]) into[k] += from[k];
}

function figures(x: Acc): AccuracyFigures {
  const measured = x.days > 0 && x.a > 0;
  return {
    measuredDays: x.days,
    forecast: round2(x.f),
    actual: round2(x.a),
    dayWape: measured ? x.e / x.a : null,
    hourWape: x.hourActual > 0 ? x.hourErr / x.hourActual : null,
    bias: measured ? (x.f - x.a) / x.a : null,
    over: round2(x.over),
    under: round2(x.under),
    labourOver: round2(x.lOver),
    labourUnder: round2(x.lUnder),
    typicalDays: x.typical,
  };
}

/**
 * Forecast against what each site took, week by week, for the `weeks` weeks ending with
 * `endWeek`. A day is measured only before today, and only when it had a forecast and traded:
 * a day nobody forecast is unmeasured, not a total miss. Actual sales are the day's takings,
 * else the till's hourly actuals summed.
 */
export function accuracyReport(state: RotaState, actuals: HourActual[], siteIds: string[], endWeek: string, weeks: number, today: string): AccuracyReport {
  const starts = Array.from({ length: weeks }, (_, i) => addDays(endWeek, (i - weeks + 1) * 7));
  const from = starts[0];
  const to = addDays(endWeek, 6);
  const inRange = (r: { date: string }) => r.date >= from && r.date <= to && r.date < today;
  // Hourly rows count towards their trading day: 01:00 on Saturday at a bar open late is Friday night.
  const site = new Map(state.sites.map((s) => [s.id, s]));
  const ofDay = (r: { siteId: string; date: string; hour: number }) => ({ date: tradingDate(site.get(r.siteId), r) });

  // One pass over each source, keyed by site and day.
  const forecastBy = new Map<string, { sales: number; typical: boolean }>();
  for (const f of state.forecast) {
    const { date } = ofDay(f);
    if (!siteIds.includes(f.siteId) || !inRange({ date })) continue;
    const k = `${f.siteId}|${date}`;
    const d = forecastBy.get(k) ?? { sales: 0, typical: true };
    d.sales += f.sales;
    d.typical &&= f.source === 'profile';
    forecastBy.set(k, d);
  }
  const takings = new Map((state.sales ?? []).filter((s) => siteIds.includes(s.siteId) && inRange(s)).map((s) => [`${s.siteId}|${s.date}`, s.netSales]));
  const hourly = new Map<string, number>();
  for (const a of actuals) {
    const { date } = ofDay(a);
    if (!siteIds.includes(a.siteId) || !inRange({ date })) continue;
    const k = `${a.siteId}|${date}`;
    hourly.set(k, (hourly.get(k) ?? 0) + a.sales);
  }

  const bySite = new Map(siteIds.map((id) => [id, { total: empty(), weekdays: Array.from({ length: 7 }, empty) }]));
  const grand = empty();
  const weekRows = starts.map((ws) => {
    const total = empty();
    const sites = siteIds.map((siteId) => {
      const target = state.sites.find((s) => s.id === siteId)?.labourTargetPct ?? 0;
      const acc = empty();
      for (const date of weekDates(ws)) {
        const k = `${siteId}|${date}`;
        const f = forecastBy.get(k);
        const a = takings.get(k) ?? hourly.get(k) ?? 0;
        if (!f || f.sales <= 0 || a <= 0) continue;
        const day: Acc = {
          ...empty(),
          days: 1,
          f: f.sales,
          a,
          e: Math.abs(f.sales - a),
          over: Math.max(0, f.sales - a),
          under: Math.max(0, a - f.sales),
          typical: f.typical ? 1 : 0,
        };
        day.lOver = day.over * target;
        day.lUnder = day.under * target;
        add(acc, day);
        add(bySite.get(siteId)!.weekdays[weekday(date)], day);
      }
      // By the hour where the till sends hours: the Forecast screen's own measure, over the same week.
      if (acc.days > 0) {
        const h = forecastAccuracy(state.forecast, actuals, siteId, ws, addDays(ws, 6) < today ? addDays(ws, 6) : addDays(today, -1));
        if (h.measuredDays > 0 && h.actual > 0) {
          acc.hourErr = h.wape * h.actual;
          acc.hourActual = h.actual;
        }
      }
      add(total, acc);
      add(bySite.get(siteId)!.total, acc);
      return { siteId, ...figures(acc) };
    });
    add(grand, total);
    return { weekStart: ws, sites, total: figures(total) };
  });

  return {
    weeks: weekRows,
    sites: siteIds.map((siteId) => {
      const s = bySite.get(siteId)!;
      const weekdays = s.weekdays
        .map((w, i) => ({ weekday: i, label: WEEKDAYS[i], measuredDays: w.days, bias: w.a > 0 ? (w.f - w.a) / w.a : 0 }))
        .filter((w) => w.measuredDays > 0);
      const patterns = weekdays
        .filter((w) => w.measuredDays >= PATTERN_DAYS && Math.abs(w.bias) >= PATTERN_BIAS)
        .map((w) => `${w.label}s are forecast ${Math.round(Math.abs(w.bias) * 100)}% too ${w.bias > 0 ? 'high' : 'low'} across ${w.measuredDays} weeks.`);
      return { siteId, total: figures(s.total), weekdays, patterns };
    }),
    total: figures(grand),
    threshold: ACCURACY_THRESHOLD,
  };
}
