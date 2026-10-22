import type { Booking, BookingPace, ForecastAdjustment, HourActual, HourForecast } from './types';
import { DAYPARTS, daypartOf, type Daypart } from './forecast';
import { addDays, daysBetween, londonDate, weekday } from './time';

// Bookings: covers already on the books beat any model. For each site and
// daypart the engine knows how many covers are booked now, how many were on
// the books at the same point before comparable days, and what those days
// finally did at the till. The difference is the pickup (walk-ins and late
// bookings, less no-shows and late cancellations), learnt from the site's
// own history. Expected covers are what is booked now plus that pickup.

/** Lead times, in days, at which a past day's bookings are remembered once the bookings themselves are dropped. */
export const PACE_LEADS = [0, 1, 2, 3, 4, 5, 6, 7, 10, 14, 21, 28, 35, 42];
/** Bookings this far ahead or nearer move the forecast; further out they are shown but not used. */
export const MAX_LEAD = 42;
/** A party this size or larger gets its own reminder. */
export const LARGE_PARTY = 12;
/** The model needs at least this many covers in a daypart before bookings are set against it. */
export const MIN_MODEL_COVERS = 5;
/** Comparable past days needed before pickup is trusted. */
export const MIN_COMPARABLES = 4;

const round = (n: number) => Math.round(n);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** The London date a timestamp falls on; plain dates pass through. */
const dayOf = (iso: string) => (iso.length <= 10 ? iso : londonDate(iso));

/**
 * Whether a booking was on the books at the end of a given day. A booking with
 * no made date counts only on its own day; a cancelled one with no cancelled
 * date never counts; a no-show counts, because it was booked.
 */
export function onBooksAt(b: Booking, asOf: string): boolean {
  if (b.status === 'cancelled' && !b.cancelledAt) return false;
  const made = b.createdAt ? dayOf(b.createdAt) : b.date;
  if (made > asOf) return false;
  if (b.cancelledAt && dayOf(b.cancelledAt) <= asOf) return false;
  return true;
}

export const daypartOfBooking = (b: Pick<Booking, 'startMinute'>) => daypartOf(Math.floor(b.startMinute / 60) % 24);

/** Covers on the books for a date and daypart, as at the end of `asOf`. */
export function coversOnBooks(bookings: Booking[], siteId: string, date: string, daypart: Daypart['id'], asOf: string): number {
  let covers = 0;
  for (const b of bookings) {
    if (b.siteId === siteId && b.date === date && daypartOfBooking(b).id === daypart && onBooksAt(b, asOf)) covers += b.covers;
  }
  return covers;
}

/** A pace row for one date and daypart, built from its bookings. */
export function paceRow(bookings: Booking[], siteId: string, date: string, daypart: Daypart['id']): BookingPace {
  return { siteId, date, daypart, booked: PACE_LEADS.map((lead) => coversOnBooks(bookings, siteId, date, daypart, addDays(date, -lead))), leads: [...PACE_LEADS] };
}

/** Covers on the books at any lead, read from a pace row, interpolating between the remembered leads. */
export function paceAt(row: BookingPace, lead: number): number {
  const leads = row.leads ?? PACE_LEADS;
  if (lead <= 0) return row.booked[0];
  for (let i = 1; i < leads.length; i++) {
    if (lead <= leads[i]) {
      const [l0, l1] = [leads[i - 1], leads[i]];
      const t = (lead - l0) / (l1 - l0);
      return row.booked[i - 1] + (row.booked[i] - row.booked[i - 1]) * t;
    }
  }
  return row.booked[row.booked.length - 1];
}

/**
 * Turns bookings for days more than `keepDays` gone into pace rows and drops
 * them, so storage stays small and no booking detail is kept for long. A day
 * imported again replaces its pace row rather than adding to it, so history
 * imports by date range can be repeated safely.
 */
export function compactBookings(bookings: Booking[], pace: BookingPace[], today: string, keepDays = 2): { bookings: Booking[]; pace: BookingPace[] } {
  const cutoff = addDays(today, -keepDays);
  const old = bookings.filter((b) => b.date < cutoff);
  if (old.length === 0) return { bookings, pace };
  const groups = new Map<string, { siteId: string; date: string }>();
  for (const b of old) groups.set(`${b.siteId}|${b.date}`, { siteId: b.siteId, date: b.date });
  const rows: BookingPace[] = [];
  for (const { siteId, date } of groups.values()) {
    const day = old.filter((b) => b.siteId === siteId && b.date === date);
    // Every daypart of a loaded day gets a row, zero included: a dinner nobody booked is still a comparable day.
    for (const dp of DAYPARTS) rows.push(paceRow(day, siteId, date, dp.id));
  }
  const replaced = new Set(groups.keys());
  return {
    bookings: bookings.filter((b) => b.date >= cutoff),
    pace: [...pace.filter((p) => !replaced.has(`${p.siteId}|${p.date}`)), ...rows].sort((a, b) => a.siteId.localeCompare(b.siteId) || a.date.localeCompare(b.date)),
  };
}

/**
 * Lays incoming bookings over those held, by id. A day already compacted into
 * pace history is replaced only by a full export (`replaceHistory`), which
 * carries every booking for each day in it. A push of single bookings for such
 * a day (a no-show marked the morning after) is left out, because rebuilding
 * the day from it would throw the real history away.
 */
export function mergeBookings(held: Booking[], incoming: Booking[], pace: BookingPace[] = [], replaceHistory = false): { bookings: Booking[]; ignored: number } {
  const compacted = new Set(pace.map((p) => `${p.siteId}|${p.date}`));
  const accepted = replaceHistory ? incoming : incoming.filter((b) => !compacted.has(`${b.siteId}|${b.date}`));
  const ids = new Set(accepted.map((b) => b.id));
  return { bookings: [...held.filter((b) => !ids.has(b.id)), ...accepted], ignored: incoming.length - accepted.length };
}

export interface BookingSignal {
  date: string;
  daypart: Daypart['id'];
  label: string;
  fromHour: number;
  toHour: number;
  lead: number;
  /** Covers on the books now. */
  booked: number;
  /** Average covers on the books at the same lead before comparable days. */
  usualAtLead: number | null;
  /** Booked now against usual at this point: 1.4 is forty per cent ahead. */
  pace: number | null;
  /** Average covers comparable days went on to add (walk-ins, late bookings, less no-shows). */
  pickup: number | null;
  /** Booked now plus pickup, with the weather applied to the walk-in part. */
  expected: number | null;
  comparables: number;
  /** Share of a comparable day's covers that came from bookings. */
  bookedShare: number | null;
  /** Whether it is solid enough to move the forecast. */
  usable: boolean;
  /** Parties of LARGE_PARTY or more. */
  largeParties: { id: string; covers: number; startMinute: number }[];
}

export interface SignalOptions {
  /** Days not to learn from: occasions, events, closures. */
  unusual?: Set<string>;
  /** What the weather does to walk-ins on a date, from the site's learnt effect. */
  weatherFactor?: (date: string) => number;
  /** How far back comparable days are taken from. */
  weeks?: number;
  /** What the weather did to each past day, taken out of comparable days so it is not counted again. */
  historyFactors?: Map<string, number>;
}

/** Covers a site actually served in a daypart, from the till. Hours after midnight count as late, as bookings at those hours do. */
function actualCovers(actuals: Map<string, number>, date: string, dp: Daypart): number {
  let total = 0;
  for (let h = 0; h < 24; h++) if (daypartOf(h).id === dp.id) total += actuals.get(`${date}|${h}`) ?? 0;
  return total;
}

/**
 * What the books say about each daypart from `from` to `to` at a site. Pickup
 * is learnt from the same weekday and daypart over recent weeks, leaving out
 * unusual days, as the till's final covers less what was on the books at the
 * same lead time.
 */
export function bookingSignals(
  bookings: Booking[],
  pace: BookingPace[],
  actualRows: HourActual[],
  siteId: string,
  from: string,
  to: string,
  today: string,
  options: SignalOptions = {},
): BookingSignal[] {
  const weeks = options.weeks ?? 12;
  const unusual = options.unusual ?? new Set<string>();
  const covers = new Map<string, number>();
  for (const a of actualRows) if (a.siteId === siteId) covers.set(`${a.date}|${a.hour}`, a.covers);
  const mine = bookings.filter((b) => b.siteId === siteId);
  const history = pace.filter((p) => p.siteId === siteId && p.date < today && p.date >= addDays(today, -7 * weeks) && !unusual.has(p.date));
  const out: BookingSignal[] = [];

  for (let date = from < today ? today : from; date <= to; date = addDays(date, 1)) {
    const lead = daysBetween(today, date);
    // A day with no bookings at all is unknown, not empty: the books may simply not have been loaded for it.
    const covered = mine.some((b) => b.date === date);
    for (const dp of DAYPARTS) {
      const day = mine.filter((b) => b.date === date && daypartOfBooking(b).id === dp.id);
      const comps = history
        .filter((p) => p.daypart === dp.id && weekday(p.date) === weekday(date))
        .map((p) => {
          // The weather moved the walk-ins that day, not the bookings, so only the walk-in part has it taken out.
          const actual = actualCovers(covers, p.date, dp);
          const booked0 = Math.min(actual, paceAt(p, 0));
          return { row: p, actual: booked0 + (actual - booked0) / (options.historyFactors?.get(p.date) ?? 1) };
        })
        .filter((c) => c.actual > 0);
      if (day.length === 0 && comps.length === 0) continue;
      const booked = day.filter((b) => onBooksAt(b, today)).reduce((s, b) => s + b.covers, 0);
      const enough = comps.length >= MIN_COMPARABLES;
      const usualAtLead = enough ? mean(comps.map((c) => paceAt(c.row, lead))) : null;
      const pickup = enough ? mean(comps.map((c) => c.actual - paceAt(c.row, lead))) : null;
      const bookedShare = enough ? mean(comps.map((c) => paceAt(c.row, 0))) / mean(comps.map((c) => c.actual)) : null;
      const wf = options.weatherFactor?.(date) ?? 1;
      // Bookings are bookings whatever the weather; walk-ins are not, so the weather moves only the pickup.
      const expected = pickup === null ? null : Math.max(0.5 * booked, booked + (pickup > 0 ? pickup * wf : pickup));
      out.push({
        date,
        daypart: dp.id,
        label: dp.label,
        fromHour: dp.from,
        toHour: dp.to,
        lead,
        booked,
        usualAtLead: usualAtLead === null ? null : round(usualAtLead),
        pace: usualAtLead ? booked / usualAtLead : null,
        pickup: pickup === null ? null : round(pickup),
        expected: expected === null ? null : round(expected),
        comparables: comps.length,
        bookedShare,
        // A walk-in site with a handful of bookings learns nothing from them; a booking-led one does.
        usable: covered && enough && lead <= MAX_LEAD && ((bookedShare ?? 0) >= 0.25 || booked >= 20),
        largeParties: day.filter((b) => b.covers >= LARGE_PARTY && onBooksAt(b, today)).map((b) => ({ id: b.id, covers: b.covers, startMinute: b.startMinute })),
      });
    }
  }
  return out;
}

/** The model's covers for a daypart on a date, from forecast rows. */
function modelCovers(rows: HourForecast[], date: string, from: number, to: number): number {
  return rows.filter((r) => r.date === date && r.hour >= from && r.hour < to).reduce((s, r) => s + r.covers, 0);
}

export interface BookingAdjustment extends ForecastAdjustment {
  source: 'bookings';
  evidence: string;
  booked: number;
  expected: number;
  modelCovers: number;
}

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/**
 * Turns usable signals into adjustments: expected covers over the model's own
 * covers for the daypart, before any occasion, event or weather effect (the
 * bookings already carry those). Where a person has set an adjustment on
 * those hours, theirs stands and the bookings are only shown.
 */
export function bookingAdjustments(signals: BookingSignal[], baseRows: HourForecast[], people: ForecastAdjustment[], siteId: string): BookingAdjustment[] {
  const out: BookingAdjustment[] = [];
  for (const s of signals) {
    if (!s.usable || s.expected === null) continue;
    const overlapsPerson = people.some((a) => a.siteId === siteId && a.date === s.date && (a.fromHour ?? 0) < s.toHour && (a.toHour ?? 24) > s.fromHour);
    if (overlapsPerson) continue;
    const model = modelCovers(baseRows, s.date, s.fromHour, s.toHour);
    // Too few covers in the model to divide by: a ratio of near nothing would be wild.
    if (model < MIN_MODEL_COVERS) continue;
    const factor = Math.min(4, Math.max(0.3, s.expected / model));
    if (Math.abs(factor - 1) < 0.03) continue;
    const day = DAY_NAMES[weekday(s.date)];
    out.push({
      id: `bookings:${s.date}:${s.daypart}`,
      siteId,
      date: s.date,
      factor,
      reason: 'event',
      source: 'bookings',
      fromHour: s.fromHour,
      toHour: s.toHour,
      note: `${s.label} bookings`,
      booked: s.booked,
      expected: s.expected,
      modelCovers: model,
      evidence:
        `${s.booked} covers booked for ${day} ${s.label.toLowerCase()}. At this point a normal ${day} had ${s.usualAtLead} on the books ` +
        `and went on to ${s.pickup! >= 0 ? 'add' : 'lose'} ${Math.abs(s.pickup!)} (walk-ins and late bookings, less no-shows). ` +
        `Expect ${s.expected} covers; the model alone said ${model}.`,
    });
  }
  return out;
}

/**
 * Takes the hours the bookings speak for out of other automatic adjustments on
 * the same date: the bookings already reflect the occasion, the event and the
 * weather, so applying those as well would count them twice.
 */
export function clipAround<T extends ForecastAdjustment>(adjustments: T[], bookings: ForecastAdjustment[]): T[] {
  const out: T[] = [];
  for (const a of adjustments) {
    let pieces: [number, number][] = [[a.fromHour ?? 0, a.toHour ?? 24]];
    for (const b of bookings.filter((x) => x.date === a.date)) {
      const [bf, bt] = [b.fromHour ?? 0, b.toHour ?? 24];
      pieces = pieces.flatMap(([f, t]) => {
        if (bt <= f || bf >= t) return [[f, t] as [number, number]];
        return ([[f, bf], [bt, t]] as [number, number][]).filter(([x, y]) => y > x);
      });
    }
    pieces.forEach(([f, t], i) => out.push({ ...a, id: pieces.length > 1 ? `${a.id}#${i}` : a.id, fromHour: f, toHour: t }));
  }
  return out;
}
