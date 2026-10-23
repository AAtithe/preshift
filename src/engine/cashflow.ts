// The labour cash calendar: what each employing company must pay out for its people, and when, over
// the weeks ahead. Pure, shared by the API, the screen and their tests.
//
// The P&L carries labour when it is worked (the accrual in journal.ts). Cash goes out later and in
// three streams on three timetables: net pay on each pay day, PAYE and NI to HMRC by the 22nd of the
// month after the tax month, and pension contributions to the provider by the 22nd of the month after
// they were deducted. A good week on the rota is a large HMRC bill six weeks later; this is where an
// operator sees it coming.
//
// Pay is costed exactly as the accrual costs it (employeeWeekCost and weekOnCosts), so the two
// reconcile: weeks gone use approved clocked time where there is any and the rota otherwise, weeks
// ahead use the rota where it is built and each person's last four weeks where it is not. Deductions
// are estimated on the standard tax code at rest of UK rates; payroll is the record.

import { bankHolidays } from './calendar';
import { employeeWeekCost } from './cost';
import { employedShare } from './employees';
import { workedShifts } from './holiday';
import { entriesAsShifts } from './timesheet';
import { addDays, daysBetween, taxYearOf, weekday, weekStart } from './time';
import type { Employee, Entity, PaySchedule, RotaState, Shift, TimeEntry } from './types';
import { PAYE_2026_27, UK_RATES_2026_27, type PayeRates, type UkRates } from './ukRates';

export const DEFAULT_PAY_SCHEDULE: Required<Pick<PaySchedule, 'frequency' | 'payLagDays'>> & PaySchedule = {
  frequency: 'weekly',
  payLagDays: 5,
};
/** The Monday that starts tax year 2026/27: pay periods count from it unless a company says otherwise. */
export const DEFAULT_ANCHOR = '2026-04-06';
/** Weeks looked back over for a person's run rate, where the rota ahead is not built. */
export const RUN_RATE_WEEKS = 4;

const PERIOD_WEEKS = { weekly: 1, fortnightly: 2, 'four-weekly': 4 } as const;
const PERIODS_A_YEAR = { weekly: 52, fortnightly: 26, 'four-weekly': 13, monthly: 12 } as const;

const round2 = (n: number) => Math.round(n * 100) / 100;

export const scheduleOf = (entity: Entity): PaySchedule => ({ ...DEFAULT_PAY_SCHEDULE, ...(entity.paySchedule ?? {}) });

/** Checks a pay schedule before it is saved; returns what is wrong, or null. */
export function payScheduleProblem(s: PaySchedule): string | null {
  if (!['weekly', 'fortnightly', 'four-weekly', 'monthly'].includes(s.frequency)) return 'Choose weekly, fortnightly, four-weekly or monthly.';
  if (s.anchor !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(s.anchor) || weekday(s.anchor) !== 0)) return 'A pay period starts on a Monday.';
  if (s.payLagDays !== undefined && !(Number.isInteger(s.payLagDays) && s.payLagDays >= 0 && s.payLagDays <= 31)) {
    return 'Pay day is between 0 and 31 days after the period ends.';
  }
  if (s.monthlyPayDay !== undefined && s.monthlyPayDay !== 'last-working' && !(Number.isInteger(s.monthlyPayDay) && s.monthlyPayDay >= 1 && s.monthlyPayDay <= 31)) {
    return 'A monthly pay day is a day of the month, or the last working day.';
  }
  return null;
}

// Working days

const holidayCache = new Map<number, Set<string>>();
function isBankHoliday(date: string): boolean {
  const year = Number(date.slice(0, 4));
  if (!holidayCache.has(year)) holidayCache.set(year, new Set(bankHolidays(year).map((h) => h.date)));
  return holidayCache.get(year)!.has(date);
}

export const isWorkingDay = (date: string) => weekday(date) < 5 && !isBankHoliday(date);

/** The day itself if it is a working day, else the working day before: when a due date or pay day falls. */
export function workingDayOnOrBefore(date: string): string {
  let d = date;
  while (!isWorkingDay(d)) d = addDays(d, -1);
  return d;
}

const lastDayOfMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const iso = (year: number, month: number, day: number) => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
/** The 22nd (or another day) of the month after the one `date` falls in, moved back to a working day. */
function dayOfNextMonth(date: string, day: number): string {
  let year = Number(date.slice(0, 4));
  let month = Number(date.slice(5, 7)) + 1;
  if (month > 12) (month = 1), (year += 1);
  return workingDayOnOrBefore(iso(year, month, Math.min(day, lastDayOfMonth(year, month))));
}

// Pay periods

export interface PayPeriod {
  entityId: string;
  from: string;
  to: string;
  payDate: string;
  frequency: PaySchedule['frequency'];
}

/** Every pay period of the company whose pay day falls in [from, to]. */
export function payPeriods(entity: Entity, from: string, to: string): PayPeriod[] {
  const s = scheduleOf(entity);
  const out: PayPeriod[] = [];
  if (s.frequency === 'monthly') {
    let year = Number(from.slice(0, 4));
    let month = Number(from.slice(5, 7)) - 1;
    if (month < 1) (month = 12), (year -= 1);
    for (let i = 0; i < 40; i++) {
      const last = lastDayOfMonth(year, month);
      const wanted = s.monthlyPayDay === undefined || s.monthlyPayDay === 'last-working' ? last : Math.min(s.monthlyPayDay, last);
      const payDate = workingDayOnOrBefore(iso(year, month, wanted));
      if (payDate > to) break;
      if (payDate >= from) out.push({ entityId: entity.id, from: iso(year, month, 1), to: iso(year, month, last), payDate, frequency: 'monthly' });
      month += 1;
      if (month > 12) (month = 1), (year += 1);
    }
    return out;
  }
  const length = PERIOD_WEEKS[s.frequency] * 7;
  const anchor = s.anchor ?? DEFAULT_ANCHOR;
  const lag = s.payLagDays ?? DEFAULT_PAY_SCHEDULE.payLagDays;
  // The first period whose pay day could fall on or after `from`.
  let start = addDays(anchor, Math.floor(daysBetween(anchor, addDays(from, -lag - length)) / length) * length);
  for (let i = 0; i < 200; i++, start = addDays(start, length)) {
    const end = addDays(start, length - 1);
    const payDate = workingDayOnOrBefore(addDays(end, lag));
    if (payDate > to) break;
    if (payDate >= from) out.push({ entityId: entity.id, from: start, to: end, payDate, frequency: s.frequency });
  }
  return out;
}

// What a person is paid

/** Where a week's pay comes from: time worked, the rota, a salary, or the person's recent weeks repeated. */
export type CashBasis = 'worked' | 'rota' | 'salary' | 'run-rate';

interface WeekPay {
  /** Gross pay including holiday pay, as the accrual carries it. */
  pay: number;
  employerNi: number;
  employerPension: number;
  basis: CashBasis;
}

/**
 * One person's pay for each rota week, costed as the accrual costs it. Weeks fully gone use approved
 * clocked time where a day has any and the rota otherwise; weeks the company has started rostering use
 * the rota; later weeks repeat the person's last four weeks.
 */
export class PayModel {
  private readonly cache = new Map<string, WeekPay>();
  private readonly built = new Map<string, boolean>();
  private readonly byPerson = new Map<string, Shift[]>();
  private readonly actual: Shift[];

  constructor(
    private readonly state: Pick<RotaState, 'employees' | 'shifts' | 'sites' | 'entities'>,
    entries: TimeEntry[],
    private readonly today: string,
    private readonly rates: UkRates = UK_RATES_2026_27,
  ) {
    for (const s of state.shifts) this.byPerson.set(s.employeeId, [...(this.byPerson.get(s.employeeId) ?? []), s]);
    this.actual = entriesAsShifts(entries.filter((t) => t.date < today));
  }

  /** Whether any of the company's people has a shift in the week: the rota for it has been started. */
  private rostered(entityId: string, monday: string): boolean {
    const key = `${entityId}|${monday}`;
    if (!this.built.has(key)) {
      const people = new Set(this.state.employees.filter((e) => e.entityId === entityId).map((e) => e.id));
      const end = addDays(monday, 6);
      this.built.set(key, this.state.shifts.some((s) => people.has(s.employeeId) && s.date >= monday && s.date <= end));
    }
    return this.built.get(key)!;
  }

  week(e: Employee, monday: string): WeekPay {
    const key = `${e.id}|${monday}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const end = addDays(monday, 6);
    const share = employedShare(e, monday);
    let result: WeekPay;
    if (share <= 0 || e.anonymisedOn) {
      result = { pay: 0, employerNi: 0, employerPension: 0, basis: end < this.today ? 'worked' : 'rota' };
    } else if (end < this.today || this.rostered(e.entityId, monday) || e.payBasis === 'salaried') {
      const rota = (this.byPerson.get(e.id) ?? []).filter((s) => s.date >= monday && s.date <= end);
      const done = this.actual.filter((s) => s.employeeId === e.id && s.date >= monday && s.date <= end);
      const shifts = workedShifts(rota, done);
      const c = employeeWeekCost(e, shifts, this.rates, share, this.state.sites, this.state.entities);
      const basis: CashBasis = end < this.today ? 'worked' : e.payBasis === 'salaried' ? 'salary' : 'rota';
      result = { pay: c.gross + c.holiday, employerNi: c.employerNi, employerPension: c.pension, basis };
    } else {
      // Not rostered yet: what the last four whole weeks averaged.
      const back = Array.from({ length: RUN_RATE_WEEKS }, (_, i) => addDays(weekStart(this.today), -7 * (i + 1))).map((m) => this.week(e, m));
      const avg = (f: (w: WeekPay) => number) => round2(back.reduce((sum, w) => sum + f(w), 0) / RUN_RATE_WEEKS);
      result = { pay: avg((w) => w.pay), employerNi: avg((w) => w.employerNi), employerPension: avg((w) => w.employerPension), basis: 'run-rate' };
    }
    this.cache.set(key, result);
    return result;
  }

  /** A person's pay for a pay period: whole weeks, or the days of each week inside a calendar month. */
  period(e: Employee, p: PayPeriod): WeekPay & { bases: Set<CashBasis> } {
    const total = { pay: 0, employerNi: 0, employerPension: 0, basis: 'rota' as CashBasis, bases: new Set<CashBasis>() };
    for (let monday = weekStart(p.from); monday <= p.to; monday = addDays(monday, 7)) {
      const first = monday < p.from ? p.from : monday;
      const last = addDays(monday, 6) > p.to ? p.to : addDays(monday, 6);
      const share = (daysBetween(first, last) + 1) / 7;
      const w = this.week(e, monday);
      total.pay += w.pay * share;
      total.employerNi += w.employerNi * share;
      total.employerPension += w.employerPension * share;
      if (w.pay > 0) total.bases.add(w.basis);
    }
    return total;
  }
}

// What comes out of pay

export interface Deductions {
  tax: number;
  employeeNi: number;
  employeePension: number;
  net: number;
}

/**
 * Income tax, employee NI and the employee's pension contribution on one pay period's pay, worked
 * non-cumulatively on the standard code: each period gets its share of the year's allowances.
 */
export function deductions(e: Employee, pay: number, frequency: PaySchedule['frequency'], paye: PayeRates = PAYE_2026_27, rates: UkRates = UK_RATES_2026_27): Deductions {
  const n = PERIODS_A_YEAR[frequency];
  const taxable = Math.max(0, pay - paye.personalAllowance / n);
  const band = paye.basicRateBand / n;
  const tax = Math.min(taxable, band) * paye.basicRate + Math.max(0, taxable - band) * paye.higherRate;
  const pt = paye.niPrimaryThreshold / n;
  const uel = paye.niUpperEarningsLimit / n;
  const employeeNi = Math.max(0, Math.min(pay, uel) - pt) * paye.employeeNiRate + Math.max(0, pay - uel) * paye.employeeNiUpperRate;
  const weeks = 52 / n;
  const employeePension = e.pensionEnrolled
    ? Math.max(0, Math.min(pay, rates.pensionUpperWeekly * weeks) - rates.pensionLowerWeekly * weeks) * paye.employeePensionRate
    : 0;
  // Each deduction is rounded to the penny before it comes off, as a payslip shows it.
  const d = { tax: round2(tax), employeeNi: round2(employeeNi), employeePension: round2(employeePension) };
  return { ...d, net: round2(pay - d.tax - d.employeeNi - d.employeePension) };
}

// The calendar

export type CashKind = 'net-pay' | 'hmrc' | 'pension';

export const CASH_LABEL: Record<CashKind, string> = {
  'net-pay': 'Net pay',
  hmrc: 'PAYE and NI to HMRC',
  pension: 'Pension contributions',
};

export interface CashItem {
  id: string;
  entityId: string;
  kind: CashKind;
  /** The day the money leaves: pay day, or the due date moved back to a working day. */
  date: string;
  amount: number;
  /** For net pay, the pay period. For HMRC the tax month, for pensions the month of deduction. */
  covers: { from: string; to: string };
  bases: CashBasis[];
  people: number;
  /** HMRC only: what makes up the payment. */
  parts?: { tax: number; employeeNi: number; employerNi: number; allowance: number };
}

export interface CashWeek {
  weekStart: string;
  byKind: Record<CashKind, number>;
  total: number;
  /** Running total from the first week shown. */
  cumulative: number;
}

export interface CashCalendar {
  from: string;
  to: string;
  items: CashItem[];
  weeks: CashWeek[];
  totals: Record<CashKind, number> & { total: number };
  /** Said beside the figures: what they assume, and anything set up that moves them. */
  notes: string[];
}

interface Bucket {
  entityId: string;
  key: string;
  from: string;
  to: string;
  people: Set<string>;
  bases: Set<CashBasis>;
  tax: number;
  employeeNi: number;
  employerNi: number;
  pension: number;
  /** The last pay day in it, for ordering the allowance. */
  lastPay: string;
}

/** The 5th of the month after: the last day of the tax month that starts on the 6th of `start`'s month. */
function taxMonthEnd(start: string): string {
  const year = Number(start.slice(0, 4));
  const month = Number(start.slice(5, 7));
  return month === 12 ? iso(year + 1, 1, 5) : iso(year, month + 1, 5);
}

/** The tax month a pay day falls in: 6th of one month to the 5th of the next, named by its start. */
function taxMonthStart(date: string): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  if (Number(date.slice(8, 10)) >= 6) return iso(year, month, 6);
  return month === 1 ? iso(year - 1, 12, 6) : iso(year, month - 1, 6);
}

/**
 * Cash out for labour, by company, from `today` for `weeks` weeks. `entityIds` narrows it to some
 * companies; Employment Allowance is still worked across the group, as HMRC applies it to one.
 */
export function cashCalendar(
  state: Pick<RotaState, 'employees' | 'shifts' | 'sites' | 'entities'>,
  entries: TimeEntry[],
  today: string,
  weeks = 13,
  entityIds?: string[],
  paye: PayeRates = PAYE_2026_27,
  rates: UkRates = UK_RATES_2026_27,
): CashCalendar {
  const from = today;
  const to = addDays(weekStart(today), weeks * 7 - 1);
  // HMRC and pension payments in the window cover pay days up to two months before it.
  const lookback = addDays(today, -70);
  const model = new PayModel(state, entries, today, rates);
  const items: CashItem[] = [];
  const shown = (id: string) => !entityIds || entityIds.includes(id);
  const notes: string[] = [];

  const hmrc = new Map<string, Bucket>();
  const pension = new Map<string, Bucket>();
  const bucket = (map: Map<string, Bucket>, entityId: string, key: string, f: string, t: string) => {
    const k = `${entityId}|${key}`;
    if (!map.has(k)) map.set(k, { entityId, key, from: f, to: t, people: new Set(), bases: new Set(), tax: 0, employeeNi: 0, employerNi: 0, pension: 0, lastPay: '' });
    return map.get(k)!;
  };

  for (const entity of state.entities) {
    const people = state.employees.filter((e) => e.entityId === entity.id);
    for (const p of payPeriods(entity, lookback, to)) {
      let net = 0;
      const paid = new Set<string>();
      const bases = new Set<CashBasis>();
      const tm = taxMonthStart(p.payDate);
      const hb = bucket(hmrc, entity.id, tm, tm, taxMonthEnd(tm));
      const pm = p.payDate.slice(0, 7);
      const pb = bucket(pension, entity.id, pm, `${pm}-01`, iso(Number(pm.slice(0, 4)), Number(pm.slice(5, 7)), lastDayOfMonth(Number(pm.slice(0, 4)), Number(pm.slice(5, 7)))));
      for (const e of people) {
        const w = model.period(e, p);
        if (w.pay <= 0) continue;
        const d = deductions(e, w.pay, p.frequency, paye, rates);
        net += d.net;
        paid.add(e.id);
        w.bases.forEach((b) => bases.add(b));
        hb.tax += d.tax;
        hb.employeeNi += d.employeeNi;
        hb.employerNi += w.employerNi;
        hb.people.add(e.id);
        w.bases.forEach((b) => hb.bases.add(b));
        pb.pension += w.employerPension + d.employeePension;
        if (w.employerPension + d.employeePension > 0) pb.people.add(e.id);
        w.bases.forEach((b) => pb.bases.add(b));
      }
      if (p.payDate > hb.lastPay) hb.lastPay = p.payDate;
      if (p.payDate >= from && paid.size > 0) {
        items.push({ id: `net:${entity.id}:${p.payDate}`, entityId: entity.id, kind: 'net-pay', date: p.payDate, amount: round2(net), covers: { from: p.from, to: p.to }, bases: [...bases], people: paid.size });
      }
    }
  }

  // Employment Allowance: the claimant's remaining allowance set against its employer NI, tax month by
  // tax month, from the month after the last payroll it was given for. A new tax year starts it again.
  const claimant = state.entities.find((e) => e.employmentAllowance);
  const allowance = new Map<string, number>();
  if (claimant) {
    const { remaining, asAt } = claimant.employmentAllowance!;
    let year = taxYearOf(asAt);
    let left = remaining;
    const months = [...hmrc.values()].filter((b) => b.entityId === claimant.id && b.lastPay > asAt).sort((a, b) => a.key.localeCompare(b.key));
    for (const b of months) {
      const y = taxYearOf(b.key);
      if (y !== year) (year = y), (left = rates.employmentAllowance);
      const used = round2(Math.min(left, b.employerNi));
      allowance.set(b.key, used);
      left = round2(left - used);
    }
    const before = [...hmrc.values()].some((b) => b.entityId === claimant.id && b.lastPay <= asAt && dayOfNextMonth(b.key, paye.payeDueDay) >= from);
    if (before) notes.push(`HMRC payments for tax months up to ${asAt} are shown before Employment Allowance: the last payroll you recorded already used it there.`);
  }

  for (const b of hmrc.values()) {
    const date = dayOfNextMonth(b.key, paye.payeDueDay);
    if (date < from || date > to) continue;
    const used = b.entityId === claimant?.id ? allowance.get(b.key) ?? 0 : 0;
    const amount = round2(b.tax + b.employeeNi + b.employerNi - used);
    if (amount <= 0 && b.people.size === 0) continue;
    items.push({
      id: `hmrc:${b.entityId}:${b.key}`, entityId: b.entityId, kind: 'hmrc', date, amount, covers: { from: b.from, to: b.to }, bases: [...b.bases], people: b.people.size,
      parts: { tax: round2(b.tax), employeeNi: round2(b.employeeNi), employerNi: round2(b.employerNi), allowance: used },
    });
  }
  for (const b of pension.values()) {
    const date = dayOfNextMonth(b.from, paye.pensionDueDay);
    if (date < from || date > to || b.pension <= 0) continue;
    items.push({ id: `pension:${b.entityId}:${b.key}`, entityId: b.entityId, kind: 'pension', date, amount: round2(b.pension), covers: { from: b.from, to: b.to }, bases: [...b.bases], people: b.people.size });
  }

  const visible = items.filter((i) => shown(i.entityId)).sort((a, b) => a.date.localeCompare(b.date) || a.entityId.localeCompare(b.entityId) || a.kind.localeCompare(b.kind));
  const zero = (): Record<CashKind, number> => ({ 'net-pay': 0, hmrc: 0, pension: 0 });
  let cumulative = 0;
  const calendarWeeks: CashWeek[] = Array.from({ length: weeks }, (_, i) => {
    const monday = addDays(weekStart(today), i * 7);
    const byKind = zero();
    for (const item of visible) if (item.date >= monday && item.date <= addDays(monday, 6)) byKind[item.kind] += item.amount;
    const total = round2(byKind['net-pay'] + byKind.hmrc + byKind.pension);
    cumulative = round2(cumulative + total);
    return { weekStart: monday, byKind: { 'net-pay': round2(byKind['net-pay']), hmrc: round2(byKind.hmrc), pension: round2(byKind.pension) }, total, cumulative };
  });
  const totals = { ...zero(), total: 0 };
  for (const item of visible) totals[item.kind] = round2(totals[item.kind] + item.amount);
  totals.total = round2(totals['net-pay'] + totals.hmrc + totals.pension);

  const unset = state.entities.filter((e) => shown(e.id) && !e.paySchedule);
  if (unset.length) notes.push(`${unset.map((e) => e.name).join(', ')} ${unset.length === 1 ? 'has' : 'have'} no pay schedule set, so weekly pay on the Friday after the week is assumed.`);
  if (visible.some((i) => i.bases.includes('run-rate'))) notes.push(`Weeks not yet rostered repeat each person's last ${RUN_RATE_WEEKS} weeks.`);
  if (taxYearOf(to) !== paye.taxYear || taxYearOf(from) !== paye.taxYear) notes.push(`Rates are ${paye.taxYear}. Payments after 5 April use them too until next year's are set.`);
  return { from, to, items: visible, weeks: calendarWeeks, totals, notes };
}

/** The calendar as a CSV: one row a payment. */
export function cashCsv(calendar: CashCalendar, entityName: (id: string) => string): string {
  const cell = (v: string | number) => (typeof v === 'string' && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : String(v));
  const rows = calendar.items.map((i) => [i.date, entityName(i.entityId), CASH_LABEL[i.kind], i.amount.toFixed(2), i.covers.from, i.covers.to, i.people, i.bases.join(' ')].map(cell).join(','));
  return ['Date,Company,Payment,Amount,Covers from,Covers to,People,Basis', ...rows].join('\n');
}

