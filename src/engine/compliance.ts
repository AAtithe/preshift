import type { Employee, RestOverride, RotaState, Shift } from './types';
import { shiftPaidMinutes } from './cost';
import { isEmployedOn } from './employees';
import { isAbsentOn } from './hr';
import { absoluteMinute, ageOn, addDays, weekDates, weekday } from './time';
import { travelIssues } from './travel';
import { UK_RATES_2026_27, minimumWageFor, type UkRates } from './ukRates';

export type Severity = 'block' | 'warn';

export interface Issue {
  code: string;
  severity: Severity;
  employeeId: string;
  shiftId?: string;
  date?: string;
  message: string;
  /** Set on breaches a manager may override with a reason: rest periods only. */
  overrideKey?: string;
  /** The override that turned this breach from blocking into a warning. */
  overridden?: Pick<RestOverride, 'id' | 'reason' | 'by' | 'at'>;
}

/** Rest breaches a manager can publish through, with a recorded reason. Nothing else can be overridden. */
export const OVERRIDABLE = new Set(['daily-rest', 'weekly-rest']);

const H = 60;

/** Unpaid break the Working Time Regulations require for a shift of this length. */
export function requiredBreakMinutes(shiftMinutes: number, age: number): number {
  if (age < 18) return shiftMinutes > 4.5 * H ? 30 : 0;
  return shiftMinutes > 6 * H ? 20 : 0;
}

function overlaps(a: Shift, b: Shift, anchor: string) {
  const a0 = absoluteMinute(anchor, a.date, a.startMinute);
  const a1 = absoluteMinute(anchor, a.date, a.endMinute);
  const b0 = absoluteMinute(anchor, b.date, b.startMinute);
  const b1 = absoluteMinute(anchor, b.date, b.endMinute);
  return a0 < b1 && b0 < a1;
}

export function isAvailable(employee: Employee, shift: Shift): boolean {
  if (employee.availability.length === 0) return true;
  const day = weekday(shift.date);
  return employee.availability.some(
    (a) => a.weekday === day && a.fromMinute <= shift.startMinute && a.toMinute >= shift.endMinute,
  );
}

/**
 * Checks one person's week against UK employment law and their own contract.
 * `context` should include the days either side of the week so rest periods
 * across the week boundary are caught.
 */
export function checkEmployeeWeek(
  employee: Employee,
  weekStartDate: string,
  context: Shift[],
  overrides: RestOverride[] = [],
  rates: UkRates = UK_RATES_2026_27,
): Issue[] {
  const issues: Issue[] = [];
  const dates = weekDates(weekStartDate);
  const inWeek = new Set(dates);
  const anchor = addDays(weekStartDate, -7);
  const mine = context
    .filter((s) => s.employeeId === employee.id)
    .sort(
      (a, b) =>
        absoluteMinute(anchor, a.date, a.startMinute) - absoluteMinute(anchor, b.date, b.startMinute),
    );
  const week = mine.filter((s) => inWeek.has(s.date));
  // Someone not on the books this week, and not rostered, has nothing to check.
  if (week.length === 0 && !dates.some((d) => isEmployedOn(employee, d))) return [];
  const age = ageOn(employee.dateOfBirth, weekStartDate);
  const young = age < 18;
  const push = (i: Omit<Issue, 'employeeId'>) => issues.push({ employeeId: employee.id, ...i });
  // A rest breach a manager has overridden still shows, as a warning carrying who and why.
  const pushRest = (i: Omit<Issue, 'employeeId' | 'overrideKey'>, key: string) => {
    const o = overrides.find((x) => x.employeeId === employee.id && x.key === key);
    if (!o) return push({ ...i, overrideKey: key });
    push({
      ...i,
      overrideKey: key,
      severity: 'warn',
      message: `${i.message} Overridden by ${o.by}: ${o.reason}`,
      overridden: { id: o.id, reason: o.reason, by: o.by, at: o.at },
    });
  };

  for (const shift of week) {
    const length = shift.endMinute - shift.startMinute;
    const base = { shiftId: shift.id, date: shift.date };

    if (length <= 0) push({ ...base, code: 'invalid-time', severity: 'block', message: 'Shift ends before it starts.' });

    const needed = requiredBreakMinutes(length, age);
    if (shift.breakMinutes < needed) {
      push({
        ...base,
        code: 'break',
        severity: 'block',
        message: `${(length / H).toFixed(1)}h shift needs a ${needed} minute break${young ? ' (under 18)' : ''}.`,
      });
    }
    if (!isEmployedOn(employee, shift.date)) {
      const before = employee.startDate && shift.date < employee.startDate;
      push({ ...base, code: 'not-employed', severity: 'block', message: before ? `Starts on ${employee.startDate}.` : `Left on ${employee.leaveDate}.` });
    }
    const rtw = employee.rightToWork;
    if (rtw && !rtw.checked) {
      push({ ...base, code: 'right-to-work', severity: 'block', message: 'No right to work check on file.' });
    } else if (rtw?.expiry && shift.date > rtw.expiry) {
      push({ ...base, code: 'right-to-work', severity: 'block', message: `Right to work expired on ${rtw.expiry}.` });
    }
    if (employee.leave.includes(shift.date)) {
      push({ ...base, code: 'on-leave', severity: 'block', message: 'Rostered on approved leave.' });
    }
    if (isAbsentOn(employee, shift.date)) {
      push({ ...base, code: 'absent', severity: 'block', message: 'Recorded as absent that day. Re-cover the shift.' });
    }
    if (!isAvailable(employee, shift)) {
      push({ ...base, code: 'availability', severity: 'warn', message: 'Outside stated availability.' });
    }
    if (!employee.roleIds.includes(shift.roleId)) {
      push({ ...base, code: 'not-trained', severity: 'warn', message: 'Not signed off for this role.' });
    }
    if (employee.payBasis === 'hourly') {
      const band = minimumWageFor(ageOn(employee.dateOfBirth, shift.date), rates);
      // Withheld pay reads as nought; the API, which holds the real rate, makes this check for that reader.
      if (band && !employee.payHidden && employee.hourlyRate < band.hourly) {
        push({
          ...base,
          code: 'minimum-wage',
          severity: 'block',
          message: `£${employee.hourlyRate.toFixed(2)}/h is below the ${band.label} of £${band.hourly.toFixed(2)}.`,
        });
      }
    }
    if (young) {
      if (length - shift.breakMinutes > 8 * H) {
        push({ ...base, code: 'young-daily', severity: 'block', message: 'Under 18s cannot work more than 8 hours a day.' });
      }
      // Hospitality may roster under 18s until midnight in limited cases; flag rather than block.
      if (shift.endMinute > 22 * H || shift.startMinute < 6 * H) {
        push({ ...base, code: 'young-night', severity: 'warn', message: 'Under 18 working between 22:00 and 06:00. Check the hospitality exemption applies and is supervised.' });
      }
    }
  }

  // Overlaps and daily rest, including across the week boundary.
  const minRest = (young ? 12 : 11) * H;
  for (let i = 1; i < mine.length; i++) {
    const prev = mine[i - 1];
    const next = mine[i];
    if (!inWeek.has(next.date) && !inWeek.has(prev.date)) continue;
    if (overlaps(prev, next, anchor)) {
      push({ shiftId: next.id, date: next.date, code: 'double-booked', severity: 'block', message: 'Overlaps another shift.' });
      continue;
    }
    const gap = absoluteMinute(anchor, next.date, next.startMinute) - absoluteMinute(anchor, prev.date, prev.endMinute);
    if (prev.date !== next.date && gap < minRest) {
      pushRest(
        {
          shiftId: next.id,
          date: next.date,
          code: 'daily-rest',
          severity: 'block',
          message: `Only ${(gap / H).toFixed(1)}h rest since the last shift; ${minRest / H}h is the legal minimum.`,
        },
        `daily-rest|${prev.id}|${prev.date}|${prev.endMinute}|${next.id}|${next.date}|${next.startMinute}`,
      );
    }
  }

  // Weekly rest: at least one clear day (two for under 18s).
  const worked = new Set(week.map((s) => s.date));
  const daysOff = dates.filter((d) => !worked.has(d)).length;
  const neededOff = young ? 2 : 1;
  if (daysOff < neededOff) {
    pushRest(
      { code: 'weekly-rest', severity: 'block', message: `Needs ${neededOff} clear day${neededOff > 1 ? 's' : ''} off this week.` },
      `weekly-rest|${weekStartDate}|${[...worked].sort().join(',')}`,
    );
  }

  const hours = week.reduce((sum, s) => sum + shiftPaidMinutes(s), 0) / H;
  if (young && hours > 40) {
    push({ code: 'young-weekly', severity: 'block', message: `Under 18s are capped at 40 hours a week (${hours.toFixed(1)}h rostered).` });
  }
  if (!young && hours > 48 && !employee.optedOutOf48) {
    push({ code: 'wtr-48', severity: 'warn', message: `${hours.toFixed(1)}h rostered without a 48 hour opt-out. Must average 48h or less over 17 weeks.` });
  }
  if (hours > employee.maxWeeklyHours) {
    push({ code: 'max-hours', severity: 'warn', message: `${hours.toFixed(1)}h exceeds their ${employee.maxWeeklyHours}h maximum.` });
  }
  const fullWeek = dates.every((d) => isEmployedOn(employee, d));
  if (fullWeek && employee.payBasis === 'hourly' && employee.contractedHours > 0 && hours < employee.contractedHours) {
    push({ code: 'under-contract', severity: 'warn', message: `${hours.toFixed(1)}h is below ${employee.contractedHours} contracted hours. You pay the gap either way.` });
  }
  return issues;
}

/**
 * Checks everyone based at, or rostered into, the given sites (all sites if none
 * given). A person's whole week is checked across every site and entity they
 * work for: rest, hours and double booking are about the worker, not the site.
 */
export function checkWeek(state: RotaState, weekStartDate: string, siteIds?: string | string[]): Issue[] {
  const from = addDays(weekStartDate, -1);
  const to = addDays(weekStartDate, 7);
  const context = state.shifts.filter((s) => s.date >= from && s.date <= to);
  const scope = siteIds === undefined ? null : new Set(typeof siteIds === 'string' ? [siteIds] : siteIds);
  return state.employees
    .filter((e) => !scope || scope.has(e.siteId) || context.some((s) => s.employeeId === e.id && scope.has(s.siteId)))
    .flatMap((e) => [...checkEmployeeWeek(e, weekStartDate, context, state.restOverrides), ...travelIssues(e, context, state.sites)]);
}

/** The site an issue belongs to: where its shift is worked, or the person's home site for a week-level issue. */
export function issueSiteId(state: RotaState, issue: Issue): string | undefined {
  if (issue.shiftId) return state.shifts.find((s) => s.id === issue.shiftId)?.siteId;
  return state.employees.find((e) => e.id === issue.employeeId)?.siteId;
}

/**
 * Rest overrides per site for the week given and the weeks before it, oldest first. One override is an
 * exception; one most weeks is a site short of people or cross-training.
 */
export function overrideTrend(state: RotaState, weekStartDate: string, siteIds: string[], weeks = 4): { weekStarts: string[]; bySite: Map<string, number[]> } {
  const weekStarts = Array.from({ length: weeks }, (_, n) => addDays(weekStartDate, -7 * (weeks - 1 - n)));
  const bySite = new Map(siteIds.map((id) => [id, weekStarts.map(() => 0)]));
  weekStarts.forEach((ws, n) => {
    for (const issue of checkWeek(state, ws, siteIds)) {
      if (!issue.overridden) continue;
      const counts = bySite.get(issueSiteId(state, issue) ?? '');
      if (counts) counts[n]++;
    }
  });
  return { weekStarts, bySite };
}
