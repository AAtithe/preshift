import { addDays } from '../engine/time';
import { dropBlocker } from '../engine/candidates';
import type { Employee, Shift } from '../engine/types';

/** Shifts snap to quarter hours. */
export const SNAP_MINUTES = 15;
/** Horizontal pixels of pointer travel per snap step when resizing. */
export const PX_PER_SNAP = 6;
export const MIN_SHIFT_MINUTES = 60;
/**
 * Latest finish allowed: the end of the next day, as far as a shift can run. Night shifts finish in
 * the morning (22:00 to 08:00) and a site open round the clock can have one finish later still.
 */
export const LATEST_END = 2 * 1440;

export type Edge = 'start' | 'end';

const snap = (m: number) => Math.round(m / SNAP_MINUTES) * SNAP_MINUTES;

/** Turn pointer travel into whole snap steps of minutes. */
export function pixelsToMinutes(dx: number): number {
  return Math.round(dx / PX_PER_SNAP) * SNAP_MINUTES;
}

/** Move one edge of a shift, keeping it at least an hour long and inside the trading day. */
export function resizeShift(shift: Shift, edge: Edge, deltaMinutes: number): Shift {
  if (edge === 'start') {
    const start = Math.min(Math.max(0, snap(shift.startMinute + deltaMinutes)), shift.endMinute - MIN_SHIFT_MINUTES);
    return { ...shift, startMinute: start };
  }
  const end = Math.max(Math.min(LATEST_END, snap(shift.endMinute + deltaMinutes)), shift.startMinute + MIN_SHIFT_MINUTES);
  return { ...shift, endMinute: end };
}

/** Slide a whole shift earlier or later, keeping its length. */
export function nudgeShift(shift: Shift, deltaMinutes: number): Shift {
  const length = shift.endMinute - shift.startMinute;
  const start = Math.min(Math.max(0, snap(shift.startMinute + deltaMinutes)), LATEST_END - length);
  return { ...shift, startMinute: start, endMinute: start + length };
}

/**
 * Hand a shift to another person or day. The role is kept when the new person is trained
 * for it, otherwise it falls back to their primary role so the shift stays workable.
 */
export function moveShift(shift: Shift, to: Employee, date: string): Shift {
  const roleId = to.roleIds.includes(shift.roleId) ? shift.roleId : to.roleIds[0];
  return { ...shift, employeeId: to.id, date, roleId };
}

/** A shift's times, break and role, held to drop on other people and days: copied from a shift or a shift type. */
export interface ShiftTemplate {
  /** What it is called back to the person: the shift type's name, or the role of the shift copied. */
  label: string;
  startMinute: number;
  endMinute: number;
  breakMinutes: number;
  /** Absent: the person's own role. */
  roleId?: string;
  areaId?: string;
}

export function templateOf(shift: Shift, label: string): ShiftTemplate {
  const { startMinute, endMinute, breakMinutes, roleId, areaId } = shift;
  return { label, startMinute, endMinute, breakMinutes, roleId, ...(areaId ? { areaId } : {}) };
}

/**
 * A new shift from a template for one person on one day. The role is kept when they are trained for
 * it, as a moved shift's is; otherwise it is their primary role, and the area goes with the role.
 */
export function pasteShift(template: ShiftTemplate, to: Employee, date: string, siteId: string, id: string): Shift {
  const kept = !!template.roleId && to.roleIds.includes(template.roleId);
  return {
    id,
    employeeId: to.id,
    roleId: kept ? template.roleId! : to.roleIds[0],
    siteId,
    date,
    startMinute: template.startMinute,
    endMinute: template.endMinute,
    breakMinutes: template.breakMinutes,
    ...(kept && template.areaId ? { areaId: template.areaId } : {}),
  };
}

export function sameShift(a: Shift, b: Shift): boolean {
  return (
    a.employeeId === b.employeeId &&
    a.date === b.date &&
    a.roleId === b.roleId &&
    a.startMinute === b.startMinute &&
    a.endMinute === b.endMinute
  );
}

// Leave and availability stops are shared with the shift picker and cover requests.
export { dropBlocker };

export interface KeyPress {
  key: string;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * Keyboard equivalent of dragging: Alt+Left/Right moves a day within the week, Alt+Up/Down
 * moves 15 minutes, Alt+Shift+Up/Down changes the finish. Returns null for other keys.
 */
export function keyChange(press: KeyPress, shift: Shift, dates: string[], person: Employee | undefined) {
  if (!press.altKey) return null;
  let next: Shift | null = null;
  if (press.key === 'ArrowLeft' || press.key === 'ArrowRight') {
    const date = addDays(shift.date, press.key === 'ArrowLeft' ? -1 : 1);
    if (dates.includes(date)) next = { ...shift, date };
  } else if (press.key === 'ArrowUp' || press.key === 'ArrowDown') {
    const step = press.key === 'ArrowUp' ? -SNAP_MINUTES : SNAP_MINUTES;
    next = press.shiftKey ? resizeShift(shift, 'end', step) : nudgeShift(shift, step);
  }
  if (!next || sameShift(next, shift)) return null;
  const reason = person && !dropBlocker(person, shift) ? dropBlocker(person, next) : null;
  return { next, reason };
}
