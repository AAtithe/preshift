import { bankHolidays } from './calendar';
import { absoluteMinute, addDays, weekday } from './time';
import type { Employee, Entity, PremiumRule, Shift } from './types';

// Pay premiums: the enhanced rates a company's contracts pay for Sundays, bank holidays, nights and
// overtime. Each is an uplift on the person's normal rate for the hours that qualify, so the base
// hours keep their own line and the premium is paid on top, as a payslip shows it.

export const PREMIUM_KINDS: Record<PremiumRule['kind'], string> = {
  day: 'Days of the week',
  bank_holiday: 'Bank holidays',
  night: 'Night hours',
  overtime: 'Overtime',
};

/** What one qualifying hour adds, for a person on a given rate. */
export function upliftPerHour(rule: PremiumRule, hourlyRate: number): number {
  if (typeof rule.multiplier === 'number') return Math.max(0, hourlyRate * (rule.multiplier - 1));
  return Math.max(0, rule.perHour ?? 0);
}

/** The weekly hours after which an overtime rule pays: its own threshold, else the person's contracted hours. */
export function overtimeThreshold(rule: PremiumRule, employee: Employee): number | null {
  if (typeof rule.afterHours === 'number') return rule.afterHours;
  return employee.contractedHours > 0 ? employee.contractedHours : null;
}

/** One premium earned on one shift. */
export interface PremiumLine {
  shiftId: string;
  ruleId: string;
  name: string;
  /** Paid hours that qualified. */
  hours: number;
  /** Added to each of those hours. */
  uplift: number;
  amount: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function inWindow(minuteOfDay: number, from: number, to: number) {
  // A window such as 22:00 to 06:00 runs past midnight.
  return from <= to ? minuteOfDay >= from && minuteOfDay < to : minuteOfDay >= from || minuteOfDay < to;
}

const holidayCache = new Map<number, Set<string>>();
function isBankHoliday(date: string) {
  const year = Number(date.slice(0, 4));
  let set = holidayCache.get(year);
  if (!set) {
    set = new Set(bankHolidays(year).map((h) => h.date));
    holidayCache.set(year, set);
  }
  return set.has(date);
}

/** The rules that apply to a person: their employing company's, for hourly staff only. */
export function rulesFor(employee: Employee, entities: Entity[]): PremiumRule[] {
  if (employee.payBasis !== 'hourly') return [];
  return entities.find((e) => e.id === employee.entityId)?.premiums ?? [];
}

/**
 * Premiums earned across a person's week. Every paid minute is checked against every rule; where
 * more than one applies (a Sunday night, overtime on a bank holiday) only the highest is paid, as
 * premiums usually do not stack. Day rules go by the calendar day of each minute, so the hours after
 * midnight on a Saturday night shift are Sunday's. Overtime is the last hours worked in the week, once
 * the threshold is passed. An unpaid break is taken evenly across the shift, since when it falls is not
 * recorded. Bank holidays follow England and Wales.
 */
export function weekPremiums(employee: Employee, shifts: Shift[], rules: PremiumRule[]): PremiumLine[] {
  if (rules.length === 0 || employee.payBasis !== 'hourly' || shifts.length === 0) return [];
  const anchor = shifts.reduce((m, s) => (s.date < m ? s.date : m), shifts[0].date);
  const ordered = [...shifts].sort(
    (a, b) => absoluteMinute(anchor, a.date, a.startMinute) - absoluteMinute(anchor, b.date, b.startMinute),
  );
  const thresholds = rules.map((r) => (r.kind === 'overtime' ? overtimeThreshold(r, employee) : null));
  const uplifts = rules.map((r) => upliftPerHour(r, employee.hourlyRate));
  const out: PremiumLine[] = [];
  let worked = 0; // paid minutes so far this week

  for (const shift of ordered) {
    const length = shift.endMinute - shift.startMinute;
    if (length <= 0) continue;
    // Paid minutes over clock minutes; worked out here rather than imported, as the cost engine imports this file.
    const weight = Math.max(0, length - shift.breakMinutes) / length;
    const minutesByRule = new Array<number>(rules.length).fill(0);
    // The calendar facts for each day the shift touches, worked out once rather than every minute.
    const days = new Map<number, { weekday: number; bankHoliday: boolean }>();
    const dayFacts = (offset: number) => {
      let facts = days.get(offset);
      if (!facts) {
        const date = offset === 0 ? shift.date : addDays(shift.date, offset);
        facts = { weekday: weekday(date), bankHoliday: isBankHoliday(date) };
        days.set(offset, facts);
      }
      return facts;
    };
    for (let m = shift.startMinute; m < shift.endMinute; m++) {
      worked += weight;
      const day = dayFacts(Math.floor(m / 1440));
      const minuteOfDay = m % 1440;
      let best = -1;
      for (let i = 0; i < rules.length; i++) {
        const r = rules[i];
        if (r.roleIds?.length && !r.roleIds.includes(shift.roleId)) continue;
        const applies =
          r.kind === 'day'
            ? (r.weekdays ?? []).includes(day.weekday)
            : r.kind === 'bank_holiday'
              ? day.bankHoliday
              : r.kind === 'night'
                ? inWindow(minuteOfDay, r.fromMinute ?? 0, r.toMinute ?? 0)
                : thresholds[i] !== null && worked > thresholds[i]! * 60 + 1e-9;
        if (applies && uplifts[i] > 0 && (best < 0 || uplifts[i] > uplifts[best])) best = i;
      }
      if (best >= 0) minutesByRule[best] += weight;
    }
    minutesByRule.forEach((minutes, i) => {
      if (minutes <= 0) return;
      const hours = minutes / 60;
      out.push({
        shiftId: shift.id,
        ruleId: rules[i].id,
        name: rules[i].name,
        hours: round2(hours),
        uplift: round2(uplifts[i]),
        amount: round2(hours * uplifts[i]),
      });
    });
  }
  return out;
}

/** Plain English for one rule, for settings screens and audit notes. */
export function describeRule(rule: PremiumRule): string {
  const rate = typeof rule.multiplier === 'number' ? multiplierWords(rule.multiplier) : `£${(rule.perHour ?? 0).toFixed(2)} an hour extra`;
  const clock = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const days = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'];
  const when =
    rule.kind === 'day'
      ? `on ${(rule.weekdays ?? []).map((d) => days[d]).join(', ') || 'no days yet'}`
      : rule.kind === 'bank_holiday'
        ? 'on bank holidays'
        : rule.kind === 'night'
          ? `between ${clock(rule.fromMinute ?? 0)} and ${clock(rule.toMinute ?? 0)}`
          : typeof rule.afterHours === 'number'
            ? `after ${rule.afterHours} hours in a week`
            : 'after contracted hours in a week';
  return `${rate} ${when}${rule.roleIds?.length ? ' (some roles only)' : ''}`;
}

function multiplierWords(m: number) {
  if (Math.abs(m - 1.5) < 1e-9) return 'Time and a half';
  if (Math.abs(m - 2) < 1e-9) return 'Double time';
  if (Math.abs(m - 1.25) < 1e-9) return 'Time and a quarter';
  return `${m}x the normal rate`;
}
