import { occasionsBetween, type OccasionKind } from '../engine/calendar';
import { counts, describeEvent } from '../engine/privateEvents';
import { formatMinute } from '../engine/time';
import type { LocalEvent, PrivateEvent, SchoolPeriod } from '../engine/types';

export interface KeyDate {
  label: string;
  kind: OccasionKind | 'event' | 'school' | 'private' | 'private held';
  /** The longer story, shown on hover: what to do about it. */
  detail?: string;
}

/**
 * What is on each day of the week, for the strip along the top of the rota: bank holidays and
 * trading occasions, local events, weddings and functions, and school holidays. A visual reminder
 * only; the forecast already allows for what it can, and demand for confirmed private events.
 */
export function keyDates(dates: string[], events: LocalEvent[], school: SchoolPeriod[], privateEvents: PrivateEvent[] = []): Record<string, KeyDate[]> {
  const out: Record<string, KeyDate[]> = Object.fromEntries(dates.map((d) => [d, []]));
  if (dates.length === 0) return out;
  for (const o of occasionsBetween(dates[0], dates[dates.length - 1])) {
    out[o.date]?.push({ label: o.name, kind: o.kind, detail: o.advice });
  }
  for (const e of [...events].sort((a, b) => (a.startMinute ?? -1) - (b.startMinute ?? -1))) {
    const at = e.startMinute === undefined ? '' : `${formatMinute(e.startMinute)} `;
    out[e.date]?.push({ label: `${at}${e.name}`, kind: 'event', detail: e.venue });
  }
  // A held event is shown too, marked, so it is chased before the week is built around it.
  for (const e of privateEvents.filter((x) => x.status !== 'cancelled').sort((a, b) => a.startMinute - b.startMinute)) {
    const held = !counts(e);
    out[e.date]?.push({
      label: `${formatMinute(e.startMinute)} ${describeEvent(e)}${held ? ` (${e.status})` : ''}`,
      kind: held ? 'private held' : 'private',
      detail: held ? 'Not confirmed: not in the rota\'s demand until it is.' : 'Confirmed: its team is in the rota\'s demand on top of normal trade.',
    });
  }
  for (const p of school) {
    for (const d of dates) {
      if (d >= p.start && d <= p.end) out[d].push({ label: p.name, kind: 'school', detail: p.source === 'estimate' ? 'School holiday, estimated from the usual pattern.' : 'School holiday.' });
    }
  }
  return out;
}
