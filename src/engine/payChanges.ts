import { shiftPaidHours, weekOnCosts } from './cost';
import { addDays, daysBetween } from './time';
import type { BackPay, Employee, PayChange, PayTerms, Shift } from './types';
import { UK_RATES_2026_27, type UkRates } from './ukRates';

export const payTermsOf = (e: Pick<Employee, 'payBasis' | 'hourlyRate' | 'annualSalary'>): PayTerms => ({
  payBasis: e.payBasis,
  hourlyRate: e.hourlyRate,
  annualSalary: e.annualSalary,
});

export const sameTerms = (a: PayTerms, b: PayTerms) =>
  a.payBasis === b.payBasis && a.hourlyRate === b.hourlyRate && a.annualSalary === b.annualSalary;

/** Weeks of rota looked back over for someone with no contracted hours. */
export const LOOKBACK_WEEKS = 4;

/** Hours a week the change applies to: the contract, else the average rostered over the last four weeks. */
export function weeklyHours(e: Employee, shifts: Shift[], today: string): number {
  if (e.contractedHours > 0) return e.contractedHours;
  const from = addDays(today, -7 * LOOKBACK_WEEKS);
  const paid = shifts.filter((s) => s.employeeId === e.id && s.date >= from && s.date < today).reduce((sum, s) => sum + shiftPaidHours(s), 0);
  return paid / LOOKBACK_WEEKS;
}

const annualGross = (t: PayTerms, hoursPerWeek: number) => (t.payBasis === 'salaried' ? t.annualSalary : t.hourlyRate * hoursPerWeek * 52);

/** A year of pay on some terms with what the employer adds: holiday for hourly pay, employer NI and pension, worked week by week. */
function annualFull(e: Employee, t: PayTerms, hoursPerWeek: number, rates: UkRates) {
  const week = weekOnCosts({ ...e, ...t }, annualGross(t, hoursPerWeek) / 52, rates);
  return { gross: week.gross * 52, holiday: week.holiday * 52, employerNi: week.employerNi * 52, pension: week.pension * 52, total: week.total * 52 };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * What the change adds over a year: to gross pay, and to the full cost once holiday (hourly pay
 * only: salary already includes it), employer NI and pension are added. Finance approves on the full
 * cost, which runs some 20 to 25 percent above gross, so both are shown beside every proposal.
 */
export function annualImpact(change: Pick<PayChange, 'before' | 'after'>, e: Employee, shifts: Shift[], today: string, rates: UkRates = UK_RATES_2026_27) {
  const hours = weeklyHours(e, shifts, today);
  const before = annualGross(change.before, hours);
  const after = annualGross(change.after, hours);
  const fullBefore = annualFull(e, change.before, hours, rates);
  const fullAfter = annualFull(e, change.after, hours, rates);
  return {
    hoursPerWeek: hours,
    before,
    after,
    difference: after - before,
    pct: before > 0 ? (after - before) / before : null,
    fullBefore: round2(fullBefore.total),
    fullAfter: round2(fullAfter.total),
    fullDifference: round2(fullAfter.total - fullBefore.total),
    /** What each on-cost adds, a year. */
    onCosts: {
      holiday: round2(fullAfter.holiday - fullBefore.holiday),
      employerNi: round2(fullAfter.employerNi - fullBefore.employerNi),
      pension: round2(fullAfter.pension - fullBefore.pension),
    },
  };
}

/** Pay for a stretch of days on some terms: hours at the rate, or salary by the day. */
const payFor = (t: PayTerms, hours: number, days: number) => (t.payBasis === 'salaried' ? (t.annualSalary / 365) * days : t.hourlyRate * hours);

/**
 * Arrears when a change is applied after the date it was agreed from: the difference between pay on
 * the new terms and the old for the work done in between. Hours are those clocked and approved, or
 * the rota where nothing was clocked, the same hours payroll was paid on. Null when nothing is owed.
 */
export function backPayFor(change: Pick<PayChange, 'before' | 'after' | 'employeeId'>, effectiveFrom: string, appliedOn: string, worked: Shift[], rostered: Shift[]): BackPay | null {
  if (effectiveFrom >= appliedOn) return null;
  const to = addDays(appliedOn, -1);
  const inGap = (s: Shift) => s.employeeId === change.employeeId && s.date >= effectiveFrom && s.date <= to;
  const clocked = worked.filter(inGap);
  const used = clocked.length ? clocked : rostered.filter(inGap);
  const hours = round2(used.reduce((sum, s) => sum + shiftPaidHours(s), 0));
  const days = daysBetween(effectiveFrom, appliedOn);
  const amount = round2(payFor(change.after, hours, days) - payFor(change.before, hours, days));
  if (amount <= 0) return null;
  const salaried = change.after.payBasis === 'salaried' && change.before.payBasis === 'salaried';
  return { from: effectiveFrom, to, hours, amount, basis: salaried ? 'salary' : clocked.length ? 'clocked' : 'rota' };
}
