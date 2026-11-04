// Time off in lieu: extra hours worked and banked as time off instead of pay. Each person has a
// ledger: an opening balance at go-live, hours earned, hours taken, and adjustments. Nothing is ever
// removed, so the balance can always be shown as it stood on any day.
//
// The money matters as much as the hours. Hours banked and not yet taken are owed to the person, so
// they are a liability for the balance sheet, like untaken holiday, valued at their rate with
// employer NI.

import { holidayHourlyRate } from './holiday';
import { addDays } from './time';
import type { Employee, ToilEntry } from './types';
import { UK_RATES_2026_27, type UkRates } from './ukRates';

/** Hours banked longer than this are flagged: most policies ask for TOIL to be taken within three months. */
export const TOIL_TAKE_WITHIN_DAYS = 90;
/** A balance above this many hours is flagged: it is pay owed building up, and a sign of under-staffing. */
export const TOIL_HIGH_HOURS = 37.5;

export interface ToilBalance {
  employeeId: string;
  /** Hours owed today, never below nought for the liability. */
  hours: number;
  earned: number;
  taken: number;
  /** Earned or opening hours older than TOIL_TAKE_WITHIN_DAYS still not covered by time taken since, first in first out. */
  staleHours: number;
  /** Hours owed at the person's holiday rate, before employer NI. */
  value: number;
  /** With employer NI at the marginal rate: what the balance sheet carries. */
  liability: number;
  warnings: string[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function toilBalance(employee: Employee, today: string, rates: UkRates = UK_RATES_2026_27): ToilBalance {
  const entries = (employee.toil ?? []).filter((t) => t.date <= today).sort((a, b) => a.date.localeCompare(b.date) || a.at.localeCompare(b.at));
  const earned = entries.filter((t) => t.hours > 0).reduce((n, t) => n + t.hours, 0);
  const taken = -entries.filter((t) => t.hours < 0).reduce((n, t) => n + t.hours, 0);
  const total = earned - taken;
  // First in, first out: time taken uses up the oldest banked hours first.
  let used = taken;
  let stale = 0;
  const cutoff = addDays(today, -TOIL_TAKE_WITHIN_DAYS);
  for (const t of entries.filter((x) => x.hours > 0)) {
    const left = Math.max(0, t.hours - used);
    used = Math.max(0, used - t.hours);
    if (t.date < cutoff) stale += left;
  }
  const hours = Math.max(0, total);
  const value = hours * holidayHourlyRate(employee);
  const warnings: string[] = [];
  if (total < -0.01) warnings.push(`${r2(-total)}h more TOIL taken than earned. Correct the record, or recover it as unpaid time with the person's agreement.`);
  if (stale > 0.01) warnings.push(`${r2(stale)}h banked more than ${TOIL_TAKE_WITHIN_DAYS} days ago and not taken. Agree dates for it, or pay it.`);
  if (hours > TOIL_HIGH_HOURS) warnings.push(`${r2(hours)}h owed: more than a working week of pay building up. Book it in, or pay it.`);
  return {
    employeeId: employee.id,
    hours: r2(hours),
    earned: r2(earned),
    taken: r2(taken),
    staleHours: r2(stale),
    value: r2(value),
    liability: r2(value * (1 + rates.employerNiRate)),
    warnings,
  };
}

/** The checks on a new entry before it is saved. */
export function toilEntryProblems(entry: Pick<ToilEntry, 'kind' | 'hours' | 'date'>, today: string): string[] {
  const out: string[] = [];
  if (!Number.isFinite(entry.hours) || entry.hours === 0) out.push('Give the hours.');
  if (Math.abs(entry.hours) > 200) out.push('More than 200 hours in one entry is almost certainly a mistake.');
  if ((entry.kind === 'earned' || entry.kind === 'opening') && entry.hours < 0) out.push('Hours earned, or an opening balance, cannot be negative. Record time taken as taken.');
  if (entry.kind === 'taken' && entry.hours > 0) out.push('Hours taken are recorded as a negative figure.');
  if ((entry.kind === 'earned' || entry.kind === 'opening') && entry.date > today) out.push('Hours cannot be earned on a day still to come.');
  return out;
}
