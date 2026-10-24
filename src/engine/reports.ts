import type { SspCheckLine } from './ssp';
import type { DaySales, Department, RotaState, Shift, Site, TimeEntry } from './types';
import { shiftPaidHours, weekCost } from './cost';
import { forecastSalesForDay } from './demand';
import type { PayrollVariance } from './timesheet';
import { addDays, weekDates } from './time';

// Management reports. Every figure comes from the same cost and metrics engine the rota and the
// close use, so a report always ties back to the KPI bar and to the journal for the same scope.

const round2 = (n: number) => Math.round(n * 100) / 100;
const ratio = (a: number, b: number) => (b > 0 ? a / b : 0);

/** Actual takings where the till has them, the forecast for days it does not. */
export function salesEstimate(state: RotaState, siteId: string, dates: string[]) {
  let forecast = 0;
  let actual = 0;
  let estimate = 0;
  let actualDays = 0;
  for (const date of dates) {
    const f = forecastSalesForDay(state, siteId, date);
    const a = state.sales?.find((x) => x.siteId === siteId && x.date === date);
    forecast += f;
    if (a) {
      actual += a.netSales;
      actualDays++;
    }
    estimate += a ? a.netSales : f;
  }
  return { forecast: round2(forecast), actual: round2(actual), estimate: round2(estimate), actualDays };
}

export interface TrendFigures {
  forecastSales: number;
  /** Takings where recorded, forecast for the rest. */
  sales: number;
  /** Days of the week that have takings recorded. */
  actualDays: number;
  rotaLabour: number;
  /** Clocked time for days worked, the rota for the rest, or the rota alone where nothing was clocked. */
  labour: number;
  labourBasis: 'clock' | 'rota';
  labourPct: number;
  targetPct: number;
  /** Labour the week should have cost at target on what it actually took. */
  targetCost: number;
  varianceToTarget: number;
  paidHours: number;
}

export interface TrendWeek extends TrendFigures {
  weekStart: string;
  sites: (TrendFigures & { siteId: string })[];
}

/**
 * Labour against target on what each week actually took, oldest first, ending with `endWeek`.
 * The target flexes with takings: a site that took less than forecast should have spent less,
 * so the variance is set against target spend on real sales, not on the forecast.
 */
export function performanceTrend(state: RotaState, entries: TimeEntry[], siteIds: string[], endWeek: string, weeks: number, today: string): TrendWeek[] {
  return Array.from({ length: weeks }, (_, i) => {
    const weekStart = addDays(endWeek, (i - weeks + 1) * 7);
    const dates = weekDates(weekStart);
    // Sites go with the shifts so paid travel between them is costed the same way on both sides.
    const latest = { employees: state.employees, sites: state.sites, entities: state.entities, shifts: latestShifts(state, entries, weekStart, today) };
    const sites = siteIds.map((siteId) => {
      const site = state.sites.find((s) => s.id === siteId);
      const sales = salesEstimate(state, siteId, dates);
      const rota = weekCost(state, weekStart, siteId);
      const est = weekCost(latest, weekStart, siteId);
      const clocked = entries.some((e) => e.siteId === siteId && dates.includes(e.date));
      const targetPct = site?.labourTargetPct ?? 0;
      const paidHours = latest.shifts.filter((s) => s.siteId === siteId && dates.includes(s.date)).reduce((t, s) => t + shiftPaidHours(s), 0);
      return {
        siteId,
        forecastSales: sales.forecast,
        sales: sales.estimate,
        actualDays: sales.actualDays,
        rotaLabour: rota.total,
        labour: est.total,
        labourBasis: clocked ? ('clock' as const) : ('rota' as const),
        labourPct: ratio(est.total, sales.estimate),
        targetPct,
        targetCost: round2(sales.estimate * targetPct),
        varianceToTarget: round2(est.total - sales.estimate * targetPct),
        paidHours: round2(paidHours),
      };
    });
    const sum = (f: (x: TrendFigures) => number) => round2(sites.reduce((t, x) => t + f(x), 0));
    const sales = sum((x) => x.sales);
    const labour = sum((x) => x.labour);
    const targetCost = sum((x) => x.targetCost);
    return {
      weekStart,
      sites,
      forecastSales: sum((x) => x.forecastSales),
      sales,
      actualDays: Math.min(...sites.map((x) => x.actualDays), 7),
      rotaLabour: sum((x) => x.rotaLabour),
      labour,
      labourBasis: sites.some((x) => x.labourBasis === 'clock') ? 'clock' : 'rota',
      labourPct: ratio(labour, sales),
      targetPct: ratio(targetCost, sales),
      targetCost,
      varianceToTarget: round2(labour - targetCost),
      paidHours: sum((x) => x.paidHours),
    };
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

/**
 * The week as it now stands, as shifts the cost engine can price: clocked time for days worked and
 * the rota for days left. Today counts as worked for a person once they have clocked out there;
 * until then their rota stands. A site with nothing clocked all week keeps its rota, because that
 * means clocking is not in use there yet, not that nobody came in.
 */
export function latestShifts(state: RotaState, entries: TimeEntry[], week: string, today: string): Shift[] {
  const dates = weekDates(week);
  const clocked = clockedShifts(entries.filter((e) => dates.includes(e.date) && e.date <= today));
  const clockingSites = new Set(entries.filter((e) => dates.includes(e.date)).map((e) => e.siteId));
  const rota = state.shifts.filter((s) => dates.includes(s.date));
  const closedToday = (s: Shift) => s.date === today && clocked.some((c) => c.employeeId === s.employeeId && c.siteId === s.siteId && c.date === s.date);
  return [
    ...rota.filter((s) => !clockingSites.has(s.siteId) || s.date > today || (s.date === today && !closedToday(s))),
    ...clocked.filter((c) => c.date < today || closedToday(c)),
  ];
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
  /** Takings where recorded, forecast for the rest: what the estimate's labour % is set against. */
  sales: number;
  rotaCost: number;
  estimateCost: number;
  costVariance: number;
  rotaPct: number;
  estimatePct: number;
}

export interface RotaVsActual {
  /** Last day that counts as worked; later days are still the rota. */
  workedTo: string;
  /** Sites in scope with nothing clocked this week: their estimate is the rota and nobody is flagged. */
  unclockedSiteIds: string[];
  sites: SiteVariance[];
  people: PersonVariance[];
  forecastSales: number;
  sales: number;
  rotaCost: number;
  estimateCost: number;
  costVariance: number;
  /** Rota against forecast: the plan, as the KPI bar showed it. */
  rotaPct: number;
  /** Latest estimate against takings so far plus forecast for the rest. */
  estimatePct: number;
  /** Clocked entries in scope still waiting for a manager. */
  awaitingApproval: number;
  /** People still clocked in, not yet in the clocked figures. */
  stillOpen: number;
}

/**
 * The rota against the floor, in pounds. The latest estimate (see latestShifts) is set against the
 * whole week's forecast, and salaried pay is a full week on both sides. Both are priced by the same
 * cost engine, so the variance is what drift costs after NI, pension and holiday. Before today, only
 * the clock counts where a site clocks, so a rostered shift nobody clocked costs nothing.
 */
export function rotaVsActual(state: RotaState, entries: TimeEntry[], siteIds: string[], week: string, today: string): RotaVsActual {
  const dates = weekDates(week);
  const end = dates[6];
  const workedTo = today < end ? today : end;
  // Every site's time stays in, so people who also work outside the scope keep their true on-costs.
  const weekEntries = entries.filter((e) => e.date >= week && e.date <= workedTo);
  const clocked = clockedShifts(weekEntries);
  const rota = state.shifts.filter((s) => dates.includes(s.date));
  const estimate = latestShifts(state, entries, week, today);
  const planned = { employees: state.employees, sites: state.sites, entities: state.entities, shifts: rota };
  const latest = { employees: state.employees, sites: state.sites, entities: state.entities, shifts: estimate };

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
    // A site that does not clock yet has nothing to compare hours against.
    const clocks = entries.some((e) => e.siteId === siteId && dates.includes(e.date));
    for (const s of rota.filter((x) => clocks && x.siteId === siteId && x.date <= workedTo)) {
      const p = person(s.employeeId);
      p.rosteredHours += shiftPaidHours(s);
      const any = siteEntries.some((e) => e.employeeId === s.employeeId && e.date === s.date);
      if (!any && s.date < today) p.noShows++;
    }
    for (const c of clocked.filter((x) => x.siteId === siteId)) person(c.employeeId).clockedHours += shiftPaidHours(c);
    for (const e of siteEntries) {
      if (!rota.some((s) => s.employeeId === e.employeeId && s.siteId === siteId && s.date === e.date)) person(e.employeeId).unrostered++;
    }

    const sales = salesEstimate(state, siteId, dates);
    return {
      siteId,
      forecastSales: sales.forecast,
      sales: sales.estimate,
      rotaCost: plan.total,
      estimateCost: est.total,
      costVariance: round2(est.total - plan.total),
      rotaPct: ratio(plan.total, sales.forecast),
      estimatePct: ratio(est.total, sales.estimate),
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
  const sales = round2(sites.reduce((s, x) => s + x.sales, 0));
  const rotaCost = round2(sites.reduce((s, x) => s + x.rotaCost, 0));
  const estimateCost = round2(sites.reduce((s, x) => s + x.estimateCost, 0));
  return {
    workedTo,
    unclockedSiteIds: siteIds.filter((id) => !entries.some((e) => e.siteId === id && dates.includes(e.date))),
    sites,
    people: list,
    forecastSales,
    sales,
    rotaCost,
    estimateCost,
    costVariance: round2(estimateCost - rotaCost),
    rotaPct: ratio(rotaCost, forecastSales),
    estimatePct: ratio(estimateCost, sales),
    awaitingApproval: scoped.filter((e) => e.status === 'submitted').length,
    stillOpen: scoped.filter((e) => e.status === 'open').length,
  };
}

/** A completed pay run as the API returns it, reconciled to the accrual sent with its hours. */
export interface PayRunSummary {
  id: string;
  entityId?: string;
  periodStart: string;
  periodEnd: string;
  /** When the run came back. A later run for the same company and period replaces an earlier one. */
  receivedAt?: string;
  variance: PayrollVariance;
  /** SSP paid against SSP due on the absence record, when the payroll reports it. */
  ssp?: SspCheckLine[];
}

export interface AccuracyRow extends PayRunSummary {
  withinTolerance: boolean;
}

export interface AccrualAccuracy {
  runs: AccuracyRow[];
  tolerance: number;
  within: number;
  accrued: number;
  actual: number;
  /** Net of every run: what the accruals have under or over stated in total. */
  variance: number;
  /** Average size of the miss, ignoring sign, as a share of accrued. Netting would hide misses that cancel. */
  meanAbsolutePct: number;
  /** Earlier runs for a period that a rerun replaced, left out of every figure. */
  superseded: number;
  /** People whose accrual missed in the same direction in more than one run: a rate or contract to fix, not noise. */
  repeatOffenders: { employeeId: string; runs: number; variance: number }[];
}

/**
 * How far the week-end accrual has been from what payroll actually cost, run by run. The accrual is
 * only worth posting if it is close: inside 1% of labour and the 3-day close can rely on it.
 */
export function accrualAccuracy(runs: PayRunSummary[], tolerance = 0.01): AccrualAccuracy {
  // A rerun of a period is a correction: only the latest run for each company and period counts.
  const latest = new Map<string, PayRunSummary>();
  for (const r of runs) {
    const k = `${r.entityId ?? ''}|${r.periodStart}`;
    const cur = latest.get(k);
    if (!cur || (r.receivedAt ?? '') > (cur.receivedAt ?? '')) latest.set(k, r);
  }
  const rows = [...latest.values()]
    .sort((a, b) => a.periodStart.localeCompare(b.periodStart) || (a.entityId ?? '').localeCompare(b.entityId ?? ''))
    .map((r) => ({ ...r, withinTolerance: Math.abs(r.variance.variancePct) <= tolerance }));
  const accrued = round2(rows.reduce((s, r) => s + r.variance.accrued, 0));
  const actual = round2(rows.reduce((s, r) => s + r.variance.actual, 0));
  const misses = new Map<string, { employeeId: string; over: number; under: number; variance: number }>();
  for (const r of rows) {
    for (const l of r.variance.lines) {
      if (Math.abs(l.variance) < 1) continue;
      const m = misses.get(l.employeeId) ?? { employeeId: l.employeeId, over: 0, under: 0, variance: 0 };
      if (l.variance > 0) m.over++;
      else m.under++;
      m.variance += l.variance;
      misses.set(l.employeeId, m);
    }
  }
  const repeatOffenders = [...misses.values()]
    .filter((m) => Math.max(m.over, m.under) > 1)
    .map((m) => ({ employeeId: m.employeeId, runs: Math.max(m.over, m.under), variance: round2(m.variance) }))
    .sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance));
  return {
    runs: rows,
    superseded: runs.length - rows.length,
    tolerance,
    within: rows.filter((r) => r.withinTolerance).length,
    accrued,
    actual,
    variance: round2(actual - accrued),
    meanAbsolutePct: rows.length ? rows.reduce((s, r) => s + Math.abs(r.variance.variancePct), 0) / rows.length : 0,
    repeatOffenders,
  };
}

export interface TakingsImport {
  rows: Omit<DaySales, 'source'>[];
  errors: string[];
}

/**
 * Reads takings from a till or EPOS export: one row per site and day with the date, the site (its
 * name, id or tracking code) and net sales, then covers if the file has them. A header row is
 * skipped. Dates may be 2026-10-19 or 19/10/2026. Pound signs and thousands commas in quoted
 * figures are ignored. Rows that cannot be read are reported by line, never guessed at.
 */
export function parseTakingsCsv(text: string, sites: Pick<Site, 'id' | 'name' | 'trackingCode'>[]): TakingsImport {
  const rows: Omit<DaySales, 'source'>[] = [];
  const errors: string[] = [];
  const siteOf = (v: string) => {
    const k = v.trim().toLowerCase();
    return sites.find((s) => s.id.toLowerCase() === k || s.name.toLowerCase() === k || s.trackingCode.toLowerCase() === k);
  };
  const dateOf = (v: string) => {
    const t = v.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
    return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
  };
  const amount = (v: string | undefined) => {
    if (v === undefined || v.trim() === '') return undefined;
    const n = Number(v.replace(/[£,\s]/g, ''));
    return Number.isFinite(n) ? n : NaN;
  };
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    const cells = splitCsvLine(line);
    const date = dateOf(cells[0] ?? '');
    if (!date) {
      if (i > 0) errors.push(`Line ${i + 1}: "${cells[0] ?? ''}" is not a date`);
      return; // the first line without a date is the header
    }
    const site = siteOf(cells[1] ?? '');
    if (!site) return void errors.push(`Line ${i + 1}: no site called "${cells[1] ?? ''}"`);
    const netSales = amount(cells[2]);
    if (netSales === undefined || Number.isNaN(netSales) || netSales < 0) return void errors.push(`Line ${i + 1}: "${cells[2] ?? ''}" is not an amount`);
    const covers = amount(cells[3]);
    rows.push({ siteId: site.id, date, netSales: round2(netSales), ...(covers !== undefined && !Number.isNaN(covers) ? { covers } : {}) });
  });
  return { rows, errors };
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted && c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
    else if (c === '"') quoted = !quoted;
    else if (c === ',' && !quoted) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
