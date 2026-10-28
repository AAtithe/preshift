import { occasionsBetween, type OccasionKind } from '../engine/calendar';
import { formatMinute } from '../engine/time';
import type { LocalEvent, SchoolPeriod } from '../engine/types';

export interface KeyDate {
  label: string;
  kind: OccasionKind | 'event' | 'school';
  /** The longer story, shown on hover: what to do about it. */
  detail?: string;
}

/**
 * What is on each day of the week, for the strip along the top of the rota: bank holidays and
 * trading occasions, local events, and school holidays. A visual reminder only; the forecast
 * already allows for what it can.
 */
export function keyDates(dates: string[], events: LocalEvent[], school: SchoolPeriod[]): Record<string, KeyDate[]> {
  const out: Record<string, KeyDate[]> = Object.fromEntries(dates.map((d) => [d, []]));
  if (dates.length === 0) return out;
  for (const o of occasionsBetween(dates[0], dates[dates.length - 1])) {
    out[o.date]?.push({ label: o.name, kind: o.kind, detail: o.advice });
  }
  for (const e of [...events].sort((a, b) => (a.startMinute ?? -1) - (b.startMinute ?? -1))) {
    const at = e.startMinute === undefined ? '' : `${formatMinute(e.startMinute)} `;
    out[e.date]?.push({ label: `${at}${e.name}`, kind: 'event', detail: e.venue });
  }
  for (const p of school) {
    for (const d of dates) {
      if (d >= p.start && d <= p.end) out[d].push({ label: p.name, kind: 'school', detail: p.source === 'estimate' ? 'School holiday, estimated from the usual pattern.' : 'School holiday.' });
    }
  }
  return out;
}
