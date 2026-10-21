import { checkEmployeeWeek, requiredBreakMinutes, type Issue } from '../engine/compliance';
import { employeeWeekCost, shiftsInWeek, weekCost } from '../engine/cost';
import { dayDemand } from '../engine/demand';
import { addDays, absoluteMinute, ageOn, formatMinute, weekStart } from '../engine/time';
import type { Employee, RotaState, Shift } from '../engine/types';
import { dropBlocker, MIN_SHIFT_MINUTES, SNAP_MINUTES } from './drag';

/** A shift being drawn on the timeline, before anyone is put on it. */
export interface Opening {
  siteId: string;
  roleId: string;
  date: string;
  startMinute: number;
  endMinute: number;
}

export interface Candidate {
  employee: Employee;
  shift: Shift;
  /** What adding this shift does to the group's loaded labour cost for this person's week. */
  marginal: number;
  /** What it adds to the labour of the site the shift is at, which is what that site's labour % sees. */
  siteCost: number;
  /** Works for another site and would be borrowed. */
  borrowed: boolean;
  homeSite: string;
  trained: boolean;
  /** Why this person cannot take the shift, or null when they can. */
  blocker: string | null;
  /** Things to review that do not stop the shift, such as going over a soft limit. */
  warnings: Issue[];
}

const DEFAULT_LENGTH = 4 * 60;
const MAX_GAP_SHIFT = 8 * 60;
const snap = (m: number) => Math.round(m / SNAP_MINUTES) * SNAP_MINUTES;

/** Turn a drawn range into an opening: snapped, at least an hour, earliest edge first. */
export function rangeFromDraw(a: number, b: number, roleId: string, siteId: string, date: string): Opening {
  let start = snap(Math.min(a, b));
  let end = snap(Math.max(a, b));
  // A click rather than a drag starts a standard four hour block on the hour.
  if (end - start < SNAP_MINUTES) {
    start = Math.floor(Math.min(a, b) / 60) * 60;
    end = start + DEFAULT_LENGTH;
  }
  if (end - start < MIN_SHIFT_MINUTES) end = start + MIN_SHIFT_MINUTES;
  return { siteId, roleId, date, startMinute: start, endMinute: end };
}

/** The role with the deepest shortfall across a time range, for the picker's default. */
export function shortestRole(state: RotaState, siteId: string, date: string, startMinute: number, endMinute: number): string | null {
  let best: string | null = null;
  let worst = 0;
  for (const rule of state.demandRules.filter((r) => r.siteId === siteId)) {
    const short = dayDemand(state, siteId, rule.roleId, date)
      .filter((h) => h.hour * 60 >= startMinute && h.hour * 60 < endMinute)
      .reduce((sum, h) => sum + Math.max(0, h.gap), 0);
    if (short > worst) {
      worst = short;
      best = rule.roleId;
    }
  }
  return best;
}

/**
 * Clicking a short hour fills the gap: the run of short hours for the shortest role from that
 * hour on, at least a standard block and at most a full shift.
 */
export function openingForGap(state: RotaState, siteId: string, date: string, hour: number): Opening | null {
  const roleId = shortestRole(state, siteId, date, hour * 60, hour * 60 + 60);
  if (!roleId) return null;
  const rows = dayDemand(state, siteId, roleId, date);
  let end = hour;
  while (end < 24 && rows[end].gap > 0 && (end + 1 - hour) * 60 <= MAX_GAP_SHIFT) end++;
  const length = Math.min(MAX_GAP_SHIFT, Math.max(DEFAULT_LENGTH, (end - hour) * 60));
  return { siteId, roleId, date, startMinute: hour * 60, endMinute: hour * 60 + length };
}

/** A gap shorter than this between shifts at two sites is flagged as too tight to travel. */
export const TRAVEL_MINUTES = 60;

/**
 * Everyone who could work an opening, cheapest legal person first: the site's own team, then
 * people who could be borrowed from other sites. Cost is the change to the person's whole loaded
 * week, so someone short of their contracted hours can cost the group nothing, and someone already
 * over the NI threshold costs more than their rate suggests. The site cost is the share the shift
 * moves onto this site's labour, because cost follows the work.
 */
export function candidates(state: RotaState, opening: Opening, id: string): Candidate[] {
  const ws = weekStart(opening.date);
  const siteName = (siteId: string) => state.sites.find((x) => x.id === siteId)?.name ?? siteId;
  const context = state.shifts.filter((s) => s.date >= addDays(ws, -1) && s.date <= addDays(ws, 7));
  return state.employees
    .map((employee) => {
      const length = opening.endMinute - opening.startMinute;
      const shift: Shift = {
        id,
        employeeId: employee.id,
        roleId: opening.roleId,
        siteId: opening.siteId,
        date: opening.date,
        startMinute: opening.startMinute,
        endMinute: opening.endMinute,
        breakMinutes: requiredBreakMinutes(length, ageOn(employee.dateOfBirth, opening.date)),
      };
      const week = shiftsInWeek(state.shifts, ws).filter((s) => s.employeeId === employee.id);
      const marginal = employeeWeekCost(employee, [...week, shift]).total - employeeWeekCost(employee, week).total;
      const atSite = (shifts: Shift[]) => weekCost({ employees: [employee], shifts }, ws, opening.siteId).total;
      const siteCost = atSite([...week, shift]) - atSite(week);
      const issues = checkEmployeeWeek(employee, ws, [...context, shift]).filter((i) => i.shiftId === shift.id);
      const trained = employee.roleIds.includes(opening.roleId);
      const blocker = dropBlocker(employee, shift) ?? issues.find((i) => i.severity === 'block')?.message ?? null;
      const warnings = issues.filter((i) => i.severity === 'warn' && i.code !== 'not-trained');
      const travel = travelWarning(employee, shift, context, siteName);
      if (travel) warnings.unshift(travel);
      const borrowed = employee.siteId !== opening.siteId;
      return { employee, shift, marginal, siteCost, trained, blocker, warnings, borrowed, homeSite: siteName(employee.siteId) };
    })
    .sort((a, b) => rank(a) - rank(b) || a.marginal - b.marginal || a.employee.name.localeCompare(b.employee.name));
}

/** Flags a same-day shift at another site that leaves too little time to get between them. */
export function travelWarning(employee: Employee, shift: Shift, shifts: Shift[], siteName: (id: string) => string): Issue | null {
  const anchor = shift.date;
  const start = absoluteMinute(anchor, shift.date, shift.startMinute);
  const end = absoluteMinute(anchor, shift.date, shift.endMinute);
  for (const other of shifts) {
    if (other.employeeId !== employee.id || other.siteId === shift.siteId || other.id === shift.id) continue;
    const oStart = absoluteMinute(anchor, other.date, other.startMinute);
    const oEnd = absoluteMinute(anchor, other.date, other.endMinute);
    const gap = Math.max(start - oEnd, oStart - end);
    if (gap >= 0 && gap < TRAVEL_MINUTES) {
      return {
        code: 'travel',
        severity: 'warn',
        employeeId: employee.id,
        shiftId: shift.id,
        date: shift.date,
        message: `Also at ${siteName(other.siteId)} ${formatMinute(other.startMinute)}-${formatMinute(other.endMinute)}, ${gap} minutes to get across.`,
      };
    }
  }
  return null;
}

/** Trained and clear first, then trained with something to review, then the rest. */
function rank(c: Candidate) {
  if (c.blocker) return 3;
  if (!c.trained) return 2;
  return c.warnings.length ? 1 : 0;
}
