import type { Booking, BookingStatus } from './types';
import { londonClock } from './time';

// Reading a booking system's export. ResDiary, SevenRooms and OpenTable all
// export bookings as CSV, each with its own column names and date styles, so
// the columns are found by name rather than position. Only the columns the
// forecast needs are read: names, phone numbers, emails and notes are never
// read, so they can never be stored.

type Field = 'ref' | 'date' | 'time' | 'covers' | 'status' | 'created' | 'cancelled';

const HEADERS: Record<Field, string[]> = {
  ref: ['reference', 'booking reference', 'booking ref', 'booking id', 'booking number', 'reservation id', 'reservation number', 'reservation reference', 'confirmation', 'confirmation number', 'conf', 'id'],
  date: ['date', 'booking date', 'reservation date', 'visit date', 'arrival date', 'date of visit', 'reservation datetime', 'booking datetime', 'visit', 'datetime'],
  time: ['time', 'booking time', 'reservation time', 'arrival time', 'start time', 'seating time', 'visit time'],
  // Not "party" or "state": those are as likely to be a guest name ("Smith party") or an address as a count or a status.
  covers: ['covers', 'party size', 'pax', 'guests', 'people', 'size', 'number of guests', 'no of guests', 'cover count', 'guest count', 'number of covers'],
  status: ['status', 'booking status', 'reservation status'],
  created: ['created', 'created date', 'created on', 'created at', 'date created', 'booked on', 'date booked', 'booking made', 'made on', 'booked at', 'booking created', 'creation date'],
  cancelled: ['cancelled', 'cancelled date', 'cancelled on', 'cancelled at', 'cancellation date', 'date cancelled', 'canceled at', 'canceled date'],
};

/** A cell quoted back in a problem, kept short: it goes back only to the person who uploaded the file. */
const quote = (v: string) => (v.length > 20 ? `${v.slice(0, 20)}…` : v);

const normal = (h: string) => h.toLowerCase().replace(/^﻿/, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** Splits CSV text into rows, honouring quotes, doubled quotes and line breaks inside quotes. Detects comma, semicolon or tab. */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^﻿/, '');
  const firstLine = clean.slice(0, clean.indexOf('\n') >= 0 ? clean.indexOf('\n') : clean.length);
  const delimiter = [',', ';', '\t'].map((d) => ({ d, n: firstLine.split(d).length })).sort((a, b) => b.n - a.n)[0].d;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (quoted) {
      if (c === '"' && clean[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && clean[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n: number) => String(n).padStart(2, '0');

/**
 * A date, and a time when the value carries one, from the styles booking
 * exports use: 2026-10-24, 24/10/2026 (or 10/24/2026 with usDates), 24-10-26,
 * 24 Oct 2026, Sat 24 Oct 2026, and any of those followed by a time. An
 * instant with a zone (Z or +01:00) is turned into London time.
 */
export function parseDateTime(raw: string, usDates = false): { date: string; minute?: number } | null {
  const v = raw.trim();
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(v)) {
    const c = londonClock(new Date(v).toISOString());
    return { date: c.date, minute: c.minute };
  }
  let date: string | null = null;
  let rest = v;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})[T ]?(.*)$/.exec(v);
  if (m) {
    date = `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
    rest = m[4];
  } else if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\s*(.*)$/.exec(v))) {
    const [a, b] = usDates ? [+m[2], +m[1]] : [+m[1], +m[2]];
    const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    date = `${year}-${pad(b)}-${pad(a)}`;
    rest = m[4];
  } else if ((m = /^(?:[a-z]{3,9},?\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?,?\s+(\d{2,4})\s*(.*)$/i.exec(v))) {
    const mon = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
    if (mon < 0) return null;
    const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    date = `${year}-${pad(mon + 1)}-${pad(+m[1])}`;
    rest = m[4];
  }
  if (!date || !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(date)) return null;
  // A real day: 31 February is refused rather than rolled into March.
  if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) return null;
  const minute = parseTime(rest);
  return minute === null ? { date } : { date, minute };
}

/** 19:30, 19.30, 7:30pm, 7pm, 1930. Null when there is no time. */
export function parseTime(raw: string): number | null {
  const v = raw.trim().toLowerCase().replace(/^at\s+/, '');
  if (!v) return null;
  const m = /^(\d{1,2})(?:[:.](\d{2}))?(?::\d{2})?\s*(am|pm)?$/.exec(v) ?? /^(\d{2})(\d{2})$/.exec(v);
  if (!m) return null;
  let h = +m[1];
  const min = m[2] ? +m[2] : 0;
  if (m[3] === 'pm' && h < 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function statusOf(raw: string): BookingStatus | 'skip' {
  const v = raw.trim().toLowerCase();
  if (!v) return 'booked';
  if (/cancel/.test(v)) return 'cancelled';
  if (/no.?show|did not (arrive|attend)|not arrived/.test(v)) return 'no_show';
  if (/wait.?list|enquir|inquir|request|declin|reject/.test(v)) return 'skip';
  if (/seat|arriv|complet|finish|left|paid|closed|depart/.test(v)) return 'completed';
  return 'booked';
}

export interface ImportResult {
  rows: Booking[];
  skipped: { line: number; reason: string }[];
  /** Which column each field was read from. */
  columns: Partial<Record<Field, string>>;
  /** Columns not read. Personal data in them is never kept. */
  ignored: string[];
}

/** Reads a booking export for one site. Returns the bookings it could read and why it skipped the rest. */
export function importBookings(csv: string, siteId: string, source: string, options: { usDates?: boolean } = {}): ImportResult {
  const table = parseCsv(csv);
  if (table.length === 0) return { rows: [], skipped: [{ line: 1, reason: 'The file is empty' }], columns: {}, ignored: [] };
  const headers = table[0].map(normal);
  const columns: Partial<Record<Field, string>> = {};
  const index: Partial<Record<Field, number>> = {};
  for (const field of Object.keys(HEADERS) as Field[]) {
    // Exact names first, so "date" is not taken for "date booked".
    const i = HEADERS[field].map((h) => headers.indexOf(h)).find((x) => x >= 0 && !Object.values(index).includes(x));
    if (i !== undefined) {
      index[field] = i;
      columns[field] = table[0][i].trim();
    }
  }
  const ignored = table[0].filter((_, i) => !Object.values(index).includes(i)).map((h) => h.trim());
  if (index.date === undefined || index.covers === undefined) {
    return { rows: [], skipped: [{ line: 1, reason: 'Could not find a date column and a covers (party size) column' }], columns, ignored };
  }

  const rows: Booking[] = [];
  const skipped: ImportResult['skipped'] = [];
  const seen = new Map<string, number>();
  table.slice(1).forEach((cells, i) => {
    const line = i + 2;
    const cell = (f: Field) => (index[f] === undefined ? '' : (cells[index[f]!] ?? '').trim());
    const when = parseDateTime(cell('date'), options.usDates);
    if (!when) return skipped.push({ line, reason: `Could not read the date "${quote(cell('date'))}"` });
    const minute = index.time !== undefined ? parseTime(cell('time')) : when.minute ?? null;
    if (minute === null) return skipped.push({ line, reason: 'No booking time' });
    const covers = Number(cell('covers').replace(/[^0-9.]/g, ''));
    if (!Number.isInteger(covers) || covers < 1 || covers > 500) return skipped.push({ line, reason: `Could not read the covers "${quote(cell('covers'))}"` });
    const status = statusOf(cell('status'));
    if (status === 'skip') return skipped.push({ line, reason: `Not a booking (${quote(cell('status'))})` });
    const created = index.created !== undefined ? parseDateTime(cell('created'), options.usDates) : null;
    const cancelled = index.cancelled !== undefined ? parseDateTime(cell('cancelled'), options.usDates) : null;
    // Without a reference, a booking is known by when and how many, counted, so the same file imported twice matches itself.
    let ref = cell('ref');
    if (!ref) {
      const base = `${when.date}T${minute}:${covers}`;
      const k = (seen.get(base) ?? 0) + 1;
      seen.set(base, k);
      ref = `${base}#${k}`;
    }
    rows.push({
      id: `${source}:${ref}`,
      siteId,
      source,
      date: when.date,
      startMinute: minute,
      covers,
      status,
      createdAt: created?.date,
      cancelledAt: status === 'cancelled' ? cancelled?.date : undefined,
    });
  });
  return { rows, skipped, columns, ignored };
}
