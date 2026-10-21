import type { ClockRecord, Employee, RotaState, Shift } from './types';
import { checkWeek, type Issue } from './compliance';
import { shiftPaidMinutes, weekCost, type WeekCost } from './cost';
import { forecastSalesForDay } from './demand';
import { weekDates } from './time';
import { UK_RATES_2026_27, type UkRates } from './ukRates';

/** A completed clocking in the shape of a shift, so the cost and compliance engines run on it unchanged. */
export function clockAsShift(clock: ClockRecord): Shift {
  return {
    id: clock.id,
    employeeId: clock.employeeId,
    roleId: clock.roleId,
    siteId: clock.siteId,
    date: clock.date,
    startMinute: clock.clockIn,
    endMinute: clock.clockOut ?? clock.clockIn,
    breakMinutes: clock.breakMinutes,
    published: true,
  };
}

export function actualShifts(state: Pick<RotaState, 'clocks'>): Shift[] {
  return state.clocks.filter((c) => c.clockOut !== undefined).map(clockAsShift);
}

/**
 * The best estimate of what payroll will pay: clocked time for days that have
 * traded, the rota for days that have not. `asOf` is the first day not yet
 * closed, usually today.
 */
export function blendedShifts(state: Pick<RotaState, 'shifts' | 'clocks'>, asOf: string): Shift[] {
  return [
    ...actualShifts(state).filter((s) => s.date < asOf),
    ...state.shifts.filter((s) => s.date >= asOf),
  ];
}

export function actualSalesForDay(state: Pick<RotaState, 'actuals'>, siteId: string, date: string): number {
  return state.actuals.filter((a) => a.siteId === siteId && a.date === date).reduce((sum, a) => sum + a.sales, 0);
}

export type VarianceKind =
  | 'early-start'
  | 'overrun'
  | 'short-break'
  | 'unrostered'
  | 'late-start'
  | 'early-finish'
  | 'long-break'
  | 'no-show';

/** What each kind of variance means and what a GM does about it. */
export const VARIANCE_GUIDE: Record<VarianceKind, { label: string; action: string }> = {
  'early-start': { label: 'Early clock-ins', action: 'Paid before the shift started. Hold the clock-in window and brief the team.' },
  overrun: { label: 'Overruns', action: 'Paid past the rostered finish. Check close-down tasks and who is on the close.' },
  'short-break': { label: 'Breaks not taken', action: 'Paid time, and a Working Time breach where the break was required.' },
  unrostered: { label: 'Unrostered shifts', action: 'Worked without being on the rota. Approve or challenge before payroll.' },
  'late-start': { label: 'Late arrivals', action: 'Saves pay but leaves service short. A conduct conversation, not a saving.' },
  'early-finish': { label: 'Sent home early', action: 'The cut call working. Check it matched trade, not just a quiet hour.' },
  'long-break': { label: 'Long breaks', action: 'Unpaid time over the rostered break.' },
  'no-show': { label: 'No-shows', action: 'Rostered and never clocked in. Service was short or someone covered unrostered.' },
};

export const VARIANCE_ORDER = Object.keys(VARIANCE_GUIDE) as VarianceKind[];

export interface VarianceItem {
  kind: VarianceKind;
  employeeId: string;
  siteId: string;
  date: string;
  shiftId?: string;
  clockId?: string;
  /** Paid minutes against the rota: positive costs money, negative saves it. */
  minutes: number;
  cost: number;
  /** Extra paid time a manager has not signed off yet. */
  needsApproval: boolean;
}

export interface VarianceSummary {
  count: number;
  minutes: number;
  cost: number;
}

export interface WeekVariance {
  closedDates: string[];
  items: VarianceItem[];
  byKind: Record<VarianceKind, VarianceSummary>;
  /** Loaded cost of the rota for the closed days. */
  rotaCost: number;
  /** Loaded cost of what was clocked for the closed days. */
  actualCost: number;
  /** actualCost - rotaCost. Positive means payroll will pay more than the rota said. */
  total: number;
  /** total / rotaCost. The headline rota-to-payroll number; the target is under 1%. */
  pct: number;
  /**
   * The part of the variance the items do not explain: guaranteed hours paid
   * whether worked or not, and NI and pension thresholds crossed or not.
   */
  onCostEffect: number;
  unapprovedCost: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Loaded cost of one more hour for this person: pay, holiday, employer NI and
 * pension at the marginal rate. Salaried pay does not move with hours.
 */
export function loadedHourlyRate(employee: Employee, rates: UkRates = UK_RATES_2026_27): number {
  if (employee.payBasis === 'salaried') return 0;
  const earnings = employee.hourlyRate * (1 + rates.holidayAccrualRate);
  const pension = employee.pensionEnrolled ? rates.employerPensionRate : 0;
  return earnings * (1 + rates.employerNiRate + pension);
}

/** Loaded cost of a site's labour on the given days, from a week costed as a whole. */
function costOnDates(cost: WeekCost, shifts: Shift[], siteId: string | undefined, dates: string[]): number {
  const on = new Set(dates);
  const shiftCost = shifts
    .filter((s) => on.has(s.date) && (!siteId || s.siteId === siteId))
    .reduce((sum, s) => sum + (cost.shifts.get(s.id)?.total ?? 0), 0);
  return shiftCost + (cost.unallocated * dates.length) / 7;
}

/**
 * Rota against clock for every closed day of the week. Each difference is
 * classified by cause and costed at the person's loaded marginal rate, then the
 * whole is reconciled to the cost engine so the causes plus the on-cost effect
 * add back exactly to what payroll will pay over the rota.
 */
export function weekVariance(
  state: RotaState,
  weekStartDate: string,
  asOf: string,
  siteId?: string,
  rates: UkRates = UK_RATES_2026_27,
): WeekVariance {
  const closedDates = weekDates(weekStartDate).filter((d) => d < asOf);
  const closed = new Set(closedDates);
  const atSite = (s: { siteId: string; date: string }) => closed.has(s.date) && (!siteId || s.siteId === siteId);
  const employees = new Map(state.employees.map((e) => [e.id, e]));
  const items: VarianceItem[] = [];

  const push = (item: Omit<VarianceItem, 'cost' | 'needsApproval'>, clock?: ClockRecord) => {
    if (item.minutes === 0) return;
    const employee = employees.get(item.employeeId);
    const cost = employee ? round2((item.minutes / 60) * loadedHourlyRate(employee, rates)) : 0;
    items.push({ ...item, cost, needsApproval: item.minutes > 0 && !clock?.approved });
  };

  const done = state.clocks.filter((c) => c.clockOut !== undefined && atSite(c));
  const rostered = state.shifts.filter(atSite);
  const rosteredIds = new Set(rostered.map((s) => s.id));

  for (const shift of rostered) {
    const base = { employeeId: shift.employeeId, siteId: shift.siteId, date: shift.date, shiftId: shift.id };
    const clock = done.find((c) => c.shiftId === shift.id);
    if (!clock) {
      push({ ...base, kind: 'no-show', minutes: -shiftPaidMinutes(shift) });
      continue;
    }
    const withClock = { ...base, clockId: clock.id };
    const early = shift.startMinute - clock.clockIn;
    push({ ...withClock, kind: early > 0 ? 'early-start' : 'late-start', minutes: early }, clock);
    const late = clock.clockOut! - shift.endMinute;
    push({ ...withClock, kind: late > 0 ? 'overrun' : 'early-finish', minutes: late }, clock);
    const breakGap = shift.breakMinutes - clock.breakMinutes;
    push({ ...withClock, kind: breakGap > 0 ? 'short-break' : 'long-break', minutes: breakGap }, clock);
  }
  for (const clock of done) {
    if (clock.shiftId && rosteredIds.has(clock.shiftId)) continue;
    push(
      { kind: 'unrostered', employeeId: clock.employeeId, siteId: clock.siteId, date: clock.date, clockId: clock.id, minutes: shiftPaidMinutes(clockAsShift(clock)) },
      clock,
    );
  }

  const byKind = Object.fromEntries(VARIANCE_ORDER.map((k) => [k, { count: 0, minutes: 0, cost: 0 }])) as Record<
    VarianceKind,
    VarianceSummary
  >;
  for (const item of items) {
    const k = byKind[item.kind];
    k.count += 1;
    k.minutes += item.minutes;
    k.cost = round2(k.cost + item.cost);
  }

  const plan = { employees: state.employees, shifts: state.shifts };
  const actual = { employees: state.employees, shifts: blendedShifts(state, asOf) };
  const rotaCost = round2(costOnDates(weekCost(plan, weekStartDate, siteId, rates), plan.shifts, siteId, closedDates));
  const actualCost = round2(costOnDates(weekCost(actual, weekStartDate, siteId, rates), actual.shifts, siteId, closedDates));
  const total = round2(actualCost - rotaCost);
  const explained = items.reduce((sum, i) => sum + i.cost, 0);

  return {
    closedDates,
    items,
    byKind,
    rotaCost,
    actualCost,
    total,
    pct: rotaCost > 0 ? total / rotaCost : 0,
    onCostEffect: round2(total - explained),
    unapprovedCost: round2(items.filter((i) => i.needsApproval).reduce((sum, i) => sum + i.cost, 0)),
  };
}

/** Clock ids with extra paid time still waiting for a manager. */
export function clocksNeedingApproval(variance: WeekVariance): string[] {
  return [...new Set(variance.items.filter((i) => i.needsApproval && i.clockId).map((i) => i.clockId!))];
}

const ACTUAL_COMPLIANCE_CODES = new Set([
  'break',
  'daily-rest',
  'double-booked',
  'young-daily',
  'young-night',
  'weekly-rest',
  'young-weekly',
  'wtr-48',
  'rtw-expired',
  'rtw-student-hours',
]);
const WEEK_LEVEL_CODES = new Set(['weekly-rest', 'young-weekly', 'wtr-48', 'rtw-student-hours']);

/**
 * Working Time and young worker checks on what was clocked, not what was
 * planned. A legal rota can still produce an illegal week; this is the record
 * that matters if a claim is ever made.
 */
export function actualCompliance(state: RotaState, weekStartDate: string, asOf: string, siteId?: string): Issue[] {
  const closedDates = weekDates(weekStartDate).filter((d) => d < asOf);
  const closed = new Set(closedDates);
  const weekClosed = closedDates.length === 7;
  return checkWeek({ ...state, shifts: actualShifts(state) }, weekStartDate, siteId)
    .filter((i) => ACTUAL_COMPLIANCE_CODES.has(i.code))
    .filter((i) => (WEEK_LEVEL_CODES.has(i.code) ? weekClosed : !i.date || closed.has(i.date)))
    .map((i) => ({ ...i, message: `Clocked: ${i.message.replace('rostered', 'worked')}` }));
}

export interface FlashDay {
  date: string;
  closed: boolean;
  forecastSales: number;
  actualSales: number;
  rotaCost: number;
  actualCost: number;
  actualHours: number;
  rotaPct: number;
  actualPct: number;
}

export interface WeekFlash {
  days: FlashDay[];
  forecastSales: number;
  actualSales: number;
  rotaCost: number;
  actualCost: number;
  actualHours: number;
  rotaPct: number;
  actualPct: number;
  splh: number;
  targetPct: number;
  /** Actual labour over what the target allows on actual sales. Positive is over. */
  varianceToTarget: number;
  variance: WeekVariance;
  compliance: Issue[];
}

const ratio = (num: number, den: number) => (den > 0 ? num / den : 0);

/**
 * The Monday morning labour flash: what was sold, what labour actually cost,
 * the rota that was meant to deliver it, and why the two differ. Totals cover
 * closed days only, so a mid-week flash is never flattered by days not yet traded.
 */
export function weekFlash(state: RotaState, siteId: string, weekStartDate: string, asOf: string): WeekFlash {
  const site = state.sites.find((s) => s.id === siteId);
  const plan = { employees: state.employees, shifts: state.shifts };
  const blended = blendedShifts(state, asOf);
  const planCost = weekCost(plan, weekStartDate, siteId);
  const actualCostWeek = weekCost({ employees: state.employees, shifts: blended }, weekStartDate, siteId);

  const days = weekDates(weekStartDate).map((date): FlashDay => {
    const closed = date < asOf;
    const rotaCost = costOnDates(planCost, plan.shifts, siteId, [date]);
    const actualCost = closed ? costOnDates(actualCostWeek, blended, siteId, [date]) : 0;
    const forecastSales = forecastSalesForDay(state, siteId, date);
    const actualSales = closed ? actualSalesForDay(state, siteId, date) : 0;
    const actualHours = closed
      ? blended.filter((s) => s.siteId === siteId && s.date === date).reduce((sum, s) => sum + shiftPaidMinutes(s), 0) / 60
      : 0;
    return {
      date,
      closed,
      forecastSales,
      actualSales,
      rotaCost,
      actualCost,
      actualHours,
      rotaPct: ratio(rotaCost, forecastSales),
      actualPct: ratio(actualCost, actualSales),
    };
  });

  const closedDays = days.filter((d) => d.closed);
  const sum = (key: keyof FlashDay) => closedDays.reduce((s, d) => s + (d[key] as number), 0);
  const actualSales = sum('actualSales');
  const actualCost = sum('actualCost');
  const forecastSales = sum('forecastSales');
  const rotaCost = sum('rotaCost');
  const actualHours = sum('actualHours');
  const targetPct = site?.labourTargetPct ?? 0;
  return {
    days,
    forecastSales,
    actualSales,
    rotaCost,
    actualCost,
    actualHours,
    rotaPct: ratio(rotaCost, forecastSales),
    actualPct: ratio(actualCost, actualSales),
    splh: ratio(actualSales, actualHours),
    targetPct,
    varianceToTarget: actualCost - actualSales * targetPct,
    variance: weekVariance(state, weekStartDate, asOf, siteId),
    compliance: actualCompliance(state, weekStartDate, asOf, siteId),
  };
}

export type LiveStatus = 'due' | 'late' | 'on' | 'done' | 'missed';

export interface LiveRow {
  employeeId: string;
  roleId: string;
  shift?: Shift;
  clock?: ClockRecord;
  status: LiveStatus;
  unrostered: boolean;
}

/** Who is due, in, late or missing right now: the GM's view of the floor against the rota. */
export function liveBoard(state: RotaState, siteId: string, date: string, now: number, lateGraceMinutes = 5): LiveRow[] {
  const clocks = state.clocks.filter((c) => c.siteId === siteId && c.date === date);
  const rows: LiveRow[] = state.shifts
    .filter((s) => s.siteId === siteId && s.date === date)
    .map((shift) => {
      const clock = clocks.find((c) => c.shiftId === shift.id);
      const status: LiveStatus = clock
        ? clock.clockOut === undefined
          ? 'on'
          : 'done'
        : now >= shift.endMinute
          ? 'missed'
          : now > shift.startMinute + lateGraceMinutes
            ? 'late'
            : 'due';
      return { employeeId: shift.employeeId, roleId: shift.roleId, shift, clock, status, unrostered: false };
    });
  for (const clock of clocks.filter((c) => !c.shiftId)) {
    rows.push({
      employeeId: clock.employeeId,
      roleId: clock.roleId,
      clock,
      status: clock.clockOut === undefined ? 'on' : 'done',
      unrostered: true,
    });
  }
  return rows.sort((a, b) => (a.shift?.startMinute ?? a.clock!.clockIn) - (b.shift?.startMinute ?? b.clock!.clockIn));
}
