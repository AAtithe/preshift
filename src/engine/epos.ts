import type { DaySales, HourSales } from './types';
import { addDays } from './time';

// Turns till orders into the daily takings the reports read. Pure, so the same rules apply whichever
// EPOS the orders came from.

/** One completed order as any till reports it, already net of VAT, tips and service charge. */
export interface TillOrder {
  locationId: string;
  /** When the order closed, as an ISO instant. */
  closedAt: string;
  netSales: number;
  /** Guests on the order, where the till records them (Toast, Lightspeed; Square does not). */
  covers?: number;
  /**
   * The trading day the till itself filed the order under, where it has one (Toast's business
   * date, from the restaurant's own closeout hour). Beats the 5am rule, which is only a default.
   */
  tradingDate?: string;
}

/**
 * Sales before this hour belong to the previous night's trade. A bar that closes at 2am has one
 * trading day, not two, and its labour % only makes sense if the late hours sit with that day.
 */
export const TRADING_DAY_STARTS = 5;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Local calendar date and hour of an instant in a time zone. */
export function localDateHour(iso: string, timeZone: string): { date: string; hour: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/** The trading day and hour an instant counts towards. Early hours run on from the night before (hour 25 is 1am). */
export function tradingHour(iso: string, timeZone: string, startsAt = TRADING_DAY_STARTS): { date: string; hour: number } {
  const { date, hour } = localDateHour(iso, timeZone);
  return hour < startsAt ? { date: addDays(date, -1), hour: hour + 24 } : { date, hour };
}

export interface TradingDay {
  date: string;
  netSales: number;
  orders: number;
  /** Guests, when the till records them; absent when it does not, so nil covers never reads as a quiet day. */
  covers?: number;
  hours: HourSales[];
}

/** One location's orders, by trading day and hour. */
export function tradingDays(orders: TillOrder[], timeZone: string): Map<string, TradingDay> {
  type Day = { netSales: number; orders: number; covers?: number; hours: Map<number, HourSales> };
  const days = new Map<string, Day>();
  for (const o of orders) {
    let { date, hour } = tradingHour(o.closedAt, timeZone);
    if (o.tradingDate && o.tradingDate !== date) {
      // The till filed it under its own business day: keep its day, and run the clock on from it.
      const local = localDateHour(o.closedAt, timeZone);
      date = o.tradingDate;
      hour = local.date > date ? local.hour + 24 : local.hour;
    }
    const day: Day = days.get(date) ?? { netSales: 0, orders: 0, hours: new Map() };
    const h = day.hours.get(hour) ?? { hour, netSales: 0, orders: 0 };
    day.netSales += o.netSales;
    day.orders++;
    h.netSales += o.netSales;
    h.orders++;
    if (o.covers !== undefined) {
      day.covers = (day.covers ?? 0) + o.covers;
      h.covers = (h.covers ?? 0) + o.covers;
    }
    day.hours.set(hour, h);
    days.set(date, day);
  }
  return new Map(
    [...days].map(([date, d]) => [
      date,
      {
        date,
        netSales: round2(d.netSales),
        orders: d.orders,
        ...(d.covers !== undefined ? { covers: d.covers } : {}),
        hours: [...d.hours.values()].sort((a, b) => a.hour - b.hour).map((h) => ({ ...h, netSales: round2(h.netSales) })),
      },
    ]),
  );
}

export interface TillMerge {
  sales: DaySales[];
  written: number;
  /** Days a manager keyed in by hand. Their figure stands: the till never overwrites a correction. */
  kept: { siteId: string; date: string }[];
}

/**
 * Writes one site's till takings for each trading day in `dates`. A day with no orders is written as
 * nil, because the till is the record of what was sold. Pass only days that have finished trading,
 * so a half-done day is never read as a whole one.
 */
export function mergeTill(existing: DaySales[], siteId: string, dates: string[], days: Map<string, TradingDay>): TillMerge {
  const kept: TillMerge['kept'] = [];
  const replace = new Map<string, DaySales>();
  for (const date of dates) {
    const current = existing.find((s) => s.siteId === siteId && s.date === date);
    if (current?.source === 'manual') {
      kept.push({ siteId, date });
      continue;
    }
    const day = days.get(date);
    replace.set(date, {
      siteId,
      date,
      netSales: day?.netSales ?? 0,
      orders: day?.orders ?? 0,
      // Covers the till did not report are left as they were: a booking system may have sent them.
      ...(day?.covers !== undefined ? { covers: day.covers } : current?.covers !== undefined ? { covers: current.covers } : {}),
      hours: day?.hours ?? [],
      source: 'till',
    });
  }
  return {
    sales: [...existing.filter((s) => !(s.siteId === siteId && replace.has(s.date))), ...replace.values()],
    written: replace.size,
    kept,
  };
}
