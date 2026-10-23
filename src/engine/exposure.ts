import type { Employee, RotaState, TimeEntry } from './types';
import { actualCompliance, clockedShifts, weekVariance } from './actuals';
import { checkWeek, type Issue } from './compliance';
import { compensationOnEarlyFinishes, ERA_ASSUMPTIONS, guaranteedHoursOffers, type EraPolicy, type GuaranteedHoursOffer } from './era';
import { nmwCheck, type NmwRow } from './nmw';
import { tipsPayBy, troncCompliance, troncRun, type TroncIssue } from './tronc';
import { addDays, weekDates, weekStart } from './time';
import { shiftPaidMinutes, shiftsInWeek } from './cost';
import { WTR_AVERAGE_LIMIT, workingTimeAverages, type WorkingTimeAverage } from './wtr';
import { UK_RATES_2026_27, type UkRates } from './ukRates';

export interface RightToWorkLine {
  employeeId: string;
  code: string;
  /** Rota means the rota would break it and publication is blocked; clocked means it happened. */
  source: 'rota' | 'clocked';
  message: string;
  /** Home Office civil penalty ceiling for this worker. Zero for a reminder. */
  penaltyCeiling: number;
}

export interface ExposureRegister {
  nmw: NmwRow[];
  rightToWork: RightToWorkLine[];
  /** Working Time breaches on clocked hours. Claim risk with no tariff, so counted rather than priced. */
  workingTime: Issue[];
  /** 17 week averages for anyone over, or within four hours of, the 48 hour limit. */
  workingTimeAverages: WorkingTimeAverage[];
  tronc: {
    /** Tips past the Act's deadline and still unpaid: owed to staff now. */
    overdue: number;
    overdueWorkers: number;
    /** Tribunal awards on top of the tips, at the cap per worker. */
    tribunalCeiling: number;
    /**
     * A year's National Insurance that rests on the troncmaster genuinely
     * deciding the allocation. Not owed; at stake if HMRC finds the business
     * was involved.
     */
    niAtStakeAnnual: number;
    issues: TroncIssue[];
  };
  era: {
    policy: EraPolicy;
    offers: GuaranteedHoursOffer[];
    weeklyFixedCost: number;
    earlyFinishes: { count: number; saved: number; compensation: number };
  };
  /** Money owed to workers now: minimum wage arrears and overdue tips. */
  owedNow: number;
  /** The most that could be charged on top: NMW and illegal working penalties and tips tribunal awards. */
  penaltyCeiling: number;
  /** Minimum wage arrears if this week's pattern ran for a year. */
  annualisedArrears: number;
}

/** Term time unless every day of the week falls inside one of the institution's vacations. */
export function isTermTimeWeek(dates: string[], vacations: { from: string; to: string }[] = []): boolean {
  return !dates.every((d) => vacations.some((v) => d >= v.from && d <= v.to));
}

/**
 * Hours clocked in a Monday to Sunday week against a student's term-time limit. The rota cannot
 * see this: a week rostered at the limit goes over it with a few minutes of overrun, and it is the
 * clocked hours the Home Office counts.
 */
export function studentHoursBreach(employee: Employee, entries: TimeEntry[], weekStartDate: string): { hours: number; limit: number } | null {
  const limit = employee.rightToWork?.studentWeeklyHourLimit;
  if (limit === undefined || !isTermTimeWeek(weekDates(weekStartDate), employee.rightToWork?.termVacations)) return null;
  const hours =
    shiftsInWeek(clockedShifts(entries), weekStartDate)
      .filter((s) => s.employeeId === employee.id)
      .reduce((sum, s) => sum + shiftPaidMinutes(s), 0) / 60;
  return hours > limit ? { hours, limit } : null;
}
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Compliance as a price, not a warning. For each week and site: what is owed
 * to staff now, the ceiling on what HMRC and the Home Office could add, the
 * breaches that carry claim risk without a tariff, and what the Employment
 * Rights Act would change on the assumptions in force. Penalties are ceilings,
 * not predictions: regulators reduce them for disclosure and cooperation, which
 * is the point of finding the breach first.
 */
export function complianceExposure(
  state: RotaState,
  entries: TimeEntry[],
  siteId: string,
  weekStartDate: string,
  asOf: string,
  policy: EraPolicy = ERA_ASSUMPTIONS,
  rates: UkRates = UK_RATES_2026_27,
): ExposureRegister {
  const nmw = nmwCheck(state, entries, weekStartDate, asOf, siteId, rates).filter((r) => r.arrears > 0 || r.headroomHours < 2);

  const clocked = actualCompliance(state, entries, weekStartDate, asOf, siteId);
  // The rota's own right to work rule: no check on file, or permission expired. On the rota it blocks
  // publication; on the clock it has happened.
  const planned = checkWeek(state, weekStartDate, siteId).filter((i) => i.code === 'right-to-work');
  const rightToWork: RightToWorkLine[] = [];
  const seen = new Set<string>();
  for (const [source, issues] of [['clocked', clocked], ['rota', planned]] as const) {
    for (const i of issues) {
      if (i.code !== 'right-to-work') continue;
      const key = `${i.employeeId}|${source}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rightToWork.push({ employeeId: i.employeeId, code: i.code, source, message: i.message, penaltyCeiling: 0 });
    }
  }
  for (const employee of state.employees.filter((e) => e.siteId === siteId)) {
    const breach = studentHoursBreach(employee, entries, weekStartDate);
    if (!breach) continue;
    rightToWork.push({
      employeeId: employee.id,
      code: 'student-hours',
      source: 'clocked',
      message: `Student permission allows ${breach.limit}h a week in term time; ${breach.hours.toFixed(1)}h worked. Breaching it is illegal working.`,
      penaltyCeiling: 0,
    });
  }
  // One penalty per illegal worker, however many breaches they have, and only for what happened.
  const charged = new Set<string>();
  for (const line of rightToWork) {
    if (line.source !== 'clocked' || charged.has(line.employeeId)) continue;
    line.penaltyCeiling = rates.illegalWorkingPenaltyFirst;
    charged.add(line.employeeId);
  }

  const offers = guaranteedHoursOffers(state, entries, siteId, asOf, policy);
  const earlyFinishes = compensationOnEarlyFinishes(state, weekVariance(state, entries, weekStartDate, asOf, siteId), policy);

  // Tips past the deadline: what is owed, and who it is owed to, from the allocation of the week it was taken.
  const overdueTips = (state.tips ?? []).filter((t) => t.siteId === siteId && !t.paidOn && tipsPayBy(t.date) < asOf);
  const overdueWorkers = new Set<string>();
  for (const w of new Set(overdueTips.map((t) => weekStart(t.date)))) {
    for (const share of troncRun(state, entries, siteId, w, asOf, rates).shares) overdueWorkers.add(share.employeeId);
  }
  const overdue = round2(overdueTips.reduce((s, t) => s + t.amount, 0));
  const tribunalCeiling = overdueWorkers.size * rates.tipsTribunalAwardCap;
  // Annualise a full week: the selected one if it has closed, otherwise the last one that has.
  const fullWeek = weekDates(weekStartDate).every((d) => d < asOf) ? weekStartDate : addDays(weekStart(asOf), -7);
  const run = troncRun(state, entries, siteId, fullWeek, asOf, rates);
  const niAtStakeAnnual = run.independent ? round2((run.niSaving.employer + run.niSaving.employee) * 52) : 0;

  const owedNow = nmw.reduce((s, r) => s + r.arrears, 0) + overdue;
  return {
    nmw,
    rightToWork,
    workingTime: clocked.filter((i) => i.code !== 'right-to-work'),
    workingTimeAverages: workingTimeAverages(state, entries, siteId, asOf).filter((r) => r.average > WTR_AVERAGE_LIMIT - 4),
    tronc: {
      overdue,
      overdueWorkers: overdueWorkers.size,
      tribunalCeiling,
      niAtStakeAnnual,
      issues: troncCompliance(state, entries, siteId, weekStartDate, asOf, rates),
    },
    era: { policy, offers, weeklyFixedCost: round2(offers.reduce((s, o) => s + o.weeklyFixedCost, 0)), earlyFinishes },
    owedNow: round2(owedNow),
    penaltyCeiling: round2(nmw.reduce((s, r) => s + r.penalty, 0) + rightToWork.reduce((s, l) => s + l.penaltyCeiling, 0) + tribunalCeiling),
    annualisedArrears: round2(nmw.reduce((s, r) => s + r.annualisedArrears, 0)),
  };
}
