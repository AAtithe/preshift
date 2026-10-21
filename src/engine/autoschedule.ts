import type { RotaState, Shift } from './types';
import { checkEmployeeWeek, requiredBreakMinutes } from './compliance';
import { shiftPaidMinutes } from './cost';
import { dayDemand, forecastSalesForDay } from './demand';
import { isEmployedOn } from './employees';
import { addDays, ageOn, weekDates, weekStart } from './time';
import { travelIssues } from './travel';

export interface AutoScheduleOptions {
  minShiftHours: number;
  maxShiftHours: number;
  /** Borrow people from other sites who have said they will cover this one. */
  allowCover: boolean;
}

export interface UnfilledGap {
  siteId: string;
  date: string;
  roleId: string;
  fromHour: number;
  toHour: number;
}

export interface AutoScheduleResult {
  shifts: Shift[];
  added: Shift[];
  unfilled: UnfilledGap[];
}

const DEFAULTS: AutoScheduleOptions = { minShiftHours: 4, maxShiftHours: 9, allowCover: true };

let seq = 0;
const newId = () => `auto-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/**
 * Fills the gaps between forecast demand and the current rota. It keeps every
 * existing shift, then for each role and day builds shifts across the hours
 * that are short and gives each one to the person who costs least to add:
 * people still under their guaranteed hours first (already paid for), then
 * the lowest hourly rate, then whoever has the fewest hours so the work is
 * shared. Nobody is given a shift that would break a blocking compliance rule.
 */
export function autoSchedule(
  state: RotaState,
  siteId: string,
  weekStartDate: string,
  options: Partial<AutoScheduleOptions> = {},
): AutoScheduleResult {
  const opts = { ...DEFAULTS, ...options };
  const site = state.sites.find((s) => s.id === siteId);
  if (!site) return { shifts: state.shifts, added: [], unfilled: [] };

  let shifts = [...state.shifts];
  const added: Shift[] = [];
  const unfilled: UnfilledGap[] = [];
  const rules = state.demandRules.filter((r) => r.siteId === siteId);
  const closeHour = Math.ceil(site.closeMinute / 60);

  // Busiest days first, so the weekend gets first call on people before weekly limits bite.
  const days = weekDates(weekStartDate).sort(
    (a, b) => forecastSalesForDay(state, siteId, b) - forecastSalesForDay(state, siteId, a),
  );
  for (const date of days) {
    for (const rule of rules) {
      for (let guard = 0; guard < 50; guard++) {
        const demand = dayDemand({ ...state, shifts }, siteId, rule.roleId, date);
        // Fill the peak first: the hour most short of people, then grow the shift either side of it.
        const first = demand.reduce<(typeof demand)[number] | null>(
          (best, d) => (d.gap > 0 && (!best || d.gap > best.gap) ? d : best),
          null,
        );
        if (!first) break;

        let start = first.hour;
        let end = first.hour + 1;
        while (end - start < opts.maxShiftHours) {
          const right = end < 24 && demand[end].gap > 0;
          const left = start > 0 && demand[start - 1].gap > 0;
          if (!right && !left) break;
          if (right && (!left || demand[end].gap >= demand[start - 1].gap)) end++;
          else start--;
        }
        // Pad short blocks to a minimum shift: forward to close, then backward to open.
        while (end - start < opts.minShiftHours && end < closeHour) end++;
        while (end - start < opts.minShiftHours && start * 60 > site.openMinute) start--;

        const candidate = pickEmployee(state, shifts, opts.allowCover, {
          siteId,
          roleId: rule.roleId,
          date,
          startMinute: start * 60,
          endMinute: end * 60,
        });
        if (!candidate) {
          unfilled.push({ siteId, date, roleId: rule.roleId, fromHour: start, toHour: end });
          // Mark these hours as handled so we move on to the next gap.
          const placeholder: Shift = {
            id: `unfilled-${date}-${rule.roleId}-${start}`,
            employeeId: '__unfilled__',
            roleId: rule.roleId,
            siteId,
            date,
            startMinute: start * 60,
            endMinute: end * 60,
            breakMinutes: 0,
          };
          shifts.push(placeholder);
          continue;
        }
        shifts.push(candidate);
        added.push(candidate);
      }
    }
  }
  shifts = shifts.filter((s) => s.employeeId !== '__unfilled__');
  shifts = trimOverstaffedEdges({ ...state, shifts }, new Set(added.map((s) => s.id)), opts.minShiftHours);
  const addedIds = new Set(added.map((s) => s.id));
  return { shifts, added: shifts.filter((s) => addedIds.has(s.id)), unfilled: mergeGaps(unfilled) };
}

/**
 * Builds several sites together. The first pass fills every site from its own
 * team, so each site has first call on its people. The second pass fills what
 * is left with cover from other sites. Sites go busiest first in both passes.
 */
export function autoScheduleSites(
  state: RotaState,
  siteIds: string[],
  weekStartDate: string,
  options: Partial<AutoScheduleOptions> = {},
): AutoScheduleResult {
  const weekSales = (siteId: string) =>
    weekDates(weekStartDate).reduce((sum, d) => sum + forecastSalesForDay(state, siteId, d), 0);
  const order = [...siteIds].sort((a, b) => weekSales(b) - weekSales(a));
  let shifts = state.shifts;
  const added: Shift[] = [];
  let unfilled: UnfilledGap[] = [];
  for (const allowCover of [false, true]) {
    unfilled = [];
    for (const siteId of order) {
      const result = autoSchedule({ ...state, shifts }, siteId, weekStartDate, { ...options, allowCover });
      shifts = result.shifts;
      added.push(...result.added);
      unfilled.push(...result.unfilled);
    }
  }
  const ids = new Set(shifts.map((s) => s.id));
  return { shifts, added: added.filter((s) => ids.has(s.id)), unfilled };
}

/**
 * Padding to a minimum shift length leaves people on at the quiet edges of a
 * shift. Shave an hour off either end of the new shifts while that hour is
 * overstaffed, so the rota pays for cover only where the forecast needs it.
 */
function trimOverstaffedEdges(state: RotaState, ids: Set<string>, minShiftHours: number): Shift[] {
  let shifts = state.shifts;
  for (const id of ids) {
    for (let guard = 0; guard < 24; guard++) {
      const shift = shifts.find((s) => s.id === id)!;
      if (shift.endMinute - shift.startMinute <= minShiftHours * 60) break;
      const demand = dayDemand({ ...state, shifts }, shift.siteId, shift.roleId, shift.date);
      const firstHour = Math.floor(shift.startMinute / 60);
      const lastHour = Math.floor((shift.endMinute - 1) / 60);
      let next: Shift | null = null;
      if (demand[firstHour]?.gap < 0) next = { ...shift, startMinute: shift.startMinute + 60 };
      else if (lastHour < 24 && demand[lastHour]?.gap < 0) next = { ...shift, endMinute: shift.endMinute - 60 };
      if (!next) break;
      const employee = state.employees.find((e) => e.id === next!.employeeId)!;
      next.breakMinutes = requiredBreakMinutes(next.endMinute - next.startMinute, ageOn(employee.dateOfBirth, next.date));
      shifts = shifts.map((s) => (s.id === id ? next! : s));
    }
  }
  return shifts;
}

interface Slot {
  siteId: string;
  roleId: string;
  date: string;
  startMinute: number;
  endMinute: number;
}

/** 0 = home site, 1 = another site in the same entity, 2 = another entity (an intercompany recharge). */
export function coverDistance(state: Pick<RotaState, 'sites'>, employee: { siteId: string; entityId: string }, siteId: string): number {
  if (employee.siteId === siteId) return 0;
  const site = state.sites.find((s) => s.id === siteId);
  return site?.entityId === employee.entityId ? 1 : 2;
}

function pickEmployee(state: RotaState, shifts: Shift[], allowCover: boolean, slot: Slot): Shift | null {
  const ws = weekStart(slot.date);
  const week = new Set(weekDates(ws));
  const ranked = state.employees
    .filter((e) => e.siteId === slot.siteId || (allowCover && e.coverSiteIds.includes(slot.siteId)))
    .filter((e) => e.roleIds.includes(slot.roleId) && e.payBasis === 'hourly')
    .filter((e) => isEmployedOn(e, slot.date))
    .filter((e) => !shifts.some((s) => s.employeeId === e.id && s.date === slot.date))
    .map((e) => {
      const hours = shifts
        .filter((s) => s.employeeId === e.id && week.has(s.date))
        .reduce((sum, s) => sum + shiftPaidMinutes(s), 0) / 60;
      const underContract = hours < e.contractedHours;
      const primary = e.roleIds[0] === slot.roleId;
      return { e, hours, underContract, primary, distance: coverDistance(state, e, slot.siteId) };
    })
    // Guaranteed hours already paid for win wherever they are; otherwise the home team first,
    // then a sister site in the same company, and only then another company, which costs a recharge.
    .sort(
      (a, b) =>
        Number(b.underContract) - Number(a.underContract) ||
        a.distance - b.distance ||
        Number(b.primary) - Number(a.primary) ||
        a.e.hourlyRate - b.e.hourlyRate ||
        a.hours - b.hours,
    );

  for (const { e } of ranked) {
    const length = slot.endMinute - slot.startMinute;
    const shift: Shift = {
      id: newId(),
      employeeId: e.id,
      ...slot,
      breakMinutes: requiredBreakMinutes(length, ageOn(e.dateOfBirth, slot.date)),
    };
    const context = shifts.filter((s) => s.date >= addDays(ws, -1) && s.date <= addDays(ws, 7));
    const issues = [...checkEmployeeWeek(e, ws, [...context, shift]), ...travelIssues(e, [...context, shift], state.sites)].filter(
      (i) => i.shiftId === shift.id || i.code === 'young-weekly' || i.code === 'max-hours' || i.code === 'wtr-48' || i.code === 'weekly-rest',
    );
    // Auto-build never creates a breach: anything flagged on the new shift rules the person out,
    // except being under contract, which the shift itself is helping to fix.
    if (issues.length === 0) return shift;
  }
  return null;
}

function mergeGaps(gaps: UnfilledGap[]): UnfilledGap[] {
  const out: UnfilledGap[] = [];
  const sorted = [...gaps].sort(
    (a, b) =>
      a.siteId.localeCompare(b.siteId) || a.date.localeCompare(b.date) || a.roleId.localeCompare(b.roleId) || a.fromHour - b.fromHour,
  );
  for (const g of sorted) {
    const last = out[out.length - 1];
    if (last && last.siteId === g.siteId && last.date === g.date && last.roleId === g.roleId && last.toHour >= g.fromHour) {
      last.toHour = Math.max(last.toHour, g.toHour);
    } else out.push({ ...g });
  }
  return out;
}
