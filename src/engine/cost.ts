import type { Employee, Entity, RotaState, Shift, Site } from './types';
import { UK_RATES_2026_27, type UkRates } from './ukRates';
import { weekDates } from './time';
import { employedShare } from './employees';
import { travelMinutesInto, travelRate } from './travel';

export function shiftPaidMinutes(shift: Shift): number {
  return Math.max(0, shift.endMinute - shift.startMinute - shift.breakMinutes);
}

export function shiftPaidHours(shift: Shift): number {
  return shiftPaidMinutes(shift) / 60;
}

export interface EmployeeWeekCost {
  employeeId: string;
  /** Shift hours plus paid travel between sites. */
  paidHours: number;
  /** Of which travel between sites during a working day. */
  travelHours: number;
  gross: number;
  holiday: number;
  employerNi: number;
  pension: number;
  total: number;
}

export interface ShiftCost {
  shiftId: string;
  paidHours: number;
  /** Paid travel to this shift from another site earlier that day, costed with it. */
  travelHours: number;
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
  /**
   * The total split into its parts, for the site in scope only: a person who also works at
   * another site brings just the share of their week spent here.
   */
  parts: { gross: number; holiday: number; employerNi: number; pension: number };
  /** Cost of people paid but not rostered (salaried or guaranteed hours). */
  unallocated: number;
  /** Paid travel between sites in scope: hours, and the loaded cost they carry. */
  travel: { hours: number; cost: number };
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
  /** Share of the week they are employed; starters and leavers are paid pro rata. */
  share = 1,
  /** Sites, for paid travel between them; without them travel costs nothing. */
  sites: Site[] = [],
  /** Companies, for the rate their travel is paid at; without them it is the normal rate. */
  entities: Entity[] = [],
): EmployeeWeekCost {
  const travelHours = [...travelMinutesInto(shifts, sites).values()].reduce((a, b) => a + b, 0) / 60;
  const workedHours = shifts.reduce((sum, s) => sum + shiftPaidHours(s), 0);
  const paidHours = workedHours + travelHours;
  const firstDate = shifts.reduce((min, s) => (s.date < min ? s.date : min), shifts[0]?.date ?? '9999-12-31');
  const travelPay = travelHours > 0 ? travelHours * travelRate(employee, entities, firstDate, rates) : 0;
  // Guaranteed contracted hours are a floor on pay, met by work and travel alike.
  const gross =
    employee.payBasis === 'salaried'
      ? (employee.annualSalary / 52) * share
      : Math.max(workedHours * employee.hourlyRate + travelPay, employee.contractedHours * share * employee.hourlyRate);
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
    travelHours: round2(travelHours),
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
  state: Pick<RotaState, 'employees' | 'shifts'> & { sites?: Site[]; entities?: Entity[] },
  start: string,
  siteId?: string,
  rates: UkRates = UK_RATES_2026_27,
): WeekCost {
  const weekShifts = shiftsInWeek(state.shifts, start);
  const employees = new Map<string, EmployeeWeekCost>();
  const shifts = new Map<string, ShiftCost>();
  let total = 0;
  let unallocated = 0;
  const travel = { hours: 0, cost: 0 };
  const sites = state.sites ?? [];
  const parts = { gross: 0, holiday: 0, employerNi: 0, pension: 0 };
  const addParts = (c: { gross: number; holiday: number; employerNi: number; pension: number }) => {
    parts.gross += c.gross;
    parts.holiday += c.holiday;
    parts.employerNi += c.employerNi;
    parts.pension += c.pension;
  };

  for (const employee of state.employees) {
    // On-costs depend on everything the person works that week, at any site.
    const own = weekShifts.filter((s) => s.employeeId === employee.id);
    const share = employedShare(employee, start);
    if (own.length === 0 && (share === 0 || (employee.payBasis === 'hourly' && employee.contractedHours === 0))) continue;
    const cost = employeeWeekCost(employee, own, rates, share, sites, state.entities);
    const travelInto = travelMinutesInto(own, sites);
    // An hour of travel weighs what it pays against an hour of work, so each site carries what it caused.
    const travelWeight =
      employee.payBasis === 'hourly' && employee.hourlyRate > 0 && own.length > 0
        ? travelRate(employee, state.entities ?? [], own.reduce((m, s) => (s.date < m ? s.date : m), own[0].date), rates) / employee.hourlyRate
        : 1;
    const scoped = siteId ? own.filter((s) => s.siteId === siteId) : own;
    const unrostered = own.length === 0; // salaried or guaranteed-hours staff with no shifts
    if (siteId && scoped.length === 0 && !(unrostered && employee.siteId === siteId)) continue;

    employees.set(employee.id, cost);
    // Spread by exact weighted hours: the rounded figure would leave pennies unallocated once travel is in.
    const hours = own.reduce((sum, s) => sum + shiftPaidHours(s), 0) + ([...travelInto.values()].reduce((a, b) => a + b, 0) / 60) * travelWeight;
    for (const shift of scoped) {
      const travelHours = (travelInto.get(shift.id) ?? 0) / 60;
      const share = hours > 0 ? (shiftPaidHours(shift) + travelHours * travelWeight) / hours : 0;
      const sc: ShiftCost = {
        shiftId: shift.id,
        paidHours: round2(shiftPaidHours(shift)),
        travelHours: round2(travelHours),
        gross: round2(cost.gross * share),
        holiday: round2(cost.holiday * share),
        employerNi: round2(cost.employerNi * share),
        pension: round2(cost.pension * share),
        total: round2(cost.total * share),
      };
      shifts.set(shift.id, sc);
      total += sc.total;
      addParts(sc);
      if (travelHours > 0) {
        travel.hours += travelHours;
        travel.cost += hours > 0 ? cost.total * ((travelHours * travelWeight) / hours) : 0;
      }
    }
    if (unrostered) {
      unallocated += cost.total;
      total += cost.total;
      addParts(cost);
    }
  }
  const rounded = {
    gross: round2(parts.gross),
    holiday: round2(parts.holiday),
    employerNi: round2(parts.employerNi),
    pension: round2(parts.pension),
  };
  return {
    employees,
    shifts,
    total: round2(total),
    unallocated: round2(unallocated),
    parts: rounded,
    travel: { hours: round2(travel.hours), cost: round2(travel.cost) },
  };
}
