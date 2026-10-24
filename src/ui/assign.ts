import { dayDemand } from '../engine/demand';
import type { Opening } from '../engine/candidates';
import type { RotaState } from '../engine/types';
import { MIN_SHIFT_MINUTES, SNAP_MINUTES } from './drag';

// Ranking who could work an opening is shared with the server, which asks for cover with it.
export { candidates, type Candidate, type Opening } from '../engine/candidates';

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
  while (end < rows.length && rows[end].gap > 0 && (end + 1 - hour) * 60 <= MAX_GAP_SHIFT) end++;
  const length = Math.min(MAX_GAP_SHIFT, Math.max(DEFAULT_LENGTH, (end - hour) * 60));
  return { siteId, roleId, date, startMinute: hour * 60, endMinute: hour * 60 + length };
}

