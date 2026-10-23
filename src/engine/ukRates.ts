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
  /** Employee NI: primary threshold and upper earnings limit per week, main and upper rates. */
  niPrimaryThresholdWeekly: number;
  niUpperEarningsLimitWeekly: number;
  employeeNiMainRate: number;
  employeeNiUpperRate: number;
  /** Standard VAT rate, which applies to a mandatory service charge. */
  vatRate: number;
  /** Auto-enrolment qualifying earnings band, per week. */
  pensionLowerWeekly: number;
  pensionUpperWeekly: number;
  employerPensionRate: number;
  /** Auto-enrolment earnings trigger, per week, and the age band it applies to. */
  pensionTriggerWeekly: number;
  pensionMinAge: number;
  pensionMaxAge: number;
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
  /** Employment tribunal award cap per worker under the tips legislation, on top of the tips owed. */
  tipsTribunalAwardCap: number;
  /**
   * Statutory Sick Pay. From 6 April 2026 (Employment Rights Act 2025) it is paid from the first
   * qualifying day, with no waiting days and no lower earnings limit, at the lower of the flat
   * weekly rate and a share of average weekly earnings.
   */
  ssp: {
    weeklyRate: number;
    /** Share of average weekly earnings paid when that is lower than the flat rate. */
    aweShare: number;
    /** Weeks of average earnings looked back over, before the first day of sickness. */
    aweWeeks: number;
    /** Most weeks paid in one period of sickness, linked spells included. */
    maxWeeks: number;
    /** Spells this many days apart or fewer are one period of sickness. */
    linkDays: number;
    /** Spells beginning before this date fall under the old rules and are not estimated here. */
    newRulesFrom: string;
  };
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
  niPrimaryThresholdWeekly: 242,
  niUpperEarningsLimitWeekly: 967,
  employeeNiMainRate: 0.08,
  employeeNiUpperRate: 0.02,
  vatRate: 0.2,
  pensionLowerWeekly: 120,
  pensionUpperWeekly: 967,
  employerPensionRate: 0.03,
  pensionTriggerWeekly: 192,
  pensionMinAge: 22,
  pensionMaxAge: 66,
  holidayAccrualRate: 0.1207,
  employmentAllowance: 10_500,
  nmwPenaltyRate: 2,
  nmwPenaltyCapPerWorker: 20_000,
  illegalWorkingPenaltyFirst: 45_000,
  illegalWorkingPenaltyRepeat: 60_000,
  tipsTribunalAwardCap: 5_000,
  ssp: { weeklyRate: 123.25, aweShare: 0.8, aweWeeks: 8, maxWeeks: 28, linkDays: 56, newRulesFrom: '2026-04-06' },
};

/**
 * What comes out of an employee's pay, for estimating net pay and the HMRC bill: income tax at the
 * rest of UK rates on the standard 1257L code, employee Class 1 NI and the employee's auto-enrolment
 * contribution. Scottish and Welsh taxpayers, other tax codes, student loans and salary sacrifice all
 * move the real figure; payroll is the record, this is the forecast.
 */
export interface PayeRates {
  taxYear: string;
  personalAllowance: number;
  /** Taxable income charged at the basic rate, above the personal allowance. */
  basicRateBand: number;
  basicRate: number;
  higherRate: number;
  /** Employee NI primary threshold and upper earnings limit, a year. */
  niPrimaryThreshold: number;
  niUpperEarningsLimit: number;
  employeeNiRate: number;
  employeeNiUpperRate: number;
  /**
   * Employee auto-enrolment contribution on qualifying earnings, as taken from net pay under relief at
   * source: the statutory 5% less the 1% basic rate relief the provider claims from HMRC.
   */
  employeePensionRate: number;
  /** HMRC wants PAYE paid electronically by the 22nd of the month after the tax month. */
  payeDueDay: number;
  /** Pension contributions reach the scheme by the 22nd of the month after they were deducted. */
  pensionDueDay: number;
}

export const PAYE_2026_27: PayeRates = {
  taxYear: '2026/27',
  personalAllowance: 12_570,
  basicRateBand: 37_700,
  basicRate: 0.2,
  higherRate: 0.4,
  niPrimaryThreshold: 12_570,
  niUpperEarningsLimit: 50_270,
  employeeNiRate: 0.08,
  employeeNiUpperRate: 0.02,
  employeePensionRate: 0.04,
  payeDueDay: 22,
  pensionDueDay: 22,
};

export function minimumWageFor(age: number, rates: UkRates = UK_RATES_2026_27) {
  return rates.minimumWage.find((band) => age >= band.minAge) ?? null;
}
