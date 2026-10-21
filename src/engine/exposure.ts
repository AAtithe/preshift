import type { RotaState } from './types';
import { actualCompliance, weekVariance } from './actuals';
import { checkWeek, type Issue } from './compliance';
import { compensationOnEarlyFinishes, ERA_ASSUMPTIONS, guaranteedHoursOffers, type EraPolicy, type GuaranteedHoursOffer } from './era';
import { nmwCheck, type NmwRow } from './nmw';
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
  era: {
    policy: EraPolicy;
    offers: GuaranteedHoursOffer[];
    weeklyFixedCost: number;
    earlyFinishes: { count: number; saved: number; compensation: number };
  };
  /** Money owed to workers now: minimum wage arrears. */
  owedNow: number;
  /** The most the regulators could charge on top: NMW penalties and illegal working penalties. */
  penaltyCeiling: number;
  /** Minimum wage arrears if this week's pattern ran for a year. */
  annualisedArrears: number;
}

const RTW_PRICED = new Set(['rtw-expired', 'rtw-student-hours', 'rtw-missing']);
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
  siteId: string,
  weekStartDate: string,
  asOf: string,
  policy: EraPolicy = ERA_ASSUMPTIONS,
  rates: UkRates = UK_RATES_2026_27,
): ExposureRegister {
  const nmw = nmwCheck(state, weekStartDate, asOf, siteId, rates).filter((r) => r.arrears > 0 || r.headroomHours < 2);

  const clocked = actualCompliance(state, weekStartDate, asOf, siteId);
  const planned = checkWeek(state, weekStartDate, siteId).filter((i) => i.code.startsWith('rtw-'));
  const rightToWork: RightToWorkLine[] = [];
  const seen = new Set<string>();
  for (const [source, issues] of [['clocked', clocked], ['rota', planned]] as const) {
    for (const i of issues) {
      if (!i.code.startsWith('rtw-')) continue;
      const key = `${i.employeeId}|${i.code}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rightToWork.push({ employeeId: i.employeeId, code: i.code, source, message: i.message, penaltyCeiling: 0 });
    }
  }
  // One penalty per illegal worker, however many breaches they have.
  const charged = new Set<string>();
  for (const line of rightToWork) {
    if (!RTW_PRICED.has(line.code) || charged.has(line.employeeId)) continue;
    line.penaltyCeiling = rates.illegalWorkingPenaltyFirst;
    charged.add(line.employeeId);
  }

  const offers = guaranteedHoursOffers(state, siteId, asOf, policy);
  const earlyFinishes = compensationOnEarlyFinishes(state, weekVariance(state, weekStartDate, asOf, siteId), policy);
  const owedNow = nmw.reduce((s, r) => s + r.arrears, 0);
  return {
    nmw,
    rightToWork,
    workingTime: clocked.filter((i) => !i.code.startsWith('rtw-')),
    era: { policy, offers, weeklyFixedCost: round2(offers.reduce((s, o) => s + o.weeklyFixedCost, 0)), earlyFinishes },
    owedNow: round2(owedNow),
    penaltyCeiling: round2(nmw.reduce((s, r) => s + r.penalty, 0) + rightToWork.reduce((s, l) => s + l.penaltyCeiling, 0)),
    annualisedArrears: round2(nmw.reduce((s, r) => s + r.annualisedArrears, 0)),
  };
}
