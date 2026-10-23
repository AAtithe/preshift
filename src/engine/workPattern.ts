import { addDays, weekday } from './time';
import type { Employee, Shift } from './types';

// Which days of the week someone normally works. Absence triggers and statutory sick pay both
// count working days, not calendar days: a weekend off is not a day lost, and counting it would
// score a part-timer's three-day spell as heavily as a full-timer's week.

/** Weeks of rota looked back over to learn someone's pattern. */
export const PATTERN_WEEKS = 8;
/** Assumed when the rota says nothing: Monday to Friday (0 = Monday). */
export const DEFAULT_PATTERN = [0, 1, 2, 3, 4];

export interface WorkPattern {
  /** Weekdays worked, 0 = Monday ... 6 = Sunday. */
  days: number[];
  /** Learned from the rota, or assumed because the rota had nothing for them. */
  basis: 'rota' | 'assumed';
}

/**
 * The days someone usually works: any weekday they were rostered on in the eight weeks before a
 * date. A day worked once in eight weeks counts, as SSP qualifying days follow the work actually
 * done when there is no fixed pattern in the contract.
 */
export function workPattern(employee: Pick<Employee, 'id'>, shifts: Shift[], before: string): WorkPattern {
  const from = addDays(before, -7 * PATTERN_WEEKS);
  const days = [...new Set(shifts.filter((s) => s.employeeId === employee.id && s.date >= from && s.date < before).map((s) => weekday(s.date)))].sort();
  return days.length ? { days, basis: 'rota' } : { days: DEFAULT_PATTERN, basis: 'assumed' };
}

/** The dates from one day to another, inclusive, that fall on the pattern. */
export function workingDates(from: string, to: string, pattern: WorkPattern): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (pattern.days.includes(weekday(d))) out.push(d);
  return out;
}
