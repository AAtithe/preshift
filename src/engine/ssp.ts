import { shiftPaidHours } from './cost';
import { addDays, daysBetween } from './time';
import type { Absence, Employee, Shift } from './types';
import { UK_RATES_2026_27, type UkRates } from './ukRates';
import { workingDates, workPattern, type WorkPattern } from './workPattern';

// An estimate of Statutory Sick Pay owed, from the absence record and the rota, so the business
// can check what payroll paid. Payroll is the record of what was paid; this is the check on it.
//
// The rules from 6 April 2026: SSP is due from the first qualifying day of sickness, with no
// waiting days and no lower earnings limit. The weekly rate is the lower of the flat rate and 80%
// of average weekly earnings over the eight weeks before the period of sickness began. Spells 56
// days apart or fewer link into one period, and one period pays at most 28 weeks. Qualifying days
// are the days the person normally works, here the days of the week they were rostered on.

export interface SspDay {
  date: string;
  /** The daily rate, unrounded. */
  amount: number;
}

export interface SspSpell {
  absenceId: string;
  from: string;
  /** Last day counted: the end of the spell, or today while it runs. */
  to: string;
  /** First day of the period of sickness this spell belongs to, earlier than `from` when it links to an earlier spell. */
  periodFrom: string;
  /** Average weekly earnings over the eight weeks before the period began. */
  awe: number;
  /** How earnings were found: pay on the rota, salary, or contracted hours for someone with no earnings yet. */
  aweBasis: 'rota' | 'salary' | 'contract';
  weeklyRate: number;
  /** Paid at 80% of earnings rather than the flat rate. */
  belowFlatRate: boolean;
  pattern: WorkPattern;
  dailyRate: number;
  /** Qualifying days in the spell, each with SSP due for it. Days past the 28 week limit are left out. */
  days: SspDay[];
  qualifyingDays: number;
  amount: number;
  /** The 28 week limit was reached in this spell. */
  exhausted: boolean;
}

export interface SspEstimate {
  spells: SspSpell[];
  total: number;
  /** Sickness spells that began before the new rules and are left to payroll. */
  oldRules: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Average weekly earnings before a date: pay for rostered hours, salary, or contracted hours. */
export function averageWeeklyEarnings(employee: Employee, shifts: Shift[], before: string, rates: UkRates = UK_RATES_2026_27) {
  if (employee.payBasis === 'salaried') return { awe: employee.annualSalary / 52, basis: 'salary' as const };
  const weeks = rates.ssp.aweWeeks;
  // Someone employed for less than the full period is averaged over the weeks they were employed.
  const start = employee.startDate && employee.startDate > addDays(before, -7 * weeks) ? employee.startDate : addDays(before, -7 * weeks);
  const weeksEmployed = Math.max(1, Math.min(weeks, Math.ceil(daysBetween(start, before) / 7)));
  const hours = shifts.filter((s) => s.employeeId === employee.id && s.date >= start && s.date < before).reduce((sum, s) => sum + shiftPaidHours(s), 0);
  if (hours > 0) return { awe: (hours * employee.hourlyRate) / weeksEmployed, basis: 'rota' as const };
  return { awe: employee.contractedHours * employee.hourlyRate, basis: 'contract' as const };
}

/**
 * SSP due for each sickness spell up to today. Spells marked as another type of absence are not
 * sickness, and spells before 6 April 2026 are left to payroll under the old rules.
 */
export function sspEstimate(employee: Employee, shifts: Shift[], today: string, rates: UkRates = UK_RATES_2026_27): SspEstimate {
  const sick = (employee.absences ?? [])
    .filter((a): a is Absence => a.type === 'sickness' && a.from <= today)
    .sort((a, b) => a.from.localeCompare(b.from));
  const spells: SspSpell[] = [];
  let oldRules = 0;
  // The period of sickness the last spell belonged to, and the qualifying days already paid in it.
  let period: { from: string; lastDay: string; paidDays: number; awe: ReturnType<typeof averageWeeklyEarnings>; pattern: WorkPattern } | null = null;
  for (const a of sick) {
    const to = a.to && a.to < today ? a.to : today;
    if (a.from < rates.ssp.newRulesFrom) {
      oldRules++;
      period = null;
      continue;
    }
    if (!period || daysBetween(period.lastDay, a.from) > rates.ssp.linkDays) {
      period = { from: a.from, lastDay: to, paidDays: 0, awe: averageWeeklyEarnings(employee, shifts, a.from, rates), pattern: workPattern(employee, shifts, a.from) };
    }
    period.lastDay = to;
    const { awe, basis } = period.awe;
    const capped = awe * rates.ssp.aweShare;
    const weeklyRate = round2(Math.min(rates.ssp.weeklyRate, capped));
    const perWeek = period.pattern.days.length;
    const dailyRate = weeklyRate / perWeek;
    const limit = rates.ssp.maxWeeks * perWeek;
    const qualifying = workingDates(a.from, to, period.pattern);
    const payable = qualifying.slice(0, Math.max(0, limit - period.paidDays));
    period.paidDays += payable.length;
    // The daily rate is kept unrounded, as payroll does: only totals are rounded to the penny.
    const days = payable.map((date) => ({ date, amount: dailyRate }));
    spells.push({
      absenceId: a.id,
      from: a.from,
      to,
      periodFrom: period.from,
      awe: round2(awe),
      aweBasis: basis,
      weeklyRate,
      belowFlatRate: capped < rates.ssp.weeklyRate,
      pattern: period.pattern,
      dailyRate: round2(dailyRate),
      days,
      qualifyingDays: qualifying.length,
      amount: round2(days.reduce((s, d) => s + d.amount, 0)),
      exhausted: payable.length < qualifying.length,
    });
  }
  return { spells, total: round2(spells.reduce((s, x) => s + x.amount, 0)), oldRules };
}

/** One person's SSP in a pay run: what the absence record says was due, against what payroll paid. */
export interface SspCheckLine {
  employeeId: string;
  expected: number;
  paid: number;
  difference: number;
}

/** SSP due for qualifying days inside a pay period, to compare with what payroll paid for it. */
export function sspInPeriod(estimate: SspEstimate, from: string, to: string): number {
  return round2(estimate.spells.flatMap((s) => s.days).filter((d) => d.date >= from && d.date <= to).reduce((s, d) => s + d.amount, 0));
}
