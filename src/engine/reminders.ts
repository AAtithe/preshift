// Shift reminders and no-show alerts: which published shifts are due a reminder or a "not clocked
// in" alert right now. Pure, so the scheduled job and the tests share one answer.

import { isEmployedOn } from './employees';
import { isAbsentOn } from './hr';
import { LATE_AFTER_MINUTES } from './insights';
import { absoluteMinute, addDays } from './time';
import type { RotaState, Shift, TimeEntry } from './types';

/** The evening reminder goes from this time the day before. */
export const EVENING_FROM_MINUTE = 18 * 60;
/** The second reminder, this many minutes before the start. */
export const SOON_WITHIN_MINUTES = 120;
/** How late before the person is nudged and their manager told. The same as a late arrival in the insights. */
export const LATE_AFTER = LATE_AFTER_MINUTES;
/** Sites with clocked time in this many days count as clocking. Elsewhere a missing clock means nothing. */
export const CLOCKING_LOOKBACK_DAYS = 14;

export type AlertKind = 'evening' | 'soon' | 'late';

/** What has been sent for one shift, kept until the shift is two days gone. */
export interface ShiftAlertRecord {
  date: string;
  evening?: string;
  soon?: string;
  late?: string;
}

export interface DueAlert {
  kind: AlertKind;
  shift: Shift;
  /** Minutes from now to the start: negative once it has started. */
  startsIn: number;
}

export interface Now {
  date: string;
  minute: number;
}

/** Sites where people clock, judged from the last fortnight's entries. */
export function clockingSites(entries: TimeEntry[], today: string): Set<string> {
  const from = addDays(today, -CLOCKING_LOOKBACK_DAYS);
  return new Set(entries.filter((t) => t.date >= from && t.date <= today).map((t) => t.siteId));
}

/** Whether the person has clocked anything for this shift: against it, or that day at that site. */
export function clockedFor(entries: TimeEntry[], shift: Shift): boolean {
  return entries.some((t) => t.employeeId === shift.employeeId && (t.shiftId === shift.id || (t.date === shift.date && t.siteId === shift.siteId)));
}

/**
 * Every alert due now. Only published shifts, only people employed and not on leave or off that day.
 * Reminders: the evening before (from 18:00) and within two hours of the start. A no-show alert: ten
 * minutes after the start, before the end, at a site where people clock, with nothing clocked.
 * Nothing already sent is due again.
 */
export function dueAlerts(state: Pick<RotaState, 'shifts' | 'employees'>, entries: TimeEntry[], sent: Record<string, ShiftAlertRecord>, now: Now): DueAlert[] {
  const clocking = clockingSites(entries, now.date);
  const tomorrow = addDays(now.date, 1);
  const out: DueAlert[] = [];
  for (const shift of state.shifts) {
    if (!shift.published || shift.date < addDays(now.date, -1) || shift.date > tomorrow) continue;
    const e = state.employees.find((x) => x.id === shift.employeeId);
    if (!e || e.status === 'leaver' || !isEmployedOn(e, shift.date) || e.leave.includes(shift.date) || isAbsentOn(e, shift.date)) continue;
    const done = sent[shift.id] ?? { date: shift.date };
    const startsIn = absoluteMinute(now.date, shift.date, shift.startMinute) - now.minute;
    const endsIn = absoluteMinute(now.date, shift.date, shift.endMinute) - now.minute;
    if (!done.evening && shift.date === tomorrow && now.minute >= EVENING_FROM_MINUTE) out.push({ kind: 'evening', shift, startsIn });
    if (!done.soon && startsIn > 0 && startsIn <= SOON_WITHIN_MINUTES) out.push({ kind: 'soon', shift, startsIn });
    if (!done.late && startsIn <= -LATE_AFTER && endsIn > 0 && clocking.has(shift.siteId) && !clockedFor(entries, shift)) out.push({ kind: 'late', shift, startsIn });
  }
  return out;
}

/** Drops the record of shifts more than two days gone, so the record never grows past a few days of rota. */
export function pruneAlerts(sent: Record<string, ShiftAlertRecord>, today: string): Record<string, ShiftAlertRecord> {
  const cutoff = addDays(today, -2);
  return Object.fromEntries(Object.entries(sent).filter(([, r]) => r.date >= cutoff));
}
