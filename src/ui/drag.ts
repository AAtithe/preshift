import type { Employee, Shift } from '../engine/types';

/** Shifts snap to quarter hours. */
export const SNAP_MINUTES = 15;
/** Horizontal pixels of pointer travel per snap step when resizing. */
export const PX_PER_SNAP = 6;
export const MIN_SHIFT_MINUTES = 60;
/** Latest finish allowed: 06:00 the next morning. */
export const LATEST_END = 1440 + 6 * 60;

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

export function sameShift(a: Shift, b: Shift): boolean {
  return (
    a.employeeId === b.employeeId &&
    a.date === b.date &&
    a.roleId === b.roleId &&
    a.startMinute === b.startMinute &&
    a.endMinute === b.endMinute
  );
}
