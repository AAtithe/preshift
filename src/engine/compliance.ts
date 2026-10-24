import type { Employee, RestOverride, RotaState, SchoolPeriod, Shift, Site } from './types';
import { isSchoolDay } from './school';
import { employeeWeekCost, shiftPaidMinutes, shiftsInWeek } from './cost';
import { employedShare, isEmployedOn, ruleAge } from './employees';
import { isAbsentOn } from './hr';
import { absoluteMinute, addDays, ageOn, weekDates, weekday } from './time';
import { travelIssues, travelMinutesInto } from './travel';
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

export type Nation = NonNullable<Site['nation']>;

/** The last Friday of June in a year. */
function lastFridayOfJune(year: number): string {
  const d = `${year}-06-30`;
  return addDays(d, -((weekday(d) - 4 + 7) % 7));
}

/**
 * The last day someone is of compulsory school age, from gov.uk "Know when
 * you can leave school". England and Wales: the last Friday in June if they
 * will be 16 by the end of the summer holidays (taken as 31 August), otherwise
 * the year after. Scotland: 31 May if they turn 16 between March and
 * September, otherwise the start of the Christmas holidays (taken as 20
 * December). Northern Ireland: 30 June if they turn 16 by 1 July, otherwise
 * the year after.
 */
export function schoolLeavingDate(dateOfBirth: string, nation: Nation = 'england'): string {
  const year = Number(dateOfBirth.slice(0, 4)) + 16;
  const sixteenth = `${year}${dateOfBirth.slice(4)}`;
  const md = dateOfBirth.slice(5);
  if (nation === 'scotland') {
    if (md >= '03-01' && md <= '09-30') return `${year}-05-31`;
    return md >= '10-01' ? `${year}-12-20` : `${year - 1}-12-20`;
  }
  if (nation === 'northern_ireland') return md <= '07-01' ? `${year}-06-30` : `${year + 1}-06-30`;
  return sixteenth <= `${year}-08-31` ? lastFridayOfJune(year) : lastFridayOfJune(year + 1);
}

/** Still of compulsory school age on this date, so the child employment rules apply rather than the young worker ones. */
export const isChildOn = (employee: Pick<Employee, 'dateOfBirth'>, date: string, nation: Nation = 'england') =>
  // No date of birth (withheld from this reader as an adult's, or not yet entered) is never read as a child.
  Boolean(employee.dateOfBirth) && date <= schoolLeavingDate(employee.dateOfBirth, nation);

/** The break a shift needs for this person on this date: a child needs an hour once a shift passes four hours. */
export function breakFor(employee: Pick<Employee, 'dateOfBirth' | 'personalHidden' | 'under18'>, date: string, shiftMinutes: number, nation: Nation = 'england'): number {
  if (isChildOn(employee, date, nation)) return shiftMinutes > 4 * H ? 60 : 0;
  return requiredBreakMinutes(shiftMinutes, ruleAge(employee, date));
}

export interface ComplianceOptions {
  /** The person's home site's confirmed school holidays. Estimates are never used here: until the council's dates are in, it is term time. */
  schoolHolidays?: SchoolPeriod[];
  nation?: Nation;
  /** Roles in the bar department, for the school-age bar warning. */
  barRoleIds?: string[];
  /** Sites, so travel between them counts as working time; without them it is left out. */
  sites?: Site[];
}

/**
 * What the checks need to know about a person. School holidays are their home
 * site's: a child's school follows where they live, and the home site is the
 * best stand-in for that, wherever they cover.
 */
export function complianceOptions(state: Pick<RotaState, 'sites' | 'schoolHolidays'> & Partial<Pick<RotaState, 'roles'>>, employee: Pick<Employee, 'siteId'>): ComplianceOptions {
  return {
    barRoleIds: (state.roles ?? []).filter((r) => r.department === 'BAR').map((r) => r.id),
    schoolHolidays: (state.schoolHolidays ?? []).filter((p) => p.siteId === employee.siteId),
    nation: state.sites.find((s) => s.id === employee.siteId)?.nation ?? 'england',
    sites: state.sites,
  };
}

/** School hours on a school day; no child may work in them. */
const SCHOOL_FROM = 8 * H + 30;
const SCHOOL_TO = 15 * H + 30;

function overlaps(a: Shift, b: Shift, anchor: string) {
  const a0 = absoluteMinute(anchor, a.date, a.startMinute);
  const a1 = absoluteMinute(anchor, a.date, a.endMinute);
  const b0 = absoluteMinute(anchor, b.date, b.startMinute);
  const b1 = absoluteMinute(anchor, b.date, b.endMinute);
  return a0 < b1 && b0 < a1;
}

export function isAvailable(employee: Employee, shift: Shift): boolean {
  if (employee.unavailable?.some((u) => u.date === shift.date)) return false;
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
  options: ComplianceOptions = {},
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
  const age = ruleAge(employee, weekStartDate);
  const young = age < 18;
  const push = (i: Omit<Issue, 'employeeId'>) => issues.push({ employeeId: employee.id, ...i });
  const nation = options.nation ?? 'england';
  const confirmed = options.schoolHolidays ?? [];
  const child = (date: string) => isChildOn(employee, date, nation);
  // Anyone of school age this week is held to the child rules, which are stricter than the young worker ones they replace.
  const childWeek = week.some((s) => child(s.date));
  // Daily limits are per day, not per shift: two short shifts on one day count together, and the one that tips it over is flagged.
  const paidSoFar = new Map<string, number>();
  const beforeSchoolSoFar = new Map<string, number>();
  const barRoles = new Set(options.barRoleIds ?? []);
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

    const needed = child(shift.date) ? (length > 4 * H ? 60 : 0) : requiredBreakMinutes(length, age);
    if (shift.breakMinutes < needed) {
      push({
        ...base,
        code: 'break',
        severity: 'block',
        message: `${(length / H).toFixed(1)}h shift needs a ${needed} minute break${child(shift.date) ? ' (school age: an hour after four hours)' : young ? ' (under 18)' : ''}.`,
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
      const band = minimumWageFor(ruleAge(employee, shift.date), rates);
      // Withheld pay or age reads as nought or a guess; the API, which holds both, makes this check for that reader.
      if (band && !employee.payHidden && !employee.personalHidden && employee.hourlyRate < band.hourly) {
        push({
          ...base,
          code: 'minimum-wage',
          severity: 'block',
          message: `£${employee.hourlyRate.toFixed(2)}/h is below the ${band.label} of £${band.hourly.toFixed(2)}.`,
        });
      }
    }
    const dayPaid = (paidSoFar.get(shift.date) ?? 0) + Math.max(0, length - shift.breakMinutes);
    paidSoFar.set(shift.date, dayPaid);
    if (child(shift.date)) {
      const childAge = ageOn(employee.dateOfBirth, shift.date);
      const paid = dayPaid;
      const day = weekday(shift.date);
      const schoolDay = isSchoolDay(shift.date, confirmed);
      const longDay = childAge <= 14 ? 5 * H : 8 * H;
      const cap = day === 6 || schoolDay ? 2 * H : longDay;
      const capLabel = day === 6 ? 'on a Sunday' : schoolDay ? 'on a school day' : day === 5 ? 'on a Saturday' : 'in the school holidays';
      if (childAge < 13) {
        push({ ...base, code: 'child-age', severity: 'block', message: 'Children under 13 cannot be employed (13 only where local byelaws allow).' });
      }
      if (shift.startMinute < 7 * H || shift.endMinute > 19 * H) {
        push({ ...base, code: 'child-time', severity: 'block', message: 'School age: no work before 07:00 or after 19:00.' });
      }
      if (paid > cap) {
        push({ ...base, code: 'child-daily', severity: 'block', message: `School age: at most ${cap / H} hours ${capLabel} (${(paid / H).toFixed(1)}h rostered).` });
      }
      if (schoolDay && shift.startMinute < SCHOOL_TO && shift.endMinute > SCHOOL_FROM) {
        push({ ...base, code: 'child-school-hours', severity: 'block', message: 'School age: no work during school hours on a school day. If it is a holiday there, add the council\'s dates for the site.' });
      }
      const before = (beforeSchoolSoFar.get(shift.date) ?? 0) + (schoolDay && shift.endMinute <= SCHOOL_FROM ? length : 0);
      beforeSchoolSoFar.set(shift.date, before);
      if (schoolDay && shift.endMinute <= SCHOOL_FROM && before > H) {
        push({ ...base, code: 'child-before-school', severity: 'block', message: 'School age: no more than one hour before school.' });
      }
      if (barRoles.has(shift.roleId)) {
        push({ ...base, code: 'child-bar', severity: 'warn', message: 'School age: check local byelaws and licensing before rostering behind a bar.' });
      }
    } else if (young) {
      if (dayPaid > 8 * H) {
        push({ ...base, code: 'young-daily', severity: 'block', message: 'Under 18s cannot work more than 8 hours a day.' });
      }
      // Working Time Regulations 1998, regulation 27A: hotels, restaurants and bars may keep an under 18
      // on between 22:00 and 06:00 where needed and supervised, but never between midnight and 04:00.
      if (shift.startMinute < 4 * H || (shift.endMinute > 24 * H && shift.startMinute < 28 * H)) {
        push({ ...base, code: 'young-midnight', severity: 'block', message: 'Under 18s cannot work between midnight and 04:00, even under the hospitality exemption.' });
      } else if (shift.endMinute > 22 * H || shift.startMinute < 6 * H) {
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

  // Travel between sites within the day is working time for everyone, salaried staff included,
  // so it counts towards the weekly limits even where it does not change pay.
  const travelMinutes = [...travelMinutesInto(mine, options.sites ?? [])].filter(([id]) => week.some((s) => s.id === id)).reduce((sum, [, m]) => sum + m, 0);
  const hours = (week.reduce((sum, s) => sum + shiftPaidMinutes(s), 0) + travelMinutes) / H;
  const rostered = `${hours.toFixed(1)}h rostered${travelMinutes > 0 ? `, ${(travelMinutes / H).toFixed(1)}h of it travel between sites` : ''}`;
  if (childWeek) {
    // A week with any school day in it is a term-time week; only confirmed holidays count as holidays.
    const termWeek = dates.slice(0, 5).some((d) => isSchoolDay(d, confirmed));
    const childAge = ageOn(employee.dateOfBirth, weekStartDate);
    const cap = termWeek ? 12 : childAge <= 14 ? 25 : 35;
    if (hours > cap) {
      push({ code: 'child-weekly', severity: 'block', message: `School age: at most ${cap} hours a week ${termWeek ? 'in term time' : 'in the school holidays'} (${rostered}).` });
    }
    push({ code: 'child-permit', severity: 'warn', message: 'School age: check the council\'s child employment permit is on file, and two clear weeks off in the school holidays this year.' });
  } else if (young && hours > 40) {
    push({ code: 'young-weekly', severity: 'block', message: `Under 18s are capped at 40 hours a week (${rostered}).` });
  }
  if (!young && hours > 48 && !employee.optedOutOf48) {
    push({ code: 'wtr-48', severity: 'warn', message: `${rostered} without a 48 hour opt-out. Must average 48h or less over 17 weeks.` });
  }
  if (hours > employee.maxWeeklyHours) {
    push({ code: 'max-hours', severity: 'warn', message: `${rostered}, over their ${employee.maxWeeklyHours}h maximum.` });
  }
  const fullWeek = dates.every((d) => isEmployedOn(employee, d));
  // A salary is a fixed sum for however many hours are worked, so a long rota can take it below the minimum wage.
  // Paid travel between sites is working time here too. A warning, not a block: salaried pay is judged over the
  // pay period, where on monthly pay a lighter week can make up for this one. Withheld pay or age would read as a
  // guess, so as for hourly pay the API, which holds both, makes this check for that reader.
  if (fullWeek && employee.payBasis === 'salaried' && !employee.payHidden && !employee.personalHidden && hours > 0) {
    const band = minimumWageFor(ruleAge(employee, weekStartDate), rates);
    const weekly = employee.annualSalary / 52 - (employee.nmwReducingDeductionsWeekly ?? 0);
    if (band && weekly < band.hourly * hours) {
      push({
        code: 'salaried-minimum-wage',
        severity: 'warn',
        message: `£${weekly.toFixed(2)} a week over ${rostered} is £${(weekly / hours).toFixed(2)}/h, below the ${band.label} of £${band.hourly.toFixed(2)}. The salary covers ${(weekly / band.hourly).toFixed(1)}h a week; on monthly pay a lighter week can make up for this one.`,
      });
    }
  }
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
    .flatMap((e) => [
      ...checkEmployeeWeek(e, weekStartDate, context, state.restOverrides, undefined, complianceOptions(state, e)),
      ...travelIssues(e, context, state.sites),
      ...averagingIssues(e, weekStartDate, state),
    ]);
}

/**
 * Where a company averages travel pay below the minimum wage, says when a week needed topping up
 * and by how much: the top-up is already in the cost and on the payroll travel line.
 */
function averagingIssues(employee: Employee, weekStartDate: string, state: RotaState): Issue[] {
  const policy = state.entities.find((x) => x.id === employee.entityId)?.travelPay;
  if (policy?.basis !== 'fixed' || !policy.averaging || employee.payBasis !== 'hourly') return [];
  const week = shiftsInWeek(state.shifts, weekStartDate).filter((s) => s.employeeId === employee.id);
  const cost = employeeWeekCost(employee, week, undefined, employedShare(employee, weekStartDate), state.sites, state.entities);
  if (cost.minimumWageTopUp < 0.01) return [];
  return [
    {
      employeeId: employee.id,
      code: 'travel-minimum-wage',
      severity: 'warn',
      message: `Travel at £${policy.hourly.toFixed(2)} an hour takes this week's average pay below the minimum wage: £${cost.minimumWageTopUp.toFixed(2)} is added to their travel pay to make it up.`,
    },
  ];
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
