import { shiftPaidHours } from './cost';
import type { RecordCheck } from './employees';
import { addDays, daysBetween } from './time';
import type { Employee, Shift } from './types';
import { UK_RATES_2026_27, type UkRates } from './ukRates';

export const STATUTORY_WEEKS = 5.6;
/** Hours a working week is taken to be for salaried staff with no contracted hours. */
export const DEFAULT_SALARIED_WEEK = 40;
/** A leave day for someone with no pattern yet to average. */
export const DEFAULT_DAY_HOURS = 8;
/** Days before the end of the leave year we start warning about untaken leave. */
export const YEAR_END_WARNING_DAYS = 60;

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface LeaveYear {
  start: string;
  end: string;
}

/** The leave year containing `date`, for a year that starts on `startMonthDay` (MM-DD). */
export function leaveYear(date: string, startMonthDay = '01-01'): LeaveYear {
  const year = Number(date.slice(0, 4));
  const thisYear = `${year}-${startMonthDay}`;
  const start = date >= thisYear ? thisYear : `${year - 1}-${startMonthDay}`;
  const next = `${Number(start.slice(0, 4)) + 1}-${startMonthDay}`;
  return { start, end: addDays(next, -1) };
}

/**
 * Fixed hours: a set entitlement of weeks x weekly hours.
 * Accrual: irregular hours and part-year workers build 12.07% of hours worked.
 */
export type HolidayBasis = 'fixed' | 'accrual';

export function holidayBasis(employee: Employee): HolidayBasis {
  if (employee.irregularHours) return 'accrual';
  if (employee.payBasis === 'hourly' && employee.contractedHours === 0) return 'accrual';
  return 'fixed';
}

function weeklyHours(employee: Employee): number {
  if (employee.contractedHours > 0) return employee.contractedHours;
  return employee.payBasis === 'salaried' ? DEFAULT_SALARIED_WEEK : 0;
}

/** Pay for one hour of holiday, before on-costs. */
export function holidayHourlyRate(employee: Employee): number {
  if (employee.payBasis === 'hourly') return employee.hourlyRate;
  const week = weeklyHours(employee);
  return week > 0 ? employee.annualSalary / 52 / week : 0;
}

/**
 * Actual hours worked: approved time where a day has any, the rota otherwise.
 * Both arrive as shifts; actual shifts carry ids starting `te:` (see entriesAsShifts).
 */
export function workedShifts(rostered: Shift[], actual: Shift[]): Shift[] {
  const clocked = new Set(actual.map((s) => `${s.employeeId}|${s.date}`));
  return [...actual, ...rostered.filter((s) => !clocked.has(`${s.employeeId}|${s.date}`))];
}

export interface HolidayBalance {
  employeeId: string;
  basis: HolidayBasis;
  year: LeaveYear;
  /** Full-year entitlement for fixed hours (pro rata to employment), accrued so far for accrual. */
  entitlementHours: number;
  /** Earned to date: what would be owed if they left today. */
  accruedHours: number;
  carriedOverHours: number;
  takenHours: number;
  bookedHours: number;
  /** Entitlement plus carry over, less taken and booked. */
  remainingHours: number;
  /** Earned and not yet taken: the basis of the holiday pay provision. Negative means taken ahead of accrual. */
  untakenHours: number;
  /** Hours a normal leave day counts for. */
  dayHours: number;
  hourlyRate: number;
  /** Untaken holiday at pay rate, and with employer NI on top, as the provision in the accounts. */
  liability: number;
  liabilityWithNi: number;
  checks: RecordCheck[];
}

function daysInclusive(from: string, to: string) {
  return to < from ? 0 : daysBetween(from, to) + 1;
}

/**
 * Holiday position for one person in the leave year containing `today`.
 * `worked` is paid time, actual where known (see workedShifts); only shifts up
 * to `today` count towards accrual.
 */
export function holidayBalance(
  employee: Employee,
  worked: Shift[],
  today: string,
  leaveYearStart = '01-01',
  rates: UkRates = UK_RATES_2026_27,
): HolidayBalance {
  const year = leaveYear(today, leaveYearStart);
  const record = employee.holiday ?? {};
  const basis = holidayBasis(employee);
  const from = employee.startDate && employee.startDate > year.start ? employee.startDate : year.start;
  const to = employee.leaveDate && employee.leaveDate < year.end ? employee.leaveDate : year.end;
  const upTo = today < to ? today : to;
  const yearDays = daysInclusive(year.start, year.end);

  const mine = worked.filter((s) => s.employeeId === employee.id && s.date >= from && s.date <= upTo);
  const workedHours = mine.reduce((sum, s) => sum + shiftPaidHours(s), 0);

  let entitlementHours: number;
  let accruedHours: number;
  let dayHours: number;
  if (basis === 'fixed') {
    const annual = (record.entitlementWeeks ?? STATUTORY_WEEKS) * weeklyHours(employee);
    entitlementHours = (annual * daysInclusive(from, to)) / yearDays;
    // Fixed entitlement builds evenly over the year from the dates alone, so no opening accrual is needed.
    accruedHours = (annual * daysInclusive(from, upTo)) / yearDays;
    dayHours = weeklyHours(employee) / 5;
  } else {
    accruedHours = workedHours * rates.holidayAccrualRate + (record.openingAccruedHours ?? 0);
    entitlementHours = accruedHours;
    const days = new Set(mine.map((s) => s.date)).size;
    dayHours = days > 0 ? workedHours / days : DEFAULT_DAY_HOURS;
  }

  const hoursOn = (date: string) => record.dayHours?.[date] ?? dayHours;
  const inYear = employee.leave.filter((d) => d >= year.start && d <= year.end);
  const takenHours = inYear.filter((d) => d <= today).reduce((sum, d) => sum + hoursOn(d), 0) + (record.openingTakenHours ?? 0);
  const bookedHours = inYear.filter((d) => d > today).reduce((sum, d) => sum + hoursOn(d), 0);
  const carriedOverHours = record.carriedOverHours ?? 0;

  const remainingHours = entitlementHours + carriedOverHours - takenHours - bookedHours;
  const untakenHours = accruedHours + carriedOverHours - takenHours;
  const hourlyRate = holidayHourlyRate(employee);
  const liability = Math.max(0, untakenHours) * hourlyRate;

  const checks: RecordCheck[] = [];
  const h = (n: number) => `${round2(n)}h`;
  if (remainingHours < -0.01) {
    checks.push({
      code: 'holiday-overbooked',
      severity: 'warn',
      message:
        basis === 'accrual'
          ? `Leave booked is ${h(-remainingHours)} ahead of what they have accrued so far.`
          : `Leave booked is ${h(-remainingHours)} more than their entitlement this year.`,
    });
  }
  const daysLeft = daysBetween(today, year.end);
  const leaving = employee.leaveDate && employee.leaveDate <= year.end;
  if (!leaving && daysLeft <= YEAR_END_WARNING_DAYS && remainingHours > dayHours * 5) {
    checks.push({
      code: 'holiday-unused',
      severity: 'warn',
      message: `${h(remainingHours)} unbooked with ${daysLeft} days of the leave year left. Statutory leave cannot normally be carried over.`,
    });
  }
  if (leaving && untakenHours > 0.01) {
    checks.push({
      code: 'holiday-final-pay',
      severity: 'warn',
      message: `Leaving ${employee.leaveDate}: ${h(untakenHours)} accrued and untaken, about £${liability.toFixed(2)} to add to final pay.`,
    });
  }
  if (leaving && untakenHours < -0.01) {
    checks.push({
      code: 'holiday-overtaken',
      severity: 'warn',
      message: `Leaving ${employee.leaveDate} having taken ${h(-untakenHours)} more than accrued. Deduct from final pay only if the contract allows it.`,
    });
  }

  return {
    employeeId: employee.id,
    basis,
    year,
    entitlementHours: round2(entitlementHours),
    accruedHours: round2(accruedHours),
    carriedOverHours: round2(carriedOverHours),
    takenHours: round2(takenHours),
    bookedHours: round2(bookedHours),
    remainingHours: round2(remainingHours),
    untakenHours: round2(untakenHours),
    dayHours: round2(dayHours),
    hourlyRate: round2(hourlyRate),
    liability: round2(liability),
    liabilityWithNi: round2(liability * (1 + rates.employerNiRate)),
    checks,
  };
}
