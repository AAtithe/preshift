import { autoSchedule, autoScheduleSites, coverDistance, type AutoScheduleResult } from '../engine/autoschedule';
import { checkWeek, requiredBreakMinutes, type Issue } from '../engine/compliance';
import { shiftPaidHours, weekCost } from '../engine/cost';
import { dayDemand } from '../engine/demand';
import { isEmployedOn } from '../engine/employees';
import type { PersonInsight } from '../engine/insights';
import { weekMetrics } from '../engine/metrics';
import { hasStarted, type LondonNow } from '../engine/rotaWeek';
import { ageOn, formatMinute, parseClock, weekDates, weekday } from '../engine/time';
import type { Employee, RotaState, Shift } from '../engine/types';

/**
 * The tools Claude uses to write a rota. Every tool works on a draft copy of
 * the rota and goes through the same engine the manager uses: costs come from
 * the payroll model, and any change that would create a blocking compliance
 * issue is refused. The model can suggest; it cannot break the law.
 */

export interface RotaDraft {
  state: RotaState;
  /** The sites being planned together: one, a company's, or the whole group. */
  siteIds: string[];
  weekStart: string;
  /** UK wall-clock time. Shifts that have started are history and stay exactly as they are. */
  now: LondonNow;
  /** What the last few weeks say about each person, from peopleInsights; absent if it could not be loaded. */
  insights?: Record<string, PersonInsight>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const CLOCK = '^([01][0-9]|2[0-3]):[0-5][0-9]$';
const SITE = { type: 'string', description: 'Site id, one of the sites being planned.' };
const SITE_OR_ALL = { type: ['string', 'null'], description: 'Site id, or null for every site being planned.' };

export const ROTA_TOOLS: ToolDefinition[] = [
  {
    name: 'get_rota_status',
    description:
      'Current state of the draft week for one site or all of them: forecast sales, loaded labour cost and labour % by ' +
      'site and day against each site target, compliance issues, and for each day and role the hours that are short of ' +
      'or over the forecast headcount. Call this first, and again after making changes to check the result.',
    input_schema: { type: 'object', properties: { site_id: SITE_OR_ALL }, required: ['site_id'], additionalProperties: false },
  },
  {
    name: 'list_team',
    description:
      'Everyone who can work at a site this week: its own team, then people from other sites who have agreed to cover it. ' +
      'For each: id, roles (first is primary), pay, age, contracted (guaranteed) hours, maximum weekly hours, availability, ' +
      'approved leave, the days they are employed if they start or leave this week, whether they can be rostered at all ' +
      '(right to work), hours already rostered this week at this site and elsewhere, and what borrowing them costs: home ' +
      'team, a sister site in the same company, or another company in the group, which means an intercompany recharge. ' +
      'Contracted hours are paid whether rostered or not, so use them first.',
    input_schema: { type: 'object', properties: { site_id: SITE }, required: ['site_id'], additionalProperties: false },
  },
  {
    name: 'get_people_insights',
    description:
      'What the last four weeks say about the people who can work at a site, or every site being planned: average weekly ' +
      'hours, weekend and closing shifts worked (spread these fairly), late arrivals and no-shows where the site uses ' +
      'clocking (do not rely on someone with several on a shift they would be covering alone), their rota notes ' +
      '(preferences and commitments to respect), and holiday left with the leave year end (offer quiet shifts as leave ' +
      'to people flagged should_plan_leave, in your note; do not book leave yourself).',
    input_schema: { type: 'object', properties: { site_id: SITE_OR_ALL }, required: ['site_id'], additionalProperties: false },
  },
  {
    name: 'list_shifts',
    description:
      'Shifts on the draft rota this week, with id, site, person, role, times, paid hours, loaded cost, and whether it has ' +
      'started (started shifts are fixed).',
    input_schema: {
      type: 'object',
      properties: {
        site_id: SITE_OR_ALL,
        date: { type: ['string', 'null'], description: 'ISO date to limit to one day, or null for the whole week.' },
      },
      required: ['site_id', 'date'],
      additionalProperties: false,
    },
  },
  {
    name: 'build_from_forecast',
    description:
      'Runs the demand-led auto-build for one site or several: keeps existing shifts, then fills every hour short of ' +
      'forecast headcount with the cheapest legal person, busiest sites and days first, and trims overstaffed edges. With ' +
      'several sites, every site is first filled from its own team, and only then is cover borrowed between them. A strong ' +
      'starting point for an empty or part-built week. It never adds anything that has already started. Use ' +
      'exclude_employee_ids to keep named people out of the build, and allow_cover to choose whether it may borrow people ' +
      'from other sites once each home team is used.',
    input_schema: {
      type: 'object',
      properties: {
        site_ids: { type: ['array', 'null'], items: { type: 'string' }, description: 'Sites to build, or null for every site being planned.' },
        exclude_employee_ids: { type: 'array', items: { type: 'string' }, description: 'People the build must not roster.' },
        allow_cover: { type: 'boolean', description: 'Borrow willing people from other sites for gaps a home team cannot fill.' },
      },
      required: ['site_ids', 'exclude_employee_ids', 'allow_cover'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_shift',
    description:
      'Adds one shift at a site for someone on that site\'s list_team. The statutory unpaid break is applied automatically. ' +
      'Refused if it has already started, or would create a blocking compliance issue (double booking, leave, not employed ' +
      'that day, no right to work, under 18 limits, minimum wage). Returns the cost it adds to the week and any warnings.',
    input_schema: {
      type: 'object',
      properties: {
        site_id: SITE,
        employee_id: { type: 'string' },
        role_id: { type: 'string' },
        date: { type: 'string', description: 'ISO date within the week.' },
        start: { type: 'string', pattern: CLOCK, description: '24 hour clock, e.g. 11:00.' },
        end: { type: 'string', pattern: CLOCK, description: '24 hour clock. A time at or before the start runs past midnight.' },
      },
      required: ['site_id', 'employee_id', 'role_id', 'date', 'start', 'end'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_shift',
    description:
      'Changes the times or the person on an existing shift. Pass null for anything that stays the same. ' +
      'Refused for a shift that has started, and on the same terms as add_shift.',
    input_schema: {
      type: 'object',
      properties: {
        shift_id: { type: 'string' },
        employee_id: { type: ['string', 'null'] },
        start: { type: ['string', 'null'], pattern: CLOCK },
        end: { type: ['string', 'null'], pattern: CLOCK },
      },
      required: ['shift_id', 'employee_id', 'start', 'end'],
      additionalProperties: false,
    },
  },
  {
    name: 'remove_shift',
    description: 'Removes one shift from the draft. Refused for a shift that has started. Returns the saving to the week.',
    input_schema: {
      type: 'object',
      properties: { shift_id: { type: 'string' } },
      required: ['shift_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'clear_week',
    description: 'Removes every shift this week that has not started yet, at one site or all of them. Use only when asked to start again.',
    input_schema: { type: 'object', properties: { site_id: SITE_OR_ALL }, required: ['site_id'], additionalProperties: false },
  },
];

export class ToolInputError extends Error {}

export interface ToolOutcome {
  /** JSON returned to the model. */
  result: unknown;
  /** One line for the manager's progress log. */
  label: string;
  isError?: boolean;
}

let seq = 0;
const newId = () => `ai-${Date.now().toString(36)}-${(seq++).toString(36)}`;

const round2 = (n: number) => Math.round(n * 100) / 100;

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== 'string' || v.length === 0) throw new ToolInputError(`${key} must be a non-empty string.`);
  return v;
}

function optStr(input: Record<string, unknown>, key: string): string | null {
  const v = input[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw new ToolInputError(`${key} must be a string or null.`);
  return v;
}

function clock(value: string, key: string): number {
  if (!new RegExp(CLOCK).test(value)) throw new ToolInputError(`${key} must be HH:MM on the 24 hour clock.`);
  return parseClock(value);
}

function siteArg(d: RotaDraft, input: Record<string, unknown>, key = 'site_id'): string {
  const id = str(input, key);
  if (!d.siteIds.includes(id)) throw new ToolInputError(`Site ${id} is not one of the sites being planned (${d.siteIds.join(', ')}).`);
  return id;
}

/** One site if given, otherwise every site being planned. */
function scopeArg(d: RotaDraft, input: Record<string, unknown>): string[] {
  return input.site_id === null || input.site_id === undefined ? d.siteIds : [siteArg(d, input)];
}

function weekShifts(d: RotaDraft, siteIds = d.siteIds): Shift[] {
  const dates = new Set(weekDates(d.weekStart));
  return d.state.shifts.filter((s) => siteIds.includes(s.siteId) && dates.has(s.date));
}

/** Loaded labour across every site being planned, so moves between them are costed as a whole. */
function siteCost(d: RotaDraft): number {
  return d.siteIds.reduce((sum, id) => sum + weekCost(d.state, d.weekStart, id).total, 0);
}

const siteName = (d: RotaDraft, id: string) => d.state.sites.find((x) => x.id === id)?.name ?? id;

function issueKey(i: Issue) {
  return `${i.employeeId}|${i.code}|${i.shiftId ?? ''}|${i.date ?? ''}`;
}

/**
 * Applies a change to the draft only if it leaves no new blocking issue for the
 * people it touches. Warnings are allowed through and reported back.
 */
function applyChecked(d: RotaDraft, next: Shift[], people: string[]): { ok: true; warnings: string[]; delta: number } | { ok: false; reasons: string[] } {
  const before = new Set(checkWeek(d.state, d.weekStart).map(issueKey));
  const costBefore = siteCost(d);
  const candidate = { ...d.state, shifts: next };
  const fresh = checkWeek(candidate, d.weekStart).filter((i) => people.includes(i.employeeId) && !before.has(issueKey(i)));
  const blocks = fresh.filter((i) => i.severity === 'block');
  if (blocks.length) return { ok: false, reasons: blocks.map((i) => i.message) };
  d.state = candidate;
  return { ok: true, warnings: fresh.map((i) => i.message), delta: round2(siteCost(d) - costBefore) };
}

function personName(d: RotaDraft, id: string) {
  return d.state.employees.find((e) => e.id === id)?.name ?? id;
}

function describe(d: RotaDraft, s: Shift) {
  const where = d.siteIds.length > 1 ? ` at ${siteName(d, s.siteId)}` : '';
  return `${personName(d, s.employeeId)} ${WEEKDAYS[weekday(s.date)]} ${formatMinute(s.startMinute)}-${formatMinute(s.endMinute)}${where}`;
}

/** Hour ranges where a role is short (gap > 0) or over (gap < 0) the forecast headcount. */
function ranges(hours: { hour: number; gap: number }[], test: (gap: number) => boolean): string[] {
  const out: string[] = [];
  let from = -1;
  for (let i = 0; i <= hours.length; i++) {
    const hit = i < hours.length && test(hours[i].gap);
    if (hit && from < 0) from = hours[i].hour;
    if (!hit && from >= 0) {
      out.push(`${String(from).padStart(2, '0')}:00-${String(hours[i - 1].hour + 1).padStart(2, '0')}:00`);
      from = -1;
    }
  }
  return out;
}

function siteStatus(d: RotaDraft, siteId: string) {
  const site = d.state.sites.find((s) => s.id === siteId)!;
  const m = weekMetrics(d.state, siteId, d.weekStart);
  const rules = d.state.demandRules.filter((r) => r.siteId === siteId);
  return {
    site_id: siteId,
    site: site.name,
    labour_target_pct: round2(site.labourTargetPct * 100),
    week: {
      forecast_sales: round2(m.forecastSales),
      labour_cost: round2(m.labourCost),
      labour_pct: round2(m.labourPct * 100),
      variance_to_target: round2(m.varianceToTarget),
      paid_hours: round2(m.paidHours),
    },
    days: m.days.map((day) => ({
      date: day.date,
      weekday: WEEKDAYS[weekday(day.date)],
      past: day.date < d.now.date,
      forecast_sales: round2(day.forecastSales),
      labour_cost: round2(day.labourCost),
      labour_pct: round2(day.labourPct * 100),
      cover: rules.map((r) => {
        const demand = dayDemand(d.state, siteId, r.roleId, day.date);
        return { role_id: r.roleId, short: ranges(demand, (g) => g > 0), over: ranges(demand, (g) => g < 0) };
      }).filter((c) => c.short.length || c.over.length),
    })),
  };
}

function rotaStatus(d: RotaDraft, siteIds: string[]) {
  const sites = siteIds.map((id) => siteStatus(d, id));
  const sales = sites.reduce((sum, x) => sum + x.week.forecast_sales, 0);
  const labour = sites.reduce((sum, x) => sum + x.week.labour_cost, 0);
  return {
    week_commencing: d.weekStart,
    now: `${d.now.date} ${formatMinute(d.now.minute)}`,
    ...(sites.length > 1 ? { all_sites: { forecast_sales: round2(sales), labour_cost: round2(labour), labour_pct: round2(sales ? (labour / sales) * 100 : 0) } } : {}),
    sites,
    issues: checkWeek(d.state, d.weekStart, siteIds).map((i) => ({
      severity: i.severity,
      person: personName(d, i.employeeId),
      shift_id: i.shiftId ?? null,
      date: i.date ?? null,
      message: i.message,
    })),
  };
}

/** People who may be rostered at a site: its own team, then those who have said they will cover it. */
function canWorkAt(e: Employee, siteId: string) {
  return e.siteId === siteId || e.coverSiteIds.includes(siteId);
}

const COVER = ['home team', 'sister site, same company', 'another company: intercompany recharge'];

function rightToWork(e: Employee, dates: string[]) {
  const rtw = e.rightToWork;
  if (rtw && !rtw.checked) return 'not checked: cannot be rostered';
  if (rtw?.expiry && rtw.expiry < dates[6]) return `expires ${rtw.expiry}: cannot be rostered after that`;
  return 'ok';
}

function team(d: RotaDraft, siteId: string) {
  const dates = weekDates(d.weekStart);
  const shifts = d.state.shifts.filter((s) => dates.includes(s.date));
  const entityName = (id: string) => d.state.entities.find((x) => x.id === id)?.name ?? id;
  return d.state.employees
    .filter((e) => canWorkAt(e, siteId) && dates.some((day) => isEmployedOn(e, day)))
    .map((e) => ({ e, distance: coverDistance(d.state, e, siteId) }))
    .sort((a, b) => a.distance - b.distance)
    .map(({ e, distance }) => {
      const employedDays = dates.filter((day) => isEmployedOn(e, day));
      const mine = shifts.filter((s) => s.employeeId === e.id);
      return {
        id: e.id,
        name: e.name,
        cover: COVER[distance],
        home_site: siteName(d, e.siteId),
        employer: entityName(e.entityId),
        roles: e.roleIds,
        pay: e.payBasis === 'salaried' ? `salaried £${e.annualSalary}` : `£${e.hourlyRate.toFixed(2)}/h`,
        age: ageOn(e.dateOfBirth, d.weekStart),
        contracted_hours: e.contractedHours,
        max_weekly_hours: e.maxWeeklyHours,
        opted_out_of_48: e.optedOutOf48,
        availability: e.availability.length
          ? e.availability.map((a) => `${WEEKDAYS[a.weekday]} ${formatMinute(a.fromMinute)}-${formatMinute(a.toMinute)}`)
          : 'any',
        leave_this_week: e.leave.filter((l) => dates.includes(l)),
        employed_this_week: employedDays.length === 7 ? 'all week' : employedDays,
        right_to_work: rightToWork(e, dates),
        rostered_hours_here: round2(mine.filter((s) => s.siteId === siteId).reduce((sum, s) => sum + shiftPaidHours(s), 0)),
        rostered_hours_elsewhere: round2(mine.filter((s) => s.siteId !== siteId).reduce((sum, s) => sum + shiftPaidHours(s), 0)),
      };
    });
}

function insightsFor(d: RotaDraft, siteIds: string[]) {
  if (!d.insights) return { available: false, reason: 'History could not be loaded for this draft. Plan without it.' };
  const dates = weekDates(d.weekStart);
  return {
    available: true,
    people: d.state.employees
      .filter((e) => siteIds.some((id) => canWorkAt(e, id)) && dates.some((day) => isEmployedOn(e, day)))
      .map((e) => {
        const i = d.insights![e.id];
        if (!i) return { id: e.id, name: e.name, history: 'none yet' };
        return {
          id: e.id,
          name: e.name,
          looked_back: `${i.from} to ${i.to}`,
          average_weekly_hours: i.averageWeeklyHours,
          weekend_shifts: i.weekendShifts,
          closing_shifts: i.closingShifts,
          late_arrivals: i.lateArrivals ?? 'no clocking at their sites',
          no_shows: i.noShows ?? 'no clocking at their sites',
          notes: i.notes ?? null,
          holiday_left_hours: i.holiday?.remainingHours ?? null,
          leave_year_ends: i.holiday?.leaveYearEnd ?? null,
          should_plan_leave: i.holiday?.shouldPlanLeave ?? false,
        };
      }),
  };
}

function shiftList(d: RotaDraft, siteIds: string[], date: string | null) {
  const costs = new Map(siteIds.map((id) => [id, weekCost(d.state, d.weekStart, id)]));
  return weekShifts(d, siteIds)
    .filter((s) => !date || s.date === date)
    .sort((a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute)
    .map((s) => ({
      id: s.id,
      site_id: s.siteId,
      person: personName(d, s.employeeId),
      employee_id: s.employeeId,
      role_id: s.roleId,
      date: s.date,
      start: formatMinute(s.startMinute),
      end: formatMinute(s.endMinute),
      break_minutes: s.breakMinutes,
      paid_hours: round2(shiftPaidHours(s)),
      cost: round2(costs.get(s.siteId)?.shifts.get(s.id)?.total ?? 0),
      published: Boolean(s.published),
      started: hasStarted(s, d.now),
    }));
}

function makeShift(d: RotaDraft, base: Omit<Shift, 'breakMinutes'>): Shift {
  const employee = d.state.employees.find((e) => e.id === base.employeeId);
  if (!employee) throw new ToolInputError(`No one with id ${base.employeeId}.`);
  if (!canWorkAt(employee, base.siteId)) {
    throw new ToolInputError(`${employee.name} is not on ${siteName(d, base.siteId)}'s team and has not agreed to cover it.`);
  }
  if (hasStarted(base, d.now)) throw new ToolInputError('That time has already started. Only future hours can be rostered.');
  if (!weekDates(d.weekStart).includes(base.date)) throw new ToolInputError(`${base.date} is not in the week commencing ${d.weekStart}.`);
  const length = base.endMinute - base.startMinute;
  if (length <= 0) throw new ToolInputError('Shift must end after it starts.');
  if (length > 16 * 60) throw new ToolInputError('Shift is longer than 16 hours.');
  return { ...base, breakMinutes: requiredBreakMinutes(length, ageOn(employee.dateOfBirth, base.date)) };
}

function endAfter(start: number, end: number) {
  return end <= start ? end + 1440 : end;
}

export function executeRotaTool(d: RotaDraft, name: string, raw: unknown): ToolOutcome {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  try {
    switch (name) {
      case 'get_rota_status':
        return { result: rotaStatus(d, scopeArg(d, input)), label: 'Checked labour % and cover' };

      case 'list_team': {
        const siteId = siteArg(d, input);
        return { result: team(d, siteId), label: d.siteIds.length > 1 ? `Read the ${siteName(d, siteId)} team` : 'Read the team' };
      }

      case 'get_people_insights':
        return { result: insightsFor(d, scopeArg(d, input)), label: 'Read the last four weeks: fairness, reliability, holiday' };

      case 'list_shifts':
        return { result: shiftList(d, scopeArg(d, input), optStr(input, 'date')), label: 'Read the shifts' };

      case 'build_from_forecast': {
        const exclude = Array.isArray(input.exclude_employee_ids) ? input.exclude_employee_ids.map(String) : [];
        const allowCover = input.allow_cover !== false;
        const siteIds = Array.isArray(input.site_ids) && input.site_ids.length
          ? input.site_ids.map((id) => siteArg(d, { site_id: id }))
          : d.siteIds;
        const before = siteCost(d);
        const state = { ...d.state, employees: d.state.employees.filter((e) => !exclude.includes(e.id)) };
        const built = buildSites(state, siteIds, d.weekStart, allowCover);
        // The build fills the whole week; hours already gone stay as they happened.
        const late = new Set(built.added.filter((s) => hasStarted(s, d.now)).map((s) => s.id));
        built.added = built.added.filter((s) => !late.has(s.id));
        built.unfilled = built.unfilled.filter((g) => !hasStarted({ date: g.date, startMinute: g.toHour * 60 - 1 }, d.now));
        d.state = { ...d.state, shifts: built.shifts.filter((s) => !late.has(s.id)) };
        return {
          result: {
            shifts_added: built.added.length,
            borrowed_from_other_sites: built.added.filter((s) => d.state.employees.find((e) => e.id === s.employeeId)?.siteId !== s.siteId).length,
            cost_added: round2(siteCost(d) - before),
            unfilled: built.unfilled.map((g) => ({ site_id: g.siteId, date: g.date, role_id: g.roleId, from_hour: g.fromHour, to_hour: g.toHour })),
          },
          label: `Built from forecast: ${built.added.length} shifts${built.unfilled.length ? `, ${built.unfilled.length} gaps unfilled` : ''}`,
        };
      }

      case 'add_shift': {
        const siteId = siteArg(d, input);
        const employeeId = str(input, 'employee_id');
        const roleId = str(input, 'role_id');
        if (!d.state.roles.some((r) => r.id === roleId)) throw new ToolInputError(`No role with id ${roleId}.`);
        const start = clock(str(input, 'start'), 'start');
        const shift = makeShift(d, {
          id: newId(),
          employeeId,
          roleId,
          siteId,
          date: str(input, 'date'),
          startMinute: start,
          endMinute: endAfter(start, clock(str(input, 'end'), 'end')),
        });
        const outcome = applyChecked(d, [...d.state.shifts, shift], [employeeId]);
        if (!outcome.ok) return refused(`Refused: ${describe(d, shift)}`, outcome.reasons);
        return {
          result: { added: true, shift_id: shift.id, cost_added: outcome.delta, warnings: outcome.warnings },
          label: `Added ${describe(d, shift)}`,
        };
      }

      case 'update_shift': {
        const id = str(input, 'shift_id');
        const current = weekShifts(d).find((s) => s.id === id);
        if (!current) throw new ToolInputError(`No shift ${id} this week.`);
        if (hasStarted(current, d.now)) throw new ToolInputError('That shift has started, so it stays as it is.');
        const startClock = optStr(input, 'start');
        const endClock = optStr(input, 'end');
        const start = startClock ? clock(startClock, 'start') : current.startMinute;
        const end = endClock ? endAfter(start, clock(endClock, 'end')) : current.endMinute;
        const shift = makeShift(d, {
          ...current,
          employeeId: optStr(input, 'employee_id') ?? current.employeeId,
          startMinute: start,
          endMinute: end,
          published: false,
        });
        const next = d.state.shifts.map((s) => (s.id === id ? shift : s));
        const outcome = applyChecked(d, next, [shift.employeeId]);
        if (!outcome.ok) return refused(`Refused change to ${describe(d, current)}`, outcome.reasons);
        return {
          result: { updated: true, cost_change: outcome.delta, warnings: outcome.warnings },
          label: `Changed to ${describe(d, shift)}`,
        };
      }

      case 'remove_shift': {
        const id = str(input, 'shift_id');
        const current = weekShifts(d).find((s) => s.id === id);
        if (!current) throw new ToolInputError(`No shift ${id} this week.`);
        if (hasStarted(current, d.now)) throw new ToolInputError('That shift has started, so it stays as it is.');
        const before = siteCost(d);
        d.state = { ...d.state, shifts: d.state.shifts.filter((s) => s.id !== id) };
        return { result: { removed: true, saving: round2(before - siteCost(d)) }, label: `Removed ${describe(d, current)}` };
      }

      case 'clear_week': {
        const scope = scopeArg(d, input);
        const ids = new Set(weekShifts(d, scope).filter((s) => !hasStarted(s, d.now)).map((s) => s.id));
        const kept = weekShifts(d, scope).length - ids.size;
        d.state = { ...d.state, shifts: d.state.shifts.filter((s) => !ids.has(s.id)) };
        return { result: { removed: ids.size, kept_because_started: kept }, label: `Cleared ${ids.size} shifts` };
      }

      default:
        return { result: { error: `Unknown tool ${name}.` }, label: `Unknown tool ${name}`, isError: true };
    }
  } catch (err) {
    if (err instanceof ToolInputError) return { result: { error: err.message }, label: `Rejected input: ${err.message}`, isError: true };
    throw err;
  }
}

/**
 * Builds the given sites. With cover, each site is first filled from its own team and only then do
 * sites borrow from one another (autoScheduleSites). Without, each site uses its own team alone.
 */
function buildSites(state: RotaState, siteIds: string[], weekStart: string, allowCover: boolean): AutoScheduleResult {
  if (allowCover) return autoScheduleSites(state, siteIds, weekStart);
  let shifts = state.shifts;
  const result: AutoScheduleResult = { shifts, added: [], unfilled: [] };
  for (const siteId of siteIds) {
    const one = autoSchedule({ ...state, shifts }, siteId, weekStart, { allowCover: false });
    shifts = one.shifts;
    result.added.push(...one.added);
    result.unfilled.push(...one.unfilled);
  }
  return { ...result, shifts };
}

function refused(label: string, reasons: string[]): ToolOutcome {
  return { result: { refused: true, blocking_issues: reasons }, label: `${label} (${reasons[0]})`, isError: true };
}
