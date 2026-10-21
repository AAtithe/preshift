// UK statutory parameters for tax year 2026/27 (from 6 April 2026).
// These move every April. Keep them in one place, and re-check against
// GOV.UK before each new tax year.

export interface UkRates {
  taxYear: string;
  /** National Minimum / Living Wage bands by minimum age, highest age first. */
  minimumWage: { minAge: number; hourly: number; label: string }[];
  apprenticeRate: number;
  employerNiRate: number;
  /** Employer NI secondary threshold, per week. */
  niSecondaryThresholdWeekly: number;
  /** Auto-enrolment qualifying earnings band, per week. */
  pensionLowerWeekly: number;
  pensionUpperWeekly: number;
  employerPensionRate: number;
  /** Holiday accrual on hours worked for irregular-hours and hourly staff (5.6 / 46.4). */
  holidayAccrualRate: number;
  /** Annual Employment Allowance, offset against the employer NI bill at entity level. */
  employmentAllowance: number;
  /** HMRC minimum wage penalty as a multiple of arrears, and its cap per worker. */
  nmwPenaltyRate: number;
  nmwPenaltyCapPerWorker: number;
  /** Home Office civil penalty ceiling per illegal worker: first breach and repeat breach. */
  illegalWorkingPenaltyFirst: number;
  illegalWorkingPenaltyRepeat: number;
}

export const UK_RATES_2026_27: UkRates = {
  taxYear: '2026/27',
  minimumWage: [
    { minAge: 21, hourly: 12.71, label: 'National Living Wage (21+)' },
    { minAge: 18, hourly: 10.85, label: 'NMW 18-20' },
    { minAge: 16, hourly: 8.0, label: 'NMW 16-17' },
  ],
  apprenticeRate: 8.0,
  employerNiRate: 0.15,
  niSecondaryThresholdWeekly: 96,
  pensionLowerWeekly: 120,
  pensionUpperWeekly: 967,
  employerPensionRate: 0.03,
  holidayAccrualRate: 0.1207,
  employmentAllowance: 10_500,
  nmwPenaltyRate: 2,
  nmwPenaltyCapPerWorker: 20_000,
  illegalWorkingPenaltyFirst: 45_000,
  illegalWorkingPenaltyRepeat: 60_000,
};

export function minimumWageFor(age: number, rates: UkRates = UK_RATES_2026_27) {
  return rates.minimumWage.find((band) => age >= band.minAge) ?? null;
}
