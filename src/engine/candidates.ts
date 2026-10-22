// Who could work a shift: the site's own team, then people agreed to cover it from other sites,
// cheapest legal person first. Shared by the shift picker on the rota and by cover requests, so a
// person asked to cover is exactly a person the picker would have offered.

import { breakFor, checkEmployeeWeek, complianceOptions, isAvailable, type Issue } from './compliance';
import { employeeWeekCost, shiftsInWeek, weekCost } from './cost';
import { employedShare, isEmployedOn } from './employees';
import { addDays, formatMinute, weekday, weekStart } from './time';
import { journeyBetween, travelIssues, type Journey } from './travel';
import type { Employee, RotaState, Shift } from './types';

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
  /** Employed by a different company from the host site's, so the shift is an intercompany recharge. */
  intercompany: boolean;
  /** The journey from their home site, for someone borrowed. */
  journey: Journey | null;
  /** Paid travel this shift adds, from another site the same day; already in the costs. */
  travelMinutes: number;
  trained: boolean;
  /** Why this person cannot take the shift, or null when they can. */
  blocker: string | null;
  /** Things to review that do not stop the shift, such as going over a soft limit. */
  warnings: Issue[];
}

const DAY_NAMES = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'];

/**
 * Why a shift may not be dropped on this person and day, or null when it can.
 * Leave and stated availability are hard stops for a drag; a manager who has agreed
 * an exception can still set it in the shift editor, where it is flagged.
 */
export function dropBlocker(employee: Employee, shift: Shift): string | null {
  const first = employee.name.split(' ')[0];
  if (employee.leave.includes(shift.date)) return `${first} is on approved leave that day.`;
  if (isAvailable(employee, shift)) return null;
  const day = weekday(shift.date);
  const windows = employee.availability.filter((a) => a.weekday === day);
  if (windows.length === 0) return `${first} is not available on ${DAY_NAMES[day]}.`;
  const times = windows.map((a) => `${formatMinute(a.fromMinute)}-${formatMinute(a.toMinute)}`).join(', ');
  return `${first} is only available ${times} on ${DAY_NAMES[day]}.`;
}

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
  const host = state.sites.find((x) => x.id === opening.siteId);
  const context = state.shifts.filter((s) => s.date >= addDays(ws, -1) && s.date <= addDays(ws, 7));
  return state.employees
    .filter((e) => isEmployedOn(e, opening.date))
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
        breakMinutes: breakFor(employee, opening.date, length, complianceOptions(state, employee).nation),
      };
      const week = shiftsInWeek(state.shifts, ws).filter((s) => s.employeeId === employee.id);
      const share = employedShare(employee, ws);
      const before = employeeWeekCost(employee, week, undefined, share, state.sites, state.entities);
      const after = employeeWeekCost(employee, [...week, shift], undefined, share, state.sites, state.entities);
      const marginal = after.total - before.total;
      const travelMinutes = Math.round((after.travelHours - before.travelHours) * 60);
      const atSite = (shifts: Shift[]) => weekCost({ employees: [employee], shifts, sites: state.sites, entities: state.entities }, ws, opening.siteId).total;
      const siteCost = atSite([...week, shift]) - atSite(week);
      const issues = [...checkEmployeeWeek(employee, ws, [...context, shift], state.restOverrides, undefined, complianceOptions(state, employee)), ...travelIssues(employee, [...context, shift], state.sites)].filter(
        (i) => i.shiftId === shift.id,
      );
      const trained = employee.roleIds.includes(opening.roleId);
      const borrowed = employee.siteId !== opening.siteId;
      // Cover is set up person by person on their People record, the same rule the auto-build uses.
      const notCover = borrowed && !employee.coverSiteIds.includes(opening.siteId)
        ? `Not set up to cover ${siteName(opening.siteId)}. Add it on their People record.`
        : null;
      const blocker = dropBlocker(employee, shift) ?? notCover ?? issues.find((i) => i.severity === 'block')?.message ?? null;
      const warnings = issues.filter((i) => i.severity === 'warn' && i.code !== 'not-trained');
      // Travel issues lead: a borrowed person's journey is the first thing to know about them.
      warnings.sort((x, y) => Number(y.code.startsWith('travel')) - Number(x.code.startsWith('travel')));
      const intercompany = borrowed && !!host && employee.entityId !== host.entityId;
      const journey = borrowed ? journeyBetween(state.sites, employee.siteId, opening.siteId) : null;
      return { employee, shift, marginal, siteCost, trained, blocker, warnings, borrowed, homeSite: siteName(employee.siteId), intercompany, journey, travelMinutes };
    })
    .sort((a, b) => rank(a) - rank(b) || a.marginal - b.marginal || a.employee.name.localeCompare(b.employee.name));
}

/** Trained and clear first, then trained with something to review, then the rest. */
function rank(c: Candidate) {
  if (c.blocker) return 3;
  if (!c.trained) return 2;
  return c.warnings.length ? 1 : 0;
}
