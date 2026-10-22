import { bankHolidays } from './calendar';
import { shiftPaidHours } from './cost';
import { entryPaidHours } from './timesheet';
import { addDays, daysBetween, londonParts, parseISODate, toISODate, weekday } from './time';
import type { Employee, Entity, Shift, TimeEntry } from './types';

/**
 * How often a payroll runs. Weekly, fortnightly and four weekly repeat on a fixed cycle from an anchor
 * date. Monthly runs to a day of the month. Last Friday pays on the last Friday of each month, with the
 * hours period ending a set number of days before it, so periods run four or five whole weeks.
 */
export type PayFrequency = 'weekly' | 'fortnightly' | 'four_weekly' | 'monthly' | 'last_friday';

/**
 * One payroll's calendar, set by the client for each company. Every date in it is worked out from
 * these few numbers, so a client changes its calendar here and every period, payday and cutoff follows.
 */
export interface PaySchedule {
  id: string;
  name: string;
  frequency: PayFrequency;
  /** Weekly, fortnightly and four weekly: the first day of any one period, which fixes the cycle. */
  anchorDate?: string;
  /** Monthly: the day of the month the hours period ends. 31 means the last day, a calendar month. */
  periodEndDay?: number;
  /** Monthly: the day of the month pay lands. 31 means the last working day. */
  payDay?: number;
  /** Monthly: pay lands in the month the period ends (0) or the month after (1). */
  payMonthOffset?: 0 | 1;
  /** Weekly, fortnightly and four weekly: days after the period ends that pay lands. 5 is the Friday after a Sunday. */
  payDaysAfterPeriodEnd?: number;
  /** Last Friday: the hours period ends this many days before payday. 5 is the Sunday before. */
  periodEndDaysBeforePay?: number;
  /** Rota locked, time cards approved and hours passed to payroll by this many days before payday. */
  cutoffDaysBeforePay: number;
  /** The time on the cutoff day, UK time, as HH:MM. */
  cutoffTime: string;
}

/** One period of a schedule: the days its hours cover, when they are due and when pay lands. */
export interface PayPeriod {
  scheduleId: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  cutoffDate: string;
  cutoffTime: string;
}

export const FREQUENCY_LABEL: Record<PayFrequency, string> = {
  weekly: 'Weekly',
  fortnightly: 'Fortnightly',
  four_weekly: 'Four weekly',
  monthly: 'Monthly',
  last_friday: 'Last working Friday',
};

const CYCLE_DAYS: Partial<Record<PayFrequency, number>> = { weekly: 7, fortnightly: 14, four_weekly: 28 };

/**
 * The payroll a company runs when it has set none: weekly, Monday to Sunday, paid the Friday after,
 * with hours in by noon on the Tuesday. It is what Preshift did before schedules could be set, so
 * existing clients carry on exactly as they were.
 */
export const DEFAULT_SCHEDULE: PaySchedule = {
  id: 'weekly',
  name: 'Weekly',
  frequency: 'weekly',
  anchorDate: '2024-01-01',
  payDaysAfterPeriodEnd: 5,
  cutoffDaysBeforePay: 3,
  cutoffTime: '12:00',
};

/** Starting points for a client setting up a payroll. Each is a common UK hospitality calendar. */
export const SCHEDULE_PRESETS: Record<PayFrequency, Omit<PaySchedule, 'id' | 'name'>> = {
  weekly: { frequency: 'weekly', anchorDate: '2024-01-01', payDaysAfterPeriodEnd: 5, cutoffDaysBeforePay: 3, cutoffTime: '12:00' },
  fortnightly: { frequency: 'fortnightly', anchorDate: '2024-01-01', payDaysAfterPeriodEnd: 5, cutoffDaysBeforePay: 3, cutoffTime: '12:00' },
  four_weekly: { frequency: 'four_weekly', anchorDate: '2024-01-01', payDaysAfterPeriodEnd: 5, cutoffDaysBeforePay: 3, cutoffTime: '12:00' },
  monthly: { frequency: 'monthly', periodEndDay: 20, payDay: 31, payMonthOffset: 0, cutoffDaysBeforePay: 5, cutoffTime: '12:00' },
  last_friday: { frequency: 'last_friday', periodEndDaysBeforePay: 5, cutoffDaysBeforePay: 3, cutoffTime: '12:00' },
};

const holidayCache = new Map<number, Set<string>>();
function holidaysIn(year: number): Set<string> {
  let set = holidayCache.get(year);
  if (!set) {
    set = new Set(bankHolidays(year).map((h) => h.date));
    holidayCache.set(year, set);
  }
  return set;
}

/** Monday to Friday and not an England and Wales bank holiday: a day banks pay out on. */
export function isWorkingDay(date: string): boolean {
  return weekday(date) < 5 && !holidaysIn(Number(date.slice(0, 4))).has(date);
}

/** The day itself if banks pay out on it, otherwise the working day before. Pay never lands late. */
export function workingDayOnOrBefore(date: string): string {
  let d = date;
  while (!isWorkingDay(d)) d = addDays(d, -1);
  return d;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** The date of a day in a month, with any day past the month's end taken as its last day. */
function dayOfMonth(year: number, month: number, day: number): string {
  const y = year + Math.floor(month / 12);
  const m = ((month % 12) + 12) % 12;
  return toISODate(new Date(Date.UTC(y, m, Math.min(day, daysInMonth(y, m)))));
}

function lastFridayOf(year: number, month: number): string {
  const last = dayOfMonth(year, month, 31);
  return addDays(last, -((weekday(last) - 4 + 7) % 7));
}

/** Months counted from year 0, so a period's month can step forward and back across years. */
const monthIndex = (date: string) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;

/**
 * Hours are due the working day on or before the set number of days before payday. Where a bank
 * holiday would pull that back into the period itself (Christmas week, most years), it moves forward
 * to the first working day after the period instead, so hours are never due before they are worked.
 */
function cutoffFor(s: PaySchedule, periodEnd: string, payDate: string): string {
  const cutoff = workingDayOnOrBefore(addDays(payDate, -s.cutoffDaysBeforePay));
  if (cutoff > periodEnd) return cutoff;
  let d = addDays(periodEnd, 1);
  while (!isWorkingDay(d) && d < payDate) d = addDays(d, 1);
  return d;
}

function monthlyEnd(s: PaySchedule, index: number): string {
  return dayOfMonth(0, index, s.periodEndDay ?? 31);
}

function monthlyPay(s: PaySchedule, endIndex: number): string {
  const index = endIndex + (s.payMonthOffset ?? 0);
  const day = s.payDay ?? 31;
  return workingDayOnOrBefore(dayOfMonth(0, index, day));
}

function lastFridayPay(index: number): string {
  return workingDayOnOrBefore(lastFridayOf(0, index));
}

function lastFridayEnd(s: PaySchedule, index: number): string {
  // Counted back from the last Friday itself, so a bank holiday moving payday does not move the period.
  return addDays(lastFridayOf(0, index), -(s.periodEndDaysBeforePay ?? 5));
}

function period(s: PaySchedule, periodStart: string, periodEnd: string, payDate: string): PayPeriod {
  return { scheduleId: s.id, periodStart, periodEnd, payDate, cutoffDate: cutoffFor(s, periodEnd, payDate), cutoffTime: s.cutoffTime };
}

/** The period of a schedule that a day falls in. */
export function periodContaining(s: PaySchedule, date: string): PayPeriod {
  const cycle = CYCLE_DAYS[s.frequency];
  if (cycle) {
    const anchor = s.anchorDate ?? DEFAULT_SCHEDULE.anchorDate!;
    const k = Math.floor(daysBetween(anchor, date) / cycle);
    const start = addDays(anchor, k * cycle);
    const end = addDays(start, cycle - 1);
    return period(s, start, end, workingDayOnOrBefore(addDays(end, s.payDaysAfterPeriodEnd ?? 5)));
  }
  const endOf = s.frequency === 'monthly' ? (i: number) => monthlyEnd(s, i) : (i: number) => lastFridayEnd(s, i);
  const payOf = s.frequency === 'monthly' ? (i: number) => monthlyPay(s, i) : (i: number) => lastFridayPay(i);
  // The period ending in this month, or the next one if this month's has already ended.
  let i = monthIndex(date) - 1;
  while (endOf(i) < date) i++;
  return period(s, addDays(endOf(i - 1), 1), endOf(i), payOf(i));
}

/** Every period of a schedule that touches the days from one date to another. */
export function periodsBetween(s: PaySchedule, from: string, to: string): PayPeriod[] {
  const out: PayPeriod[] = [];
  let p = periodContaining(s, from);
  while (p.periodStart <= to) {
    out.push(p);
    p = periodContaining(s, addDays(p.periodEnd, 1));
  }
  return out;
}

/** The next periods from the one a day falls in, for showing a client their calendar. */
export function upcomingPeriods(s: PaySchedule, from: string, count: number): PayPeriod[] {
  const out: PayPeriod[] = [];
  let p = periodContaining(s, from);
  for (let i = 0; i < count; i++) {
    out.push(p);
    p = periodContaining(s, addDays(p.periodEnd, 1));
  }
  return out;
}

/** The instant hours are due, from the cutoff day and time in UK local time. */
export function cutoffInstant(p: Pick<PayPeriod, 'cutoffDate' | 'cutoffTime'>): string {
  const [h, m] = p.cutoffTime.split(':').map(Number);
  const wall = parseISODate(p.cutoffDate).getTime() + (h * 60 + m) * 60_000;
  // London is UTC in winter and an hour ahead in summer: read the wall clock back to find which.
  const ahead = londonParts(new Date(wall)).minute !== h * 60 + m;
  return new Date(ahead ? wall - 3_600_000 : wall).toISOString();
}

/**
 * Whether a schedule makes sense, checked over the next two years of its periods so a bank holiday or a
 * short month cannot catch it out. Hours can only be passed once the period has ended, and pay can only
 * land once they have been passed.
 */
export function scheduleProblems(s: PaySchedule, from: string): string[] {
  const problems: string[] = [];
  if (!s.name.trim()) problems.push('Give the payroll a name.');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.cutoffTime)) problems.push('The cutoff time must be HH:MM, for example 12:00.');
  if (!Number.isInteger(s.cutoffDaysBeforePay) || s.cutoffDaysBeforePay < 0 || s.cutoffDaysBeforePay > 27) {
    problems.push('The cutoff must be between 0 and 27 days before payday.');
  }
  if (CYCLE_DAYS[s.frequency]) {
    if (!s.anchorDate || Number.isNaN(parseISODate(s.anchorDate).getTime())) problems.push('Give the first day of any one period, which sets the cycle.');
    const after = s.payDaysAfterPeriodEnd ?? 5;
    if (!Number.isInteger(after) || after < 0 || after > 28) problems.push('Payday must be between 0 and 28 days after the period ends.');
  }
  if (s.frequency === 'monthly') {
    if (!Number.isInteger(s.periodEndDay ?? 31) || (s.periodEndDay ?? 31) < 1 || (s.periodEndDay ?? 31) > 31) problems.push('The period end day must be 1 to 31.');
    if (!Number.isInteger(s.payDay ?? 31) || (s.payDay ?? 31) < 1 || (s.payDay ?? 31) > 31) problems.push('Payday must be a day from 1 to 31.');
  }
  if (s.frequency === 'last_friday') {
    const before = s.periodEndDaysBeforePay ?? 5;
    if (!Number.isInteger(before) || before < 0 || before > 21) problems.push('The period must end between 0 and 21 days before payday.');
  }
  if (problems.length) return problems;
  for (const p of upcomingPeriods(s, from, s.frequency === 'weekly' ? 104 : 26)) {
    if (p.cutoffDate <= p.periodEnd || p.payDate <= p.periodEnd) {
      problems.push(
        `The period ${p.periodStart} to ${p.periodEnd} would be paid on ${p.payDate} with hours due ${p.cutoffDate}, before its last day is worked. ` +
          (s.frequency === 'monthly'
            ? 'End the hours period earlier in the month (the 20th is common) or pay in the month after.'
            : 'Pay later after the period ends, or bring the cutoff closer to payday.'),
      );
      break;
    }
    if (p.payDate < p.cutoffDate) {
      problems.push(`Payday ${p.payDate} would come before the cutoff ${p.cutoffDate}. Leave at least a working day between the period end and payday.`);
      break;
    }
  }
  return problems;
}

/** The schedules a company runs: those it has set, or the weekly default. */
export function schedulesOf(entity: Pick<Entity, 'paySchedules'> | undefined): PaySchedule[] {
  return entity?.paySchedules?.length ? entity.paySchedules : [DEFAULT_SCHEDULE];
}

/** The schedule a person is paid on: the one set on their record, otherwise their company's first. */
export function scheduleFor(employee: Pick<Employee, 'payScheduleId'>, entity: Pick<Entity, 'paySchedules'> | undefined): PaySchedule {
  const all = schedulesOf(entity);
  return all.find((s) => s.id === employee.payScheduleId) ?? all[0];
}

/** One person's hours for a pay period, rota against clock, with what still stands between them and payroll. */
export interface TimeCard {
  employeeId: string;
  salaried: boolean;
  rosteredHours: number;
  clockedHours: number;
  approvedHours: number;
  variance: number;
  entries: number;
  open: number;
  waiting: number;
  approved: number;
  rejected: number;
  /** Clocked with no rostered shift behind it. */
  unrostered: number;
  /** Rostered shifts already past with nothing clocked against them. */
  notClocked: number;
  status: 'no_time' | 'clocked_in' | 'waiting' | 'approved';
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The time cards for a period: everyone on the payroll who was rostered or clocked in it. A card is
 * approved once every entry on it is approved or rejected and nobody is still clocked in.
 */
export function timeCards(
  people: Employee[],
  shifts: Shift[],
  entries: TimeEntry[],
  p: Pick<PayPeriod, 'periodStart' | 'periodEnd'>,
  today: string,
): TimeCard[] {
  const inPeriod = (x: { date: string }) => x.date >= p.periodStart && x.date <= p.periodEnd;
  const ids = new Set(people.map((e) => e.id));
  const myShifts = shifts.filter((s) => ids.has(s.employeeId) && inPeriod(s));
  const myEntries = entries.filter((t) => ids.has(t.employeeId) && inPeriod(t));
  // A manual entry carries no shift, so a day's clocking is matched to that day's shifts by person.
  const worked = (e: string, date: string) => myEntries.some((t) => t.employeeId === e && t.date === date && t.status !== 'rejected');
  const rostered = (e: string, date: string) => myShifts.some((s) => s.employeeId === e && s.date === date);
  return people
    .filter((e) => myShifts.some((s) => s.employeeId === e.id) || myEntries.some((t) => t.employeeId === e.id))
    .map((e) => {
      const rota = myShifts.filter((s) => s.employeeId === e.id);
      const time = myEntries.filter((t) => t.employeeId === e.id);
      const live = time.filter((t) => t.status !== 'rejected');
      const n = (status: TimeEntry['status']) => time.filter((t) => t.status === status).length;
      const rosteredHours = round2(rota.reduce((sum, s) => sum + shiftPaidHours(s), 0));
      const clockedHours = round2(live.reduce((sum, t) => sum + entryPaidHours(t), 0));
      const open = n('open');
      const waiting = n('submitted');
      return {
        employeeId: e.id,
        salaried: e.payBasis === 'salaried',
        rosteredHours,
        clockedHours,
        approvedHours: round2(time.filter((t) => t.status === 'approved').reduce((sum, t) => sum + entryPaidHours(t), 0)),
        variance: round2(clockedHours - rosteredHours),
        entries: time.length,
        open,
        waiting,
        approved: n('approved'),
        rejected: n('rejected'),
        unrostered: live.filter((t) => !t.shiftId && !rostered(e.id, t.date)).length,
        notClocked: rota.filter((s) => s.date < today && !worked(e.id, s.date) && !myEntries.some((t) => t.shiftId === s.id && t.status !== 'rejected')).length,
        status: time.length === 0 ? 'no_time' : open > 0 ? 'clocked_in' : waiting > 0 ? 'waiting' : 'approved',
      } satisfies TimeCard;
    })
    .sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance));
}
