import { describe, expect, it } from 'vitest';
import { bookingAdjustments, bookingSignals, clipAround, compactBookings, coversOnBooks, mergeBookings, onBooksAt, paceAt, paceRow, PACE_LEADS } from './bookings';
import { planAhead } from './plan';
import { seedState } from './seed';
import { addDays } from './time';
import type { Booking, HourActual, HourForecast, RotaState } from './types';

const TODAY = '2026-10-21'; // a Wednesday
const SAT = '2026-10-24';

let n = 0;
/** A dinner booking for `covers`, made `madeDaysBefore` days ahead. */
const booking = (date: string, covers: number, madeDaysBefore: number, over: Partial<Booking> = {}): Booking => ({
  id: `rd:${n++}`,
  siteId: 'mar',
  source: 'resdiary',
  date,
  startMinute: 19 * 60,
  covers,
  status: 'completed',
  createdAt: `${addDays(date, -madeDaysBefore)}T12:00:00Z`,
  ...over,
});

/**
 * Twelve past Saturdays: 100 covers booked for dinner, filling steadily over three weeks,
 * and 130 covers served, so a normal Saturday dinner picks up 30 covers on the day.
 */
function history(): { bookings: Booking[]; actuals: HourActual[] } {
  const bookings: Booking[] = [];
  const actuals: HourActual[] = [];
  for (let w = 1; w <= 12; w++) {
    const date = addDays(SAT, -7 * w);
    for (let i = 0; i < 25; i++) bookings.push(booking(date, 4, Math.round((i / 25) * 21)));
    for (const hour of [17, 18, 19, 20]) actuals.push({ siteId: 'mar', date, hour, sales: 1300, covers: hour === 19 ? 40 : 30 });
  }
  return { bookings, actuals };
}

describe('what is on the books', () => {
  it('counts a booking from the day it was made until it is cancelled, in London time', () => {
    const b = booking(SAT, 4, 5, { status: 'booked' });
    expect(onBooksAt(b, addDays(SAT, -6))).toBe(false);
    expect(onBooksAt(b, addDays(SAT, -5))).toBe(true);
    const cancelled = { ...b, status: 'cancelled' as const, cancelledAt: `${addDays(SAT, -2)}T23:30:00Z` };
    // 23:30 UTC on the 22nd is 00:30 on the 23rd in London (summer time).
    expect(onBooksAt(cancelled, addDays(SAT, -2))).toBe(true);
    expect(onBooksAt(cancelled, addDays(SAT, -1))).toBe(false);
    expect(onBooksAt({ ...b, status: 'cancelled', cancelledAt: undefined }, SAT)).toBe(false);
    expect(onBooksAt({ ...b, status: 'no_show' }, SAT)).toBe(true);
    const unknown = { ...b, createdAt: undefined };
    expect(onBooksAt(unknown, addDays(SAT, -1))).toBe(false);
    expect(onBooksAt(unknown, SAT)).toBe(true);
  });

  it('remembers how a day filled up once the bookings are gone, and replaces a day imported again', () => {
    const { bookings } = history();
    const row = paceRow(bookings, 'mar', addDays(SAT, -7), 'dinner');
    expect(row.booked).toHaveLength(PACE_LEADS.length);
    expect(row.booked[0]).toBe(100);
    expect(paceAt(row, 0)).toBe(100);
    expect(paceAt(row, 8)).toBeGreaterThan(paceAt(row, 10));
    expect(paceAt(row, 8)).toBeLessThan(paceAt(row, 7));
    const compacted = compactBookings(bookings, [], TODAY);
    expect(compacted.bookings).toEqual([]);
    // One row per daypart of each loaded day, zero rows included.
    expect(compacted.pace).toHaveLength(12 * 5);
    const dinners = (p: typeof compacted.pace) => p.filter((r) => r.daypart === 'dinner');
    expect(dinners(compacted.pace).every((p) => p.booked[0] === 100)).toBe(true);
    // The same export imported again replaces each day; it never doubles it.
    const again = compactBookings(bookings, compacted.pace, TODAY);
    expect(dinners(again.pace)).toHaveLength(12);
    expect(dinners(again.pace).every((p) => p.booked[0] === 100)).toBe(true);
  });

  it('merges by booking reference', () => {
    const a = booking(SAT, 4, 3, { id: 'x', status: 'booked' });
    expect(mergeBookings([a], [{ ...a, covers: 6 }]).bookings).toEqual([{ ...a, covers: 6 }]);
  });

  it('never lets a single late update rebuild a day already in history', () => {
    const { bookings } = history();
    const { pace } = compactBookings(bookings, [], TODAY);
    const lastSat = addDays(SAT, -7);
    const late = booking(lastSat, 4, 10, { id: 'late', status: 'no_show' });
    const pushed = mergeBookings([], [late], pace, false);
    expect(pushed.ignored).toBe(1);
    const after = compactBookings(pushed.bookings, pace, TODAY).pace.find((p) => p.date === lastSat && p.daypart === 'dinner')!;
    expect(after.booked[0]).toBe(100);
    // A full export of the day may replace it.
    const exported = mergeBookings([], bookings.filter((b) => b.date === lastSat), pace, true);
    expect(exported.ignored).toBe(0);
  });
});

describe('booking signals', () => {
  const { bookings, actuals } = history();
  const { pace } = compactBookings(bookings, [], TODAY);

  it('expects what is booked now plus the pickup a normal day gets from this point', () => {
    // 150 covers on the books three days out, against about 90 usually by now.
    const ahead = Array.from({ length: 30 }, () => booking(SAT, 5, 10, { status: 'booked' }));
    const [dinner] = bookingSignals(ahead, pace, actuals, 'mar', SAT, SAT, TODAY).filter((s) => s.daypart === 'dinner');
    expect(dinner.booked).toBe(150);
    expect(dinner.lead).toBe(3);
    expect(dinner.comparables).toBe(12);
    expect(dinner.usualAtLead).toBeGreaterThan(80);
    expect(dinner.pickup).toBeGreaterThan(30);
    expect(dinner.expected).toBe(150 + dinner.pickup!);
    expect(dinner.pace).toBeGreaterThan(1.5);
    expect(dinner.usable).toBe(true);
  });

  it('moves only the walk-in part with the weather', () => {
    const ahead = Array.from({ length: 30 }, () => booking(SAT, 5, 10, { status: 'booked' }));
    const dry = bookingSignals(ahead, pace, actuals, 'mar', SAT, SAT, TODAY).find((s) => s.daypart === 'dinner')!;
    const wet = bookingSignals(ahead, pace, actuals, 'mar', SAT, SAT, TODAY, { weatherFactor: () => 0.5 }).find((s) => s.daypart === 'dinner')!;
    expect(wet.expected).toBe(150 + Math.round(dry.pickup! * 0.5));
  });

  it('needs four comparable days, and leaves unusual days out of them', () => {
    const fewer = bookingSignals([], pace.filter((p) => p.daypart === 'dinner').slice(0, 3), actuals, 'mar', SAT, SAT, TODAY).find((s) => s.daypart === 'dinner')!;
    expect(fewer.usable).toBe(false);
    expect(fewer.expected).toBeNull();
    const unusual = new Set(pace.filter((p) => p.daypart === 'dinner').slice(0, 10).map((p) => p.date));
    expect(bookingSignals([], pace, actuals, 'mar', SAT, SAT, TODAY, { unusual }).find((s) => s.daypart === 'dinner')!.comparables).toBe(2);
  });
});

describe('bookings in the forecast', () => {
  const base: HourForecast[] = [17, 18, 19, 20].map((hour) => ({ siteId: 'mar', date: SAT, hour, sales: 1300, covers: 30 }));
  const signal = { date: SAT, daypart: 'dinner' as const, label: 'Dinner', fromHour: 17, toHour: 21, lead: 3, booked: 150, usualAtLead: 90, pace: 1.67, pickup: 30, expected: 180, comparables: 12, bookedShare: 0.77, usable: true, largeParties: [] };

  it('sets expected covers against the model’s own covers for the daypart, with the evidence', () => {
    const [adj] = bookingAdjustments([signal], base, [], 'mar');
    expect(adj).toMatchObject({ source: 'bookings', fromHour: 17, toHour: 21, booked: 150, expected: 180, modelCovers: 120 });
    expect(adj.factor).toBeCloseTo(1.5);
    expect(adj.evidence).toMatch(/^150 covers booked for Saturday dinner\. At this point a normal Saturday had 90 on the books/);
  });

  it('leaves a person’s adjustment standing, and never divides by almost nothing', () => {
    const person = { id: 'p', siteId: 'mar', date: SAT, factor: 1.1, reason: 'event' as const, fromHour: 18, toHour: 22 };
    expect(bookingAdjustments([signal], base, [person], 'mar')).toEqual([]);
    expect(bookingAdjustments([signal], base.map((r) => ({ ...r, covers: 1 })), [], 'mar')).toEqual([]);
  });

  it('takes the booked hours out of other automatic effects so nothing counts twice', () => {
    const occasion = { id: 'o', siteId: 'mar', date: SAT, factor: 1.3, reason: 'event' as const, source: 'auto' as const, fromHour: 12, toHour: 24 };
    const clipped = clipAround([occasion], bookingAdjustments([signal], base, [], 'mar'));
    expect(clipped.map((a) => [a.fromHour, a.toHour])).toEqual([[12, 17], [21, 24]]);
  });
});

describe('booking reminders', () => {
  const { bookings, actuals } = history();
  const state = (extra: Booking[]): RotaState => {
    const s = seedState(TODAY);
    const compacted = compactBookings(bookings, [], TODAY);
    return { ...s, actuals: [...(s.actuals ?? []).filter((a) => a.siteId !== 'mar'), ...actuals], bookings: extra, bookingPace: compacted.pace };
  };

  it('reminds about a large party and about pace well ahead of normal', () => {
    const extra = [...Array.from({ length: 30 }, () => booking(SAT, 5, 10, { status: 'booked' })), booking(SAT, 24, 20, { id: 'party', status: 'booked', startMinute: 19 * 60 + 30 })];
    const plan = planAhead(state(extra), 'mar', TODAY, addDays(TODAY, 14), TODAY);
    const keys = plan.reminders.filter((r) => r.kind === 'bookings').map((r) => r.key);
    expect(keys).toContain('bookings:party:party');
    expect(keys).toContain(`bookings:pace:${SAT}:dinner`);
    const party = plan.reminders.find((r) => r.key === 'bookings:party:party')!;
    expect(party.title).toBe('Party of 24, 19:30');
    expect(plan.days.find((d) => d.date === SAT)!.bookings.find((b) => b.daypart === 'dinner')!.booked).toBe(174);
  });

  it('treats a day with no bookings loaded as unknown, not as empty', () => {
    const plan = planAhead(state([]), 'mar', TODAY, addDays(TODAY, 14), TODAY);
    expect(plan.reminders.some((r) => r.kind === 'bookings')).toBe(false);
    expect(plan.bookingSignals.every((s) => !s.usable)).toBe(true);
  });

  it('does not chase small numbers', () => {
    // Lunch: three covers booked where five is usual is 40% behind, but only two covers.
    const lunch = Array.from({ length: 30 }, () => booking(SAT, 5, 10, { status: 'booked' }));
    lunch.push(booking(SAT, 3, 10, { status: 'booked', startMinute: 12 * 60 }));
    const plan = planAhead(state(lunch), 'mar', TODAY, addDays(TODAY, 14), TODAY);
    expect(plan.reminders.some((r) => r.key === `bookings:pace:${SAT}:lunch`)).toBe(false);
  });

  it('does not chase a normal week', () => {
    const extra = Array.from({ length: 18 }, () => booking(SAT, 5, 10, { status: 'booked' }));
    const plan = planAhead(state(extra), 'mar', TODAY, addDays(TODAY, 14), TODAY);
    expect(plan.reminders.some((r) => r.key.startsWith('bookings:pace'))).toBe(false);
    expect(coversOnBooks(extra, 'mar', SAT, 'dinner', TODAY)).toBe(90);
  });
});
