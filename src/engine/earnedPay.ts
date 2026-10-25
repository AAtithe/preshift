import { periodContaining, scheduleFor, type PayPeriod } from './payPeriods';
import { entryPaidHours } from './timesheet';
import { daysBetween } from './time';
import type { EarnedPayDraw, EarnedPaySettings, Employee, Entity, TimeEntry } from './types';

// Earned pay on demand. A person may draw part of the pay they have already earned this pay period,
// before payday. It is their wages paid early, not a loan: no interest, no fee, and the payslip
// shows it taken off that payday's net pay. Payroll pays it, as it holds the bank details.
//
// The figure is cautious on purpose. Only time a manager has approved counts, at the person's own
// rate, without premiums or tips; tax, National Insurance and pension are assumed at their highest
// usual rates; and only a share of the rest may be drawn. Payday then always has more than was drawn.

export const DEFAULT_EARNED_PAY: EarnedPaySettings = { on: false, sharePct: 50, minDraw: 10, maxDrawsPerPeriod: 3 };

/** The most of earned net pay a company may let people draw: half, so payday is never left empty. */
export const MAX_SHARE_PCT = 50;

/** Earned net pay as a share of gross, assuming basic rate tax and NI on all of it. */
const NET_OF_TAX_AND_NI = 0.72;
/** And the employee's pension contribution, for those enrolled. */
const PENSION = 0.05;

export interface EarnedPayPosition {
  /** Whether this person can draw now, and if not, why not in plain words. */
  allowed: boolean;
  reason?: string;
  period: PayPeriod;
  /** Gross pay earned so far this period: approved hours at their rate, or salary to date. */
  earnedGross: number;
  /** That less the most tax, NI and pension could take. */
  earnedNet: number;
  /** Drawn this period already, paid or on its way. */
  drawn: number;
  /** What may be drawn now, in whole pounds. */
  available: number;
  drawsLeft: number;
  settings: EarnedPaySettings;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export const settingsOf = (entity: Pick<Entity, 'earnedPay'> | undefined): EarnedPaySettings => ({ ...DEFAULT_EARNED_PAY, ...entity?.earnedPay });

/** Draws that count against a period: everything except one that failed or was cancelled. */
export const counted = (d: EarnedPayDraw) => d.status === 'requested' || d.status === 'paid';

/** What a person may draw today, and how it is worked out. */
export function earnedPayPosition(employee: Employee, entity: Entity | undefined, entries: TimeEntry[], draws: EarnedPayDraw[], today: string): EarnedPayPosition {
  const settings = settingsOf(entity);
  const period = periodContaining(scheduleFor(employee, entity), today);
  let earnedGross = 0;
  if (employee.payBasis === 'salaried') {
    // Salary to date: the period's share of the year for each day gone, today included.
    const days = Math.max(0, Math.min(daysBetween(period.periodStart, today) + 1, daysBetween(period.periodStart, period.periodEnd) + 1));
    earnedGross = (employee.annualSalary / 365) * days;
  } else {
    const hours = entries
      .filter((e) => e.employeeId === employee.id && e.status === 'approved' && e.date >= period.periodStart && e.date <= period.periodEnd && e.date <= today)
      .reduce((h, e) => h + entryPaidHours(e), 0);
    earnedGross = hours * employee.hourlyRate;
  }
  const earnedNet = earnedGross * (NET_OF_TAX_AND_NI - (employee.pensionEnrolled ? PENSION : 0));
  const mine = draws.filter((d) => d.employeeId === employee.id && d.periodStart === period.periodStart && d.scheduleId === period.scheduleId && counted(d));
  const drawn = round2(mine.reduce((s, d) => s + d.amount, 0));
  const share = Math.min(settings.sharePct, MAX_SHARE_PCT) / 100;
  const available = Math.max(0, Math.floor(earnedNet * share - drawn));
  const drawsLeft = Math.max(0, settings.maxDrawsPerPeriod - mine.length);
  const base = { period, earnedGross: round2(earnedGross), earnedNet: round2(earnedNet), drawn, available, drawsLeft, settings };
  const refuse = (reason: string) => ({ ...base, allowed: false, reason, available: 0 });
  if (!settings.on) return refuse('Your employer has not turned on early pay.');
  if (employee.leaveDate && employee.leaveDate <= today) return refuse('Early pay is for people still working here.');
  if (!employee.payrollId) return refuse('You are not set up in payroll yet, so there is nowhere to pay it.');
  // From the day before payday, or once payday has been (a month paid on the 28th runs to the 31st),
  // a draw could not come off this payday: the pay is on its way or has landed.
  if (daysBetween(today, period.payDate) <= 1) return refuse('Payday for this pay period is here: your pay is on its way or has landed.');
  if (drawsLeft === 0) return refuse(`You have made the ${settings.maxDrawsPerPeriod} draws allowed this pay period.`);
  if (available < settings.minDraw) return refuse(`You can draw once at least £${settings.minDraw} is available. Approved hours add to it.`);
  return { ...base, allowed: true };
}

/** Why a draw of this amount cannot go, or null when it can. */
export function drawProblem(position: EarnedPayPosition, amount: number): string | null {
  if (!position.allowed) return position.reason ?? 'Early pay is not available.';
  if (!Number.isInteger(amount) || amount <= 0) return 'Draw whole pounds.';
  if (amount < position.settings.minDraw) return `The smallest draw is £${position.settings.minDraw}.`;
  if (amount > position.available) return `You can draw up to £${position.available} today.`;
  return null;
}

/** Problems with a company's settings, for the screen that saves them. */
export function settingsProblems(s: EarnedPaySettings): string[] {
  const out: string[] = [];
  if (!(s.sharePct >= 10 && s.sharePct <= MAX_SHARE_PCT)) out.push(`The share must be between 10% and ${MAX_SHARE_PCT}% of earned pay.`);
  if (!(s.minDraw >= 5 && s.minDraw <= 100)) out.push('The smallest draw must be between £5 and £100.');
  if (!(Number.isInteger(s.maxDrawsPerPeriod) && s.maxDrawsPerPeriod >= 1 && s.maxDrawsPerPeriod <= 5)) out.push('Allow between 1 and 5 draws a pay period.');
  return out;
}
