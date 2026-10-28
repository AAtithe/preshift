import { weekday } from './time';
import type { DayNote, DayNoteKind } from './types';

// Notes on days at a site: the big booking, the match, the road closure, the Tuesday delivery.
// One day can carry several, a note can repeat every week, and a note marked for the team is
// shown to the people working that day as well as to whoever builds the rota.

export const NOTE_KINDS: { id: DayNoteKind; label: string }[] = [
  { id: 'booking', label: 'Booking' },
  { id: 'event', label: 'Event' },
  { id: 'closure', label: 'Closure' },
  { id: 'delivery', label: 'Delivery' },
  { id: 'staffing', label: 'Staffing' },
  { id: 'other', label: 'Note' },
];

export const noteKindLabel = (kind: DayNoteKind) => NOTE_KINDS.find((k) => k.id === kind)?.label ?? 'Note';

/** Whether a note is for a day: its own date, or every week on the same weekday while it repeats. */
export function occursOn(note: DayNote, date: string): boolean {
  if (date < note.date) return false;
  if (!note.weekly) return date === note.date;
  if (note.until && date > note.until) return false;
  return weekday(date) === weekday(note.date);
}

/** Whether a note is for any day from `from` to `to`, inclusive, without walking the days. */
export function overlaps(note: DayNote, from: string, to: string): boolean {
  if (note.date > to) return false;
  return note.weekly ? !note.until || note.until >= from : note.date >= from;
}

/** A site's notes for one day: all-day notes first, then by the time they happen. */
export function notesOn(notes: readonly DayNote[], siteId: string, date: string, only?: { team: boolean }): DayNote[] {
  return notes
    .filter((n) => n.siteId === siteId && occursOn(n, date) && (!only?.team || n.team))
    .sort((a, b) => (a.startMinute ?? -1) - (b.startMinute ?? -1) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}

/** A note as the team sees it: what it is, when, and what it says, never who wrote it. */
export const teamView = (n: DayNote) => ({ id: n.id, kind: noteKindLabel(n.kind), startMinute: n.startMinute ?? null, text: n.text });
