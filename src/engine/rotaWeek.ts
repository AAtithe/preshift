import type { Shift } from './types';
import { weekDates } from './time';

/** A moment in UK wall-clock time, as londonParts gives it. */
export interface LondonNow {
  date: string;
  minute: number;
}

/**
 * Whether a shift has already started. Started shifts are history: people have
 * clocked against them, and timesheets and payroll hang off them, so drafting
 * tools leave them exactly as they are.
 */
export function hasStarted(shift: Pick<Shift, 'date' | 'startMinute'>, now: LondonNow): boolean {
  return shift.date < now.date || (shift.date === now.date && shift.startMinute <= now.minute);
}

/**
 * A short fingerprint of one site's week. A draft records the fingerprint it
 * started from; saving it is refused if the week has changed since, so an
 * accepted draft never silently overwrites someone else's edits.
 */
export function weekFingerprint(shifts: Shift[], siteId: string, weekStartDate: string): string {
  const dates = new Set(weekDates(weekStartDate));
  const rows = shifts
    .filter((s) => s.siteId === siteId && dates.has(s.date))
    .map((s) => [s.id, s.employeeId, s.roleId, s.date, s.startMinute, s.endMinute, s.breakMinutes].join('|'))
    .sort();
  // FNV-1a: tiny, deterministic, and the same in the browser and on the server.
  let hash = 0x811c9dc5;
  for (const ch of rows.join('\n')) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${rows.length}:${hash.toString(16).padStart(8, '0')}`;
}
