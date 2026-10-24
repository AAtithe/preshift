import { bankHolidays } from './calendar';
import { addDays, daysBetween, weekday } from './time';
import type { PayChange } from './types';

// The organisation's rule for pay approvals: how fast finance decides, and the day payroll is
// sent. The software enforces who approves; this makes how fast visible, so proposals do not pile
// up before the cut-off and someone is paid late.

export interface PayPolicy {
  /** Working days finance has to decide a change, from when it was proposed. */
  turnaroundDays: number;
  /** The day of the week hours go to payroll (0 = Monday). A change decided after it misses that pay run. */
  cutoffWeekday: number;
}

export const DEFAULT_PAY_POLICY: PayPolicy = { turnaroundDays: 2, cutoffWeekday: 0 };

export const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const isWorkingDay = (date: string) => weekday(date) < 5 && !bankHolidays(Number(date.slice(0, 4))).some((h) => h.date === date);

/** A number of working days on from a date, skipping weekends and England and Wales bank holidays. */
export function addWorkingDays(date: string, days: number): string {
  let d = date;
  for (let left = days; left > 0; ) {
    d = addDays(d, 1);
    if (isWorkingDay(d)) left--;
  }
  return d;
}

/** The next payroll cut-off on or after a date. */
export function nextCutoff(today: string, policy: PayPolicy): string {
  return addDays(today, (policy.cutoffWeekday - weekday(today) + 7) % 7);
}

export type Standing = 'on_time' | 'due_today' | 'overdue';

export interface ChangeStanding {
  /** The last day finance should decide by. */
  dueBy: string;
  standing: Standing;
  /** The cut-off it needs deciding by to be in the next pay run. */
  cutoff: string;
  /** Days until that cut-off: 0 is the cut-off day itself. */
  daysToCutoff: number;
}

/** Where a waiting change stands against the turnaround and the next cut-off. */
export function standingOf(change: Pick<PayChange, 'requestedAt'>, today: string, policy: PayPolicy): ChangeStanding {
  const dueBy = addWorkingDays(change.requestedAt.slice(0, 10), policy.turnaroundDays);
  const cutoff = nextCutoff(today, policy);
  return {
    dueBy,
    standing: today > dueBy ? 'overdue' : today === dueBy ? 'due_today' : 'on_time',
    cutoff,
    daysToCutoff: daysBetween(today, cutoff),
  };
}

export interface ApprovalDigest {
  waiting: number;
  overdue: number;
  /** Waiting with the cut-off today or tomorrow: decide now or it misses the pay run. */
  nearCutoff: number;
  oldestDays: number;
  cutoff: string;
  /** Whether it goes beyond finance: something is overdue, or the cut-off is close with changes waiting. */
  escalate: boolean;
}

/** What a daily reminder to finance says, and whether it goes to the owner too. */
export function approvalDigest(pending: Pick<PayChange, 'requestedAt'>[], today: string, policy: PayPolicy): ApprovalDigest {
  const standings = pending.map((c) => standingOf(c, today, policy));
  const cutoff = nextCutoff(today, policy);
  const close = daysBetween(today, cutoff) <= 1;
  const overdue = standings.filter((s) => s.standing === 'overdue').length;
  const nearCutoff = close ? pending.length : 0;
  return {
    waiting: pending.length,
    overdue,
    nearCutoff,
    oldestDays: pending.reduce((max, c) => Math.max(max, daysBetween(c.requestedAt.slice(0, 10), today)), 0),
    cutoff,
    escalate: overdue > 0 || nearCutoff > 0,
  };
}
