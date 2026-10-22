import type { Department, Role, RotaState, TimeEntry, TipsTaken, TroncScheme } from './types';
import { clockedShifts } from './actuals';
import { employeeWeekCost, shiftPaidMinutes, shiftsInWeek } from './cost';
import { addDays, daysBetween, parseISODate, toISODate, weekDates } from './time';
import { UK_RATES_2026_27, type UkRates } from './ukRates';

/** The Act's deadline: tips must reach workers by the end of the month after the month they were paid. */
export function tipsPayBy(date: string): string {
  const d = parseISODate(date);
  return toISODate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 2, 0)));
}

export function employerNi(weeklyEarnings: number, rates: UkRates = UK_RATES_2026_27): number {
  return Math.max(0, weeklyEarnings - rates.niSecondaryThresholdWeekly) * rates.employerNiRate;
}

export function employeeNi(weeklyEarnings: number, rates: UkRates = UK_RATES_2026_27): number {
  const main = Math.min(Math.max(0, weeklyEarnings - rates.niPrimaryThresholdWeekly), rates.niUpperEarningsLimitWeekly - rates.niPrimaryThresholdWeekly);
  const upper = Math.max(0, weeklyEarnings - rates.niUpperEarningsLimitWeekly);
  return main * rates.employeeNiMainRate + upper * rates.employeeNiUpperRate;
}

export interface TroncShare {
  employeeId: string;
  hours: number;
  points: number;
  amount: number;
  /** National Insurance on this share if the employer allocated it: what an independent tronc saves. */
  employerNi: number;
  employeeNi: number;
}

export interface TroncRun {
  siteId: string;
  weekStartDate: string;
  received: number;
  bySource: Record<TipsTaken['source'], number>;
  shares: TroncShare[];
  allocated: number;
  /** Money with no clocked points to go to. It is still the workers' and must be carried forward. */
  unallocated: number;
  independent: boolean;
  /** NI actually due on this run: nothing through an independent tronc. */
  niDue: { employer: number; employee: number };
  /** NI the scheme saves, or would save if it were made independent. */
  niSaving: { employer: number; employee: number };
  /** VAT due on a mandatory service charge, which is part of the price. */
  vatOnServiceCharge: number;
  payBy: string | null;
  paid: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const gbp = (n: number) => `£${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Splits pennies so the shares add back to the pool exactly: everything taken
 * is passed on, with the leftover pennies going to the largest remainders.
 */
function toPennies(raw: Map<string, number>, total: number): Map<string, number> {
  const pennies = Math.round(total * 100);
  const entries = [...raw].map(([id, v]) => ({ id, exact: v * 100, floor: Math.floor(v * 100 + 1e-9) }));
  let left = pennies - entries.reduce((s, e) => s + e.floor, 0);
  entries.sort((a, b) => b.exact - b.floor - (a.exact - a.floor) || a.id.localeCompare(b.id));
  for (const e of entries) {
    if (left <= 0) break;
    e.floor += 1;
    left -= 1;
  }
  return new Map(entries.map((e) => [e.id, e.floor / 100]));
}

/**
 * One week's tronc. The pool is everything taken in tips and service charge on
 * the days that have traded. It is split on clocked hours, not rostered hours,
 * so the person who stayed for the close is paid for it, weighted by the
 * scheme's points per role, after any department split. National Insurance is
 * worked on each person's whole week of pay, so the saving from an independent
 * tronc is the real one, not 15% of the pool.
 */
export function troncRun(
  state: RotaState,
  entries: TimeEntry[],
  siteId: string,
  weekStartDate: string,
  asOf: string,
  rates: UkRates = UK_RATES_2026_27,
): TroncRun {
  const scheme = (state.troncSchemes ?? []).find((s) => s.siteId === siteId);
  const week = new Set(weekDates(weekStartDate).filter((d) => d < asOf));
  const tips = (state.tips ?? []).filter((t) => t.siteId === siteId && week.has(t.date));
  const bySource = { 'service-charge': 0, 'card-tip': 0, 'cash-pooled': 0 };
  for (const t of tips) bySource[t.source] = round2(bySource[t.source] + t.amount);
  const received = round2(tips.reduce((s, t) => s + t.amount, 0));
  const independent = scheme?.independent ?? false;

  const allClocked = shiftsInWeek(clockedShifts(entries), weekStartDate);
  const here = allClocked.filter((s) => s.siteId === siteId && week.has(s.date));
  const department = (roleId: string): Department => state.roles.find((r) => r.id === roleId)?.department ?? 'FOH';

  // Points by person and department.
  const points = new Map<string, Map<Department, number>>();
  const hours = new Map<string, number>();
  for (const s of here) {
    const h = shiftPaidMinutes(s) / 60;
    hours.set(s.employeeId, (hours.get(s.employeeId) ?? 0) + h);
    const p = h * (scheme?.pointsPerHour[s.roleId] ?? 0);
    if (p <= 0) continue;
    const mine = points.get(s.employeeId) ?? new Map<Department, number>();
    mine.set(department(s.roleId), (mine.get(department(s.roleId)) ?? 0) + p);
    points.set(s.employeeId, mine);
  }
  const deptPoints = new Map<Department, number>();
  for (const mine of points.values()) for (const [d, p] of mine) deptPoints.set(d, (deptPoints.get(d) ?? 0) + p);

  // Department shares, renormalised over departments that actually worked so nothing is left behind.
  const shares = scheme?.departmentShares;
  const weights = new Map<Department, number>();
  for (const [d, p] of deptPoints) if (p > 0) weights.set(d, shares ? shares[d] ?? 0 : p);
  const weightTotal = [...weights.values()].reduce((s, w) => s + w, 0);

  const raw = new Map<string, number>();
  if (weightTotal > 0 && received > 0) {
    for (const [employeeId, mine] of points) {
      let amount = 0;
      for (const [d, p] of mine) {
        const deptPool = (received * (weights.get(d) ?? 0)) / weightTotal;
        amount += (deptPool * p) / deptPoints.get(d)!;
      }
      raw.set(employeeId, amount);
    }
  }
  const unallocated = raw.size === 0 ? received : 0;
  const amounts = toPennies(raw, received - unallocated);

  const result: TroncShare[] = [];
  const niDue = { employer: 0, employee: 0 };
  const niSaving = { employer: 0, employee: 0 };
  for (const [employeeId, amount] of amounts) {
    if (amount === 0) continue;
    const employee = state.employees.find((e) => e.id === employeeId);
    if (!employee) continue;
    const cost = employeeWeekCost(employee, allClocked.filter((s) => s.employeeId === employeeId), rates);
    const pay = cost.gross + cost.holiday;
    const er = round2(employerNi(pay + amount, rates) - employerNi(pay, rates));
    const ee = round2(employeeNi(pay + amount, rates) - employeeNi(pay, rates));
    result.push({ employeeId, hours: round2(hours.get(employeeId) ?? 0), points: round2([...points.get(employeeId)!.values()].reduce((s, p) => s + p, 0)), amount, employerNi: er, employeeNi: ee });
    const bucket = independent ? niSaving : niDue;
    bucket.employer += er;
    bucket.employee += ee;
    if (!independent) {
      niSaving.employer += er;
      niSaving.employee += ee;
    }
  }

  const unpaid = tips.filter((t) => !t.paidOn);
  const payBy = unpaid.length ? unpaid.map((t) => tipsPayBy(t.date)).sort()[0] : null;
  return {
    siteId,
    weekStartDate,
    received,
    bySource,
    shares: result.sort((a, b) => b.amount - a.amount),
    allocated: round2(result.reduce((s, r) => s + r.amount, 0)),
    unallocated: round2(unallocated),
    independent,
    niDue: { employer: round2(niDue.employer), employee: round2(niDue.employee) },
    niSaving: { employer: round2(niSaving.employer), employee: round2(niSaving.employee) },
    vatOnServiceCharge:
      scheme?.serviceCharge === 'mandatory' ? round2((bySource['service-charge'] * rates.vatRate) / (1 + rates.vatRate)) : 0,
    payBy,
    paid: tips.length > 0 && unpaid.length === 0,
  };
}

export interface TroncIssue {
  code: string;
  severity: 'block' | 'warn';
  message: string;
}

const REVIEW_YEARS = 3;

/**
 * The Act and its Code of Practice as checks: a written policy, fair
 * allocation reviewed with staff, every penny passed on, paid by the end of
 * the following month. Plus the two tax points operators most often miss:
 * an employer-run allocation pays National Insurance, and a mandatory service
 * charge is part of the price and carries VAT.
 */
export function troncCompliance(state: RotaState, entries: TimeEntry[], siteId: string, weekStartDate: string, asOf: string, rates: UkRates = UK_RATES_2026_27): TroncIssue[] {
  const issues: TroncIssue[] = [];
  const scheme: TroncScheme | undefined = (state.troncSchemes ?? []).find((s) => s.siteId === siteId);
  const siteTips = (state.tips ?? []).filter((t) => t.siteId === siteId);
  if (!scheme) {
    if (siteTips.length) issues.push({ code: 'tronc-no-scheme', severity: 'block', message: 'Tips are being taken with no allocation scheme. Every penny belongs to the workers.' });
    return issues;
  }
  if (!scheme.policyPublishedOn) {
    issues.push({ code: 'tips-no-policy', severity: 'block', message: 'No written tipping policy. The Act requires one, available to every worker, wherever tips are more than occasional.' });
  }
  if (!scheme.lastReviewedOn || daysBetween(scheme.lastReviewedOn, asOf) > REVIEW_YEARS * 365) {
    issues.push({
      code: 'tips-review',
      severity: 'warn',
      message: `Allocation not reviewed with staff ${scheme.lastReviewedOn ? `since ${scheme.lastReviewedOn}` : 'on record'}. Consult on fairness at least every ${REVIEW_YEARS} years and whenever the scheme changes.`,
    });
  }

  const run = troncRun(state, entries, siteId, weekStartDate, asOf, rates);
  if (!scheme.independent && run.received > 0) {
    const saving = run.niSaving.employer + run.niSaving.employee;
    issues.push({
      code: 'tronc-not-independent',
      severity: 'warn',
      message: `The employer decides the allocation, so ${gbp(saving)} of National Insurance is due on this week's tips (${gbp(run.niSaving.employer)} employer, ${gbp(run.niSaving.employee)} staff). An independent troncmaster removes it.`,
    });
  }
  if (run.vatOnServiceCharge > 0) {
    issues.push({
      code: 'service-charge-vat',
      severity: 'warn',
      message: `The service charge is mandatory, so it is part of the price: ${gbp(run.vatOnServiceCharge)} of this week's charge is VAT. Make it discretionary and it is outside the scope of VAT.`,
    });
  }
  if (run.unallocated > 0) {
    issues.push({ code: 'tronc-unallocated', severity: 'warn', message: `${gbp(run.unallocated)} has no clocked hours to go to. Carry it into the next run; it cannot be kept.` });
  }
  if (scheme.departmentShares) {
    const shares = scheme.departmentShares;
    const left = state.roles.filter((r) => (scheme.pointsPerHour[r.id] ?? 0) > 0 && !shares[r.department]);
    if (left.length) {
      issues.push({
        code: 'tronc-department-gap',
        severity: 'warn',
        message: `${left.map((r) => r.name).join(', ')} ${left.length > 1 ? 'have' : 'has'} points but no department share, so earn nothing. Give the department a share or set the points to zero so the policy says what happens.`,
      });
    }
  }
  if (Math.abs(run.allocated + run.unallocated - run.received) > 0.005) {
    issues.push({ code: 'tronc-not-passed-on', severity: 'block', message: 'The allocation does not add back to what was taken.' });
  }

  const overdue = siteTips.filter((t) => !t.paidOn && tipsPayBy(t.date) < asOf);
  if (overdue.length) {
    const total = overdue.reduce((s, t) => s + t.amount, 0);
    issues.push({ code: 'tips-overdue', severity: 'block', message: `${gbp(total)} of tips is past the end of the month after it was taken and still unpaid.` });
  }
  return issues;
}

/** Marks every tip in the week as paid through payroll on `date`. */
export function markWeekPaid(tips: TipsTaken[], siteId: string, weekStartDate: string, date: string): TipsTaken[] {
  const week = new Set(weekDates(weekStartDate));
  return tips.map((t) => (t.siteId === siteId && week.has(t.date) && !t.paidOn ? { ...t, paidOn: date } : t));
}

/** The tips record for one worker over a period, for a request under the Act. */
export function tipsStatement(state: RotaState, entries: TimeEntry[], employeeId: string, from: string, to: string, asOf: string) {
  const employee = state.employees.find((e) => e.id === employeeId);
  const rows: { weekStartDate: string; hours: number; amount: number }[] = [];
  if (!employee) return rows;
  for (let w = from; w <= to; w = addDays(w, 7)) {
    const share = troncRun(state, entries, employee.siteId, w, asOf).shares.find((s) => s.employeeId === employeeId);
    if (share) rows.push({ weekStartDate: w, hours: share.hours, amount: share.amount });
  }
  return rows;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DEPARTMENTS: Department[] = ['FOH', 'BAR', 'BOH', 'MGMT'];

/**
 * What stops a scheme being recorded as it stands. A scheme is the written basis on which every
 * tip at the site is shared, so it must name who decides, give points only to roles that exist,
 * and, where the pool is split by department first, split all of it.
 */
export function troncSchemeProblems(scheme: TroncScheme, roles: Pick<Role, 'id' | 'name'>[], today: string): string[] {
  const problems: string[] = [];
  if (!scheme.troncmaster.trim()) problems.push('Name the troncmaster: the person who decides the allocation.');
  const unknown = Object.keys(scheme.pointsPerHour).filter((id) => !roles.some((r) => r.id === id));
  if (unknown.length) problems.push(`Points are set for roles that do not exist: ${unknown.join(', ')}.`);
  if (Object.values(scheme.pointsPerHour).some((p) => !Number.isFinite(p) || p < 0)) problems.push('Points per hour cannot be negative.');
  if (!roles.some((r) => (scheme.pointsPerHour[r.id] ?? 0) > 0)) problems.push('Give at least one role points, or no tip can be passed on.');
  if (scheme.departmentShares) {
    const shares = Object.entries(scheme.departmentShares);
    if (shares.some(([d]) => !DEPARTMENTS.includes(d as Department))) problems.push('Department shares can only be for FOH, BAR, BOH or MGMT.');
    if (shares.some(([, v]) => v === undefined || !Number.isFinite(v) || v < 0 || v > 1)) problems.push('Each department share is a fraction from 0 to 1.');
    const total = shares.reduce((s, [, v]) => s + (v ?? 0), 0);
    if (shares.length > 0 && Math.abs(total - 1) > 0.001) problems.push(`Department shares add up to ${Math.round(total * 100)}%. They must share all of the pool.`);
  }
  for (const [label, date] of [['policy published', scheme.policyPublishedOn], ['last reviewed', scheme.lastReviewedOn]] as const) {
    if (date === undefined) continue;
    if (!ISO_DATE.test(date) || toISODate(parseISODate(date)) !== date) problems.push(`The ${label} date is not a date.`);
    else if (date > today) problems.push(`The ${label} date is in the future.`);
  }
  return problems;
}
