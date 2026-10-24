import type { HrRecord, Shift } from './types';

// Night time helpers with no other dependencies, shared by the compliance rules, the night work
// checks and the HR file.

/** Working Time Regulations night time, unless agreed otherwise: 23:00 to 06:00. */
export const NIGHT_FROM = 23 * 60;
export const NIGHT_TO = 6 * 60;
/** Three hours or more of a day's work in night time makes it a night shift. */
export const NIGHT_SHIFT_MINUTES = 3 * 60;

/**
 * Minutes of a shift inside a nightly window, from `from` to `to` minutes after midnight (a window such
 * as 22:00 to 06:00 runs past midnight), on every day the shift touches.
 */
export function nightOverlap(shift: Pick<Shift, 'startMinute' | 'endMinute'>, from: number, to: number): number {
  const windows: [number, number][] = [];
  for (let day = -1; day <= 2; day++) {
    const base = day * 1440;
    if (from < to) windows.push([base + from, base + to]);
    else windows.push([base + from, base + 1440 + to]);
  }
  return windows.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(b, shift.endMinute) - Math.max(a, shift.startMinute)), 0);
}

/** Paid minutes of a shift in night time, the unpaid break taken as spread across it. */
export function nightMinutes(shift: Pick<Shift, 'startMinute' | 'endMinute' | 'breakMinutes'>): number {
  const length = shift.endMinute - shift.startMinute;
  if (length <= 0) return 0;
  return nightOverlap(shift, NIGHT_FROM, NIGHT_TO) * (Math.max(0, length - shift.breakMinutes) / length);
}

export const isNightShift = (s: Pick<Shift, 'startMinute' | 'endMinute' | 'breakMinutes'>) => nightMinutes(s) >= NIGHT_SHIFT_MINUTES;

/** A night work health assessment offered and not yet due again. Declining still counts: the offer was made. */
export function currentHealthOffer(records: HrRecord[], employeeId: string, asOf: string): HrRecord | undefined {
  return records
    .filter((r) => r.kind === 'health_assessment' && r.employeeId === employeeId && r.date <= asOf && (!r.nextDue || r.nextDue >= asOf))
    .sort((a, b) => b.date.localeCompare(a.date))[0];
}
