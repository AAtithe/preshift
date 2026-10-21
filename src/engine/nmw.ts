import type { Employee, RotaState } from './types';
import { blendedShifts } from './actuals';
import { shiftPaidMinutes } from './cost';
import { addDays, ageOn, parseISODate, toISODate } from './time';
import { UK_RATES_2026_27, minimumWageFor, type UkRates } from './ukRates';

export interface PayPeriod {
  from: string;
  to: string;
  frequency: 'weekly' | 'monthly';
}

/**
 * The pay reference period that holds a given week: the week itself for weekly
 * pay, or the calendar month holding most of the week for monthly pay.
 */
export function payPeriodFor(frequency: 'weekly' | 'monthly', weekStartDate: string): PayPeriod {
  if (frequency === 'weekly') return { from: weekStartDate, to: addDays(weekStartDate, 6), frequency };
  const thursday = parseISODate(addDays(weekStartDate, 3));
  const y = thursday.getUTCFullYear();
  const m = thursday.getUTCMonth();
  return {
    from: toISODate(new Date(Date.UTC(y, m, 1))),
    to: toISODate(new Date(Date.UTC(y, m + 1, 0))),
    frequency,
  };
}

/** Minimum wage pay for a whole pay reference period. */
export function nmwPayForPeriod(employee: Employee, hoursWorked: number, period: PayPeriod): number {
  const weeks = period.frequency === 'weekly' ? 1 : 52 / 12;
  const basic =
    employee.payBasis === 'salaried'
      ? period.frequency === 'weekly'
        ? employee.annualSalary / 52
        : employee.annualSalary / 12
      : employee.hourlyRate * hoursWorked;
  return basic - (employee.nmwReducingDeductionsWeekly ?? 0) * weeks;
}

export interface NmwRow {
  employeeId: string;
  period: PayPeriod;
  /**
   * Clocked when the whole period has traded. Projected otherwise: clocked
   * days, the rota still to come, and the person's daily average over the rest.
   */
  basis: 'clocked' | 'projected';
  /** Share of the period's days covered by clock or rota rather than extrapolated. */
  coverage: number;
  hoursWorked: number;
  pay: number;
  bandRate: number;
  bandLabel: string;
  effectiveRate: number;
  arrears: number;
  /** HMRC penalty ceiling on those arrears. */
  penalty: number;
  /** The arrears if this period's pattern runs for a year. */
  annualisedArrears: number;
  /** Hours the person can still work in the period before pay drops below the band. Negative is over. */
  headroomHours: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * The minimum wage test HMRC runs, on hours actually worked rather than hours
 * contracted, over each person's own pay reference period. The usual
 * hospitality failure is a salaried head chef or assistant manager whose salary
 * looks generous until it is divided by a 55 hour week, made worse by a uniform
 * deduction, and for monthly pay, worse again in a long month: the salary is
 * the same but there are more days to work. Rows are returned for salaried
 * staff, anyone with deductions, and anyone below the band.
 */
export function nmwCheck(
  state: RotaState,
  weekStartDate: string,
  asOf: string,
  siteId?: string,
  rates: UkRates = UK_RATES_2026_27,
): NmwRow[] {
  const blended = blendedShifts(state, asOf);
  const rows: NmwRow[] = [];

  for (const employee of state.employees) {
    if (siteId && employee.siteId !== siteId) continue;
    const period = payPeriodFor(employee.payFrequency ?? 'weekly', weekStartDate);
    const dates = datesBetween(period.from, period.to);
    const mine = blended.filter((s) => s.employeeId === employee.id && s.date >= period.from && s.date <= period.to);
    const knownHours = mine.reduce((sum, s) => sum + shiftPaidMinutes(s), 0) / 60;
    if (knownHours === 0) continue;

    // Real data: every day that has traded (the clock is the truth, including days off), and
    // the days after that the site has a rota for. Beyond the rota, extrapolate.
    const rotaEnd = state.shifts.filter((s) => s.siteId === employee.siteId).reduce((a, s) => (s.date > a ? s.date : a), '');
    const firstClock = state.clocks.filter((c) => c.siteId === employee.siteId).reduce((a, c) => (c.date < a ? c.date : a), asOf);
    const covered = dates.filter((d) => (d < asOf && d >= firstClock) || (d >= asOf && d <= rotaEnd));
    const hoursWorked = covered.length > 0 ? (knownHours * dates.length) / covered.length : knownHours;
    const complete = covered.length === dates.length && period.to < asOf;

    // Minimum wage band is set by age at the start of the pay reference period.
    const band = minimumWageFor(ageOn(employee.dateOfBirth, period.from), rates);
    if (!band) continue;
    const pay = nmwPayForPeriod(employee, hoursWorked, period);
    const arrears = round2(Math.max(0, band.hourly * hoursWorked - pay));
    const relevant = employee.payBasis === 'salaried' || (employee.nmwReducingDeductionsWeekly ?? 0) > 0 || arrears > 0;
    if (!relevant) continue;
    rows.push({
      employeeId: employee.id,
      period,
      basis: complete ? 'clocked' : 'projected',
      coverage: round2(covered.length / dates.length),
      hoursWorked: round2(hoursWorked),
      pay: round2(pay),
      bandRate: band.hourly,
      bandLabel: band.label,
      effectiveRate: round2(pay / hoursWorked),
      arrears,
      penalty: round2(Math.min(arrears * rates.nmwPenaltyRate, rates.nmwPenaltyCapPerWorker)),
      annualisedArrears: round2(arrears * (period.frequency === 'weekly' ? 52 : 12)),
      headroomHours: employee.payBasis === 'salaried' ? round2(pay / band.hourly - hoursWorked) : 0,
    });
  }
  return rows.sort((a, b) => b.arrears - a.arrears || a.headroomHours - b.headroomHours);
}
