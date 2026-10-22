// Staff self-service: what a request asks for, whether the person it would put on a shift may
// legally work it, and how a change to someone's published week reads to them. Every check here
// is the compliance engine's own, so a request can never make a rota the manager could not.

import { checkEmployeeWeek, complianceOptions, type Issue } from './compliance';
import { isEmployedOn } from './employees';
import { ABSENCE_LABEL } from './hr';
import { addDays, daysBetween, formatMinute, parseISODate, weekStart } from './time';
import { travelIssues } from './travel';
import type { AbsenceType, Employee, RotaState, Shift, StaffNotification, StaffRequest } from './types';

/** The longest holiday or time off one request may cover. Longer leave is split, so each part is decided on its merits. */
export const MAX_REQUEST_DAYS = 31;
/** Notifications are a feed, not a record: the audit log is the record. */
export const NOTIFICATION_KEEP_DAYS = 90;
export const NOTIFICATIONS_PER_PERSON = 100;
/** Time off a person may ask for in the app. Sickness is reported, not asked for; unauthorised is a manager's finding. */
export const REQUESTABLE_ABSENCE: AbsenceType[] = ['compassionate', 'dependants', 'family', 'unpaid', 'other'];

export const REQUEST_LABEL: Record<StaffRequest['kind'], string> = {
  holiday: 'Holiday',
  time_off: 'Time off',
  sickness: 'Sickness',
  availability: 'Availability',
  swap: 'Shift swap',
  open_shift: 'Open shift claim',
};

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Mon 26 Oct": how a date reads on a phone. */
export function dayLabel(date: string): string {
  const d = parseISODate(date);
  return `${DAYS[(d.getUTCDay() + 6) % 7]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** Every date from `from` to `to`, inclusive. */
export function datesBetween(from: string, to: string): string[] {
  if (to < from) return [];
  return Array.from({ length: daysBetween(from, to) + 1 }, (_, i) => addDays(from, i));
}

export interface ShiftNames {
  site: (id: string) => string;
  role: (id: string) => string;
}

export const namesOf = (state: Pick<RotaState, 'sites' | 'roles'>): ShiftNames => ({
  site: (id) => state.sites.find((s) => s.id === id)?.name ?? id,
  role: (id) => state.roles.find((r) => r.id === id)?.name ?? id,
});

type Slot = Pick<Shift, 'date' | 'startMinute' | 'endMinute' | 'siteId' | 'roleId'>;

/** "Sat 24 Oct 17:00-23:00, Bar at Marylebone". */
export function shiftLine(s: Slot, names: ShiftNames): string {
  return `${dayLabel(s.date)} ${formatMinute(s.startMinute)}-${formatMinute(s.endMinute)}, ${names.role(s.roleId)} at ${names.site(s.siteId)}`;
}

/** Why this person cannot be put on this slot at all, before any rule is checked, or null. */
export function coverProblem(e: Employee, slot: Pick<Slot, 'siteId' | 'roleId' | 'date'>): string | null {
  if (e.status === 'leaver' || !isEmployedOn(e, slot.date)) return 'not employed on that day';
  if (e.siteId !== slot.siteId && !e.coverSiteIds.includes(slot.siteId)) return 'not set up to work at that site';
  if (!e.roleIds.includes(slot.roleId)) return 'not trained for that role';
  return null;
}

/**
 * The compliance issues a change would add for the people it touches: what the week shows after
 * it that it did not before. `after` is the whole shift list once the change is made. Rest
 * overrides already given still apply, since they belong to the person and the breach.
 */
export function changeIssues(state: RotaState, after: Shift[], employeeIds: string[], dates: string[]): Issue[] {
  const weeks = [...new Set(dates.map(weekStart))];
  const out: Issue[] = [];
  const key = (i: Issue) => `${i.code}|${i.shiftId ?? ''}|${i.date ?? ''}|${i.severity}`;
  for (const id of new Set(employeeIds)) {
    const e = state.employees.find((x) => x.id === id);
    if (!e) continue;
    for (const ws of weeks) {
      const near = (list: Shift[]) => list.filter((s) => s.date >= addDays(ws, -1) && s.date <= addDays(ws, 7));
      const check = (list: Shift[]) => [
        ...checkEmployeeWeek(e, ws, near(list), state.restOverrides ?? [], undefined, complianceOptions(state, e)),
        ...travelIssues(e, near(list), state.sites),
      ];
      const before = new Set(check(state.shifts).map(key));
      out.push(...check(after).filter((i) => !before.has(key(i))));
    }
  }
  return out;
}

export const blocking = (issues: Issue[]) => issues.filter((i) => i.severity === 'block');

/** The shift list once `shiftId` changes hands (and, for an exchange, `returnShiftId` goes the other way). */
export function swapped(state: RotaState, r: Pick<StaffRequest, 'shiftId' | 'returnShiftId' | 'employeeId'>, takerId: string): Shift[] {
  return state.shifts.map((s) => {
    if (s.id === r.shiftId) return { ...s, employeeId: takerId };
    if (r.returnShiftId && s.id === r.returnShiftId) return { ...s, employeeId: r.employeeId };
    return s;
  });
}

/** Everything a swap would add, for both people, and why the taker could not take it at all. */
export function swapCheck(state: RotaState, r: Pick<StaffRequest, 'shiftId' | 'returnShiftId' | 'employeeId'>, takerId: string) {
  const shift = state.shifts.find((s) => s.id === r.shiftId);
  const back = r.returnShiftId ? state.shifts.find((s) => s.id === r.returnShiftId) : undefined;
  const taker = state.employees.find((e) => e.id === takerId);
  const giver = state.employees.find((e) => e.id === r.employeeId);
  if (!shift || !taker || !giver || (r.returnShiftId && !back)) return { problem: 'That shift is no longer on the rota.', issues: [] as Issue[] };
  const problem = coverProblem(taker, shift) ?? (back ? coverProblem(giver, back) : null);
  if (problem) {
    const who = coverProblem(taker, shift) ? taker.name : giver.name;
    return { problem: `${who} is ${problem}.`, issues: [] as Issue[] };
  }
  const issues = changeIssues(state, swapped(state, r, takerId), [takerId, r.employeeId], [shift.date, ...(back ? [back.date] : [])]);
  return { problem: null, issues };
}

/** Whether a person may take an open shift, and what it would add to their week. */
export function claimCheck(state: RotaState, e: Employee, slot: Shift) {
  const problem = coverProblem(e, slot);
  if (problem) return { problem: `${e.name} is ${problem}.`, issues: [] as Issue[] };
  return { problem: null, issues: changeIssues(state, [...state.shifts, { ...slot, employeeId: e.id }], [e.id], [slot.date]) };
}

/** The people who could take a slot without breaking a rule: trained, set up for the site, free and legal. */
export function eligibleFor(state: RotaState, slot: Shift, exclude: string[] = []): Employee[] {
  return state.employees.filter((e) => {
    if (exclude.includes(e.id) || e.status === 'leaver') return false;
    const check = claimCheck(state, e, slot);
    return !check.problem && blocking(check.issues).length === 0;
  });
}

/** Hours a holiday request takes from the balance: each day at its own hours, or a normal day. Days already booked count once. */
export function holidayHours(e: Employee, dates: string[], dayHours: number): number {
  const fresh = dates.filter((d) => !e.leave.includes(d));
  return Math.round(fresh.reduce((sum, d) => sum + (e.holiday?.dayHours?.[d] ?? dayHours), 0) * 100) / 100;
}

/** What a published week reads as to one person: one line per shift, in order. */
export function weekLines(shifts: Shift[], names: ShiftNames): string[] {
  return [...shifts].sort((a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute).map((s) => shiftLine(s, names));
}

/**
 * How a person's published week changed since they were last told: lines added and lines gone.
 * Lines, not ids, so a shift deleted and drawn again at the same time is no change to them.
 */
export function weekChange(before: string[], after: string[]) {
  return { added: after.filter((l) => !before.includes(l)), removed: before.filter((l) => !after.includes(l)) };
}

/** The message for a decided request, as the person reads it. */
export function decisionText(r: StaffRequest, names: ShiftNames, shift?: Slot): { title: string; body: string } {
  const verdict = r.status === 'approved' ? 'approved' : 'declined';
  const dates = r.from ? (r.to && r.to !== r.from ? `${dayLabel(r.from)} to ${dayLabel(r.to)}` : dayLabel(r.from)) : '';
  const what =
    r.kind === 'holiday' ? `Holiday ${dates}`
    : r.kind === 'time_off' ? `${ABSENCE_LABEL[r.absenceType ?? 'other']} ${dates}`
    : r.kind === 'availability' ? 'Your new availability'
    : r.kind === 'swap' ? `Swap of ${shift ? shiftLine(shift, names) : 'your shift'}`
    : r.kind === 'open_shift' ? `Open shift ${shift ? shiftLine(shift, names) : ''}`.trim()
    : `Sickness from ${dates}`;
  const by = r.decidedBy ? ` by ${r.decidedBy}` : '';
  const note = r.decisionNote ? ` ${r.decisionNote}` : '';
  return { title: `${REQUEST_LABEL[r.kind]} ${verdict}`, body: `${what}: ${verdict}${by}.${note}` };
}

/** Keeps each person's feed short: the newest first hundred, nothing older than ninety days. */
export function pruneNotifications(list: StaffNotification[], today: string): StaffNotification[] {
  const cutoff = addDays(today, -NOTIFICATION_KEEP_DAYS);
  const kept = list.filter((n) => n.at.slice(0, 10) >= cutoff);
  const count = new Map<string, number>();
  // Newest first, so the oldest go when someone has too many.
  const newest = [...kept].sort((a, b) => b.at.localeCompare(a.at));
  const keep = new Set(newest.filter((n) => (count.set(n.employeeId, (count.get(n.employeeId) ?? 0) + 1).get(n.employeeId) ?? 0) <= NOTIFICATIONS_PER_PERSON));
  return kept.filter((n) => keep.has(n));
}
