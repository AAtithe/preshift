import { shiftPaidHours } from './cost';
import { addDays } from './time';
import type { Employee, PayChange, PayTerms, Shift } from './types';

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

/**
 * What the change adds to gross pay over a year, before holiday, employer NI and pension. It is
 * what finance weighs when approving, so it is shown beside every proposal.
 */
export function annualImpact(change: Pick<PayChange, 'before' | 'after'>, e: Employee, shifts: Shift[], today: string) {
  const hours = weeklyHours(e, shifts, today);
  const before = annualGross(change.before, hours);
  const after = annualGross(change.after, hours);
  return { hoursPerWeek: hours, before, after, difference: after - before, pct: before > 0 ? (after - before) / before : null };
}
