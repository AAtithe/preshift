import type { RotaState } from './types';
import { actualShifts } from './actuals';
import { shiftPaidMinutes, shiftsInWeek } from './cost';
import { addDays, ageOn, weekStart } from './time';

export const WTR_REFERENCE_WEEKS = 17;
export const WTR_AVERAGE_LIMIT = 48;
const MIN_WEEKS_TO_CALL = 4;

export interface WorkingTimeAverage {
  employeeId: string;
  /** Closed weeks of clocked hours in the reference period so far. */
  weeksUsed: number;
  totalHours: number;
  average: number;
  /** Weeks left in a full 17 week reference period. */
  weeksRemaining: number;
  /** The most the person can average from now on and still finish at 48. */
  allowedAverageAhead: number;
  /** A full reference period over 48: a breach. */
  breach: boolean;
  /**
   * At least four weeks in, not yet 17, and averaging over 48: will breach
   * unless hours come down. Fewer weeks than that is too little to call.
   */
  onCourseToBreach: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The 48 hour limit is an average over a 17 week reference period, not a cap
 * on any one week, so a single 55 hour week is legal and a steady 50 is not.
 * Worked on clocked hours for closed weeks, for adult workers who have not
 * opted out. What it gives a GM is the number that matters: how many hours a
 * week this person can work from here and stay legal.
 */
export function workingTimeAverages(state: RotaState, siteId: string, asOf: string): WorkingTimeAverage[] {
  const clocked = actualShifts(state);
  const current = weekStart(asOf);
  const weeks = Array.from({ length: WTR_REFERENCE_WEEKS }, (_, i) => addDays(current, -7 * (i + 1))).filter((w) =>
    clocked.some((s) => s.siteId === siteId && shiftsInWeek([s], w).length > 0),
  );
  if (weeks.length === 0) return [];

  const rows: WorkingTimeAverage[] = [];
  for (const employee of state.employees) {
    if (employee.siteId !== siteId || employee.optedOutOf48 || ageOn(employee.dateOfBirth, asOf) < 18) continue;
    const mine = clocked.filter((s) => s.employeeId === employee.id);
    const totalHours = weeks.reduce((sum, w) => sum + shiftsInWeek(mine, w).reduce((h, s) => h + shiftPaidMinutes(s), 0) / 60, 0);
    if (totalHours === 0) continue;
    const average = totalHours / weeks.length;
    const weeksRemaining = WTR_REFERENCE_WEEKS - weeks.length;
    const allowed = weeksRemaining > 0 ? (WTR_AVERAGE_LIMIT * WTR_REFERENCE_WEEKS - totalHours) / weeksRemaining : 0;
    rows.push({
      employeeId: employee.id,
      weeksUsed: weeks.length,
      totalHours: round2(totalHours),
      average: round2(average),
      weeksRemaining,
      allowedAverageAhead: round2(allowed),
      breach: weeksRemaining === 0 && average > WTR_AVERAGE_LIMIT,
      onCourseToBreach: weeksRemaining > 0 && weeks.length >= MIN_WEEKS_TO_CALL && average > WTR_AVERAGE_LIMIT,
    });
  }
  return rows.sort((a, b) => b.average - a.average);
}
