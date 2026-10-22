import type { IcsEvent } from './events';
import type { SchoolPeriod } from './types';
import { bankHolidays, easterSunday } from './calendar';
import { normalSales, salesIn, type SiteHistory } from './history';
import { DAYPARTS, type Daypart } from './forecast';
import { addDays, parseISODate, toISODate, weekday } from './time';

// School holidays. They move trade (families out at lunch, office districts
// quieter, students wanting shifts) and they change the law for anyone on the
// team still of compulsory school age. Every council sets its own dates and
// academies can differ, so the calendar here is an estimate of the usual
// England and Wales pattern until a site has its council's own dates, which
// then replace the estimate for that school year.

const iso = (y: number, m: number, d: number) => toISODate(new Date(Date.UTC(y, m - 1, d)));
function nthMonday(year: number, month: number, n: number): string {
  const first = iso(year, month, 1);
  return addDays(first, ((7 - weekday(first)) % 7) + 7 * (n - 1));
}
function lastMonday(year: number, month: number): string {
  const last = toISODate(new Date(Date.UTC(year, month, 0)));
  return addDays(last, -weekday(last));
}

/** The school year a date falls in, by its starting calendar year: 2026 for 1 September 2026 to 31 August 2027. */
export const schoolYearOf = (date: string) => (Number(date.slice(5, 7)) >= 9 ? Number(date.slice(0, 4)) : Number(date.slice(0, 4)) - 1);

/**
 * The usual England and Wales pattern for a school year, as an estimate:
 * the autumn half term the week from the last Monday of October; Christmas
 * from the Saturday after the last Friday on or before 20 December to the
 * Sunday before the first Monday on or after 4 January; February half term
 * the week from the third Monday; Easter from the Monday before Good Friday
 * to the Friday after Easter Monday; May half term the week of the spring bank
 * holiday; summer from 22 July to the day before the first Thursday of September.
 */
export function estimatedHolidays(schoolYear: number): SchoolPeriod[] {
  const y = schoolYear;
  const n = y + 1;
  const dec20 = iso(y, 12, 20);
  const lastFriday = addDays(dec20, -((weekday(dec20) - 4 + 7) % 7));
  const jan4 = iso(n, 1, 4);
  const back = addDays(jan4, (7 - weekday(jan4)) % 7);
  const easter = easterSunday(n);
  const may = lastMonday(n, 5);
  const sep1 = iso(n, 9, 1);
  const firstThursday = addDays(sep1, (3 - weekday(sep1) + 7) % 7);
  const est = (key: string, name: string, kind: SchoolPeriod['kind'], start: string, end: string): SchoolPeriod => ({ id: `est:${y}:${key}`, start, end, name, kind, source: 'estimate' });
  return [
    est('autumn', 'October half term', 'half_term', lastMonday(y, 10), addDays(lastMonday(y, 10), 4)),
    est('christmas', 'Christmas holidays', 'christmas', addDays(lastFriday, 1), addDays(back, -1)),
    est('february', 'February half term', 'half_term', nthMonday(n, 2, 3), addDays(nthMonday(n, 2, 3), 4)),
    est('easter', 'Easter holidays', 'easter', addDays(easter, -6), addDays(easter, 5)),
    est('may', 'May half term', 'half_term', may, addDays(may, 4)),
    est('summer', 'Summer holidays', 'summer', iso(n, 7, 22), addDays(firstThursday, -1)),
  ];
}

/** What kind of holiday a name describes, as councils word them. */
export const kindOf = (name: string): SchoolPeriod['kind'] => {
  const v = name.toLowerCase();
  if (/half.?term/.test(v)) return 'half_term';
  if (/christmas|winter/.test(v)) return 'christmas';
  if (/easter|spring (holiday|break)/.test(v)) return 'easter';
  if (/summer/.test(v)) return 'summer';
  if (/inset|training day|staff development|professional development|teacher day/.test(v)) return 'inset';
  return 'other';
};

const TERM = '(?:term|autumn|spring|summer|winter)';
const END_RE = new RegExp(`\\b${TERM}\\b.*\\b(?:ends|finishes|closes)\\b|\\blast day of\\b|\\bend of term\\b|\\bbreak(?:s)? up\\b|\\bschool closes for\\b`, 'i');
const START_RE = new RegExp(`\\b${TERM}\\b.*\\b(?:starts|begins|opens|returns|commences)\\b|\\bfirst day of\\b|\\bstart of term\\b|\\bschools? (?:opens|returns|reopens)\\b|\\b(?:pupils|students) return\\b|\\breturn to school\\b`, 'i');
/** Whole words only: "Breakfast club" is not a break, and "closed early for parents' evening" is not a holiday. */
const HOLIDAY_RE = /\b(?:half[- ]?term|inset(?: day)?|training day|bank holiday|staff development day|(?:christmas|easter|summer|winter|spring|october|february|may) (?:break|holidays?)|school holidays?)\b/i;
const NOT_HOLIDAY_RE = /\b(?:club|activit(?:y|ies)|camp|scheme|playscheme|early|evening|morning|afternoon)\b/i;

/** The longest a holiday can plausibly run: about two weeks, or seven for the summer. */
function plausible(start: string, end: string): boolean {
  const days = Math.round((parseISODate(end).getTime() - parseISODate(start).getTime()) / 86_400_000) + 1;
  const month = Number(start.slice(5, 7));
  return days >= 1 && days <= (month === 7 || month === 8 ? 50 : 17);
}

export interface SchoolFeedReading {
  periods: SchoolPeriod[];
  /** Entries left out, and why: a confirmed holiday relaxes the law on children's hours, so doubtful ones are not used. */
  ignored: string[];
}

/**
 * School holidays from a council's iCal feed. Councils publish them either as
 * spans ("October half term", 26 to 30 October) or as the last and first days
 * of each term; both are understood. Because a confirmed holiday lets a child
 * work longer hours and in the daytime, anything doubtful is left out and
 * reported: names are matched as whole words, and a holiday longer than is
 * plausible (over 17 days, or 50 starting in July or August) is refused.
 */
export function readSchoolFeed(events: IcsEvent[], feedId: string): SchoolFeedReading {
  const periods: SchoolPeriod[] = [];
  const ignored: string[] = [];
  const ends: string[] = [];
  const starts: string[] = [];
  for (const e of events) {
    const name = e.summary;
    if (END_RE.test(name)) ends.push(e.date);
    else if (START_RE.test(name)) starts.push(e.date);
    else if (HOLIDAY_RE.test(name) && !NOT_HOLIDAY_RE.test(name)) {
      const end = e.endDate ?? e.date;
      if (!plausible(e.date, end)) {
        ignored.push(`"${name}" (${e.date} to ${end}) is longer than a school holiday runs`);
        continue;
      }
      periods.push({ id: `${feedId}:${e.uid}`, start: e.date, end, name, kind: kindOf(name), source: 'council', feedId });
    }
  }
  // Each term end is followed by a holiday running to the day before the next term starts.
  ends.sort();
  starts.sort();
  for (const end of ends) {
    const next = starts.find((s) => s > end);
    if (!next) continue;
    const from = addDays(end, 1);
    const to = addDays(next, -1);
    if (to < from || periods.some((p) => p.start <= to && p.end >= from)) continue;
    if (!plausible(from, to)) {
      ignored.push(`a gap from ${from} to ${to} between a term end and the next start is too long to be one holiday: a term start is probably worded in a way that was not recognised`);
      continue;
    }
    const month = Number(from.slice(5, 7));
    const days = Math.round((parseISODate(to).getTime() - parseISODate(from).getTime()) / 86_400_000) + 1;
    const kind: SchoolPeriod['kind'] = days <= 10 ? 'half_term' : month === 12 ? 'christmas' : month >= 6 && month <= 8 ? 'summer' : month >= 3 && month <= 4 ? 'easter' : 'other';
    periods.push({ id: `${feedId}:gap:${from}`, start: from, end: to, name: kind === 'half_term' ? 'Half term' : kind === 'other' ? 'School holiday' : `${kind[0].toUpperCase()}${kind.slice(1)} holidays`, kind, source: 'council', feedId });
  }
  return { periods: periods.sort((a, b) => a.start.localeCompare(b.start)), ignored };
}

/** The holidays a council feed confirms. */
export const holidaysFromIcs = (events: IcsEvent[], feedId: string) => readSchoolFeed(events, feedId).periods;

/** Which holiday of the school year a period is: half terms told apart by when they fall. */
function slotOf(p: SchoolPeriod): string {
  if (p.kind !== 'half_term') return p.kind;
  const m = Number(p.start.slice(5, 7));
  return m >= 9 && m <= 11 ? 'half_term:autumn' : m >= 1 && m <= 3 ? 'half_term:february' : 'half_term:may';
}

/**
 * The holidays that apply to a site between two dates: the council's own,
 * plus the estimate for any holiday the council's dates do not cover yet. A
 * confirmed holiday replaces the estimated one it stands for (the same slot in
 * the school year, or any estimate it overlaps), so entering half term by hand
 * does not lose Christmas from the forecast. A site outside England and Wales
 * gets no estimate, because the pattern differs.
 */
export function schoolHolidays(confirmed: SchoolPeriod[], from: string, to: string, estimate = true): SchoolPeriod[] {
  const out: SchoolPeriod[] = [];
  for (let y = schoolYearOf(from); y <= schoolYearOf(to); y++) {
    const yearFrom = `${y}-09-01`;
    const yearTo = `${y + 1}-08-31`;
    const theirs = confirmed.filter((p) => p.start >= yearFrom && p.start <= yearTo);
    out.push(...theirs);
    if (!estimate) continue;
    const slots = new Set(theirs.map(slotOf));
    out.push(...estimatedHolidays(y).filter((e) => !slots.has(slotOf(e)) && !theirs.some((p) => p.start <= e.end && p.end >= e.start)));
  }
  return out.filter((p) => p.end >= from && p.start <= to).sort((a, b) => a.start.localeCompare(b.start));
}

/** Whether a date falls in one of the periods. */
export const inHoliday = (periods: SchoolPeriod[], date: string) => periods.find((p) => p.start <= date && p.end >= date);

/**
 * A school day: a weekday that is not a bank holiday and not in a confirmed
 * holiday. Estimated holidays count as school days here on purpose: the law
 * on children's hours is stricter in term time, so until the council's dates
 * are in, a child is rostered as if school were open.
 */
export function isSchoolDay(date: string, confirmed: SchoolPeriod[]): boolean {
  if (weekday(date) >= 5) return false;
  if (bankHolidays(Number(date.slice(0, 4))).some((b) => b.date === date)) return false;
  return !inHoliday(confirmed.filter((p) => p.source !== 'estimate'), date);
}

export interface SchoolEffect {
  daypart: Daypart['id'];
  weekend: boolean;
  factor: number;
  days: number;
  usable: boolean;
}

/** Holiday weekdays (or weekend days) needed before an effect is trusted. */
export const MIN_SCHOOL_DAYS = 5;

/**
 * What school holidays do to each daypart at a site, weekdays and weekends
 * apart: holiday days against normal term days of the same weekday nearby.
 * Bank holidays and other unusual days are left out, because they would teach
 * their own effect as the holiday's.
 */
export function learnSchoolEffect(h: SiteHistory, holidays: SchoolPeriod[], unusual: Set<string>): SchoolEffect[] {
  const holidayDays = new Set<string>();
  for (const p of holidays) for (let d = p.start; d <= p.end; d = addDays(d, 1)) holidayDays.add(d);
  const notNormal = new Set([...unusual, ...holidayDays]);
  const out: SchoolEffect[] = [];
  for (const dp of DAYPARTS) {
    for (const weekend of [false, true]) {
      const ratios: number[] = [];
      for (const d of holidayDays) {
        if (!h.days.has(d) || unusual.has(d) || (weekday(d) >= 5) !== weekend) continue;
        const normal = normalSales(h, d, notNormal, dp.from, dp.to);
        if (normal && normal > 0) ratios.push(salesIn(h, d, dp.from, dp.to) / normal);
      }
      const factor = ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : 1;
      out.push({ daypart: dp.id, weekend, factor: Math.min(1.6, Math.max(0.6, factor)), days: ratios.length, usable: ratios.length >= MIN_SCHOOL_DAYS });
    }
  }
  return out;
}

/** A day-level school factor for taking the holiday out of training figures: the dayparts weighted by what each normally takes. */
export function schoolDayFactor(effects: SchoolEffect[], h: SiteHistory, date: string): number {
  const weekend = weekday(date) >= 5;
  let num = 0;
  let den = 0;
  for (const e of effects.filter((x) => x.weekend === weekend && x.usable)) {
    const dp = DAYPARTS.find((d) => d.id === e.daypart)!;
    const sales = salesIn(h, date, dp.from, dp.to);
    num += sales;
    den += sales / e.factor;
  }
  return den > 0 ? num / den : 1;
}
