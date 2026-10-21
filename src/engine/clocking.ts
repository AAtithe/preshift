import type { ClockRecord, GeoPoint, RotaState, Shift } from './types';
import { formatMinute } from './time';

export interface ClockPolicy {
  /** How early before a rostered start someone may clock in. */
  earlyWindowMinutes: number;
  /** Clock-in radius when a site does not set its own. */
  defaultGeofenceMetres: number;
}

export const DEFAULT_CLOCK_POLICY: ClockPolicy = { earlyWindowMinutes: 10, defaultGeofenceMetres: 150 };

const EARTH_RADIUS_METRES = 6_371_000;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance between two points, in metres. */
export function distanceMetres(a: GeoPoint, b: GeoPoint): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.sqrt(h));
}

export type ClockInCheck =
  | { ok: true; shift?: Shift; warnings: string[] }
  | { ok: false; reason: string };

/**
 * Decides whether someone may clock in now. The controls are what stop the
 * rota-to-payroll gap opening in the first place: you clock in at the site,
 * against your shift, no more than a few minutes before it starts. Time is
 * never rounded; what is clocked is what is paid, which keeps the site on the
 * right side of minimum wage law. A missing location means a manager is
 * clocking the person in by hand, which is allowed but flagged.
 */
export function checkClockIn(
  state: Pick<RotaState, 'sites' | 'employees' | 'shifts' | 'clocks'>,
  employeeId: string,
  siteId: string,
  date: string,
  minute: number,
  position?: GeoPoint,
  policy: ClockPolicy = DEFAULT_CLOCK_POLICY,
): ClockInCheck {
  const employee = state.employees.find((e) => e.id === employeeId);
  const site = state.sites.find((s) => s.id === siteId);
  if (!employee || !site) return { ok: false, reason: 'Unknown person or site.' };
  if (state.clocks.some((c) => c.employeeId === employeeId && c.clockOut === undefined)) {
    return { ok: false, reason: 'Already clocked in. Clock out of the open shift first.' };
  }
  if (employee.leave.includes(date)) return { ok: false, reason: 'On approved leave today.' };

  const warnings: string[] = [];
  if (!position) {
    warnings.push('No location: clocked in by a manager.');
  } else if (site.location) {
    const radius = site.geofenceMetres ?? policy.defaultGeofenceMetres;
    const away = distanceMetres(position, site.location);
    if (away > radius) return { ok: false, reason: `${Math.round(away)}m from ${site.name}. Clock in on site.` };
  }

  const clocked = new Set(state.clocks.map((c) => c.shiftId));
  const today = state.shifts
    .filter((s) => s.employeeId === employeeId && s.siteId === siteId && s.date === date && !clocked.has(s.id))
    .sort((a, b) => a.startMinute - b.startMinute);
  const current = today.find((s) => minute >= s.startMinute - policy.earlyWindowMinutes && minute < s.endMinute);
  if (current) return { ok: true, shift: current, warnings };

  const next = today.find((s) => s.startMinute > minute);
  if (next) {
    return {
      ok: false,
      reason: `Shift starts at ${formatMinute(next.startMinute)}. Clock in from ${formatMinute(next.startMinute - policy.earlyWindowMinutes)}.`,
    };
  }
  warnings.push('Not on the rota: needs manager approval before payroll.');
  return { ok: true, warnings };
}

export function startClock(
  employeeId: string,
  siteId: string,
  roleId: string,
  date: string,
  minute: number,
  shift: Shift | undefined,
  source: ClockRecord['source'],
): ClockRecord {
  return {
    id: `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    employeeId,
    siteId,
    roleId: shift?.roleId ?? roleId,
    shiftId: shift?.id,
    date,
    clockIn: minute,
    breakMinutes: 0,
    source,
  };
}

/** Closes an open clocking. A clock-out earlier in the day than the clock-in is after midnight. */
export function endClock(record: ClockRecord, minute: number, breakMinutes: number): ClockRecord {
  const clockOut = minute <= record.clockIn ? minute + 1440 : minute;
  return { ...record, clockOut, breakMinutes: Math.min(breakMinutes, clockOut - record.clockIn) };
}
