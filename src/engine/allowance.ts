import type { RotaState } from './types';
import { weekCost } from './cost';
import { addDays, taxYearOf, taxYearStartDate, weekStart } from './time';
import { UK_RATES_2026_27, type UkRates } from './ukRates';

export interface AllowanceWeek {
  entityId: string;
  taxYear: string;
  /** Unused allowance at the start of the week. */
  available: number;
  /** Employer NI the claiming entity's people generate this week, before the allowance. */
  employerNi: number;
  /** Allowance set against this week's NI. */
  used: number;
  remainingAfter: number;
  /** True when payroll has already run for this week, so its actuals carry the allowance. */
  coveredByPayroll: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The claimant: the first entity that claims. A connected group gets one allowance, not one each. */
export function allowanceClaimant(state: Pick<RotaState, 'entities'>) {
  return state.entities.find((e) => e.employmentAllowance);
}

export function employmentAllowanceIssues(state: Pick<RotaState, 'entities'>, rates: UkRates = UK_RATES_2026_27): string[] {
  const claimants = state.entities.filter((e) => e.employmentAllowance);
  const issues: string[] = [];
  if (claimants.length > 1) {
    issues.push(
      `${claimants.map((e) => e.name).join(' and ')} are all set to claim Employment Allowance. A connected group gets one claim; only ${claimants[0].name} is applied.`,
    );
  }
  const claimant = claimants[0];
  if (claimant && claimant.employmentAllowance!.remaining > rates.employmentAllowance) {
    issues.push(`${claimant.name} shows more allowance remaining than the £${rates.employmentAllowance.toLocaleString('en-GB')} a year allows.`);
  }
  return issues;
}

function entityEmployerNi(state: RotaState, entityId: string, start: string, rates: UkRates): number {
  const cost = weekCost(state, start, undefined, rates);
  let ni = 0;
  for (const employee of state.employees) {
    if (employee.entityId === entityId) ni += cost.employees.get(employee.id)?.employerNi ?? 0;
  }
  return round2(ni);
}

/**
 * Employment Allowance as payroll will actually use it: set against employer NI
 * week by week from the start of the tax year until it runs out. That is how
 * HMRC applies it, so the accrual reverses cleanly against payroll. Weeks are
 * placed in the tax year their last day falls in.
 *
 * Starts from what the last payroll left unused, then runs the rota forward
 * through every week between that payroll and this one. In a later tax year it
 * starts again from the full allowance.
 */
export function employmentAllowanceWeek(
  state: RotaState,
  weekStartDate: string,
  rates: UkRates = UK_RATES_2026_27,
): AllowanceWeek | null {
  const claimant = allowanceClaimant(state);
  if (!claimant) return null;
  const { remaining, asAt } = claimant.employmentAllowance!;
  const taxYear = taxYearOf(addDays(weekStartDate, 6));
  const base = {
    entityId: claimant.id,
    taxYear,
    employerNi: entityEmployerNi(state, claimant.id, weekStartDate, rates),
  };

  if (addDays(weekStartDate, 6) <= asAt) {
    return { ...base, available: 0, used: 0, remainingAfter: 0, coveredByPayroll: true };
  }

  let available: number;
  let from: string;
  if (taxYear === taxYearOf(asAt)) {
    available = remaining;
    from = weekStart(addDays(asAt, 1));
  } else {
    available = rates.employmentAllowance;
    from = weekStart(taxYearStartDate(taxYear));
  }
  for (let w = from; w < weekStartDate; w = addDays(w, 7)) {
    available = round2(available - Math.min(available, entityEmployerNi(state, claimant.id, w, rates)));
  }
  const used = round2(Math.min(available, base.employerNi));
  return { ...base, available, used, remainingAfter: round2(available - used), coveredByPayroll: false };
}
