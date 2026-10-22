import type { HourActual } from './types';
import { addDays } from './time';

// A site's till history, by day, and what a normal day looks like around any
// date. Occasions, weather and local events are all judged the same way: what
// the day took against a normal day of the same weekday nearby.

export interface SiteHistory {
  /** Net sales by date. */
  days: Map<string, number>;
  /** Net sales by date and hour. */
  hours: Map<string, number>;
}

/** `factors` takes a known effect out of each day (the weather), so what is left can be judged on its own. */
export function siteHistory(actuals: HourActual[], siteId: string, factors?: Map<string, number>): SiteHistory {
  const days = new Map<string, number>();
  const hours = new Map<string, number>();
  for (const a of actuals) {
    if (a.siteId !== siteId) continue;
    const sales = a.sales / (factors?.get(a.date) ?? 1);
    days.set(a.date, (days.get(a.date) ?? 0) + sales);
    hours.set(`${a.date}|${a.hour}`, sales);
  }
  return { days, hours };
}

/** Sales in a span of hours on a day, or the whole day. */
export function salesIn(h: SiteHistory, date: string, fromHour = 0, toHour = 24): number {
  if (fromHour === 0 && toHour >= 24) return h.days.get(date) ?? 0;
  let total = 0;
  for (let hour = fromHour; hour < toHour; hour++) total += h.hours.get(`${date}|${hour}`) ?? 0;
  return total;
}

/**
 * A normal day for `date`: the average of the same weekday in the weeks either
 * side that traded and are not themselves unusual. Both sides, so a growing or
 * shrinking site is judged against its level at the time. Null if fewer than
 * three such days exist.
 */
export function normalSales(h: SiteHistory, date: string, unusual: Set<string>, fromHour = 0, toHour = 24, weeks = 4): number | null {
  const samples: number[] = [];
  for (let w = 1; w <= weeks; w++) {
    for (const d of [addDays(date, -7 * w), addDays(date, 7 * w)]) {
      if (h.days.has(d) && !unusual.has(d)) samples.push(salesIn(h, d, fromHour, toHour));
    }
  }
  return samples.length >= 3 ? samples.reduce((a, b) => a + b, 0) / samples.length : null;
}
