import type { Employee, RotaState, Shift } from './types';
import { UK_RATES_2026_27, type UkRates } from './ukRates';
import { weekDates } from './time';

export function shiftPaidMinutes(shift: Shift): number {
  return Math.max(0, shift.endMinute - shift.startMinute - shift.breakMinutes);
}

export function shiftPaidHours(shift: Shift): number {
  return shiftPaidMinutes(shift) / 60;
}

/**
 * Pay that counts towards minimum wage for a pay reference period of one week.
 * Holiday accrual, employer on-costs and tips do not count; deductions for the
 * employer's benefit (uniform, tools) and salary sacrifice come off.
 */
export function nmwPay(employee: Employee, hoursWorked: number): number {
  const basic = employee.payBasis === 'salaried' ? employee.annualSalary / 52 : employee.hourlyRate * hoursWorked;
  return basic - (employee.nmwReducingDeductionsWeekly ?? 0);
}

export interface EmployeeWeekCost {
  employeeId: string;
  paidHours: number;
  gross: number;
  holiday: number;
  employerNi: number;
  pension: number;
  total: number;
}

export interface ShiftCost {
  shiftId: string;
  paidHours: number;
  gross: number;
  holiday: number;
  employerNi: number;
  pension: number;
  total: number;
}

export interface WeekCost {
  employees: Map<string, EmployeeWeekCost>;
  shifts: Map<string, ShiftCost>;
  total: number;
  /** Cost of people paid but not rostered (salaried or guaranteed hours). */
  unallocated: number;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

/**
 * Fully loaded weekly cost per person: gross pay, holiday, employer NI and
 * employer pension. On-costs are worked out on the person's whole week (that is
 * how HMRC and the pension band work), then spread back over their shifts in
 * proportion to hours so each shift carries its true cost.
 */
export function employeeWeekCost(
  employee: Employee,
  shifts: Shift[],
  rates: UkRates = UK_RATES_2026_27,
): EmployeeWeekCost {
  const paidHours = shifts.reduce((sum, s) => sum + shiftPaidHours(s), 0);
  // Guaranteed contracted hours are paid whether or not they are rostered.
  const gross =
    employee.payBasis === 'salaried'
      ? employee.annualSalary / 52
      : Math.max(paidHours, employee.contractedHours) * employee.hourlyRate;
  // Salaried pay already includes paid holiday; hourly staff accrue it on top.
  const holiday = employee.payBasis === 'hourly' ? gross * rates.holidayAccrualRate : 0;
  const earnings = gross + holiday;
  const employerNi = Math.max(0, earnings - rates.niSecondaryThresholdWeekly) * rates.employerNiRate;
  const pension = employee.pensionEnrolled
    ? Math.max(0, Math.min(earnings, rates.pensionUpperWeekly) - rates.pensionLowerWeekly) *
      rates.employerPensionRate
    : 0;
  return {
    employeeId: employee.id,
    paidHours: round2(paidHours),
    gross: round2(gross),
    holiday: round2(holiday),
    employerNi: round2(employerNi),
    pension: round2(pension),
    total: round2(gross + holiday + employerNi + pension),
  };
}

export function shiftsInWeek(shifts: Shift[], start: string): Shift[] {
  const dates = new Set(weekDates(start));
  return shifts.filter((s) => dates.has(s.date));
}

export function weekCost(
  state: Pick<RotaState, 'employees' | 'shifts'>,
  start: string,
  siteId?: string,
  rates: UkRates = UK_RATES_2026_27,
): WeekCost {
  const weekShifts = shiftsInWeek(state.shifts, start);
  const employees = new Map<string, EmployeeWeekCost>();
  const shifts = new Map<string, ShiftCost>();
  let total = 0;
  let unallocated = 0;

  for (const employee of state.employees) {
    // On-costs depend on everything the person works that week, at any site.
    const own = weekShifts.filter((s) => s.employeeId === employee.id);
    if (own.length === 0 && employee.payBasis === 'hourly' && employee.contractedHours === 0) continue;
    const cost = employeeWeekCost(employee, own, rates);
    const scoped = siteId ? own.filter((s) => s.siteId === siteId) : own;
    const unrostered = own.length === 0; // salaried or guaranteed-hours staff with no shifts
    if (siteId && scoped.length === 0 && !(unrostered && employee.siteId === siteId)) continue;

    employees.set(employee.id, cost);
    const hours = cost.paidHours;
    for (const shift of scoped) {
      const share = hours > 0 ? shiftPaidHours(shift) / hours : 0;
      const sc: ShiftCost = {
        shiftId: shift.id,
        paidHours: round2(shiftPaidHours(shift)),
        gross: round2(cost.gross * share),
        holiday: round2(cost.holiday * share),
        employerNi: round2(cost.employerNi * share),
        pension: round2(cost.pension * share),
        total: round2(cost.total * share),
      };
      shifts.set(shift.id, sc);
      total += sc.total;
    }
    if (unrostered) {
      unallocated += cost.total;
      total += cost.total;
    }
  }
  return { employees, shifts, total: round2(total), unallocated: round2(unallocated) };
}
