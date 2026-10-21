import type { RotaState } from './types';
import { actualShifts, loadedHourlyRate, type WeekVariance } from './actuals';
import { shiftPaidMinutes, shiftsInWeek } from './cost';
import { addDays, weekStart } from './time';

/**
 * Employment Rights Act 2025: the zero and low hours measures. The Act sets
 * the rights; the numbers (the low hours threshold, the reference period,
 * what counts as short notice and how much is paid) are left to regulations
 * that have not been made. Every value here is an assumption to plan against,
 * and must be replaced with the regulations before anyone relies on it.
 */
export interface EraPolicy {
  /** Workers contracted below this many hours a week are owed a guaranteed hours offer. */
  lowHoursThreshold: number;
  /** Weeks of hours looked back over to set the offer. */
  referenceWeeks: number;
  /** Share of lost pay owed when a shift is cut or cancelled at short notice. */
  compensationShare: number;
}

export const ERA_ASSUMPTIONS: EraPolicy = { lowHoursThreshold: 16, referenceWeeks: 12, compensationShare: 1 };

export interface GuaranteedHoursOffer {
  employeeId: string;
  contractedHours: number;
  weeksUsed: number;
  /** Average weekly hours worked over the reference weeks: the offer that would be due. */
  averageHours: number;
  extraGuaranteedHours: number;
  /** Loaded cost of the extra guaranteed hours: paid every week whether trade needs them or not. */
  weeklyFixedCost: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Who would be owed a guaranteed hours offer on the hours they actually work,
 * and what that turns from flexible into fixed cost. The point is not the
 * total; it is seeing which people the rota leans on every week, because their
 * hours are about to stop being a lever.
 */
export function guaranteedHoursOffers(
  state: RotaState,
  siteId: string,
  asOf: string,
  policy: EraPolicy = ERA_ASSUMPTIONS,
): GuaranteedHoursOffer[] {
  const clocked = actualShifts(state);
  const current = weekStart(asOf);
  const weeks = Array.from({ length: policy.referenceWeeks }, (_, i) => addDays(current, -7 * (i + 1))).filter((w) =>
    clocked.some((s) => s.siteId === siteId && shiftsInWeek([s], w).length > 0),
  );
  if (weeks.length === 0) return [];

  const offers: GuaranteedHoursOffer[] = [];
  for (const employee of state.employees) {
    if (employee.siteId !== siteId || employee.payBasis !== 'hourly' || employee.contractedHours >= policy.lowHoursThreshold) continue;
    const mine = clocked.filter((s) => s.employeeId === employee.id);
    const total = weeks.reduce((sum, w) => sum + shiftsInWeek(mine, w).reduce((h, s) => h + shiftPaidMinutes(s), 0) / 60, 0);
    const averageHours = total / weeks.length;
    const extra = averageHours - employee.contractedHours;
    if (extra <= 0) continue;
    offers.push({
      employeeId: employee.id,
      contractedHours: employee.contractedHours,
      weeksUsed: weeks.length,
      averageHours: round2(averageHours),
      extraGuaranteedHours: round2(extra),
      weeklyFixedCost: round2(extra * loadedHourlyRate(employee)),
    });
  }
  return offers.sort((a, b) => b.weeklyFixedCost - a.weeklyFixedCost);
}

/** Compensation owed for a cut of this many minutes at short notice. */
export function shortNoticeCompensation(minutes: number, hourlyLoadedRate: number, policy: EraPolicy = ERA_ASSUMPTIONS): number {
  return round2((minutes / 60) * hourlyLoadedRate * policy.compensationShare);
}

/**
 * What last week's early finishes would have cost in compensation. Every
 * early finish on the day is short notice by any definition, so the saving the
 * GM made becomes, at a full compensation share, no saving at all.
 */
export function compensationOnEarlyFinishes(state: RotaState, variance: WeekVariance, policy: EraPolicy = ERA_ASSUMPTIONS) {
  const items = variance.items.filter((i) => i.kind === 'early-finish');
  const total = items.reduce((sum, i) => {
    const employee = state.employees.find((e) => e.id === i.employeeId);
    return sum + (employee ? shortNoticeCompensation(-i.minutes, loadedHourlyRate(employee), policy) : 0);
  }, 0);
  return { count: items.length, saved: round2(-items.reduce((s, i) => s + i.cost, 0)), compensation: round2(total) };
}
