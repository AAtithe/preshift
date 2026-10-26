// Where a point on the Gantt chart sits in time, and where a dragged bar lands. The chart lays
// days side by side, each a lane of the same minutes, so a position across the track is a day and
// a minute of it. Kept apart from the view so the arithmetic is tested on its own.

export interface Lanes {
  /** First minute of every lane. */
  from: number;
  /** Minutes in one lane. */
  lane: number;
  /** Lanes across the track: seven for the week, one for a day. */
  days: number;
}

/** The day and minute at a share of the way across the track, 0 to 1. */
export function pointAt(share: number, { from, lane, days }: Lanes): { day: number; minute: number } {
  const abs = Math.max(0, Math.min(1, share)) * lane * days;
  const day = Math.min(days - 1, Math.floor(abs / lane));
  return { day, minute: from + abs - day * lane };
}

/**
 * A shift slid along the track by some minutes. On the week it crosses into the next or last day
 * once its start passes the edge of its lane; it never leaves the week.
 */
export function slide(day: number, startMinute: number, minutes: number, { from, lane, days }: Lanes): { day: number; startMinute: number } {
  if (days === 1) return { day, startMinute: startMinute + minutes };
  const abs = day * lane + (startMinute - from) + minutes;
  const to = Math.max(0, Math.min(days - 1, Math.floor(abs / lane)));
  return { day: to, startMinute: from + abs - to * lane };
}
