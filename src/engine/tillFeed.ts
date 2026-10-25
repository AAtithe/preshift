import { parseCsv } from './bookingImport';
import { localInstant, TRADING_DAY_STARTS, type TillOrder } from './epos';
import { addDays } from './time';

// A till's sales as a file: the daily export Zonal sets up through the account manager, or a report
// scheduled from the Tevalis portal, posted to Preshift by the feed or uploaded by a manager. One row
// per site per trading day, or per hour of it. Columns are found by name, so either till's own
// export is read as it comes.

export interface TillFeedRow {
  /** The till's own reference for the site. */
  locationId: string;
  locationName?: string;
  /** The trading day the till reports it under. */
  date: string;
  /** Hour of the trading day, 0 to 23 as the till prints it, or 24 and on for after midnight. Absent: a day's total. */
  hour?: number;
  netSales: number;
  tips: number;
  serviceCharge: number;
  orders: number;
}

export interface TillFeedRead {
  rows: TillFeedRow[];
  /** Rows that could not be read, each with why, by line number in the file. */
  problems: { line: number; message: string }[];
}

const COLUMNS: Record<keyof Omit<TillFeedRow, 'hour'> | 'hour', string[]> = {
  locationId: ['site ref', 'site reference', 'site id', 'site code', 'site no', 'site number', 'location id', 'location ref', 'venue id', 'venue ref', 'outlet id', 'store id', 'site'],
  locationName: ['site name', 'location name', 'location', 'venue name', 'venue', 'outlet name', 'outlet', 'store name'],
  date: ['trading date', 'trading day', 'business date', 'business day', 'session date', 'date'],
  hour: ['hour', 'trading hour', 'time', 'time band', 'hour band', 'period'],
  netSales: ['net sales', 'sales net', 'net sales ex vat', 'net ex vat', 'sales ex vat', 'net revenue', 'total net', 'net amount', 'net'],
  tips: ['tips', 'tip', 'gratuity', 'gratuities', 'card tips'],
  serviceCharge: ['service charge', 'service', 'service charges', 'service chg'],
  orders: ['transactions', 'checks', 'bills', 'orders', 'tickets', 'covers', 'count'],
};

const normal = (h: string) => h.toLowerCase().replace(/^﻿/, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** Money as tills print it: £1,234.50, (12.00) for a refund, or plain. */
function money(v: string | undefined): number | null {
  if (v === undefined) return 0;
  const t = v.trim();
  if (!t) return 0;
  const negative = /^\(.*\)$/.test(t) || t.startsWith('-');
  const n = Number(t.replace(/[£$,()\s-]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round((negative ? -n : n) * 100) / 100;
}

/** 2026-10-23, 23/10/2026 or 23-10-2026 (UK day first). */
function day(v: string | undefined): string | null {
  const t = (v ?? '').trim().slice(0, 10);
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

/** 13, 13:00, 13:00-14:00 or 1pm: the hour the row starts. */
function hourOf(v: string | undefined): number | null | undefined {
  const t = (v ?? '').trim().toLowerCase();
  if (!t) return undefined;
  const pm = /^(\d{1,2})\s*(am|pm)/.exec(t);
  if (pm) return (Number(pm[1]) % 12) + (pm[2] === 'pm' ? 12 : 0);
  const m = /^(\d{1,2})(?::\d{2})?/.exec(t);
  if (!m) return null;
  const h = Number(m[1]);
  return h <= 47 ? h : null;
}

/** Reads a till's export: CSV with a header row, or JSON as `{ rows: [...] }` with the same names. */
export function parseTillFeed(input: string | { rows: Record<string, unknown>[] }): TillFeedRead {
  const table: string[][] =
    typeof input === 'string'
      ? parseCsv(input)
      : (() => {
          const keys = [...new Set(input.rows.flatMap((r) => Object.keys(r)))];
          return [keys, ...input.rows.map((r) => keys.map((k) => (r[k] === undefined || r[k] === null ? '' : String(r[k]))))];
        })();
  const header = (table[0] ?? []).map(normal);
  const col = (k: keyof typeof COLUMNS) => {
    for (const name of COLUMNS[k]) {
      const i = header.indexOf(name);
      if (i >= 0) return i;
    }
    return -1;
  };
  const at = Object.fromEntries((Object.keys(COLUMNS) as (keyof typeof COLUMNS)[]).map((k) => [k, col(k)])) as Record<keyof typeof COLUMNS, number>;
  // "site" is the reference unless a separate reference column exists, and then it is the name.
  if (at.locationName < 0 && at.locationId >= 0 && header[at.locationId] === 'site' && header.some((h) => h === 'site name')) at.locationName = header.indexOf('site name');
  const out: TillFeedRead = { rows: [], problems: [] };
  const missing = (['locationId', 'date', 'netSales'] as const).filter((k) => at[k] < 0);
  if (missing.length) {
    out.problems.push({ line: 1, message: `The file has no ${missing.map((k) => ({ locationId: 'site reference', date: 'trading date', netSales: 'net sales' })[k]).join(', ')} column.` });
    return out;
  }
  table.slice(1).forEach((cells, i) => {
    const line = i + 2;
    if (cells.every((c) => !c.trim())) return;
    const cell = (k: keyof typeof COLUMNS) => (at[k] >= 0 ? cells[at[k]] : undefined);
    const locationId = (cell('locationId') ?? '').trim();
    // A totals line at the foot of a report is not a site.
    if (!locationId || /^(grand )?total/i.test(locationId)) return;
    const date = day(cell('date'));
    if (!date) return void out.problems.push({ line, message: `"${(cell('date') ?? '').slice(0, 20)}" is not a date.` });
    const hour = hourOf(cell('hour'));
    if (hour === null) return void out.problems.push({ line, message: `"${(cell('hour') ?? '').slice(0, 20)}" is not an hour.` });
    const netSales = money(cell('netSales'));
    const tips = money(cell('tips'));
    const serviceCharge = money(cell('serviceCharge'));
    if (netSales === null || tips === null || serviceCharge === null) return void out.problems.push({ line, message: 'An amount is not a number.' });
    const orders = Math.max(0, Math.round(Number((cell('orders') ?? '').replace(/,/g, '')) || 0));
    const name = cell('locationName')?.trim();
    out.rows.push({ locationId, ...(name ? { locationName: name } : {}), date, ...(hour !== undefined ? { hour } : {}), netSales, tips, serviceCharge, orders });
  });
  return out;
}

/**
 * Feed rows as till orders, so they run through the same trading day rules as any till. A row's date
 * is the till's trading day: an hour before the trading day starts (01:00 under Friday) is the next
 * calendar morning, as is hour 24 and on. A day's total counts to the day and to no hour.
 */
export function feedOrders(rows: TillFeedRow[], timeZoneOf: (locationId: string) => string): TillOrder[] {
  return rows.map((r) => {
    const zone = timeZoneOf(r.locationId);
    const base = { locationId: r.locationId, netSales: r.netSales, tips: r.tips, serviceCharge: r.serviceCharge, orders: r.orders };
    if (r.hour === undefined) return { ...base, closedAt: localInstant(r.date, 12, 0, zone), noHour: true };
    const late = r.hour >= 24 || r.hour < TRADING_DAY_STARTS;
    const hour = r.hour >= 24 ? r.hour - 24 : r.hour;
    return { ...base, closedAt: localInstant(late ? addDays(r.date, 1) : r.date, hour, 30, zone) };
  });
}
