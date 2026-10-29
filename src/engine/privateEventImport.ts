import { parseCsv, parseDateTime, parseTime } from './bookingImport';
import type { PrivateEvent, PrivateEventKind, PrivateEventStatus, PrivateEventStyle } from './types';

// Reading an events system's export. Tripleseat and SevenRooms (and Perfect Venue,
// Collins and the rest) export events as CSV with their own column names, so columns
// are found by name, as for table bookings. Only what the rota needs is read: the
// event's name, the client, their contacts and the notes are never read, so they are
// never stored. An event's name is left behind too: "Smith wedding" is a person.

type Field = 'ref' | 'date' | 'start' | 'end' | 'guests' | 'status' | 'type' | 'style' | 'space' | 'spend' | 'exclusive';

const HEADERS: Record<Field, string[]> = {
  ref: ['event id', 'event number', 'event reference', 'booking id', 'booking reference', 'reference', 'reservation id', 'lead id', 'id'],
  date: ['event date', 'date', 'start date', 'event start date', 'event start', 'start'],
  start: ['start time', 'event start time', 'arrival time', 'time', 'from'],
  end: ['end time', 'event end time', 'finish time', 'end', 'to'],
  guests: ['guest count', 'guaranteed guest count', 'guaranteed guests', 'expected guests', 'guests', 'attendees', 'headcount', 'party size', 'covers', 'pax', 'number of guests'],
  status: ['status', 'event status', 'booking status'],
  type: ['event type', 'type', 'occasion', 'event category', 'category'],
  style: ['event style', 'style', 'service style', 'format', 'service type'],
  space: ['room', 'rooms', 'room s', 'space', 'spaces', 'area', 'venue space', 'location'],
  spend: ['grand total', 'event total', 'total', 'estimated revenue', 'revenue', 'minimum spend', 'min spend', 'food and beverage minimum', 'f b minimum', 'value'],
  exclusive: ['exclusive', 'exclusive use', 'buyout', 'buy out'],
};

const quote = (v: string) => (v.length > 20 ? `${v.slice(0, 20)}…` : v);
const normal = (h: string) => h.toLowerCase().replace(/^﻿/, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** Tripleseat's Definite, Tentative, Prospect and Lost; SevenRooms' Confirmed, Hold and Cancelled; and the like. */
export function statusOf(raw: string): PrivateEventStatus {
  const v = raw.trim().toLowerCase();
  if (/cancel|lost|declin|turn(ed)? down|dead|void/.test(v)) return 'cancelled';
  if (/tentativ|provisional|hold|option|pencil/.test(v)) return 'provisional';
  if (/prospect|lead|enquir|inquir|new|qualif|proposal/.test(v)) return 'enquiry';
  // Definite, confirmed, booked, closed (it has happened) and a blank status are on.
  return 'confirmed';
}

export function kindOf(raw: string): PrivateEventKind {
  const v = raw.toLowerCase();
  if (/wedding|civil partnership|ceremony/.test(v)) return 'wedding';
  if (/buy.?out|exclusive|private hire|takeover|full venue/.test(v)) return 'private_hire';
  if (/corporate|meeting|conference|business|launch|offsite|seminar|presentation|work/.test(v)) return 'corporate';
  if (/party|birthday|celebrat|christening|engagement|anniversary|wake|funeral|graduation|shower|hen|stag/.test(v)) return 'party';
  return 'other';
}

export function styleOf(raw: string, fallback: PrivateEventStyle = 'seated'): PrivateEventStyle {
  const v = raw.toLowerCase();
  // Food is read first: "canapés and drinks" still needs a kitchen. Drinks only when nothing says food.
  if (/seat|sit.?down|plated|dinner|lunch|breakfast|banquet|set menu|tasting menu/.test(v)) return 'seated';
  if (/buffet|bbq|barbecue|family.?style|sharing|grazing/.test(v)) return 'buffet';
  if (/canap|standing|stand.?up|bowl food|flying|finger food/.test(v)) return 'standing';
  if (/drinks|bar tab|cocktail|wine tasting|reception/.test(v)) return 'drinks';
  return fallback;
}

const YES = /^(y|yes|true|1|x|exclusive|buyout)$/i;
const WHOLE_SITE = /whole|entire|exclusive|buy.?out|full venue|all (rooms|areas|spaces)/i;

/** How long an event runs when the export gives no end time. */
const DEFAULT_LENGTH: Record<PrivateEventKind, number> = { wedding: 7 * 60, private_hire: 5 * 60, party: 4 * 60, corporate: 4 * 60, other: 4 * 60 };

export interface EventImportResult {
  rows: PrivateEvent[];
  skipped: { line: number; reason: string }[];
  columns: Partial<Record<Field, string>>;
  /** Columns not read. The client's details in them are never kept. */
  ignored: string[];
}

export interface EventImportOptions {
  usDates?: boolean;
  /** Totals in the file include VAT, as a grand total does: they are taken back to net. */
  spendIncludesVat?: boolean;
}

/** Reads an events export for one site. Returns the events it could read and why it skipped the rest. */
export function importPrivateEvents(csv: string, siteId: string, source: string, options: EventImportOptions = {}): EventImportResult {
  const table = parseCsv(csv);
  if (table.length === 0) return { rows: [], skipped: [{ line: 1, reason: 'The file is empty' }], columns: {}, ignored: [] };
  const headers = table[0].map(normal);
  const columns: Partial<Record<Field, string>> = {};
  const index: Partial<Record<Field, number>> = {};
  for (const field of Object.keys(HEADERS) as Field[]) {
    const i = HEADERS[field].map((h) => headers.indexOf(h)).find((x) => x >= 0 && !Object.values(index).includes(x));
    if (i !== undefined) {
      index[field] = i;
      columns[field] = table[0][i].trim();
    }
  }
  const ignored = table[0].filter((_, i) => !Object.values(index).includes(i)).map((h) => h.trim());
  if (index.date === undefined || index.guests === undefined) {
    return { rows: [], skipped: [{ line: 1, reason: 'Could not find an event date column and a guest count column' }], columns, ignored };
  }
  const vat = options.spendIncludesVat === false ? 1 : 1.2;

  const rows: PrivateEvent[] = [];
  const skipped: EventImportResult['skipped'] = [];
  const seen = new Map<string, number>();
  table.slice(1).forEach((cells, i) => {
    const line = i + 2;
    const cell = (f: Field) => (index[f] === undefined ? '' : (cells[index[f]!] ?? '').trim());
    const when = parseDateTime(cell('date'), options.usDates);
    if (!when) return skipped.push({ line, reason: `Could not read the date "${quote(cell('date'))}"` });
    const start = index.start !== undefined && cell('start') ? parseTime(cell('start')) : when.minute ?? null;
    if (start === null) return skipped.push({ line, reason: 'No start time' });
    const guests = Number(cell('guests').replace(/[^0-9.]/g, ''));
    if (!Number.isInteger(guests) || guests < 1 || guests > 5000) return skipped.push({ line, reason: `Could not read the guests "${quote(cell('guests'))}"` });
    const kind = kindOf(cell('type'));
    const space = cell('space').slice(0, 60) || undefined;
    const exclusive = YES.test(cell('exclusive')) || kind === 'private_hire' || WHOLE_SITE.test(cell('space')) || WHOLE_SITE.test(cell('type'));
    // An end written as the clock shows it: 01:00 after a 19:00 start is the small hours, not the morning before.
    let end = index.end !== undefined && cell('end') ? (parseDateTime(cell('end'), options.usDates)?.minute ?? parseTime(cell('end'))) : null;
    if (end === null || end === undefined) end = start + DEFAULT_LENGTH[kind];
    else if (end <= start) end += 1440;
    const spendRaw = Number(cell('spend').replace(/[^0-9.-]/g, ''));
    const spend = cell('spend') && Number.isFinite(spendRaw) && spendRaw > 0 ? Math.round((spendRaw / vat) * 100) / 100 : undefined;
    let ref = cell('ref');
    if (!ref) {
      const base = `${when.date}T${start}:${guests}`;
      const k = (seen.get(base) ?? 0) + 1;
      seen.set(base, k);
      ref = `${base}#${k}`;
    }
    rows.push({
      id: `${source}:${ref}`,
      siteId,
      source,
      date: when.date,
      startMinute: start,
      endMinute: end,
      guests,
      kind,
      style: styleOf(`${cell('style')} ${index.style === undefined ? cell('type') : ''}`),
      status: statusOf(cell('status')),
      exclusive,
      ...(space ? { space } : {}),
      ...(spend ? { spend } : {}),
    });
  });
  return { rows, skipped, columns, ignored };
}
