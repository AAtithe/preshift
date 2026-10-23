// Every dataset a report can be built on, one per kind of record the app keeps. Each says which
// permission reads it, mirroring the rule on its own screen and API route, so a report never
// shows anyone more than the screen would. Rows needing a finer rule than one permission at a
// site (a staff request is decided by a different role for each kind) are filtered here first.

import { canOrgWide, ROLES } from '../../src/engine/access';
import { checkWeek, issueSiteId } from '../../src/engine/compliance';
import { shiftPaidHours, weekCost } from '../../src/engine/cost';
import { breakShortfalls } from '../../src/engine/breaks';
import { employeeStatus, isEmployedOn } from '../../src/engine/employees';
import { absenceDays, ABSENCE_LABEL, bradfordFactor, requiredCourses, trainingStatus } from '../../src/engine/hr';
import { onboardingList } from '../../src/engine/onboarding';
import { metricsFor } from './labour';
import { monthsBetween, timeDimensions, type Dataset, type Dimension, type Measure, type RangeToken } from '../../src/engine/reportBuilder';
import { addDays, daysBetween, weekDates, weekStart } from '../../src/engine/time';
import { entryPaidHours } from '../../src/engine/timesheet';
import type { Employee, Shift, TimeEntry } from '../../src/engine/types';
import type { Guard } from '../guard';
import { balanceOf } from '../routes/requests';
import { authority } from '../routes/requests';
import type { OrgData } from '../store';

/** What a dataset is built from for one caller and one run. */
export interface Env {
  org: OrgData;
  g: Guard;
  today: string;
  from: string;
  to: string;
}

export interface ReportSource<R> extends Dataset<R> {
  rows: (env: Env) => R[];
  /**
   * A picture as at today (people, training, holiday) rather than events over time: its dates are
   * filtered only when a report sets them, and then on the dataset's own date (a start date).
   */
  snapshot?: boolean;
  /** The range used when a report gives none, for datasets worked out over time. */
  defaultRange?: RangeToken;
}


const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const weekdayOf = (iso: string) => WEEKDAYS[(new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7];
const DEPARTMENT: Record<string, string> = { FOH: 'Front of house', BAR: 'Bar', BOH: 'Kitchen', MGMT: 'Management' };
const one = (yes: boolean) => (yes ? 1 : 0);

/** Lookups every dataset needs, made once per run. */
function names(org: OrgData) {
  const site = new Map(org.state.sites.map((s) => [s.id, s]));
  const role = new Map(org.state.roles.map((r) => [r.id, r]));
  const person = new Map(org.state.employees.map((e) => [e.id, e]));
  const entity = new Map(org.state.entities.map((e) => [e.id, e]));
  return {
    site: (id?: string) => (id ? site.get(id)?.name ?? id : undefined),
    company: (siteId?: string) => (siteId ? entity.get(site.get(siteId)?.entityId ?? '')?.name : undefined),
    role: (id?: string) => (id ? role.get(id)?.name ?? id : undefined),
    department: (roleId?: string) => (roleId ? DEPARTMENT[role.get(roleId)?.department ?? ''] : undefined),
    person: (id?: string) => (id ? person.get(id)?.name ?? 'Former employee' : undefined),
    employee: (id: string) => person.get(id),
  };
}
type Names = ReturnType<typeof names>;

/** Site, company, role, department and person: the fields most datasets share. */
function common<R>(get: { site: (r: R) => string | undefined; role?: (r: R) => string | undefined; person?: (r: R) => string | undefined }, n: () => Names): Dimension<R>[] {
  const dims: Dimension<R>[] = [
    { id: 'site', label: 'Site', value: (r) => n().site(get.site(r)) },
    { id: 'company', label: 'Company', value: (r) => n().company(get.site(r)) },
  ];
  if (get.role) {
    dims.push({ id: 'role', label: 'Role', value: (r) => n().role(get.role!(r)) });
    dims.push({ id: 'department', label: 'Department', value: (r) => n().department(get.role!(r)) });
  }
  if (get.person) dims.push({ id: 'person', label: 'Person', value: (r) => n().person(get.person!(r)) });
  return dims;
}

const inRange = (env: Env) => (d?: string) => !!d && d >= env.from && d <= env.to;
/** Weeks in the range, capped, for datasets worked out a week at a time. */
const weeksIn = (env: Env, cap: number) => {
  const out: string[] = [];
  for (let w = weekStart(env.from); w <= env.to && out.length < cap; w = addDays(w, 7)) out.push(w);
  return out;
};

/**
 * Every dataset, built for one organisation and one run, with its names looked up once. Rows are
 * worked out only when a report asks for that dataset.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function datasetsFor(org: OrgData): ReportSource<any>[] {
  const n = names(org);
  const N = () => n;

// ---------------------------------------------------------------- Rota

interface ShiftRow extends Shift {
  cost: () => number;
}

const shifts: ReportSource<ShiftRow> = {
  id: 'shifts',
  label: 'Rota shifts',
  area: 'rota',
  description: 'Every shift on the rota, published or draft: hours, people and loaded cost.',
  permission: 'rota.view',
  dateLabel: 'Shift date',
  date: (r) => r.date,
  site: (r) => r.siteId,
  dimensions: [
    ...common<ShiftRow>({ site: (r) => r.siteId, role: (r) => r.roleId, person: (r) => r.employeeId }, N),
    { id: 'weekday', label: 'Day of the week', value: (r) => weekdayOf(r.date) },
    { id: 'published', label: 'Published', value: (r) => (r.published ? 'Published' : 'Draft') },
    { id: 'start', label: 'Start time', value: (r) => `${String(Math.floor(r.startMinute / 60) % 24).padStart(2, '0')}:00` },
  ],
  measures: [
    { id: 'shifts', label: 'Shifts', format: 'number', aggregation: 'count' },
    { id: 'hours', label: 'Paid hours', format: 'hours', aggregation: 'sum', value: (r) => shiftPaidHours(r) },
    { id: 'people', label: 'People rostered', format: 'number', aggregation: 'distinct', key: (r) => r.employeeId },
    { id: 'avgLength', label: 'Average shift length', format: 'hours', aggregation: 'average', value: (r) => shiftPaidHours(r) },
    { id: 'cost', label: 'Loaded cost', format: 'money', aggregation: 'sum', value: (r) => r.cost(), permission: 'costs.view', help: 'Pay, holiday, employer NI and pension, as the rota costs it.' },
  ],
  rows: (env) => {
    const keep = inRange(env);
    // Cost is worked a week at a time per site, as payroll would, and only when a report asks for it.
    const weeks = new Map<string, ReturnType<typeof weekCost>>();
    const costOf = (s: Shift) => {
      const k = `${weekStart(s.date)}|${s.siteId}`;
      if (!weeks.has(k)) weeks.set(k, weekCost(env.org.state, weekStart(s.date), s.siteId));
      return weeks.get(k)!.shifts.get(s.id)?.total ?? 0;
    };
    return env.org.state.shifts.filter((s) => keep(s.date)).map((s) => ({ ...s, cost: () => costOf(s) }));
  },
};

interface IssueRow {
  date: string;
  siteId?: string;
  code: string;
  severity: string;
  employeeId?: string;
  overridden: boolean;
}

const ISSUE_LABEL: Record<string, string> = {
  'daily-rest': 'Daily rest under 11 hours',
  'weekly-rest': 'No clear day off',
  break: 'Break too short',
  'wtr-48': 'Over 48 hours average',
  'max-hours': 'Over maximum hours',
  'minimum-wage': 'Below minimum wage',
  'not-trained': 'Not trained for the role',
  'on-leave': 'Rostered on leave',
  absent: 'Rostered while absent',
  availability: 'Outside availability',
  'double-booked': 'Double booked',
  'right-to-work': 'Right to work',
  'under-contract': 'Under contracted hours',
};

const compliance: ReportSource<IssueRow> = {
  id: 'compliance',
  defaultRange: 'last-13-weeks',
  label: 'Rota compliance issues',
  area: 'rota',
  description: 'What the compliance check finds on each week of the rota: rest, breaks, hours, wage, training and leave. Up to 26 weeks at a time.',
  permission: 'rota.view',
  dateLabel: 'Shift date',
  date: (r) => r.date,
  site: (r) => r.siteId,
  dimensions: [
    ...common<IssueRow>({ site: (r) => r.siteId, person: (r) => r.employeeId }, N),
    { id: 'rule', label: 'Rule', value: (r) => ISSUE_LABEL[r.code] ?? r.code },
    { id: 'severity', label: 'Severity', value: (r) => (r.severity === 'block' ? 'Blocks publishing' : 'Warning') },
    { id: 'overridden', label: 'Overridden', value: (r) => (r.overridden ? 'Overridden by a manager' : 'Not overridden') },
  ],
  measures: [
    { id: 'issues', label: 'Issues', format: 'number', aggregation: 'count' },
    { id: 'blocking', label: 'Blocking', format: 'number', aggregation: 'sum', value: (r) => one(r.severity === 'block') },
    { id: 'people', label: 'People affected', format: 'number', aggregation: 'distinct', key: (r) => r.employeeId },
  ],
  rows: (env) =>
    weeksIn(env, 26)
      .filter((w) => env.org.state.shifts.some((s) => s.date >= w && s.date <= addDays(w, 6)))
      .flatMap((w) =>
        checkWeek(env.org.state, w).map((i) => ({
          date: i.date ?? w,
          siteId: issueSiteId(env.org.state, i),
          code: i.code,
          severity: i.severity,
          employeeId: i.employeeId,
          overridden: !!i.overridden,
        })),
      )
      .filter((r) => inRange(env)(r.date)),
};

interface OverrideRow {
  date: string;
  siteId: string;
  employeeId: string;
  code: string;
  by: string;
}

const overrides: ReportSource<OverrideRow> = {
  id: 'overrides',
  label: 'Rest overrides',
  area: 'rota',
  description: 'Each rest breach a manager published with a written reason: who, where, which rule and by whom.',
  permission: 'rota.view',
  dateLabel: 'Recorded',
  date: (r) => r.date,
  site: (r) => r.siteId,
  dimensions: [
    ...common<OverrideRow>({ site: (r) => r.siteId, person: (r) => r.employeeId }, N),
    { id: 'rule', label: 'Rule', value: (r) => (r.code === 'daily-rest' ? 'Daily rest' : 'Weekly rest') },
    { id: 'by', label: 'Overridden by', value: (r) => r.by },
  ],
  measures: [
    { id: 'overrides', label: 'Overrides', format: 'number', aggregation: 'count' },
    { id: 'people', label: 'People', format: 'number', aggregation: 'distinct', key: (r) => r.employeeId },
  ],
  rows: (env) =>
    (env.org.state.restOverrides ?? [])
      .map((o) => ({ date: o.at.slice(0, 10), siteId: o.siteId, employeeId: o.employeeId, code: o.code, by: o.by }))
      .filter((r) => inRange(env)(r.date)),
};

const openShifts: ReportSource<NonNullable<OrgData['openShifts']>[number]> = {
  id: 'openShifts',
  label: 'Open shifts',
  area: 'rota',
  description: 'Shifts posted for anyone to pick up: how many, how many were filled, and how fast.',
  permission: 'rota.publish',
  dateLabel: 'Shift date',
  date: (r) => r.date,
  site: (r) => r.siteId,
  dimensions: [
    ...common<NonNullable<OrgData['openShifts']>[number]>({ site: (r) => r.siteId, role: (r) => r.roleId }, N),
    { id: 'status', label: 'Status', value: (r) => ({ open: 'Still open', filled: 'Filled', withdrawn: 'Withdrawn' })[r.status] },
  ],
  measures: [
    { id: 'posted', label: 'Posted', format: 'number', aggregation: 'count' },
    { id: 'filled', label: 'Filled', format: 'number', aggregation: 'sum', value: (r) => one(r.status === 'filled') },
    { id: 'fillRate', label: 'Fill rate', format: 'percent', aggregation: 'sum', ratio: { numerator: 'filled', denominator: 'posted' } },
    { id: 'hours', label: 'Hours posted', format: 'hours', aggregation: 'sum', value: (r) => Math.max(0, r.endMinute - r.startMinute - r.breakMinutes) / 60 },
  ],
  rows: (env) => (env.org.openShifts ?? []).filter((o) => inRange(env)(o.date)),
};

// ---------------------------------------------------------------- Time and attendance

interface EntryRow extends TimeEntry {
  minutesLate: number | null;
}

const TIME_READERS = ['time.record', 'time.approve', 'payroll.view'] as const;

const time: ReportSource<EntryRow> = {
  id: 'time',
  label: 'Clocked time',
  area: 'time',
  description: 'Every clock-in: paid hours, how it was clocked, and arrivals against the rota.',
  permission: [...TIME_READERS],
  dateLabel: 'Shift date',
  date: (r) => r.date,
  site: (r) => r.siteId,
  dimensions: [
    ...common<EntryRow>({ site: (r) => r.siteId, role: (r) => r.roleId, person: (r) => r.employeeId }, N),
    { id: 'status', label: 'Status', value: (r) => ({ open: 'Still clocked in', submitted: 'Awaiting approval', approved: 'Approved', rejected: 'Rejected' })[r.status] },
    { id: 'method', label: 'Clocked by', value: (r) => (r.source === 'manual' ? 'Entered by a manager' : ({ card: 'Card tap', device: 'Name on a site device', phone: 'Own phone', kiosk: 'Kiosk' } as Record<string, string>)[r.method ?? ''] ?? 'Clock') },
    { id: 'rostered', label: 'On the rota', value: (r) => (r.shiftId ? 'Rostered' : 'Not rostered') },
    { id: 'weekday', label: 'Day of the week', value: (r) => weekdayOf(r.date) },
  ],
  measures: [
    { id: 'entries', label: 'Clock-ins', format: 'number', aggregation: 'count' },
    { id: 'hours', label: 'Paid hours', format: 'hours', aggregation: 'sum', value: (r) => entryPaidHours(r) },
    { id: 'late', label: 'Late arrivals', format: 'number', aggregation: 'sum', value: (r) => (r.minutesLate === null ? 0 : one(r.minutesLate > 10)), help: 'Clocked in more than 10 minutes after the rostered start.' },
    { id: 'lateRate', label: 'Late arrival rate', format: 'percent', aggregation: 'sum', ratio: { numerator: 'late', denominator: 'onRota' } },
    { id: 'onRota', label: 'Rostered clock-ins', format: 'number', aggregation: 'sum', value: (r) => one(!!r.shiftId) },
    { id: 'minutesLate', label: 'Average minutes late', format: 'minutes', aggregation: 'average', value: (r) => (r.minutesLate !== null && r.minutesLate > 10 ? r.minutesLate : null) },
    { id: 'unrostered', label: 'Clock-ins with no shift', format: 'number', aggregation: 'sum', value: (r) => one(!r.shiftId) },
    { id: 'breakMinutes', label: 'Break minutes', format: 'minutes', aggregation: 'sum', value: (r) => r.breakMinutes },
    { id: 'people', label: 'People', format: 'number', aggregation: 'distinct', key: (r) => r.employeeId },
  ],
  rows: (env) => {
    const shiftById = new Map(env.org.state.shifts.map((s) => [s.id, s]));
    return env.org.timeEntries
      .filter((t) => inRange(env)(t.date))
      .map((t) => {
        const s = t.shiftId ? shiftById.get(t.shiftId) : undefined;
        return { ...t, minutesLate: s ? t.clockIn - s.startMinute : null };
      });
  },
};

interface NoShowRow {
  date: string;
  siteId: string;
  roleId: string;
  employeeId: string;
  clocked: boolean;
}

const attendance: ReportSource<NoShowRow> = {
  id: 'attendance',
  label: 'Rostered shifts worked',
  area: 'time',
  description: 'Each published shift on a day already past at a site that clocks: whether anyone clocked for it. Shows no-shows.',
  permission: [...TIME_READERS],
  dateLabel: 'Shift date',
  date: (r) => r.date,
  site: (r) => r.siteId,
  dimensions: [
    ...common<NoShowRow>({ site: (r) => r.siteId, role: (r) => r.roleId, person: (r) => r.employeeId }, N),
    { id: 'outcome', label: 'Outcome', value: (r) => (r.clocked ? 'Worked' : 'Not clocked') },
    { id: 'weekday', label: 'Day of the week', value: (r) => weekdayOf(r.date) },
  ],
  measures: [
    { id: 'shifts', label: 'Rostered shifts', format: 'number', aggregation: 'count' },
    { id: 'noShows', label: 'Not clocked', format: 'number', aggregation: 'sum', value: (r) => one(!r.clocked) },
    { id: 'noShowRate', label: 'No-show rate', format: 'percent', aggregation: 'sum', ratio: { numerator: 'noShows', denominator: 'shifts' } },
  ],
  rows: (env) => {
    const clocks = new Set(env.org.timeEntries.map((t) => t.siteId));
    const worked = new Set(env.org.timeEntries.map((t) => `${t.employeeId}|${t.siteId}|${t.date}`));
    return env.org.state.shifts
      .filter((s) => s.published && s.date < env.today && inRange(env)(s.date) && clocks.has(s.siteId))
      .map((s) => ({ date: s.date, siteId: s.siteId, roleId: s.roleId, employeeId: s.employeeId, clocked: worked.has(`${s.employeeId}|${s.siteId}|${s.date}`) }));
  },
};

interface BreakRow {
  date: string;
  siteId: string;
  employeeId: string;
  code: string;
  short: number;
  under18: boolean;
}

const breaks: ReportSource<BreakRow> = {
  id: 'breaks',
  label: 'Break shortfalls',
  area: 'time',
  description: 'Finished shifts where the break taken was under the legal minimum, or split when it should not be.',
  permission: [...TIME_READERS],
  dateLabel: 'Shift date',
  date: (r) => r.date,
  site: (r) => r.siteId,
  dimensions: [
    ...common<BreakRow>({ site: (r) => r.siteId, person: (r) => r.employeeId }, N),
    { id: 'kind', label: 'Shortfall', value: (r) => (r.code === 'split' ? 'Split break' : 'Too short') },
    { id: 'under18', label: 'Age', value: (r) => (r.under18 ? 'Under 18' : '18 and over') },
  ],
  measures: [
    { id: 'shortfalls', label: 'Shortfalls', format: 'number', aggregation: 'count' },
    { id: 'minutesShort', label: 'Minutes short', format: 'minutes', aggregation: 'sum', value: (r) => r.short },
    { id: 'people', label: 'People', format: 'number', aggregation: 'distinct', key: (r) => r.employeeId },
  ],
  rows: (env) => {
    const entries = env.org.timeEntries.filter((t) => inRange(env)(t.date));
    const site = new Map(entries.map((t) => [t.id, t.siteId]));
    return breakShortfalls(entries, env.org.state.employees).map((b) => ({
      date: b.date,
      siteId: site.get(b.entryId) ?? '',
      employeeId: b.employeeId,
      code: b.code,
      short: Math.max(0, b.requiredMinutes - b.takenMinutes),
      under18: b.under18,
    }));
  },
};

// ---------------------------------------------------------------- People

interface PersonRow {
  e: Employee;
  status: string;
  serviceYears: number | null;
  age: number | null;
  bradford: number;
}

const band = (n: number | null, edges: [number, string][], last: string) => (n === null ? 'Not recorded' : edges.find(([max]) => n < max)?.[1] ?? last);
const serviceBand = (years: number | null) => band(years, [[0.25, 'Under 3 months'], [1, '3 to 12 months'], [2, '1 to 2 years'], [5, '2 to 5 years']], '5 years or more');
const ageBand = (age: number | null) => band(age, [[18, 'Under 18'], [21, '18 to 20'], [25, '21 to 24'], [35, '25 to 34'], [50, '35 to 49']], '50 and over');
const yearsBetween = (a: string, b: string) => daysBetween(a, b) / 365.25;

/** Who may see a person's personal details: the same rule as the People screen. */
const PERSONAL = ['team.manage', 'hr.view'] as const;

const people: ReportSource<PersonRow> = {
  id: 'people',
  snapshot: true,
  label: 'People',
  area: 'people',
  description: 'Everyone on the books, with leavers: where they work, contract, length of service, age band and absence score.',
  permission: ['rota.view', 'team.manage'],
  dateLabel: 'Start date',
  date: (r) => r.e.startDate,
  site: (r) => r.e.siteId,
  dimensions: [
    ...common<PersonRow>({ site: (r) => r.e.siteId, role: (r) => r.e.roleIds[0], person: (r) => r.e.id }, N),
    { id: 'status', label: 'Status', value: (r) => r.status },
    { id: 'payBasis', label: 'Pay basis', value: (r) => (r.e.payBasis === 'salaried' ? 'Salaried' : 'Hourly') },
    { id: 'hours', label: 'Hours', value: (r) => (r.e.contractedHours > 0 ? 'Guaranteed hours' : 'Zero or flexible hours') },
    { id: 'service', label: 'Length of service', value: (r) => serviceBand(r.serviceYears) },
    { id: 'contract', label: 'Contract type', value: (r) => ({ permanent: 'Permanent', 'fixed-term': 'Fixed term', casual: 'Casual', apprentice: 'Apprentice' } as Record<string, string>)[r.e.hr?.contractType ?? ''] ?? 'Not recorded', permission: 'hr.view' },
    { id: 'age', label: 'Age band', value: (r) => ageBand(r.age), permission: [...PERSONAL] },
    { id: 'rightToWork', label: 'Right to work', value: (r) => (r.e.rightToWork?.checked ? (r.e.rightToWork.expiry ? 'Checked, time limited' : 'Checked') : 'Not checked'), permission: [...PERSONAL] },
    { id: 'pension', label: 'Pension', value: (r) => (r.e.pensionEnrolled ? 'Enrolled' : 'Not enrolled'), permission: ['costs.view', 'pay.edit'] },
  ],
  measures: [
    { id: 'people', label: 'People', format: 'number', aggregation: 'count' },
    { id: 'current', label: 'Employed now', format: 'number', aggregation: 'sum', value: (r) => one(r.status === 'Employed' || r.status === 'Leaving') },
    { id: 'service', label: 'Average service (years)', format: 'number', aggregation: 'average', value: (r) => (r.serviceYears === null ? null : Math.round(r.serviceYears * 10) / 10) },
    { id: 'contracted', label: 'Contracted hours', format: 'hours', aggregation: 'sum', value: (r) => r.e.contractedHours },
    { id: 'rate', label: 'Average hourly rate', format: 'money', aggregation: 'average', value: (r) => (r.e.payBasis === 'hourly' ? r.e.hourlyRate : null), permission: ['costs.view', 'pay.edit'] },
    { id: 'bradford', label: 'Average Bradford score', format: 'number', aggregation: 'average', value: (r) => r.bradford, permission: 'hr.view', help: 'Sickness and unauthorised absence over 52 weeks: spells squared times days.' },
    { id: 'bradfordReview', label: 'Bradford over 50', format: 'number', aggregation: 'sum', value: (r) => one(r.bradford > 50), permission: 'hr.view' },
  ],
  rows: (env) =>
    env.org.state.employees
      .filter((e) => !e.anonymisedOn)
      .map((e) => {
        const status = ({ starter: 'Starting', active: 'Employed', leaving: 'Leaving', left: 'Left' } as const)[employeeStatus(e, env.today)];
        const end = e.leaveDate && e.leaveDate < env.today ? e.leaveDate : env.today;
        return {
          e,
          status,
          serviceYears: e.startDate && e.startDate <= end ? yearsBetween(e.startDate, end) : null,
          age: e.dateOfBirth ? Math.floor(yearsBetween(e.dateOfBirth, env.today)) : null,
          bradford: bradfordFactor(e, env.today).score,
        };
      }),
};

interface MonthRow {
  month: string;
  e: Employee;
  employed: number;
  started: number;
  left: number;
  earlyLeaver: number;
}

const movements: ReportSource<MonthRow> = {
  id: 'movements',
  label: 'Headcount and turnover',
  area: 'people',
  description: 'Each person for each month they were on the books: headcount at month end, starters, leavers and turnover. Defaults to the last 12 months.',
  permission: [...PERSONAL],
  dateLabel: 'Month',
  date: (r) => r.month,
  site: (r) => r.e.siteId,
  dimensions: [...common<MonthRow>({ site: (r) => r.e.siteId, role: (r) => r.e.roleIds[0] }, N)],
  measures: [
    { id: 'headcount', label: 'Average headcount', format: 'number', aggregation: 'perMonth', value: (r) => r.employed, help: 'People on the books at the end of each month, averaged over the months shown.' },
    { id: 'starters', label: 'Starters', format: 'number', aggregation: 'sum', value: (r) => r.started },
    { id: 'leavers', label: 'Leavers', format: 'number', aggregation: 'sum', value: (r) => r.left },
    { id: 'turnover', label: 'Turnover', format: 'percent', aggregation: 'sum', ratio: { numerator: 'leavers', denominator: 'headcount' }, help: 'Leavers over average headcount, for the period shown. Over 12 months this is the annual rate.' },
    { id: 'earlyLeavers', label: 'Left within 90 days', format: 'number', aggregation: 'sum', value: (r) => r.earlyLeaver, help: 'Leavers who had been with you under 90 days: a hiring and onboarding signal.' },
    { id: 'earlyRate', label: 'Share of leavers within 90 days', format: 'percent', aggregation: 'sum', ratio: { numerator: 'earlyLeavers', denominator: 'leavers' } },
  ],
  rows: (env) => {
    const out: MonthRow[] = [];
    for (const m of monthsBetween(env.from, env.to > env.today ? env.today : env.to)) {
      const monthEnd = addDays(`${addDays(`${m.slice(0, 7)}-28`, 4).slice(0, 7)}-01`, -1);
      const asAt = monthEnd < env.today ? monthEnd : env.today;
      const inMonth = (d?: string) => !!d && d.slice(0, 7) === m.slice(0, 7);
      for (const e of env.org.state.employees) {
        const employed = isEmployedOn(e, asAt) && !(e.leaveDate && e.leaveDate < asAt);
        const started = inMonth(e.startDate);
        const left = inMonth(e.leaveDate) && (!e.startDate || e.leaveDate! >= e.startDate);
        if (!employed && !started && !left) continue;
        out.push({ month: m, e, employed: one(employed), started: one(started), left: one(left), earlyLeaver: one(left && !!e.startDate && daysBetween(e.startDate, e.leaveDate!) < 90) });
      }
    }
    return out;
  },
};

interface AbsenceRow {
  date: string;
  e: Employee;
  type: string;
  days: number;
  fitNote: boolean;
  returnToWork: boolean;
}

const absence: ReportSource<AbsenceRow> = {
  id: 'absence',
  label: 'Absence',
  area: 'people',
  description: 'Each spell of absence: type, days, fit notes and return to work conversations. Types are shown to HR and payroll only, as on their screens.',
  permission: ['hr.view', 'payroll.view', 'pay.edit'],
  dateLabel: 'First day off',
  date: (r) => r.date,
  site: (r) => r.e.siteId,
  dimensions: [
    ...common<AbsenceRow>({ site: (r) => r.e.siteId, role: (r) => r.e.roleIds[0], person: (r) => r.e.id }, N),
    { id: 'type', label: 'Type', value: (r) => r.type },
    { id: 'returnToWork', label: 'Return to work done', value: (r) => (r.returnToWork ? 'Done' : 'Not recorded'), permission: 'hr.view' },
  ],
  measures: [
    { id: 'spells', label: 'Spells', format: 'number', aggregation: 'count' },
    { id: 'days', label: 'Days off', format: 'days', aggregation: 'sum', value: (r) => r.days },
    { id: 'people', label: 'People', format: 'number', aggregation: 'distinct', key: (r) => r.e.id },
    { id: 'avgDays', label: 'Average spell (days)', format: 'days', aggregation: 'average', value: (r) => r.days },
    { id: 'fitNotes', label: 'With a fit note', format: 'number', aggregation: 'sum', value: (r) => one(r.fitNote), permission: 'hr.view' },
    { id: 'rtw', label: 'Return to work done', format: 'number', aggregation: 'sum', value: (r) => one(r.returnToWork), permission: 'hr.view' },
    { id: 'rtwRate', label: 'Return to work rate', format: 'percent', aggregation: 'sum', ratio: { numerator: 'rtw', denominator: 'spells' }, permission: 'hr.view' },
  ],
  rows: (env) =>
    env.org.state.employees.flatMap((e) =>
      (e.absences ?? [])
        .filter((a) => inRange(env)(a.from))
        .map((a) => ({
          date: a.from,
          e,
          type: a.type ? ABSENCE_LABEL[a.type] ?? a.type : 'Not given',
          days: absenceDays(a, env.today),
          fitNote: !!a.fitNote || (a.fitNotes?.length ?? 0) > 0,
          returnToWork: !!a.returnToWorkOn,
        })),
    ),
};

interface TrainingRow {
  e: Employee;
  course: string;
  status: string;
}

const training: ReportSource<TrainingRow> = {
  id: 'training',
  snapshot: true,
  label: 'Training compliance',
  area: 'people',
  description: 'Each course each person needs for their role, and whether it is valid, expiring, expired or missing, as at today.',
  permission: 'hr.view',
  dateLabel: 'Start date',
  date: (r) => r.e.startDate,
  site: (r) => r.e.siteId,
  dimensions: [
    ...common<TrainingRow>({ site: (r) => r.e.siteId, role: (r) => r.e.roleIds[0], person: (r) => r.e.id }, N),
    { id: 'course', label: 'Course', value: (r) => r.course },
    { id: 'status', label: 'Status', value: (r) => r.status },
  ],
  measures: [
    { id: 'required', label: 'Required', format: 'number', aggregation: 'count' },
    { id: 'valid', label: 'Valid', format: 'number', aggregation: 'sum', value: (r) => one(r.status === 'Valid' || r.status === 'Expiring soon') },
    { id: 'compliance', label: 'Compliance', format: 'percent', aggregation: 'sum', ratio: { numerator: 'valid', denominator: 'required' } },
    { id: 'missing', label: 'Missing or expired', format: 'number', aggregation: 'sum', value: (r) => one(r.status === 'Missing' || r.status === 'Expired') },
  ],
  rows: (env) =>
    env.org.state.employees
      .filter((e) => employeeStatus(e, env.today) !== 'left' && !e.anonymisedOn)
      .flatMap((e) =>
        requiredCourses(e, env.org.state.roles).map((c) => ({
          e,
          course: c.name,
          status: ({ valid: 'Valid', expiring: 'Expiring soon', expired: 'Expired', missing: 'Missing' } as const)[trainingStatus(env.org.hrRecords, e.id, c.name, env.today).status],
        })),
      ),
};

interface ReviewRow {
  date: string;
  e: Employee;
  kind: string;
  detail: string;
  outcome?: string;
  open: boolean;
}

const reviews: ReportSource<ReviewRow> = {
  id: 'reviews',
  label: 'Reviews and training records',
  area: 'people',
  description: 'Probation reviews, appraisals, one-to-ones and courses recorded on HR files.',
  permission: 'hr.view',
  dateLabel: 'Date',
  date: (r) => r.date,
  site: (r) => r.e.siteId,
  dimensions: [
    ...common<ReviewRow>({ site: (r) => r.e.siteId, role: (r) => r.e.roleIds[0], person: (r) => r.e.id }, N),
    { id: 'kind', label: 'Record', value: (r) => r.kind },
    { id: 'detail', label: 'Type or course', value: (r) => r.detail },
  ],
  measures: [
    { id: 'records', label: 'Records', format: 'number', aggregation: 'count' },
    { id: 'people', label: 'People', format: 'number', aggregation: 'distinct', key: (r) => r.e.id },
  ],
  rows: (env) =>
    env.org.hrRecords
      .filter((h) => (h.kind === 'review' || h.kind === 'training') && inRange(env)(h.date))
      .flatMap((h) => {
        const e = env.org.state.employees.find((x) => x.id === h.employeeId);
        if (!e) return [];
        return [{ date: h.date, e, kind: h.kind === 'review' ? 'Review' : 'Training', detail: h.kind === 'review' ? ({ probation: 'Probation', appraisal: 'Appraisal', 'one-to-one': 'One-to-one' } as Record<string, string>)[h.reviewType ?? ''] ?? 'Review' : h.title, open: false }];
      }),
};

const cases: ReportSource<ReviewRow> = {
  id: 'cases',
  label: 'Cases',
  area: 'people',
  description: 'Disciplinary, grievance, capability and investigation cases: how many, open or closed, and outcomes. Shown only to people who may see cases.',
  permission: 'hr.cases',
  dateLabel: 'Opened',
  date: (r) => r.date,
  site: (r) => r.e.siteId,
  dimensions: [
    ...common<ReviewRow>({ site: (r) => r.e.siteId, role: (r) => r.e.roleIds[0] }, N),
    { id: 'kind', label: 'Case type', value: (r) => r.kind },
    { id: 'status', label: 'Status', value: (r) => (r.open ? 'Open' : 'Closed') },
    { id: 'outcome', label: 'Outcome', value: (r) => r.outcome ?? 'None yet' },
  ],
  measures: [
    { id: 'cases', label: 'Cases', format: 'number', aggregation: 'count' },
    { id: 'open', label: 'Open', format: 'number', aggregation: 'sum', value: (r) => one(r.open) },
  ],
  rows: (env) =>
    env.org.hrRecords
      .filter((h) => h.kind === 'case' && inRange(env)(h.date))
      .flatMap((h) => {
        const e = env.org.state.employees.find((x) => x.id === h.employeeId);
        // Never the cases of the person running the report: the same rule as the HR file.
        if (!e || (env.g.user?.employeeId && env.g.user.employeeId === e.id)) return [];
        const kind = ({ investigation: 'Investigation', disciplinary: 'Disciplinary', grievance: 'Grievance', capability: 'Capability' } as Record<string, string>)[h.caseType ?? ''] ?? 'Case';
        return [{ date: h.date, e, kind, detail: kind, outcome: h.outcome, open: h.caseStatus !== 'closed' }];
      }),
};

interface HolidayRow {
  e: Employee;
  b: ReturnType<typeof balanceOf>;
}

const holiday: ReportSource<HolidayRow> = {
  id: 'holiday',
  snapshot: true,
  label: 'Holiday balances',
  area: 'people',
  description: 'Each current person’s leave year: entitlement, taken, booked and remaining hours, and the untaken holiday as a liability.',
  permission: [...PERSONAL],
  dateLabel: 'Start date',
  date: (r) => r.e.startDate,
  site: (r) => r.e.siteId,
  dimensions: [
    ...common<HolidayRow>({ site: (r) => r.e.siteId, role: (r) => r.e.roleIds[0], person: (r) => r.e.id }, N),
    { id: 'basis', label: 'Basis', value: (r) => (r.b.basis === 'accrual' ? 'Accrues on hours worked' : 'Fixed entitlement') },
  ],
  measures: [
    { id: 'people', label: 'People', format: 'number', aggregation: 'count' },
    { id: 'entitlement', label: 'Entitlement', format: 'hours', aggregation: 'sum', value: (r) => r.b.entitlementHours },
    { id: 'taken', label: 'Taken', format: 'hours', aggregation: 'sum', value: (r) => r.b.takenHours },
    { id: 'booked', label: 'Booked', format: 'hours', aggregation: 'sum', value: (r) => r.b.bookedHours },
    { id: 'remaining', label: 'Remaining', format: 'hours', aggregation: 'sum', value: (r) => r.b.remainingHours },
    { id: 'liability', label: 'Holiday pay provision', format: 'money', aggregation: 'sum', value: (r) => r.b.liabilityWithNi, permission: ['costs.view', 'payroll.view'], help: 'Untaken holiday at each person’s holiday rate, with employer NI.' },
  ],
  rows: (env) =>
    env.org.state.employees
      .filter((e) => { const s = employeeStatus(e, env.today); return s === 'active' || s === 'leaving'; })
      .map((e) => ({ e, b: balanceOf(env.org, e, env.today) })),
};

interface OnboardingRow {
  e: Employee;
  done: number;
  total: number;
  late: number;
  blocked: boolean;
  complete: boolean;
}

const onboarding: ReportSource<OnboardingRow> = {
  id: 'onboarding',
  snapshot: true,
  label: 'Onboarding',
  area: 'people',
  description: 'Everyone starting in the next 60 days or who started in the last 90: steps done, late and blocking.',
  permission: [...PERSONAL],
  dateLabel: 'Start date',
  date: (r) => r.e.startDate,
  site: (r) => r.e.siteId,
  dimensions: [
    ...common<OnboardingRow>({ site: (r) => r.e.siteId, role: (r) => r.e.roleIds[0], person: (r) => r.e.id }, N),
    { id: 'state', label: 'State', value: (r) => (r.complete ? 'Complete' : r.blocked ? 'Blocked' : r.late ? 'Steps late' : 'On track') },
  ],
  measures: [
    { id: 'starters', label: 'Starters', format: 'number', aggregation: 'count' },
    { id: 'complete', label: 'Complete', format: 'number', aggregation: 'sum', value: (r) => one(r.complete) },
    { id: 'blocked', label: 'Blocked', format: 'number', aggregation: 'sum', value: (r) => one(r.blocked) },
    { id: 'lateSteps', label: 'Steps late', format: 'number', aggregation: 'sum', value: (r) => r.late },
    { id: 'progress', label: 'Steps done', format: 'percent', aggregation: 'sum', ratio: { numerator: 'stepsDone', denominator: 'steps' } },
    { id: 'stepsDone', label: 'Steps done (count)', format: 'number', aggregation: 'sum', value: (r) => r.done },
    { id: 'steps', label: 'Steps (count)', format: 'number', aggregation: 'sum', value: (r) => r.total },
  ],
  rows: (env) =>
    onboardingList(env.org.state.employees, env.org.hrRecords, env.org.state.roles, env.today, (e) => ({ hr: env.g.can('hr.view', e.siteId), pay: env.g.can('costs.view', e.siteId) })).map(
      (o) => ({ e: o.employee, done: o.done, total: o.total, late: o.late, blocked: !!o.blocked, complete: o.complete }),
    ),
};

type RequestRow = NonNullable<OrgData['requests']>[number] & { hoursToDecide: number | null };

const REQUEST_KIND: Record<string, string> = { holiday: 'Holiday', time_off: 'Time off', sickness: 'Sickness', availability: 'Availability', swap: 'Swap', open_shift: 'Open shift' };

const requests: ReportSource<RequestRow> = {
  id: 'requests',
  label: 'Staff requests',
  area: 'people',
  description: 'Holiday, time off, sickness, availability, swaps and open shift claims from the staff app: how many, decided how, and how fast. Each kind is shown to the role that decides it.',
  permission: ['rota.publish', 'team.manage', 'hr.manage'],
  dateLabel: 'Asked',
  date: (r) => r.createdAt.slice(0, 10),
  site: (r) => r.siteId,
  dimensions: [
    ...common<RequestRow>({ site: (r) => r.siteId, person: (r) => r.employeeId }, N),
    { id: 'kind', label: 'Request', value: (r) => REQUEST_KIND[r.kind] ?? r.kind },
    { id: 'status', label: 'Status', value: (r) => ({ pending: 'Waiting', accepted: 'Accepted', approved: 'Approved', declined: 'Declined', cancelled: 'Cancelled' })[r.status] },
    { id: 'decidedBy', label: 'Decided by', value: (r) => r.decidedBy ?? 'Not decided' },
  ],
  measures: [
    { id: 'requests', label: 'Requests', format: 'number', aggregation: 'count' },
    { id: 'approved', label: 'Approved', format: 'number', aggregation: 'sum', value: (r) => one(r.status === 'approved' || r.status === 'accepted') },
    { id: 'declined', label: 'Declined', format: 'number', aggregation: 'sum', value: (r) => one(r.status === 'declined') },
    { id: 'decided', label: 'Decided', format: 'number', aggregation: 'sum', value: (r) => one(r.status === 'approved' || r.status === 'accepted' || r.status === 'declined') },
    { id: 'approvalRate', label: 'Approval rate', format: 'percent', aggregation: 'sum', ratio: { numerator: 'approved', denominator: 'decided' } },
    { id: 'waiting', label: 'Waiting', format: 'number', aggregation: 'sum', value: (r) => one(r.status === 'pending') },
    { id: 'hoursToDecide', label: 'Average hours to decide', format: 'hours', aggregation: 'average', value: (r) => r.hoursToDecide, help: 'From asking to the manager’s decision, for decided requests.' },
  ],
  rows: (env) =>
    (env.org.requests ?? [])
      .filter((r) => inRange(env)(r.createdAt.slice(0, 10)) && env.g.can(authority(r.kind).permission, r.siteId))
      .map((r) => ({ ...r, hoursToDecide: r.decidedAt ? Math.round(((Date.parse(r.decidedAt) - Date.parse(r.createdAt)) / 3_600_000) * 10) / 10 : null })),
};

interface RecognitionRow {
  date: string;
  siteId: string;
  employeeId: string;
  category: string;
  points: number;
}

const recognition: ReportSource<RecognitionRow> = {
  id: 'recognition',
  label: 'Recognition',
  area: 'people',
  description: 'Thank-yous and points given to the team, by site, category and month.',
  permission: [...PERSONAL],
  dateLabel: 'Given',
  date: (r) => r.date,
  site: (r) => r.siteId,
  dimensions: [
    ...common<RecognitionRow>({ site: (r) => r.siteId, person: (r) => r.employeeId }, N),
    { id: 'category', label: 'Category', value: (r) => r.category },
  ],
  measures: [
    { id: 'recognitions', label: 'Recognitions', format: 'number', aggregation: 'count' },
    { id: 'points', label: 'Points', format: 'number', aggregation: 'sum', value: (r) => r.points },
    { id: 'people', label: 'People recognised', format: 'number', aggregation: 'distinct', key: (r) => r.employeeId },
  ],
  rows: (env) =>
    (env.org.welfare?.recognitions ?? [])
      .map((r) => ({ date: r.at.slice(0, 10), siteId: r.siteId, employeeId: r.employeeId, category: r.category, points: r.points }))
      .filter((r) => inRange(env)(r.date)),
};

// ---------------------------------------------------------------- Labour and sales

const labour: ReportSource<ReturnType<typeof metricsFor>[number]> = {
  id: 'labour',
  defaultRange: 'last-13-weeks',
  label: 'Labour and sales by week',
  area: 'labour',
  description: 'Each site’s week: sales (takings where the till has them, else forecast), rota labour cost, labour % against target, paid hours and sales per labour hour. Up to 53 weeks at a time.',
  permission: 'costs.view',
  dateLabel: 'Week commencing',
  date: (r) => r.week,
  site: (r) => r.siteId,
  dimensions: [...common<ReturnType<typeof metricsFor>[number]>({ site: (r) => r.siteId }, N)],
  measures: [
    { id: 'forecast', label: 'Forecast sales', format: 'money', aggregation: 'sum', value: (r) => r.forecastSales },
    { id: 'sales', label: 'Sales', format: 'money', aggregation: 'sum', value: (r) => r.sales, help: 'Takings where recorded, the forecast for days without.' },
    { id: 'labour', label: 'Labour cost', format: 'money', aggregation: 'sum', value: (r) => r.labourCost },
    { id: 'labourPct', label: 'Labour %', format: 'percent', aggregation: 'sum', ratio: { numerator: 'labour', denominator: 'sales' } },
    { id: 'target', label: 'Target spend', format: 'money', aggregation: 'sum', value: (r) => r.targetCost },
    { id: 'variance', label: 'Over target', format: 'money', aggregation: 'sum', value: (r) => r.labourCost - r.targetCost },
    { id: 'hours', label: 'Paid hours', format: 'hours', aggregation: 'sum', value: (r) => r.paidHours },
    { id: 'splh', label: 'Sales per labour hour', format: 'money', aggregation: 'sum', ratio: { numerator: 'sales', denominator: 'hours' } },
  ],
  rows: (env) => metricsFor(env.org.state, weeksIn(env, 53), env.today),
};

interface TakingsRow {
  date: string;
  siteId: string;
  netSales: number;
  covers?: number;
  orders?: number;
  source: string;
  forecast: number;
}

const takings: ReportSource<TakingsRow> = {
  id: 'takings',
  label: 'Takings and forecast accuracy',
  area: 'labour',
  description: 'Each trading day with takings: net sales, covers, orders, spend per head and how far the forecast was out.',
  permission: 'rota.view',
  dateLabel: 'Trading day',
  date: (r) => r.date,
  site: (r) => r.siteId,
  dimensions: [
    ...common<TakingsRow>({ site: (r) => r.siteId }, N),
    { id: 'weekday', label: 'Day of the week', value: (r) => weekdayOf(r.date) },
    { id: 'source', label: 'Source', value: (r) => ({ till: 'From the till', manual: 'Keyed in', import: 'Imported' } as Record<string, string>)[r.source] ?? r.source },
  ],
  measures: [
    { id: 'days', label: 'Trading days', format: 'number', aggregation: 'count' },
    { id: 'sales', label: 'Net sales', format: 'money', aggregation: 'sum', value: (r) => r.netSales },
    { id: 'covers', label: 'Covers', format: 'number', aggregation: 'sum', value: (r) => r.covers ?? 0 },
    { id: 'spend', label: 'Spend per head', format: 'money', aggregation: 'sum', ratio: { numerator: 'coveredSales', denominator: 'covers' } },
    { id: 'coveredSales', label: 'Sales on days with covers', format: 'money', aggregation: 'sum', value: (r) => (r.covers ? r.netSales : 0) },
    { id: 'orders', label: 'Orders', format: 'number', aggregation: 'sum', value: (r) => r.orders ?? 0 },
    { id: 'forecast', label: 'Forecast', format: 'money', aggregation: 'sum', value: (r) => r.forecast },
    { id: 'error', label: 'Forecast error', format: 'money', aggregation: 'sum', value: (r) => Math.abs(r.forecast - r.netSales), help: 'How far out each day was, either way.' },
    { id: 'errorRate', label: 'Forecast error rate', format: 'percent', aggregation: 'sum', ratio: { numerator: 'error', denominator: 'sales' }, help: 'Total error over total sales (WAPE): lower is better.' },
    { id: 'bias', label: 'Forecast over or under', format: 'percent', aggregation: 'sum', ratio: { numerator: 'difference', denominator: 'sales' }, help: 'Positive means the forecast ran high.' },
    { id: 'difference', label: 'Forecast less sales', format: 'money', aggregation: 'sum', value: (r) => r.forecast - r.netSales },
  ],
  rows: (env) => {
    const forecast = new Map<string, number>();
    for (const f of env.org.state.forecast) forecast.set(`${f.siteId}|${f.date}`, (forecast.get(`${f.siteId}|${f.date}`) ?? 0) + f.sales);
    return (env.org.state.sales ?? [])
      .filter((s) => inRange(env)(s.date) && s.netSales > 0)
      .map((s) => ({ date: s.date, siteId: s.siteId, netSales: s.netSales, covers: s.covers, orders: s.orders, source: s.source, forecast: forecast.get(`${s.siteId}|${s.date}`) ?? 0 }));
  },
};

const coach: ReportSource<OrgData['moves'][number]> = {
  id: 'coach',
  label: 'Coach moves',
  area: 'labour',
  description: 'Changes the rota coach suggested: offered, taken or turned down, and the saving each was worth.',
  permission: 'costs.view',
  dateLabel: 'Week commencing',
  date: (r) => r.weekStart,
  site: (r) => r.siteId,
  dimensions: [
    ...common<OrgData['moves'][number]>({ site: (r) => r.siteId }, N),
    { id: 'kind', label: 'Move', value: (r) => ({ 'trim-start': 'Start later', 'trim-end': 'Finish earlier', drop: 'Drop a shift', swap: 'Swap people' } as Record<string, string>)[r.kind] ?? r.kind },
    { id: 'status', label: 'Status', value: (r) => ({ offered: 'Offered', taken: 'Taken', dismissed: 'Turned down' } as Record<string, string>)[r.status] ?? r.status },
  ],
  measures: [
    { id: 'moves', label: 'Moves offered', format: 'number', aggregation: 'count' },
    { id: 'taken', label: 'Taken', format: 'number', aggregation: 'sum', value: (r) => one(r.status === 'taken') },
    { id: 'takenRate', label: 'Take-up', format: 'percent', aggregation: 'sum', ratio: { numerator: 'taken', denominator: 'moves' } },
    { id: 'saving', label: 'Saving offered', format: 'money', aggregation: 'sum', value: (r) => r.expectedSaving },
    { id: 'savingTaken', label: 'Saving taken', format: 'money', aggregation: 'sum', value: (r) => (r.status === 'taken' ? r.expectedSaving : 0) },
  ],
  rows: (env) => env.org.moves.filter((m) => inRange(env)(m.weekStart)),
};

// ---------------------------------------------------------------- Payroll and pay

type PayChangeRow = OrgData['payChanges'][number] & { change: number | null };

const payChanges: ReportSource<PayChangeRow> = {
  id: 'payChanges',
  label: 'Pay changes',
  area: 'payroll',
  description: 'Every pay change asked for: approved, rejected or waiting, and the size of the rise.',
  permission: ['pay.edit', 'pay.approve'],
  dateLabel: 'Asked',
  date: (r) => r.requestedAt.slice(0, 10),
  site: (r) => r.siteId,
  dimensions: [
    ...common<PayChangeRow>({ site: (r) => r.siteId, person: (r) => r.employeeId }, N),
    { id: 'status', label: 'Status', value: (r) => ({ pending: 'Waiting', approved: 'Approved', rejected: 'Rejected', withdrawn: 'Withdrawn', superseded: 'Replaced' } as Record<string, string>)[r.status] ?? r.status },
    { id: 'requestedBy', label: 'Asked by', value: (r) => r.requestedBy },
  ],
  measures: [
    { id: 'changes', label: 'Changes', format: 'number', aggregation: 'count' },
    { id: 'approved', label: 'Approved', format: 'number', aggregation: 'sum', value: (r) => one(r.status === 'approved') },
    { id: 'avgRise', label: 'Average rise', format: 'percent', aggregation: 'average', value: (r) => r.change, help: 'Change in hourly rate or salary, as a share of what it was.' },
  ],
  rows: (env) =>
    env.org.payChanges
      .filter((c) => inRange(env)(c.requestedAt.slice(0, 10)))
      .map((c) => {
        const before = c.before.payBasis === 'salaried' ? c.before.annualSalary : c.before.hourlyRate;
        const after = c.after.payBasis === 'salaried' ? c.after.annualSalary : c.after.hourlyRate;
        return { ...c, change: c.before.payBasis === c.after.payBasis && before > 0 ? Math.round(((after - before) / before) * 10000) / 10000 : null };
      }),
};

interface PayRunRow {
  date: string;
  entityId?: string;
  accrued: number;
  actual: number;
  inside: boolean;
}

const payRuns: ReportSource<PayRunRow> = {
  id: 'payRuns',
  label: 'Pay runs against the accrual',
  area: 'payroll',
  description: 'Each pay run back from payroll against the week-end accrual: accrued, actual, variance and whether it was inside 1%. Only companies whose payroll you may read in full.',
  permission: 'payroll.view',
  dateLabel: 'Pay period start',
  date: (r) => r.date,
  site: () => undefined,
  dimensions: [{ id: 'company', label: 'Company', value: (r) => (r.entityId ? org.state.entities.find((e) => e.id === r.entityId)?.name ?? r.entityId : 'Main company') }],
  measures: [
    { id: 'runs', label: 'Pay runs', format: 'number', aggregation: 'count' },
    { id: 'accrued', label: 'Accrued', format: 'money', aggregation: 'sum', value: (r) => r.accrued },
    { id: 'actual', label: 'Payroll actual', format: 'money', aggregation: 'sum', value: (r) => r.actual },
    { id: 'variance', label: 'Variance', format: 'money', aggregation: 'sum', value: (r) => r.actual - r.accrued },
    { id: 'inside', label: 'Inside 1%', format: 'number', aggregation: 'sum', value: (r) => one(r.inside) },
    { id: 'insideRate', label: 'Share inside 1%', format: 'percent', aggregation: 'sum', ratio: { numerator: 'inside', denominator: 'runs' } },
  ],
  rows: (env) => {
    const reach = env.g.sites('payroll.view');
    const whole = (entityId?: string) => {
      if (reach === 'all') return true;
      const sites = env.org.state.sites.filter((s) => s.entityId === entityId);
      return !!entityId && sites.length > 0 && sites.every((s) => reach.has(s.id));
    };
    return env.org.payRuns
      .filter((r) => whole(r.entityId) && inRange(env)(r.periodStart))
      .map((r) => ({ date: r.periodStart, entityId: r.entityId, accrued: r.variance.accrued, actual: r.variance.actual, inside: Math.abs(r.variance.variancePct) <= 0.01 }));
  },
};

// ---------------------------------------------------------------- Guests

const bookings: ReportSource<NonNullable<OrgData['state']['bookings']>[number]> = {
  id: 'bookings',
  label: 'Bookings',
  area: 'guests',
  description: 'Bookings from the booking system: covers, cancellations and no-shows by site, day and source.',
  permission: 'rota.view',
  dateLabel: 'Booking date',
  date: (r) => r.date,
  site: (r) => r.siteId,
  dimensions: [
    ...common<NonNullable<OrgData['state']['bookings']>[number]>({ site: (r) => r.siteId }, N),
    { id: 'status', label: 'Status', value: (r) => ({ booked: 'Booked', cancelled: 'Cancelled', no_show: 'No-show', completed: 'Seated' } as Record<string, string>)[r.status] ?? r.status },
    { id: 'source', label: 'Source', value: (r) => r.source },
    { id: 'weekday', label: 'Day of the week', value: (r) => weekdayOf(r.date) },
  ],
  measures: [
    { id: 'bookings', label: 'Bookings', format: 'number', aggregation: 'count' },
    { id: 'covers', label: 'Covers booked', format: 'number', aggregation: 'sum', value: (r) => (r.status === 'cancelled' ? 0 : r.covers) },
    { id: 'noShows', label: 'No-shows', format: 'number', aggregation: 'sum', value: (r) => one(r.status === 'no_show') },
    { id: 'noShowRate', label: 'No-show rate', format: 'percent', aggregation: 'sum', ratio: { numerator: 'noShows', denominator: 'bookings' } },
    { id: 'cancelled', label: 'Cancelled', format: 'number', aggregation: 'sum', value: (r) => one(r.status === 'cancelled') },
  ],
  rows: (env) => (env.org.state.bookings ?? []).filter((b) => inRange(env)(b.date)),
};

// ---------------------------------------------------------------- Access and organisation

interface UserRow {
  date: string;
  status: string;
  audience: string;
  role: string;
  mfa: boolean;
  lastSeenDays: number | null;
}

const access: ReportSource<UserRow> = {
  id: 'access',
  snapshot: true,
  label: 'People with access',
  area: 'organisation',
  description: 'Everyone who can sign in to Preshift: status, role, authenticator and how recently they were seen. For whoever manages access for the whole organisation.',
  permission: ['users.manage', 'audit.view'],
  dateLabel: 'Added',
  date: (r) => r.date,
  site: () => undefined,
  dimensions: [
    { id: 'status', label: 'Status', value: (r) => r.status },
    { id: 'audience', label: 'Kind', value: (r) => r.audience },
    { id: 'role', label: 'Role', value: (r) => r.role },
    { id: 'mfa', label: 'Authenticator', value: (r) => (r.mfa ? 'Set up' : 'Not set up') },
    { id: 'seen', label: 'Last seen', value: (r) => (r.lastSeenDays === null ? 'Never' : r.lastSeenDays <= 7 ? 'This week' : r.lastSeenDays <= 30 ? 'This month' : r.lastSeenDays <= 90 ? '1 to 3 months ago' : 'Over 3 months ago') },
  ],
  measures: [
    { id: 'people', label: 'People', format: 'number', aggregation: 'count' },
    { id: 'noMfa', label: 'Without an authenticator', format: 'number', aggregation: 'sum', value: (r) => one(!r.mfa && r.status === 'Active') },
    { id: 'dormant', label: 'Not seen in 90 days', format: 'number', aggregation: 'sum', value: (r) => one(r.status === 'Active' && (r.lastSeenDays === null || r.lastSeenDays > 90)) },
  ],
  rows: (env) => {
    const user = env.g.user;
    // The whole organisation's access, so the whole organisation's authority: as the Access screen.
    if (user && !canOrgWide(user, 'users.manage', env.today) && !canOrgWide(user, 'audit.view', env.today)) return [];
    return env.org.users.map((u) => ({
      date: (u.createdAt ?? env.today).slice(0, 10),
      status: ({ invited: 'Invited', active: 'Active', suspended: 'Suspended' } as Record<string, string>)[u.status] ?? u.status,
      audience: ({ operator: 'Operator', ws: 'Williams, Stanley & Co.', external: 'External' } as Record<string, string>)[u.audience] ?? u.audience,
      role: ROLES.find((r) => r.id === u.memberships.find((m) => m.active)?.roleId)?.name ?? 'No role',
      mfa: u.mfaEnrolled,
      lastSeenDays: u.lastSeenAt ? daysBetween(u.lastSeenAt.slice(0, 10), env.today) : null,
    }));
  },
};

interface TicketRow {
  date: string;
  kind: string;
  status: string;
  severity?: string;
  hoursToRespond: number | null;
}

const support: ReportSource<TicketRow> = {
  id: 'support',
  label: 'Support requests',
  area: 'organisation',
  description: 'Questions, problems and ideas raised with support: how many, how serious, and how fast they were answered.',
  permission: ['rota.view', 'team.manage', 'hr.view', 'payroll.view', 'settings.manage'],
  dateLabel: 'Raised',
  date: (r) => r.date,
  site: () => undefined,
  dimensions: [
    { id: 'kind', label: 'Kind', value: (r) => ({ question: 'Question', bug: 'Problem', feature: 'Idea' } as Record<string, string>)[r.kind] ?? r.kind },
    { id: 'status', label: 'Status', value: (r) => r.status },
    { id: 'severity', label: 'Severity', value: (r) => r.severity ?? 'Not set' },
  ],
  measures: [
    { id: 'tickets', label: 'Requests', format: 'number', aggregation: 'count' },
    { id: 'hoursToRespond', label: 'Average hours to first answer', format: 'hours', aggregation: 'average', value: (r) => r.hoursToRespond },
  ],
  rows: (env) =>
    (env.org.support?.tickets ?? [])
      .map((t) => ({
        date: t.raisedAt.slice(0, 10),
        kind: t.kind,
        status: t.status,
        severity: t.severity,
        hoursToRespond: t.firstResponseAt ? Math.round(((Date.parse(t.firstResponseAt) - Date.parse(t.raisedAt)) / 3_600_000) * 10) / 10 : null,
      }))
      .filter((r) => inRange(env)(r.date)),
};

// ---------------------------------------------------------------- The catalogue

  return [
    people, movements, absence, training, holiday, onboarding, requests, reviews, cases, recognition,
    time, attendance, breaks,
    shifts, compliance, overrides, openShifts,
    labour, takings, coach,
    payChanges, payRuns,
    bookings,
    access, support,
  ];
}

/** Every dimension of a dataset as the builder offers it, the time ones first. */
export const dimensionsOf = <R>(ds: Dataset<R>) => [...timeDimensions(ds.date), ...ds.dimensions];
export type { Measure };
export { weekDates };
