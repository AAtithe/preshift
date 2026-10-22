import type { LocalEvent } from './types';
import { normalSales, salesIn, type SiteHistory } from './history';
import { addDays, londonClock } from './time';

// Local events: the match at the ground down the road, the concert at the
// arena, the Christmas market. Each feed is learnt on its own, because a home
// game at the stadium round the corner and a gig across town move a site very
// differently. A feed needs two past events before its effect is trusted.

export interface IcsEvent {
  uid: string;
  summary: string;
  date: string;
  /** London start time in minutes; absent for all-day events. */
  startMinute?: number;
  location?: string;
  /** The last day the event covers, inclusive, when it runs past its start day (a holiday, a festival). */
  endDate?: string;
}

/** Undoes iCal line folding and text escaping. */
function unfold(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}
const unescape = (v: string) => v.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();

/**
 * Reads the events from an iCal feed, as stadiums, venues and councils
 * publish them. Repeating events (RRULE) count once, on their first date:
 * fixture and venue feeds list each date as its own event. Times are turned into London wall-clock time whichever way
 * the feed writes them: UTC, a named zone, or floating local time.
 */
export function parseIcs(text: string): IcsEvent[] {
  const out: IcsEvent[] = [];
  let cur: Record<string, { params: string; value: string }> | null = null;
  for (const line of unfold(text)) {
    if (line === 'BEGIN:VEVENT') cur = {};
    else if (line === 'END:VEVENT') {
      // A cancelled fixture is not on.
      if (cur?.DTSTART && cur.STATUS?.value.trim().toUpperCase() !== 'CANCELLED') {
        const start = parseIcsDate(cur.DTSTART.params, cur.DTSTART.value);
        if (start) {
          // An all-day DTEND is the day after the last day; a timed one is the moment it ends.
          const end = cur.DTEND ? parseIcsDate(cur.DTEND.params, cur.DTEND.value) : null;
          const last = end ? (end.startMinute === undefined ? addDays(end.date, -1) : end.date) : undefined;
          out.push({
            uid: cur.UID?.value ?? `${start.date}-${cur.SUMMARY?.value ?? ''}`,
            summary: unescape(cur.SUMMARY?.value ?? 'Event'),
            ...start,
            location: cur.LOCATION ? unescape(cur.LOCATION.value) : undefined,
            ...(last && last > start.date ? { endDate: last } : {}),
          });
        }
      }
      cur = null;
    } else if (cur) {
      // The name and its parameters end at the first colon outside quotes (ALTREP and the like carry URLs).
      let colon = -1;
      for (let i = 0, quoted = false; i < line.length; i++) {
        if (line[i] === '"') quoted = !quoted;
        else if (line[i] === ':' && !quoted) {
          colon = i;
          break;
        }
      }
      if (colon < 0) continue;
      const [name, ...params] = line.slice(0, colon).split(';');
      cur[name.toUpperCase()] = { params: params.join(';'), value: line.slice(colon + 1) };
    }
  }
  return out;
}

function parseIcsDate(params: string, value: string): { date: string; startMinute?: number } | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, hh, mm, , z] = m;
  const date = `${y}-${mo}-${d}`;
  if (hh === undefined || /VALUE=DATE(?!-)/i.test(params)) return { date };
  const london = (instant: string) => {
    const c = londonClock(instant);
    return { date: c.date, startMinute: c.minute };
  };
  if (z) return london(`${date}T${hh}:${mm}:00Z`);
  // A named zone other than London: honour it through Intl by finding the instant that reads this wall time there.
  const tzid = /TZID=([^;:]+)/i.exec(params)?.[1];
  if (tzid && tzid !== 'Europe/London') {
    try {
      const guess = new Date(`${date}T${hh}:${mm}:00Z`);
      const there = new Intl.DateTimeFormat('en-GB', { timeZone: tzid, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(guess);
      const get = (t: string) => Number(there.find((p) => p.type === t)?.value);
      let offset = (get('hour') * 60 + get('minute')) - (Number(hh) * 60 + Number(mm));
      // Across midnight the clock difference wraps; a zone offset is never more than fourteen hours.
      if (offset > 840) offset -= 1440;
      if (offset < -840) offset += 1440;
      return london(new Date(guess.getTime() - offset * 60_000).toISOString());
    } catch {
      // An unknown zone name: treat the time as London.
    }
  }
  return { date, startMinute: Number(hh) * 60 + Number(mm) };
}

export interface EventEffect {
  feedId: string;
  /** Average change over the hours around past events from this feed. */
  factor: number;
  events: number;
  /** Hours relative to the start the effect is measured and applied over. */
  before: number;
  after: number;
  usable: boolean;
}

/** The hours an event moves: from three hours before it starts to five after, within the trading day. */
export function eventWindow(e: Pick<LocalEvent, 'startMinute'>, before = 3, after = 5): { fromHour: number; toHour: number } | null {
  if (e.startMinute === undefined) return null;
  const start = Math.floor(e.startMinute / 60);
  return { fromHour: Math.max(0, start - before), toHour: Math.min(24, start + after) };
}

/**
 * What past events from one feed did to the site, over the hours around each
 * one, against the same hours on normal days of the same weekday. Events with
 * no start time count over the whole day.
 */
export function learnEventEffect(h: SiteHistory, events: LocalEvent[], feedId: string, today: string, unusualOther: Set<string>, skipDays = new Set<string>()): EventEffect {
  // An event on a bank holiday or an occasion would teach the occasion's effect as the event's.
  const past = events.filter((e) => e.feedId === feedId && e.date < today && h.days.has(e.date) && !skipDays.has(e.date));
  // Other event days are not normal days, whether or not the caller knew about them.
  const unusual = new Set([...unusualOther, ...events.map((e) => e.date)]);
  const ratios: number[] = [];
  for (const e of past) {
    const w = eventWindow(e) ?? { fromHour: 0, toHour: 24 };
    const normal = normalSales(h, e.date, unusual, w.fromHour, w.toHour);
    if (normal && normal > 0) ratios.push(salesIn(h, e.date, w.fromHour, w.toHour) / normal);
  }
  const factor = ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : 1;
  return { feedId, factor: Math.min(2, Math.max(0.5, factor)), events: ratios.length, before: 3, after: 5, usable: ratios.length >= 2 };
}
