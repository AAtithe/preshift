import type { Employee, HrRecord, RotaState, TimeEntry } from './types';
import { clockedShifts } from './actuals';
import type { Issue } from './compliance';
import { currentHealthOffer, isNightShift } from './night';
import { shiftPaidMinutes, shiftsInWeek } from './cost';
import { addDays } from './time';

export { currentHealthOffer, isNightShift } from './night';

// Night work under the Working Time Regulations. Night time is 23:00 to 06:00 unless agreed otherwise.
// A night worker is someone who, as a normal course, works at least three hours of their day in night
// time. Their normal hours must average no more than eight in each 24 over a 17 week reference period,
// leaving out the weekly rest day, and unlike the 48 hour week this cannot be opted out of. Each must
// be offered a free health assessment before starting nights and regularly after.

const REFERENCE_WEEKS = 17;
/** "As a normal course": a third or more of the days they work, on three days at least. Our test; the law gives none. */
const NORMAL_SHARE = 1 / 3;
const MIN_NIGHT_DAYS = 3;

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface NightWorkStatus {
  employeeId: string;
  nightWorker: boolean;
  /** Days with three hours or more in night time, over the reference weeks and this week's rota. */
  nightDays: number;
  workedDays: number;
  /** Rostered night shifts this week. */
  nightShiftsThisWeek: number;
  /** Average hours in each 24 over the reference period, the weekly rest day left out. */
  averagePer24: number;
  weeksUsed: number;
  /** The latest health assessment offer still in date, if any. */
  healthOffer?: HrRecord;
}

/**
 * Night work for one person in the week starting `weekStartDate`: clocked hours for the previous 16
 * weeks (any site) and this week's rota. Someone rostered onto three or more night shifts this week is
 * treated as a night worker from the start, since the health assessment is owed before nights begin.
 */
export function nightWorkStatus(
  employee: Employee,
  state: Pick<RotaState, 'shifts'>,
  entries: TimeEntry[],
  records: HrRecord[],
  weekStartDate: string,
): NightWorkStatus {
  const clocked = clockedShifts(entries).filter((s) => s.employeeId === employee.id);
  const priorWeeks = Array.from({ length: REFERENCE_WEEKS - 1 }, (_, i) => addDays(weekStartDate, -7 * (i + 1)));
  const history = priorWeeks.flatMap((w) => shiftsInWeek(clocked, w));
  const rota = shiftsInWeek(state.shifts, weekStartDate).filter((s) => s.employeeId === employee.id);
  const days = [...history, ...rota];
  const nightDays = days.filter(isNightShift).length;
  const nightShiftsThisWeek = rota.filter(isNightShift).length;
  const nightWorker =
    nightShiftsThisWeek >= MIN_NIGHT_DAYS || (nightDays >= MIN_NIGHT_DAYS && days.length > 0 && nightDays / days.length >= NORMAL_SHARE);
  // Weeks from their first worked week: a new starter's average is over the weeks they have.
  const weekly = priorWeeks.map((w) => shiftsInWeek(clocked, w).reduce((h, s) => h + shiftPaidMinutes(s), 0) / 60);
  const firstWorked = weekly.map((h, i) => (h > 0 ? i : -1)).filter((i) => i >= 0).pop();
  const weeksUsed = (firstWorked === undefined ? 0 : firstWorked + 1) + 1;
  const hours = weekly.slice(0, weeksUsed - 1).reduce((a, b) => a + b, 0) + rota.reduce((h, s) => h + shiftPaidMinutes(s), 0) / 60;
  return {
    employeeId: employee.id,
    nightWorker,
    nightDays,
    workedDays: days.length,
    nightShiftsThisWeek,
    averagePer24: round2(hours / (6 * weeksUsed)),
    weeksUsed,
    healthOffer: currentHealthOffer(records, employee.id, weekStartDate),
  };
}

const MIN_HISTORY_WEEKS = 3;

/**
 * Warnings on the rota week for night workers: an average over eight hours in each 24 (raised for those
 * who opted out of the 48 hour week, who get no other warning, since this limit cannot be opted out
 * of), and no health assessment offered.
 */
export function nightWorkIssues(state: RotaState, entries: TimeEntry[], records: HrRecord[], weekStartDate: string, siteId?: string): Issue[] {
  const issues: Issue[] = [];
  for (const employee of state.employees) {
    const rota = shiftsInWeek(state.shifts, weekStartDate).filter((s) => s.employeeId === employee.id);
    if (rota.length === 0 || (siteId && !rota.some((s) => s.siteId === siteId))) continue;
    const status = nightWorkStatus(employee, state, entries, records, weekStartDate);
    if (!status.nightWorker) continue;
    if (employee.optedOutOf48 && status.weeksUsed >= MIN_HISTORY_WEEKS && status.averagePer24 > 8 + 1e-9) {
      issues.push({
        code: 'night-average',
        severity: 'warn',
        employeeId: employee.id,
        message: `Night worker: ${status.averagePer24}h on average in each 24 hours over 17 weeks, over the limit of 8. The 48 hour opt-out does not cover this.`,
      });
    }
    if (!status.healthOffer) {
      issues.push({
        code: 'night-health',
        severity: 'warn',
        employeeId: employee.id,
        message: `Night worker (${status.nightShiftsThisWeek} night shift${status.nightShiftsThisWeek === 1 ? '' : 's'} this week): offer a free health assessment and record it in their HR file.`,
      });
    }
  }
  return issues;
}
