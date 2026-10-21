import type { Department, RotaState, Shift, TimeEntry } from './types';
import { shiftPaidHours, weekCost } from './cost';
import { scopeMetrics, type ScopeMetrics } from './metrics';
import { addDays, weekDates } from './time';

// Management reports. Every figure comes from the same cost and metrics engine the rota and the
// close use, so a report always ties back to the KPI bar and to the journal for the same scope.

const round2 = (n: number) => Math.round(n * 100) / 100;
const ratio = (a: number, b: number) => (b > 0 ? a / b : 0);

export interface TrendWeek {
  weekStart: string;
  metrics: ScopeMetrics;
}

/** The scope's labour week by week, oldest first, ending with `endWeek`. */
export function labourTrend(state: RotaState, siteIds: string[], endWeek: string, weeks: number): TrendWeek[] {
  return Array.from({ length: weeks }, (_, i) => {
    const weekStart = addDays(endWeek, (i - weeks + 1) * 7);
    return { weekStart, metrics: scopeMetrics(state, siteIds, weekStart) };
  });
}

export interface CostLine {
  paidHours: number;
  gross: number;
  holiday: number;
  employerNi: number;
  pension: number;
  total: number;
}

export interface RoleCostLine extends CostLine {
  roleId: string;
  /** Pay for people paid but not rostered this week (salaried or guaranteed hours), in this line's total. */
  unrostered: number;
}

export interface DepartmentCost extends CostLine {
  department: Department;
  roles: RoleCostLine[];
}

export interface LabourByRole extends CostLine {
  departments: DepartmentCost[];
  forecastSales: number;
}

const zero = (): CostLine => ({ paidHours: 0, gross: 0, holiday: 0, employerNi: 0, pension: 0, total: 0 });

function addTo(into: CostLine, c: CostLine) {
  into.paidHours += c.paidHours;
  into.gross += c.gross;
  into.holiday += c.holiday;
  into.employerNi += c.employerNi;
  into.pension += c.pension;
  into.total += c.total;
}

function rounded<T extends CostLine>(c: T): T {
  return { ...c, paidHours: round2(c.paidHours), gross: round2(c.gross), holiday: round2(c.holiday), employerNi: round2(c.employerNi), pension: round2(c.pension), total: round2(c.total) };
}

const DEPARTMENT_ORDER: Department[] = ['FOH', 'BAR', 'BOH', 'MGMT'];

/**
 * The week's loaded labour split by department and role, with each on-cost shown. Shifts post to
 * the role worked; people paid but not rostered post to their primary role at their home site,
 * the same rule the accrual journal uses, so each role's gross ties to its wages nominal.
 */
export function labourByRole(state: RotaState, siteIds: string[], week: string): LabourByRole {
  const roles = new Map<string, RoleCostLine>();
  const line = (roleId: string) => {
    const cur = roles.get(roleId) ?? { roleId, unrostered: 0, ...zero() };
    roles.set(roleId, cur);
    return cur;
  };
  for (const siteId of siteIds) {
    const cost = weekCost(state, week, siteId);
    for (const shift of state.shifts) {
      const sc = cost.shifts.get(shift.id);
      if (sc) addTo(line(shift.roleId), sc);
    }
    for (const employee of state.employees) {
      const ec = cost.employees.get(employee.id);
      if (!ec || state.shifts.some((s) => s.employeeId === employee.id && cost.shifts.has(s.id))) continue;
      const l = line(employee.roleIds[0]);
      addTo(l, { ...ec, paidHours: 0 });
      l.unrostered += ec.total;
    }
  }
  const dates = weekDates(week);
  const forecastSales = state.forecast
    .filter((f) => siteIds.includes(f.siteId) && dates.includes(f.date))
    .reduce((s, f) => s + f.sales, 0);

  const departments = DEPARTMENT_ORDER.map((department) => {
    const lines = state.roles
      .filter((r) => r.department === department && roles.has(r.id))
      .map((r) => rounded({ ...roles.get(r.id)!, unrostered: round2(roles.get(r.id)!.unrostered) }))
      .sort((a, b) => b.total - a.total);
    const total = zero();
    lines.forEach((l) => addTo(total, l));
    return { department, roles: lines, ...rounded(total) };
  }).filter((d) => d.roles.length > 0);

  const total = zero();
  departments.forEach((d) => addTo(total, d));
  return { departments, forecastSales: round2(forecastSales), ...rounded(total) };
}

/** Time that counts as worked for the report: clocked out and not rejected, approved or not. */
export function clockedShifts(entries: TimeEntry[]): Shift[] {
  return entries
    .filter((e) => e.status !== 'rejected' && e.clockOut !== undefined)
    .map((e) => ({
      id: `te:${e.id}`,
      employeeId: e.employeeId,
      roleId: e.roleId,
      siteId: e.siteId,
      date: e.date,
      startMinute: e.clockIn,
      endMinute: e.clockOut!,
      breakMinutes: e.breakMinutes,
    }));
}

export interface PersonVariance {
  employeeId: string;
  /** Hours on days worked so far. */
  rosteredHours: number;
  clockedHours: number;
  hoursVariance: number;
  /** Latest estimate less the rota for the week, loaded. */
  costVariance: number;
  /** Rostered shifts on days already past with nothing clocked at that site. */
  noShows: number;
  /** Days clocked with no rostered shift at that site. */
  unrostered: number;
}

export interface SiteVariance {
  siteId: string;
  forecastSales: number;
  rotaCost: number;
  estimateCost: number;
  costVariance: number;
  rotaPct: number;
  estimatePct: number;
}

export interface RotaVsActual {
  /** Last day that counts as worked; later days are still the rota. */
  workedTo: string;
  sites: SiteVariance[];
  people: PersonVariance[];
  forecastSales: number;
  rotaCost: number;
  estimateCost: number;
  costVariance: number;
  rotaPct: number;
  estimatePct: number;
  /** Clocked entries in scope still waiting for a manager. */
  awaitingApproval: number;
  /** People still clocked in, not yet in the clocked figures. */
  stillOpen: number;
}

/**
 * The rota against the floor, in pounds. The latest estimate is the week as it now stands: clocked
 * time for days already worked and the rota for the days left, so it is set against the whole
 * week's forecast and the salaried pay is a full week on both sides. Both are priced by the same
 * cost engine, so the variance is what drift costs after NI, pension and holiday.
 *
 * Today counts as worked for a person once they have clocked out there; until then, their rota
 * stands. Before today, only the clock counts, so a rostered shift nobody clocked costs nothing.
 */
export function rotaVsActual(state: RotaState, entries: TimeEntry[], siteIds: string[], week: string, today: string): RotaVsActual {
  const dates = weekDates(week);
  const end = dates[6];
  const workedTo = today < end ? today : end;
  // Every site's time stays in, so people who also work outside the scope keep their true on-costs.
  const weekEntries = entries.filter((e) => e.date >= week && e.date <= workedTo);
  const clocked = clockedShifts(weekEntries);
  const rota = state.shifts.filter((s) => dates.includes(s.date));
  const closedToday = (s: Shift) => s.date === today && clocked.some((c) => c.employeeId === s.employeeId && c.siteId === s.siteId && c.date === s.date);
  const stands = (s: Shift) => s.date > today || (s.date === today && !closedToday(s));
  const estimate = [...rota.filter(stands), ...clocked.filter((c) => c.date < today || closedToday(c))];
  const planned = { employees: state.employees, shifts: rota };
  const latest = { employees: state.employees, shifts: estimate };

  const people = new Map<string, PersonVariance & { rotaCost: number; estimateCost: number }>();
  const person = (employeeId: string) => {
    const cur = people.get(employeeId) ?? { employeeId, rosteredHours: 0, clockedHours: 0, hoursVariance: 0, costVariance: 0, noShows: 0, unrostered: 0, rotaCost: 0, estimateCost: 0 };
    people.set(employeeId, cur);
    return cur;
  };

  const sites = siteIds.map((siteId) => {
    const plan = weekCost(planned, week, siteId);
    const est = weekCost(latest, week, siteId);
    const price = (cost: typeof plan, shifts: Shift[], key: 'rotaCost' | 'estimateCost') => {
      for (const s of shifts) if (cost.shifts.has(s.id)) person(s.employeeId)[key] += cost.shifts.get(s.id)!.total;
      // People paid but not rostered carry their pay too, so each person's figures add up to the site's.
      for (const [employeeId, ec] of cost.employees) {
        if (!shifts.some((s) => s.employeeId === employeeId && cost.shifts.has(s.id))) person(employeeId)[key] += ec.total;
      }
    };
    price(plan, rota, 'rotaCost');
    price(est, estimate, 'estimateCost');

    const siteEntries = weekEntries.filter((e) => e.siteId === siteId);
    for (const s of rota.filter((x) => x.siteId === siteId && x.date <= workedTo)) {
      const p = person(s.employeeId);
      p.rosteredHours += shiftPaidHours(s);
      const any = siteEntries.some((e) => e.employeeId === s.employeeId && e.date === s.date);
      if (!any && s.date < today) p.noShows++;
    }
    for (const c of clocked.filter((x) => x.siteId === siteId)) person(c.employeeId).clockedHours += shiftPaidHours(c);
    for (const e of siteEntries) {
      if (!rota.some((s) => s.employeeId === e.employeeId && s.siteId === siteId && s.date === e.date)) person(e.employeeId).unrostered++;
    }

    const forecastSales = state.forecast.filter((f) => f.siteId === siteId && dates.includes(f.date)).reduce((s, f) => s + f.sales, 0);
    return {
      siteId,
      forecastSales: round2(forecastSales),
      rotaCost: plan.total,
      estimateCost: est.total,
      costVariance: round2(est.total - plan.total),
      rotaPct: ratio(plan.total, forecastSales),
      estimatePct: ratio(est.total, forecastSales),
    };
  });

  const list = [...people.values()]
    .map(({ rotaCost, estimateCost, ...p }) => ({
      ...p,
      rosteredHours: round2(p.rosteredHours),
      clockedHours: round2(p.clockedHours),
      hoursVariance: round2(p.clockedHours - p.rosteredHours),
      costVariance: round2(estimateCost - rotaCost),
    }))
    .sort((a, b) => Math.abs(b.costVariance) - Math.abs(a.costVariance));

  const scoped = weekEntries.filter((e) => siteIds.includes(e.siteId));
  const forecastSales = round2(sites.reduce((s, x) => s + x.forecastSales, 0));
  const rotaCost = round2(sites.reduce((s, x) => s + x.rotaCost, 0));
  const estimateCost = round2(sites.reduce((s, x) => s + x.estimateCost, 0));
  return {
    workedTo,
    sites,
    people: list,
    forecastSales,
    rotaCost,
    estimateCost,
    costVariance: round2(estimateCost - rotaCost),
    rotaPct: ratio(rotaCost, forecastSales),
    estimatePct: ratio(estimateCost, forecastSales),
    awaitingApproval: scoped.filter((e) => e.status === 'submitted').length,
    stillOpen: scoped.filter((e) => e.status === 'open').length,
  };
}
