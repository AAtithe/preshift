import type { DaySales, HourSales, TipsTaken } from './types';
import { addDays } from './time';

// Turns till orders into the daily takings the reports read. Pure, so the same rules apply whichever
// EPOS the orders came from.

/** One completed order as any till reports it, already net of VAT, tips and service charge. */
export interface TillOrder {
  locationId: string;
  /** When the order closed, as an ISO instant. */
  closedAt: string;
  netSales: number;
  /** Card tips added to the order, in pounds. They belong to the team, so never in netSales. */
  tips?: number;
  /** Service charge collected on the order, VAT included, in pounds. The team's too, never in netSales. */
  serviceCharge?: number;
  /**
   * Orders this stands for. A till that sends one total per hour or per day (a file feed) sends one
   * record for many orders; absent is one.
   */
  orders?: number;
  /** A day's total with no hours: it counts to the day, not to any hour of it. */
  noHour?: boolean;
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

/** The instant a wall-clock time falls at in a time zone, as ISO: what a till's local report means. */
export function localInstant(date: string, hour: number, minute: number, timeZone: string): string {
  const naive = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), hour, minute);
  // The zone's offset at that moment, read back from Intl, then once more in case the first guess crossed a clock change.
  const offset = (at: number) => {
    const { date: d, hour: h } = localDateHour(new Date(at).toISOString(), timeZone);
    const minutes = new Date(at).getUTCMinutes();
    return Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)), h, minutes) - at;
  };
  const first = naive - offset(naive);
  return new Date(naive - offset(first)).toISOString();
}

export interface TradingDay {
  date: string;
  netSales: number;
  orders: number;
  hours: HourSales[];
  /** Card tips on the day's orders. Absent reads as none. */
  tips?: number;
  /** Service charge collected on the day's orders. Absent reads as none. */
  serviceCharge?: number;
}

/** One location's orders, by trading day and hour. */
export function tradingDays(orders: TillOrder[], timeZone: string): Map<string, TradingDay> {
  const days = new Map<string, { netSales: number; orders: number; tips: number; serviceCharge: number; hours: Map<number, HourSales> }>();
  for (const o of orders) {
    const { date, hour } = tradingHour(o.closedAt, timeZone);
    const day = days.get(date) ?? { netSales: 0, orders: 0, tips: 0, serviceCharge: 0, hours: new Map() };
    day.tips += o.tips ?? 0;
    day.serviceCharge += o.serviceCharge ?? 0;
    const count = o.orders ?? 1;
    day.netSales += o.netSales;
    day.orders += count;
    if (!o.noHour) {
      const h = day.hours.get(hour) ?? { hour, netSales: 0, orders: 0 };
      h.netSales += o.netSales;
      h.orders += count;
      day.hours.set(hour, h);
    }
    days.set(date, day);
  }
  return new Map(
    [...days].map(([date, d]) => [
      date,
      {
        date,
        netSales: round2(d.netSales),
        orders: d.orders,
        tips: round2(d.tips),
        serviceCharge: round2(d.serviceCharge),
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
    replace.set(date, { siteId, date, netSales: day?.netSales ?? 0, orders: day?.orders ?? 0, hours: day?.hours ?? [], source: 'till' });
  }
  return {
    sales: [...existing.filter((s) => !(s.siteId === siteId && replace.has(s.date))), ...replace.values()],
    written: replace.size,
    kept,
  };
}

/** The tips the till carries: card tips and service charge. Pooled cash never goes through it. */
export type TillTipSource = 'card-tip' | 'service-charge';

export interface TipsMerge {
  tips: TipsTaken[];
  /** Days whose figure the till set, changed or cleared. */
  written: number;
  /** Days a manager keyed in by hand. Their figure stands, as it does for takings. */
  kept: { siteId: string; date: string }[];
  /** Paid days where the till now says something different: for payroll to look at, never changed here. */
  paidDiffers: { siteId: string; date: string; paid: number; till: number }[];
}

/**
 * Writes one site's card tips, or service charge, from the till for each finished trading day in
 * `dates`, as the day's figure for that source. A figure keyed in by hand stands. A figure payroll
 * has marked paid is never changed: if the till has since moved (a tip adjusted, a charge refunded),
 * the difference is reported for payroll rather than rewriting what was paid. A day the till shows
 * none on has no figure.
 */
export function mergeTillTips(existing: TipsTaken[], siteId: string, dates: string[], days: Map<string, TradingDay>, source: TillTipSource = 'card-tip'): TipsMerge {
  const out: TipsMerge = { tips: existing, written: 0, kept: [], paidDiffers: [] };
  for (const date of dates) {
    const day = days.get(date);
    const till = round2((source === 'card-tip' ? day?.tips : day?.serviceCharge) ?? 0);
    const current = out.tips.find((t) => t.siteId === siteId && t.date === date && t.source === source);
    if (current?.paidOn) {
      if (current.amount !== till) out.paidDiffers.push({ siteId, date, paid: current.amount, till });
      continue;
    }
    if (current && !current.fromTill) {
      out.kept.push({ siteId, date });
      continue;
    }
    if ((current?.amount ?? 0) === till) continue;
    const others = out.tips.filter((t) => t !== current);
    out.tips = till > 0 ? [...others, { id: current?.id ?? `tip-${siteId}-${date}-${source}`, siteId, date, source, amount: till, fromTill: true }] : others;
    out.written++;
  }
  return out;
}
