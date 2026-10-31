import { breakFor, checkEmployeeWeek, checkWeek, complianceOptions } from '../engine/compliance';
import { shiftPaidHours } from '../engine/cost';
import { employeeStatus, isEmployedOn, newEmployee } from '../engine/employees';
import { holidayBalance, workedShifts } from '../engine/holiday';
import { isAbsentOn } from '../engine/hr';
import { weekMetrics } from '../engine/metrics';
import { hasStarted, type LondonNow } from '../engine/rotaWeek';
import { entriesAsShifts } from '../engine/timesheet';
import { addDays, ageOn, formatMinute, parseClock, weekDates, weekStart } from '../engine/time';
import type { Absence, AbsenceType, Employee, RotaState, Shift, TimeEntry } from '../engine/types';
import { minimumWageFor } from '../engine/ukRates';
import type { ToolDefinition } from './rotaTools';
import { defaultRounds, goingCandidates, MAX_NOTE, MAX_ROUND_SIZE, minutesUntil, ROUND_MINUTES, roundOf } from '../engine/cover';

/**
 * Tools for Shifty, the chat that takes both questions and things to do. Lookups read the app's own data. Anything that
 * would change a record is only ever a proposal: the manager sees it as a card and confirms it, and
 * it is then carried out through the same actions and API checks as the screens. Personal data the
 * task does not need (NI numbers, addresses, absence reasons, HR notes) is never given to the model.
 */

// Kept in step with Tab in src/ui/nav.ts; appTools.test.ts checks they match.
export const SCREENS = [
  'sites', 'rota', 'coach', 'forecast', 'calendar', 'programme', 'clock', 'demand', 'team', 'people', 'holiday', 'payroll', 'periods', 'pay', 'close', 'reports', 'hr', 'absence',
  'training', 'reviews', 'cases', 'setup', 'integrations', 'privacy', 'access', 'settings', 'profile', 'howto', 'support', 'onboarding', 'welfare', 'clients', 'customers', 'billing', 'requests', 'adoption', 'cash',
  'cutcall', 'actuals', 'tronc', 'prime', 'risk', 'retention', 'messages', 'rights', 'features',
] as const;
export type Screen = (typeof SCREENS)[number];

/** Said on any card that sets pay: a person's pay change waits for the finance director. */
export const PAY_APPROVAL = 'The pay goes to the finance director for approval. Until it is approved their current pay stays in force (nought for a starter).';

export const ABSENCE_TYPES: AbsenceType[] = ['sickness', 'unauthorised', 'compassionate', 'dependants', 'family', 'unpaid', 'other'];

export interface AppToolContext {
  state: RotaState;
  /** The sites in view and the week on screen, so "this week" and "here" mean what the manager sees. */
  siteIds: string[];
  week: string;
  now: LondonNow;
  /** Clock records, loaded on first use for holiday balances. */
  loadEntries: () => Promise<TimeEntry[]>;
  /** The organisation has switched off AI rota writing, so there is no rota assistant to hand over to. */
  rotaAiOff?: boolean;
}

interface Detail {
  label: string;
  value: string;
}

/** A change the manager is asked to confirm. Nothing happens until they do. */
export type Proposal = { id: string; summary: string; details: Detail[]; warnings: string[] } & (
  | { kind: 'add_starter'; employee: Employee }
  | { kind: 'update_person'; employee: Employee }
  | { kind: 'mark_leaver'; employeeId: string; leaveDate: string }
  | { kind: 'book_leave'; employee: Employee; dates: string[] }
  | { kind: 'record_absence'; employeeId: string; absence: Absence }
  | { kind: 'add_shift'; shift: Shift }
  | { kind: 'remove_shift'; shiftId: string }
  | { kind: 'publish_week'; siteIds: string[]; weekStart: string }
  | { kind: 'ask_cover'; shiftId: string; employeeIds: string[]; note: string | null; firstToAccept: boolean; urgent: boolean; rounds: { size: number; everyMinutes: number } | null; keepUntilTaken: boolean }
  | { kind: 'draft_rota'; instruction: string }
  | { kind: 'go_to'; screen: Screen }
);

export interface AppToolOutcome {
  result: unknown;
  label: string;
  isError?: boolean;
  proposal?: Proposal;
}

const NULLABLE_STRING = { type: ['string', 'null'] };
const NULLABLE_NUMBER = { type: ['number', 'null'] };
const DATE = { type: 'string', description: 'ISO date, YYYY-MM-DD.' };
const CLOCK = '^([01][0-9]|2[0-3]):[0-5][0-9]$';
const object = (properties: Record<string, unknown>) => ({
  type: 'object' as const,
  properties,
  required: Object.keys(properties),
  additionalProperties: false as const,
});

export const APP_TOOLS: ToolDefinition[] = [
  {
    name: 'find_people',
    description:
      'Finds people by name or part of a name, at one site or all of them. Returns id, name, home site, employer, roles, ' +
      'pay, contracted hours and status (starter, active, leaving, left). Leavers are left out unless asked for.',
    input_schema: object({
      query: { ...NULLABLE_STRING, description: 'Name or part of one; null for everyone.' },
      site_id: { ...NULLABLE_STRING, description: 'A site id; null for every site.' },
      include_leavers: { type: 'boolean' },
    }),
  },
  {
    name: 'get_person',
    description:
      "One person's rota and employment record: roles, pay, hours, age, start and leave dates, right to work, " +
      'availability, cover sites, rota notes, leave and the days they are off. Never includes HR file details.',
    input_schema: object({ employee_id: { type: 'string' } }),
  },
  {
    name: 'week_overview',
    description:
      'Forecast sales, labour cost, labour % against target, paid hours and compliance issues for a week, at one site or ' +
      'every site in view. Use the week on screen unless the manager names another.',
    input_schema: object({ site_id: NULLABLE_STRING, week_start: { ...NULLABLE_STRING, description: 'Monday of the week; null for the week on screen.' } }),
  },
  {
    name: 'list_shifts',
    description: 'Shifts in a week, filtered by site, day and person. Each has an id, needed to remove it.',
    input_schema: object({ site_id: NULLABLE_STRING, date: NULLABLE_STRING, employee_id: NULLABLE_STRING, week_start: NULLABLE_STRING }),
  },
  {
    name: 'holiday_balance',
    description: "A person's holiday this leave year in hours: entitlement, taken, booked and remaining, and when the year ends.",
    input_schema: object({ employee_id: { type: 'string' } }),
  },
  {
    name: 'propose_add_starter',
    description:
      'Proposes adding a new starter, for the manager to confirm. Needs name, home site, at least one role, start date, ' +
      'date of birth and pay. Ask for anything missing rather than guessing. They are set up with no right to work check ' +
      'on file, so they cannot be rostered until one is recorded in People.',
    input_schema: object({
      name: { type: 'string' },
      site_id: { type: 'string' },
      role_ids: { type: 'array', items: { type: 'string' }, description: 'First is their primary role.' },
      start_date: DATE,
      date_of_birth: DATE,
      pay_basis: { type: 'string', enum: ['hourly', 'salaried'] },
      hourly_rate: { ...NULLABLE_NUMBER, description: 'Pounds an hour, for hourly staff.' },
      annual_salary: { ...NULLABLE_NUMBER, description: 'Pounds a year, for salaried staff.' },
      contracted_hours: { ...NULLABLE_NUMBER, description: 'Guaranteed hours a week; null or 0 for none.' },
      email: NULLABLE_STRING,
      phone: NULLABLE_STRING,
    }),
  },
  {
    name: 'propose_update_person',
    description: "Proposes changing parts of someone's record, for the manager to confirm. Pass null for anything that stays the same.",
    input_schema: object({
      employee_id: { type: 'string' },
      hourly_rate: NULLABLE_NUMBER,
      annual_salary: NULLABLE_NUMBER,
      contracted_hours: NULLABLE_NUMBER,
      max_weekly_hours: NULLABLE_NUMBER,
      role_ids: { type: ['array', 'null'], items: { type: 'string' } },
      cover_site_ids: { type: ['array', 'null'], items: { type: 'string' }, description: 'Other sites they will cover.' },
      email: NULLABLE_STRING,
      phone: NULLABLE_STRING,
      rota_notes: NULLABLE_STRING,
    }),
  },
  {
    name: 'propose_leaver',
    description: 'Proposes marking someone as a leaver from a last day of employment, for the manager to confirm. Their later shifts are removed.',
    input_schema: object({ employee_id: { type: 'string' }, leave_date: DATE }),
  },
  {
    name: 'propose_leave',
    description: 'Proposes booking approved holiday on given days, for the manager to confirm.',
    input_schema: object({ employee_id: { type: 'string' }, dates: { type: 'array', items: DATE } }),
  },
  {
    name: 'propose_absence',
    description: 'Proposes recording sickness or another absence, for the manager to confirm. Leave the end date null while they are still off.',
    input_schema: object({
      employee_id: { type: 'string' },
      type: { type: 'string', enum: ABSENCE_TYPES },
      from: DATE,
      to: NULLABLE_STRING,
      reason: { ...NULLABLE_STRING, description: 'Only what the manager said; never ask for medical detail.' },
    }),
  },
  {
    name: 'propose_add_shift',
    description: 'Proposes one shift, for the manager to confirm. Refused here if it has started or breaks a blocking rule.',
    input_schema: object({
      employee_id: { type: 'string' },
      site_id: { type: 'string' },
      role_id: { type: 'string' },
      date: DATE,
      start: { type: 'string', pattern: CLOCK },
      end: { type: 'string', pattern: CLOCK, description: 'A time at or before the start runs past midnight.' },
    }),
  },
  {
    name: 'propose_remove_shift',
    description: 'Proposes removing one shift by id (from list_shifts), for the manager to confirm. Shifts that have started stay.',
    input_schema: object({ shift_id: { type: 'string' } }),
  },
  {
    name: 'propose_publish',
    description: "Proposes publishing a week's rota to staff phones, for the manager to confirm. Refused while there are blocking issues.",
    input_schema: object({ site_ids: { type: ['array', 'null'], items: { type: 'string' } }, week_start: NULLABLE_STRING }),
  },
  {
    name: 'propose_ask_cover',
    description:
      'Proposes asking for cover for one shift by id (from list_shifts), when its person cannot work it, for the manager to confirm. ' +
      'Preshift asks only the people who could legally work it (trained, free, within availability, rest and hours rules, agreed to ' +
      'work at the site), cheapest first, by the staff app and the channel each chose. The result says who would be asked and why ' +
      'others would not. If the person is off sick, propose the absence too with propose_record_absence. The note goes to everyone ' +
      'asked: use it for what helps them decide (a busy night, an early finish), never for why the person is off.',
    input_schema: object({
      shift_id: { type: 'string' },
      note: { ...NULLABLE_STRING, description: 'Up to 280 characters for the people asked; null for none.' },
      first_to_accept: { type: ['boolean', 'null'], description: 'True or null: the first to say yes gets it. False: the manager chooses among those who say yes.' },
      urgent: { type: ['boolean', 'null'], description: 'True sends through quiet hours; for a shift tonight or early tomorrow.' },
      round_size: {
        ...NULLABLE_NUMBER,
        description:
          'Ask this many at a time, cheapest first, widening until someone says yes. Null for the default: 3 at a time when there are ' +
          'more than 3 to ask and at least 6 hours to go, otherwise everyone at once. 0 asks everyone at once.',
      },
      round_minutes: { type: ['number', 'null'], enum: [15, 30, 60, 120, null], description: 'Minutes between rounds; null for 30.' },
      keep_with_them: {
        type: ['boolean', 'null'],
        description: 'True leaves the shift with its person until someone takes it, for someone who would rather not work it. False or null takes it off them now, for someone off sick or who cannot work it at all.',
      },
    }),
  },
  {
    name: 'open_rota_assistant',
    description:
      'For building or reshaping a whole rota (several shifts, a day or a week), hands the request to the rota assistant, ' +
      'which drafts it against the forecast for the manager to review. Use this rather than many single shifts.',
    input_schema: object({ instruction: { type: 'string', description: "The manager's request, in their words." } }),
  },
  {
    name: 'go_to',
    description: 'Opens a screen in the app. No confirmation needed.',
    input_schema: object({ screen: { type: 'string', enum: [...SCREENS] } }),
  },
];

class InputError extends Error {}

let seq = 0;
const proposalId = () => `p-${Date.now().toString(36)}-${(seq++).toString(36)}`;
const round2 = (n: number) => Math.round(n * 100) / 100;
const pounds = (n: number) => `£${n.toFixed(2)}`;

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== 'string' || !v.trim()) throw new InputError(`${key} is needed.`);
  return v.trim();
}
function optStr(input: Record<string, unknown>, key: string): string | null {
  const v = input[key];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}
function optNum(input: Record<string, unknown>, key: string): number | null {
  const v = input[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new InputError(`${key} must be a positive number.`);
  return v;
}
function date(value: string, key: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) throw new InputError(`${key} must be a date as YYYY-MM-DD.`);
  return value;
}
function person(ctx: AppToolContext, id: string): Employee {
  const e = ctx.state.employees.find((x) => x.id === id);
  if (!e) throw new InputError(`No one with id ${id}. Use find_people to look them up.`);
  return e;
}
function site(ctx: AppToolContext, id: string) {
  const s = ctx.state.sites.find((x) => x.id === id);
  if (!s) throw new InputError(`No site with id ${id}. Sites: ${ctx.state.sites.map((x) => `${x.id} (${x.name})`).join(', ')}.`);
  return s;
}
function roles(ctx: AppToolContext, ids: unknown): string[] {
  if (!Array.isArray(ids) || !ids.length) throw new InputError('At least one role is needed.');
  for (const id of ids) {
    if (!ctx.state.roles.some((r) => r.id === id)) throw new InputError(`No role ${id}. Roles: ${ctx.state.roles.map((r) => `${r.id} (${r.name})`).join(', ')}.`);
  }
  return ids as string[];
}
const siteName = (ctx: AppToolContext, id: string) => ctx.state.sites.find((s) => s.id === id)?.name ?? id;
const roleName = (ctx: AppToolContext, id: string) => ctx.state.roles.find((r) => r.id === id)?.name ?? id;

/** The legal minimum for someone's age on a date, or null when there is no band (under school leaving age). */
function payProblem(dob: string, on: string, basis: Employee['payBasis'], rate: number | null): string | null {
  if (basis !== 'hourly' || rate === null) return null;
  const band = minimumWageFor(ageOn(dob, on));
  if (band && rate < band.hourly) return `${pounds(rate)} an hour is below the legal minimum of ${pounds(band.hourly)} for their age.`;
  return null;
}

function summary(ctx: AppToolContext, e: Employee) {
  return {
    id: e.id,
    name: e.name,
    home_site: siteName(ctx, e.siteId),
    employer: ctx.state.entities.find((x) => x.id === e.entityId)?.name ?? e.entityId,
    roles: e.roleIds.map((r) => roleName(ctx, r)),
    pay: e.payBasis === 'salaried' ? `salaried ${pounds(e.annualSalary)} a year` : `${pounds(e.hourlyRate)} an hour`,
    contracted_hours: e.contractedHours,
    status: employeeStatus(e, ctx.now.date),
  };
}

function withShifts(ctx: AppToolContext, ws: string, filter: (s: Shift) => boolean) {
  const dates = new Set(weekDates(ws));
  return ctx.state.shifts.filter((s) => dates.has(s.date) && filter(s));
}

export async function executeAppTool(ctx: AppToolContext, name: string, raw: unknown): Promise<AppToolOutcome> {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  try {
    switch (name) {
      case 'find_people': {
        const q = optStr(input, 'query')?.toLowerCase();
        const siteId = optStr(input, 'site_id');
        const people = ctx.state.employees
          .filter((e) => !e.anonymisedOn)
          .filter((e) => input.include_leavers === true || employeeStatus(e, ctx.now.date) !== 'left')
          .filter((e) => !siteId || e.siteId === siteId || e.coverSiteIds.includes(siteId))
          .filter((e) => !q || e.name.toLowerCase().includes(q))
          .slice(0, 60);
        return { result: people.map((e) => summary(ctx, e)), label: q ? `Looked up "${q}"` : 'Looked up the team' };
      }

      case 'get_person': {
        const e = person(ctx, str(input, 'employee_id'));
        const ws = ctx.week;
        return {
          result: {
            ...summary(ctx, e),
            age: e.dateOfBirth ? ageOn(e.dateOfBirth, ctx.now.date) : null,
            start_date: e.startDate ?? null,
            leave_date: e.leaveDate ?? null,
            max_weekly_hours: e.maxWeeklyHours,
            right_to_work: e.rightToWork?.checked === false ? 'not checked: cannot be rostered' : e.rightToWork?.expiry ? `checked, expires ${e.rightToWork.expiry}` : 'checked',
            availability: e.availability.length ? e.availability.map((a) => `${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][a.weekday]} ${formatMinute(a.fromMinute)}-${formatMinute(a.toMinute)}`) : 'any time',
            cover_sites: e.coverSiteIds.map((id) => siteName(ctx, id)),
            rota_notes: e.rotaNotes ?? null,
            leave_upcoming: e.leave.filter((d) => d >= ctx.now.date).slice(0, 30),
            // The days only: why someone is off stays in the HR file.
            days_off_this_week: weekDates(ws).filter((d) => isAbsentOn(e, d)),
            hours_this_week: round2(withShifts(ctx, ws, (s) => s.employeeId === e.id).reduce((sum, s) => sum + shiftPaidHours(s), 0)),
          },
          label: `Read ${e.name}'s record`,
        };
      }

      case 'week_overview': {
        const ws = weekStart(date(optStr(input, 'week_start') ?? ctx.week, 'week_start'));
        const siteId = optStr(input, 'site_id');
        const ids = siteId ? [site(ctx, siteId).id] : ctx.siteIds.length ? ctx.siteIds : ctx.state.sites.map((s) => s.id);
        const sites = ids.map((id) => {
          const m = weekMetrics(ctx.state, id, ws);
          return {
            site: siteName(ctx, id),
            forecast_sales: round2(m.forecastSales),
            labour_cost: round2(m.labourCost),
            labour_pct: round2(m.labourPct * 100),
            target_pct: round2(m.targetPct * 100),
            paid_hours: round2(m.paidHours),
            shifts: withShifts(ctx, ws, (s) => s.siteId === id).length,
            published: withShifts(ctx, ws, (s) => s.siteId === id).every((s) => s.published),
          };
        });
        const issues = checkWeek(ctx.state, ws, ids);
        const name = (id: string) => ctx.state.employees.find((e) => e.id === id)?.name ?? id;
        return {
          result: {
            week_commencing: ws,
            sites,
            blocking_issues: issues.filter((i) => i.severity === 'block').slice(0, 20).map((i) => `${name(i.employeeId)}: ${i.message}`),
            warnings: issues.filter((i) => i.severity === 'warn').length,
          },
          label: 'Checked the week',
        };
      }

      case 'list_shifts': {
        const ws = weekStart(date(optStr(input, 'week_start') ?? ctx.week, 'week_start'));
        const siteId = optStr(input, 'site_id');
        const day = optStr(input, 'date');
        const who = optStr(input, 'employee_id');
        const shifts = withShifts(ctx, ws, (s) => (!siteId || s.siteId === siteId) && (!day || s.date === day) && (!who || s.employeeId === who))
          .sort((a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute)
          .slice(0, 150);
        return {
          result: shifts.map((s) => ({
            id: s.id,
            site: siteName(ctx, s.siteId),
            person: ctx.state.employees.find((e) => e.id === s.employeeId)?.name ?? s.employeeId,
            role: roleName(ctx, s.roleId),
            date: s.date,
            start: formatMinute(s.startMinute),
            end: formatMinute(s.endMinute),
            started: hasStarted(s, ctx.now),
            published: Boolean(s.published),
          })),
          label: 'Read the shifts',
        };
      }

      case 'holiday_balance': {
        const e = person(ctx, str(input, 'employee_id'));
        const entries = await ctx.loadEntries().catch(() => []);
        const worked = workedShifts(ctx.state.shifts.filter((s) => s.date <= ctx.now.date), entriesAsShifts(entries));
        const yearStart = ctx.state.entities.find((x) => x.id === e.entityId)?.leaveYearStart ?? '01-01';
        const b = holidayBalance(e, worked, ctx.now.date, yearStart);
        return {
          result: {
            name: e.name,
            leave_year: `${b.year.start} to ${b.year.end}`,
            basis: b.basis,
            entitlement_hours: round2(b.entitlementHours),
            taken_hours: round2(b.takenHours),
            booked_hours: round2(b.bookedHours),
            remaining_hours: round2(b.remainingHours),
            normal_day_hours: round2(b.dayHours),
          },
          label: `Read ${e.name}'s holiday`,
        };
      }

      case 'propose_add_starter': {
        const s = site(ctx, str(input, 'site_id'));
        const roleIds = roles(ctx, input.role_ids);
        const start = date(str(input, 'start_date'), 'start_date');
        const dob = date(str(input, 'date_of_birth'), 'date_of_birth');
        const age = ageOn(dob, start);
        if (age < 13 || age > 100) throw new InputError(`A date of birth of ${dob} makes them ${age} on their start date. Check it with the manager.`);
        const basis = input.pay_basis === 'salaried' ? 'salaried' : 'hourly';
        const rate = optNum(input, 'hourly_rate');
        const salary = optNum(input, 'annual_salary');
        if (basis === 'hourly' && rate === null) throw new InputError('An hourly rate is needed for hourly staff.');
        if (basis === 'salaried' && salary === null) throw new InputError('An annual salary is needed for salaried staff.');
        const low = payProblem(dob, start, basis, rate);
        if (low) throw new InputError(low);
        const contracted = optNum(input, 'contracted_hours') ?? 0;
        const employee: Employee = {
          ...newEmployee(s.id, s.entityId, roleIds[0], start),
          name: str(input, 'name'),
          roleIds,
          payBasis: basis,
          hourlyRate: basis === 'hourly' ? rate! : 0,
          annualSalary: basis === 'salaried' ? salary! : 0,
          dateOfBirth: dob,
          contractedHours: contracted,
          irregularHours: contracted === 0,
          startDate: start,
          ...(optStr(input, 'email') ? { email: optStr(input, 'email')! } : {}),
          ...(optStr(input, 'phone') ? { phone: optStr(input, 'phone')! } : {}),
        };
        const warnings = ['No right to work check is on file yet, so they cannot be rostered until one is recorded in People.'];
        if (age < 18) warnings.push('Under 18: young worker limits apply (8 hours a day, 40 a week, a 30 minute break after 4.5 hours).');
        warnings.push(PAY_APPROVAL);
        const proposal: Proposal = {
          id: proposalId(),
          kind: 'add_starter',
          employee,
          summary: `Add ${employee.name} as a new starter at ${s.name}`,
          details: [
            { label: 'Roles', value: roleIds.map((r) => roleName(ctx, r)).join(', ') },
            { label: 'Starts', value: start },
            { label: 'Date of birth', value: `${dob} (${age} on their first day)` },
            { label: 'Pay', value: basis === 'hourly' ? `${pounds(rate!)} an hour` : `${pounds(salary!)} a year` },
            { label: 'Contracted hours', value: contracted ? `${contracted} a week` : 'None (irregular hours)' },
            { label: 'Employer', value: ctx.state.entities.find((x) => x.id === s.entityId)?.name ?? s.entityId },
          ],
          warnings,
        };
        return { result: { proposed: true, awaiting_confirmation: true, warnings }, label: proposal.summary, proposal };
      }

      case 'propose_update_person': {
        const old = person(ctx, str(input, 'employee_id'));
        const next: Employee = structuredClone(old);
        const changes: Detail[] = [];
        const num = (key: string, field: 'hourlyRate' | 'annualSalary' | 'contractedHours' | 'maxWeeklyHours', label: string, fmt: (n: number) => string) => {
          const v = optNum(input, key);
          if (v !== null && v !== old[field]) {
            next[field] = v;
            changes.push({ label, value: `${fmt(old[field])} to ${fmt(v)}` });
          }
        };
        num('hourly_rate', 'hourlyRate', 'Hourly rate', pounds);
        num('annual_salary', 'annualSalary', 'Salary', pounds);
        num('contracted_hours', 'contractedHours', 'Contracted hours', (n) => `${n}`);
        num('max_weekly_hours', 'maxWeeklyHours', 'Most hours a week', (n) => `${n}`);
        if (Array.isArray(input.role_ids)) {
          next.roleIds = roles(ctx, input.role_ids);
          changes.push({ label: 'Roles', value: next.roleIds.map((r) => roleName(ctx, r)).join(', ') });
        }
        if (Array.isArray(input.cover_site_ids)) {
          next.coverSiteIds = input.cover_site_ids.map((id) => site(ctx, String(id)).id).filter((id) => id !== old.siteId);
          changes.push({ label: 'Covers', value: next.coverSiteIds.map((id) => siteName(ctx, id)).join(', ') || 'No other sites' });
        }
        for (const [key, field, label] of [['email', 'email', 'Email'], ['phone', 'phone', 'Phone'], ['rota_notes', 'rotaNotes', 'Rota notes']] as const) {
          const v = optStr(input, key);
          if (v !== null && v !== old[field]) {
            next[field] = v;
            changes.push({ label, value: v });
          }
        }
        if (!changes.length) throw new InputError('Nothing would change. Say what should be different.');
        if (next.contractedHours !== old.contractedHours) next.irregularHours = next.contractedHours === 0;
        const low = old.dateOfBirth ? payProblem(old.dateOfBirth, ctx.now.date, next.payBasis, next.hourlyRate) : null;
        if (low) throw new InputError(low);
        const payMoves = next.hourlyRate !== old.hourlyRate || next.annualSalary !== old.annualSalary;
        const proposal: Proposal = { id: proposalId(), kind: 'update_person', employee: next, summary: `Update ${old.name}'s record`, details: changes, warnings: payMoves ? [PAY_APPROVAL] : [] };
        return { result: { proposed: true, awaiting_confirmation: true }, label: proposal.summary, proposal };
      }

      case 'propose_leaver': {
        const e = person(ctx, str(input, 'employee_id'));
        const leaveDate = date(str(input, 'leave_date'), 'leave_date');
        if (e.startDate && leaveDate < e.startDate) throw new InputError(`${e.name} starts on ${e.startDate}, after that leave date.`);
        const later = ctx.state.shifts.filter((s) => s.employeeId === e.id && s.date > leaveDate).length;
        const proposal: Proposal = {
          id: proposalId(),
          kind: 'mark_leaver',
          employeeId: e.id,
          leaveDate,
          summary: `Mark ${e.name} as a leaver, last day ${leaveDate}`,
          details: [{ label: 'Last day', value: leaveDate }, { label: 'Shifts after it', value: later ? `${later}, removed` : 'None' }],
          warnings: ['Their leaving is sent to payroll, and holiday owed is paid in their final pay.'],
        };
        return { result: { proposed: true, awaiting_confirmation: true, shifts_removed_on_confirm: later }, label: proposal.summary, proposal };
      }

      case 'propose_leave': {
        const e = person(ctx, str(input, 'employee_id'));
        const asked = Array.isArray(input.dates) ? [...new Set(input.dates.map((d) => date(String(d), 'dates')))].sort() : [];
        if (!asked.length) throw new InputError('Which days?');
        const outside = asked.filter((d) => !isEmployedOn(e, d));
        if (outside.length) throw new InputError(`${e.name} is not employed on ${outside.join(', ')}.`);
        const dates = asked.filter((d) => !e.leave.includes(d));
        if (!dates.length) throw new InputError(`Those days are already booked as leave for ${e.name}.`);
        const rostered = ctx.state.shifts.filter((s) => s.employeeId === e.id && dates.includes(s.date));
        const proposal: Proposal = {
          id: proposalId(),
          kind: 'book_leave',
          employee: { ...e, leave: [...e.leave, ...dates].sort() },
          dates,
          summary: `Book ${dates.length} day${dates.length === 1 ? '' : 's'} of leave for ${e.name}`,
          details: [{ label: 'Days', value: dates.join(', ') }],
          warnings: rostered.length ? [`${e.name} is rostered on ${rostered.length} of those days. Those shifts will be flagged to re-cover.`] : [],
        };
        return { result: { proposed: true, awaiting_confirmation: true, rostered_on: rostered.length }, label: proposal.summary, proposal };
      }

      case 'propose_absence': {
        const e = person(ctx, str(input, 'employee_id'));
        const type = String(input.type) as AbsenceType;
        if (!ABSENCE_TYPES.includes(type)) throw new InputError(`Type must be one of ${ABSENCE_TYPES.join(', ')}.`);
        const from = date(str(input, 'from'), 'from');
        const to = optStr(input, 'to');
        if (to && date(to, 'to') < from) throw new InputError('The absence ends before it starts.');
        const reason = optStr(input, 'reason');
        const absence: Absence = { id: `a-${Date.now().toString(36)}-${(seq++).toString(36)}`, type, from, ...(to ? { to } : {}), ...(reason ? { reason } : {}) };
        const proposal: Proposal = {
          id: proposalId(),
          kind: 'record_absence',
          employeeId: e.id,
          absence,
          summary: `Record ${type} absence for ${e.name} from ${from}${to ? ` to ${to}` : ', still off'}`,
          details: [{ label: 'Type', value: type }, { label: 'From', value: from }, { label: 'To', value: to ?? 'Still off' }],
          warnings: type === 'sickness' && to && (Date.parse(to) - Date.parse(from)) / 86_400_000 >= 7 ? ['Over seven days of sickness needs a fit note.'] : [],
        };
        return { result: { proposed: true, awaiting_confirmation: true }, label: proposal.summary, proposal };
      }

      case 'propose_add_shift': {
        const e = person(ctx, str(input, 'employee_id'));
        const s = site(ctx, str(input, 'site_id'));
        const roleId = str(input, 'role_id');
        roles(ctx, [roleId]);
        if (e.siteId !== s.id && !e.coverSiteIds.includes(s.id)) throw new InputError(`${e.name} is not on ${s.name}'s team and has not agreed to cover it.`);
        const day = date(str(input, 'date'), 'date');
        const clock = (key: string) => {
          const v = str(input, key);
          if (!new RegExp(CLOCK).test(v)) throw new InputError(`${key} must be HH:MM.`);
          return parseClock(v);
        };
        const startMinute = clock('start');
        let endMinute = clock('end');
        if (endMinute <= startMinute) endMinute += 1440;
        if (hasStarted({ date: day, startMinute }, ctx.now)) throw new InputError('That time has already started. Only future hours can be rostered.');
        const shift: Shift = {
          id: `s-${Date.now().toString(36)}-${(seq++).toString(36)}`,
          employeeId: e.id, roleId, siteId: s.id, date: day, startMinute, endMinute,
          breakMinutes: breakFor(e, day, endMinute - startMinute, complianceOptions(ctx.state, e).nation),
        };
        const ws = weekStart(day);
        const context = ctx.state.shifts.filter((x) => x.date >= addDays(ws, -1) && x.date <= addDays(ws, 7));
        const issues = checkEmployeeWeek(e, ws, [...context, shift], ctx.state.restOverrides, undefined, complianceOptions(ctx.state, e)).filter((i) => i.shiftId === shift.id || !i.shiftId);
        const blocks = issues.filter((i) => i.severity === 'block');
        if (blocks.length) throw new InputError(`Not allowed: ${blocks.map((i) => i.message).join(' ')}`);
        const proposal: Proposal = {
          id: proposalId(),
          kind: 'add_shift',
          shift,
          summary: `Add a ${roleName(ctx, roleId)} shift for ${e.name} at ${s.name}`,
          details: [{ label: 'When', value: `${day}, ${formatMinute(startMinute)} to ${formatMinute(endMinute)}` }, { label: 'Unpaid break', value: `${shift.breakMinutes} minutes` }],
          warnings: issues.filter((i) => i.severity === 'warn').map((i) => i.message),
        };
        return { result: { proposed: true, awaiting_confirmation: true, warnings: proposal.warnings }, label: proposal.summary, proposal };
      }

      case 'propose_remove_shift': {
        const id = str(input, 'shift_id');
        const s = ctx.state.shifts.find((x) => x.id === id);
        if (!s) throw new InputError(`No shift ${id}. Use list_shifts.`);
        if (hasStarted(s, ctx.now)) throw new InputError('That shift has started, so it stays. Record an absence instead if they did not come in.');
        const who = ctx.state.employees.find((e) => e.id === s.employeeId)?.name ?? s.employeeId;
        const proposal: Proposal = {
          id: proposalId(),
          kind: 'remove_shift',
          shiftId: id,
          summary: `Remove ${who}'s shift on ${s.date}`,
          details: [{ label: 'Shift', value: `${siteName(ctx, s.siteId)}, ${roleName(ctx, s.roleId)}, ${formatMinute(s.startMinute)} to ${formatMinute(s.endMinute)}` }],
          warnings: s.published ? ['It has been published, so tell them it has gone.'] : [],
        };
        return { result: { proposed: true, awaiting_confirmation: true }, label: proposal.summary, proposal };
      }

      case 'propose_ask_cover': {
        const id = str(input, 'shift_id');
        const s = ctx.state.shifts.find((x) => x.id === id);
        if (!s) throw new InputError(`No shift ${id}. Use list_shifts.`);
        if (hasStarted(s, ctx.now)) throw new InputError('That shift has started, so cover can no longer be asked for it.');
        const original = ctx.state.employees.find((e) => e.id === s.employeeId);
        const note = optStr(input, 'note')?.trim() || null;
        if (note && note.length > MAX_NOTE) throw new InputError(`Keep the note under ${MAX_NOTE} characters.`);
        // Everyone asked reads the note, so it never says who is off or why.
        const first = original?.name.split(' ')[0].toLowerCase();
        if (note && ((first && note.toLowerCase().includes(first)) || /\b(sick\w*|ill|illness|unwell|hospital\w*|covid|injur\w*|bereave\w*|funeral|pregnan\w*|doctor|gp)\b/i.test(note))) {
          throw new InputError('Keep who is off and why out of the note: everyone asked reads it. Say what helps them decide, such as a busy night.');
        }
        const all = goingCandidates(ctx.state, { ...s, id: 'cover' }, [s.employeeId]);
        const asked = all.filter((c) => c.eligible).map((c) => c.candidate);
        if (asked.length === 0) {
          throw new InputError('Nobody trained for this role can legally work that shift. It is a gap to fill by hiring or cross-training, or by changing the shift.');
        }
        const notAsked = all.filter((c) => !c.eligible);
        const keep = input.keep_with_them === true;
        const firstToAccept = input.first_to_accept !== false;
        const toStart = minutesUntil(ctx.now, { date: s.date, minute: s.startMinute });
        const size = input.round_size === null || input.round_size === undefined ? undefined : Number(input.round_size);
        if (size !== undefined && (!Number.isInteger(size) || size < 0 || size > MAX_ROUND_SIZE)) throw new InputError(`Ask between 1 and ${MAX_ROUND_SIZE} a round, or 0 for everyone at once.`);
        const every = input.round_minutes === null || input.round_minutes === undefined ? 30 : Number(input.round_minutes);
        if (!(ROUND_MINUTES as readonly number[]).includes(every)) throw new InputError(`Rounds go every ${ROUND_MINUTES.join(', ')} minutes.`);
        const rounds = size === undefined ? defaultRounds(asked.length, toStart) ?? null : size > 0 && size < asked.length ? { size, everyMinutes: every } : null;
        if (rounds && toStart <= rounds.everyMinutes) throw new InputError('There is not time for a second round before the shift. Ask everyone at once.');
        const label = `${s.date} ${formatMinute(s.startMinute)} to ${formatMinute(s.endMinute)}, ${roleName(ctx, s.roleId)} at ${siteName(ctx, s.siteId)}`;
        const names = asked.map((c) => c.employee.name);
        const proposal: Proposal = {
          id: proposalId(),
          kind: 'ask_cover',
          shiftId: s.id,
          employeeIds: asked.map((c) => c.employee.id),
          note,
          firstToAccept,
          urgent: input.urgent === true,
          rounds,
          keepUntilTaken: keep,
          summary: `Ask for cover for ${original?.name ?? 'this'}'s shift, ${label}`,
          details: [
            rounds
              ? { label: 'Asks', value: `${names.slice(0, rounds.size).join(', ')} first, the cheapest; then ${rounds.size} more every ${rounds.everyMinutes} minutes until someone says yes (${asked.length} in all)` }
              : { label: 'Asks', value: `${asked.length}: ${names.slice(0, 6).join(', ')}${names.length > 6 ? ` and ${names.length - 6} more` : ''}, cheapest first` },
            { label: 'Who gets it', value: firstToAccept ? 'The first to say yes, re-checked at that moment' : 'You choose among those who say yes' },
            ...(note ? [{ label: 'Note', value: note }] : []),
            ...(notAsked.length ? [{ label: 'Not asked', value: `${notAsked.length}, who cannot legally work it or are not trained` }] : []),
            { label: `${original?.name.split(' ')[0] ?? 'Their'} shift`, value: keep ? 'Stays theirs until someone takes it' : 'Taken off them now, and they are told' },
          ],
          warnings: [
            ...(s.published ? [] : ['The shift is not published yet, so whoever takes it sees it once the week is published.']),
            ...(input.urgent === true ? ['Urgent: it reaches people through their quiet hours.'] : []),
          ...(!keep && s.published ? [`${original?.name.split(' ')[0] ?? 'They'} will be told the shift is taken off them.`] : []),
          ],
        };
        return {
          result: {
            proposed: true,
            awaiting_confirmation: true,
            would_ask: asked.map((c, i) => ({ name: c.employee.name, from_another_site: c.borrowed, round: roundOf(i, rounds ?? undefined) })),
            rounds,
            not_asked: notAsked.slice(0, 10).map((c) => ({ name: c.candidate.employee.name, why: c.reason })),
          },
          label: proposal.summary,
          proposal,
        };
      }

      case 'propose_publish': {
        const ws = weekStart(date(optStr(input, 'week_start') ?? ctx.week, 'week_start'));
        const ids = Array.isArray(input.site_ids) && input.site_ids.length ? input.site_ids.map((id) => site(ctx, String(id)).id) : ctx.siteIds;
        const blocks = checkWeek(ctx.state, ws, ids).filter((i) => i.severity === 'block');
        if (blocks.length) throw new InputError(`${blocks.length} blocking issues must be fixed before publishing. The first: ${blocks[0].message}`);
        const count = withShifts(ctx, ws, (s) => ids.includes(s.siteId)).length;
        if (!count) throw new InputError('There are no shifts to publish that week.');
        const proposal: Proposal = {
          id: proposalId(),
          kind: 'publish_week',
          siteIds: ids,
          weekStart: ws,
          summary: `Publish the week commencing ${ws} at ${ids.map((id) => siteName(ctx, id)).join(', ')}`,
          details: [{ label: 'Shifts', value: String(count) }],
          warnings: ['Staff see their shifts on their phones once published.'],
        };
        return { result: { proposed: true, awaiting_confirmation: true }, label: proposal.summary, proposal };
      }

      case 'open_rota_assistant': {
        if (ctx.rotaAiOff) {
          return {
            result: { error: 'AI rota writing is switched off for this organisation. Offer single shift changes instead, or say an owner can turn it on under Features.' },
            label: 'Rota assistant switched off',
            isError: true,
          };
        }
        const instruction = str(input, 'instruction');
        const proposal: Proposal = { id: proposalId(), kind: 'draft_rota', instruction, summary: 'Draft this with the rota assistant', details: [{ label: 'Request', value: instruction }], warnings: [] };
        return { result: { handed_over: true, note: 'The manager can open the rota assistant from the card; nothing is changed yet.' }, label: proposal.summary, proposal };
      }

      case 'go_to': {
        const screen = String(input.screen) as Screen;
        if (!SCREENS.includes(screen)) throw new InputError(`Screen must be one of ${SCREENS.join(', ')}.`);
        const proposal: Proposal = { id: proposalId(), kind: 'go_to', screen, summary: `Open ${screen}`, details: [], warnings: [] };
        return { result: { opened: screen }, label: proposal.summary, proposal };
      }

      default:
        return { result: { error: `Unknown tool ${name}.` }, label: `Unknown tool ${name}`, isError: true };
    }
  } catch (err) {
    if (err instanceof InputError) return { result: { error: err.message }, label: err.message, isError: true };
    throw err;
  }
}
