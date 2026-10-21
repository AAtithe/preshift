import { requiredBreakMinutes } from './compliance';
import { ageOn } from './time';
import type { Employee, TimeEntry } from './types';

export interface BreakShortfall {
  entryId: string;
  employeeId: string;
  date: string;
  /** 'short': less break in total than the law gives. 'split': enough in total, but no single break long enough. */
  code: 'short' | 'split';
  requiredMinutes: number;
  takenMinutes: number;
  longestMinutes: number;
  workedMinutes: number;
  under18: boolean;
}

/**
 * Whether a finished shift had the rest break the Working Time Regulations give: 20 minutes
 * uninterrupted when working time is over 6 hours, or 30 minutes over 4.5 hours for under 18s.
 * Working time leaves out the break itself, so 6h10 on site with a 20 minute break is fine.
 * The rest break must be one block, so two 10 minute breaks do not make 20.
 */
export function checkBreak(entry: TimeEntry, employee: Employee): BreakShortfall | null {
  if (entry.clockOut === undefined || entry.status === 'open' || entry.status === 'rejected') return null;
  const taken = entry.breakMinutes;
  const worked = entry.clockOut - entry.clockIn - taken;
  const age = ageOn(employee.dateOfBirth, entry.date);
  const required = requiredBreakMinutes(worked, age);
  if (!required) return null;

  // Recorded breaks show how the time was split; once a manager has changed the total they no longer do.
  const recorded = (entry.breaks ?? []).filter((b) => b.end !== undefined).map((b) => b.end! - b.start);
  const recordedTotal = recorded.reduce((a, b) => a + b, 0);
  const longest = recorded.length && recordedTotal === taken ? Math.max(...recorded) : taken;

  const base = { entryId: entry.id, employeeId: entry.employeeId, date: entry.date, requiredMinutes: required, takenMinutes: taken, longestMinutes: longest, workedMinutes: worked, under18: age < 18 };
  if (taken < required) return { ...base, code: 'short' };
  if (longest < required) return { ...base, code: 'split' };
  return null;
}

export function breakShortfalls(entries: TimeEntry[], employees: Employee[]): BreakShortfall[] {
  const byId = new Map(employees.map((e) => [e.id, e]));
  return entries.flatMap((t) => {
    const employee = byId.get(t.employeeId);
    const issue = employee ? checkBreak(t, employee) : null;
    return issue ? [issue] : [];
  });
}
