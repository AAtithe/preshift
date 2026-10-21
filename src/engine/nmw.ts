import type { RotaState } from './types';
import { blendedShifts } from './actuals';
import { nmwPay, shiftPaidMinutes, shiftsInWeek } from './cost';
import { ageOn, weekDates } from './time';
import { UK_RATES_2026_27, minimumWageFor, type UkRates } from './ukRates';

export interface NmwRow {
  employeeId: string;
  /** Clocked for a closed week; clocked days plus the rota still to come for an open one. */
  basis: 'clocked' | 'projected';
  hoursWorked: number;
  pay: number;
  bandRate: number;
  bandLabel: string;
  effectiveRate: number;
  arrears: number;
  /** HMRC penalty ceiling on those arrears. */
  penalty: number;
  /** The arrears if this week's pattern runs for a year. */
  annualisedArrears: number;
  /** Hours the person can still work this week before pay drops below the band. Negative is over. */
  headroomHours: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The minimum wage test HMRC runs, on hours actually worked rather than hours
 * contracted. The usual hospitality failure is a salaried head chef or
 * assistant manager whose salary looks generous until it is divided by a
 * 55 hour week, made worse by a uniform deduction. Rows are returned for
 * salaried staff, anyone with deductions, and anyone below the band.
 */
export function nmwCheck(
  state: RotaState,
  weekStartDate: string,
  asOf: string,
  siteId?: string,
  rates: UkRates = UK_RATES_2026_27,
): NmwRow[] {
  const closed = weekDates(weekStartDate).every((d) => d < asOf);
  const shifts = shiftsInWeek(blendedShifts(state, asOf), weekStartDate);
  const rows: NmwRow[] = [];

  for (const employee of state.employees) {
    if (siteId && employee.siteId !== siteId) continue;
    const hoursWorked = shifts.filter((s) => s.employeeId === employee.id).reduce((sum, s) => sum + shiftPaidMinutes(s), 0) / 60;
    if (hoursWorked === 0) continue;
    // Minimum wage band is set by age at the start of the pay reference period.
    const band = minimumWageFor(ageOn(employee.dateOfBirth, weekStartDate), rates);
    if (!band) continue;
    const pay = nmwPay(employee, hoursWorked);
    const required = band.hourly * hoursWorked;
    const arrears = round2(Math.max(0, required - pay));
    const relevant = employee.payBasis === 'salaried' || (employee.nmwReducingDeductionsWeekly ?? 0) > 0 || arrears > 0;
    if (!relevant) continue;
    rows.push({
      employeeId: employee.id,
      basis: closed ? 'clocked' : 'projected',
      hoursWorked: round2(hoursWorked),
      pay: round2(pay),
      bandRate: band.hourly,
      bandLabel: band.label,
      effectiveRate: round2(pay / hoursWorked),
      arrears,
      penalty: round2(Math.min(arrears * rates.nmwPenaltyRate, rates.nmwPenaltyCapPerWorker)),
      annualisedArrears: round2(arrears * 52),
      headroomHours: employee.payBasis === 'salaried' ? round2(pay / band.hourly - hoursWorked) : 0,
    });
  }
  return rows.sort((a, b) => b.arrears - a.arrears || a.headroomHours - b.headroomHours);
}
