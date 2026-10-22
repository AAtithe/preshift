import { addDays, parseISODate, toISODate, weekday } from './time';
import { normalSales, salesIn, type SiteHistory } from './history';

// The UK trading calendar: every date a hospitality operator should plan for,
// computed for any year so nothing has to be typed in. Each occasion carries
// how far ahead to act and what to do, and the site's own history says how it
// traded last time.

export type OccasionKind = 'bank_holiday' | 'occasion' | 'season' | 'operational';

export interface OccasionDef {
  key: string;
  name: string;
  kind: OccasionKind;
  /** Days ahead to remind: bookings for Mothering Sunday open weeks before. */
  leadDays: number;
  advice: string;
  /** Hours the occasion moves, when it is not the whole day. */
  fromHour?: number;
  toHour?: number;
}

export interface Occasion extends OccasionDef {
  date: string;
  /** Bank holidays are already forecast by the model's bank holiday rule; never adjust them twice. */
  bankHoliday: boolean;
}

/** Easter Sunday by the anonymous Gregorian computus (Meeus/Jones/Butcher). */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const iso = (y: number, m: number, d: number) => toISODate(new Date(Date.UTC(y, m - 1, d)));
/** The nth weekday (0 = Monday) of a month; n = -1 for the last. */
function nthWeekday(year: number, month: number, wd: number, n: number): string {
  if (n > 0) {
    const first = iso(year, month, 1);
    return addDays(first, ((wd - weekday(first) + 7) % 7) + 7 * (n - 1));
  }
  const last = toISODate(new Date(Date.UTC(year, month, 0)));
  return addDays(last, -((weekday(last) - wd + 7) % 7));
}
/** A fixed-date bank holiday on a weekend moves to the next weekday not already taken. */
function substitute(date: string, taken: Set<string>): string {
  let d = date;
  while (weekday(d) >= 5 || taken.has(d)) d = addDays(d, 1);
  return d;
}

/** England and Wales bank holidays for a year, substitute days included. One-off royal holidays are not predictable and are not here. */
export function bankHolidays(year: number): { date: string; name: string }[] {
  const easter = easterSunday(year);
  const taken = new Set<string>();
  const out: { date: string; name: string }[] = [];
  const add = (date: string, name: string) => {
    taken.add(date);
    out.push({ date, name });
  };
  add(substitute(iso(year, 1, 1), taken), "New Year's Day");
  add(addDays(easter, -2), 'Good Friday');
  add(addDays(easter, 1), 'Easter Monday');
  add(nthWeekday(year, 5, 0, 1), 'Early May bank holiday');
  add(nthWeekday(year, 5, 0, -1), 'Spring bank holiday');
  add(nthWeekday(year, 8, 0, -1), 'Summer bank holiday');
  // Boxing Day keeps the 26th when that is a weekday, and Christmas moves past it; otherwise Christmas goes first.
  if (weekday(iso(year, 12, 26)) < 5) {
    add(iso(year, 12, 26), 'Boxing Day');
    add(substitute(iso(year, 12, 25), taken), 'Christmas Day');
  } else {
    add(substitute(iso(year, 12, 25), taken), 'Christmas Day');
    add(substitute(iso(year, 12, 26), taken), 'Boxing Day');
  }
  for (const o of ONE_OFF.filter((x) => x.date.startsWith(`${year}-`))) {
    const i = out.findIndex((h) => h.date === o.replaces);
    if (i >= 0) out.splice(i, 1);
    out.push({ date: o.date, name: o.name });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Holidays set by proclamation, which no rule predicts. Add new ones as they are announced. */
const ONE_OFF: { date: string; name: string; replaces?: string }[] = [
  { date: '2020-05-08', name: 'VE Day bank holiday', replaces: '2020-05-04' },
  { date: '2022-06-02', name: 'Spring bank holiday', replaces: '2022-05-30' },
  { date: '2022-06-03', name: 'Platinum Jubilee bank holiday' },
  { date: '2022-09-19', name: 'State Funeral of Queen Elizabeth II' },
  { date: '2023-05-08', name: 'Coronation bank holiday' },
];

/** Every planned trading occasion in a year, bank holidays included. */
export function occasions(year: number): Occasion[] {
  const easter = easterSunday(year);
  const holidays = bankHolidays(year);
  const holidayDates = new Set(holidays.map((h) => h.date));
  const list: (OccasionDef & { date: string })[] = [
    ...holidays.map((h) => ({
      key: `bh-${h.name.toLowerCase().replace(/[^a-z]+/g, '-')}`,
      name: h.name,
      kind: 'bank_holiday' as const,
      leadDays: 21,
      date: h.date,
      advice: 'Bank holiday: the forecast already trades it like past bank holidays. Check holiday requests against it before you build, and remember any contractual bank holiday pay.',
    })),
    { key: 'valentines', name: "Valentine's Day", kind: 'occasion', leadDays: 28, date: iso(year, 2, 14), fromHour: 17, toHour: 24, advice: 'Evening bookings decide this one. Forecast from the booking book, not from an ordinary night, and roster to the covers.' },
    { key: 'shrove-tuesday', name: 'Shrove Tuesday', kind: 'occasion', leadDays: 14, date: addDays(easter, -47), advice: 'Pancake Day: a lift for brunch and dessert-led sites. Check stock and the kitchen, not just the floor.' },
    { key: 'mothering-sunday', name: 'Mothering Sunday', kind: 'occasion', leadDays: 35, date: addDays(easter, -21), fromHour: 11, toHour: 17, advice: 'One of the busiest Sundays of the year for lunch. Bookings fill weeks ahead: lock in your strongest team early and set covers from bookings.' },
    { key: 'st-patricks', name: "St Patrick's Day", kind: 'occasion', leadDays: 14, date: iso(year, 3, 17), fromHour: 16, toHour: 24, advice: 'Wet-led sites trade hard from late afternoon. Bar cover and door policy first.' },
    { key: 'easter-saturday', name: 'Easter Saturday', kind: 'occasion', leadDays: 21, date: addDays(easter, -1), advice: 'Part of the four-day Easter weekend. Families travel; city centres and destination sites trade differently.' },
    { key: 'easter-sunday', name: 'Easter Sunday', kind: 'occasion', leadDays: 21, date: easter, advice: 'Not a bank holiday, but a family lunch day. Check last Easter rather than an ordinary Sunday.' },
    { key: 'clocks-forward', name: 'Clocks go forward', kind: 'operational', leadDays: 7, date: nthWeekday(year, 3, 6, -1), advice: 'Overnight shifts lose an hour at 01:00: staff work, and are paid, an hour less. Check the clock record and the rota agree.' },
    { key: 'fathers-day', name: "Father's Day", kind: 'occasion', leadDays: 21, date: nthWeekday(year, 6, 6, 3), fromHour: 11, toHour: 17, advice: 'A strong Sunday lunch for pubs and grills. Bookings first, then the rota.' },
    { key: 'halloween', name: 'Halloween', kind: 'occasion', leadDays: 14, date: iso(year, 10, 31), fromHour: 18, toHour: 24, advice: 'Late trade for bars, quieter early evening for family dining. Look at last year by hour.' },
    { key: 'clocks-back', name: 'Clocks go back', kind: 'operational', leadDays: 7, date: nthWeekday(year, 10, 6, -1), advice: 'Overnight shifts gain an hour at 02:00: staff work an extra hour and must be paid for it. Make sure the clock record shows it.' },
    { key: 'bonfire-night', name: 'Bonfire Night', kind: 'occasion', leadDays: 14, date: iso(year, 11, 5), fromHour: 17, toHour: 22, advice: 'Displays pull people out early evening, then into pubs nearby. Check local display times.' },
    {
      key: 'black-friday',
      name: 'Black Friday',
      kind: 'occasion',
      leadDays: 14,
      // The day after the fourth Thursday of November.
      date: addDays(nthWeekday(year, 11, 3, 4), 1),
      advice: 'Shopping centre and high street sites see the footfall; destination sites may not.',
    },
    { key: 'party-season', name: 'Christmas party season begins', kind: 'season', leadDays: 70, date: nthWeekday(year, 12, 4, 1), advice: 'Party bookings are taken from September. Thursdays to Saturdays in December trade like no other month: plan the team and the holiday freeze now.' },
    {
      key: 'mad-friday',
      name: 'Mad Friday',
      kind: 'occasion',
      leadDays: 28,
      // The last Friday before Christmas, but never Christmas Eve itself: the trade calls the Friday before that.
      date: addDays(iso(year, 12, 23), -((weekday(iso(year, 12, 23)) - 4 + 7) % 7)),
      fromHour: 16,
      toHour: 24,
      advice: 'The biggest night out of the year for many bars. Full team, door staff, and no new starters on shift.',
    },
    { key: 'christmas-eve', name: 'Christmas Eve', kind: 'occasion', leadDays: 28, date: iso(year, 12, 24), advice: 'Trade stops early in most places. Decide closing time before you build, and give the team notice.' },
    { key: 'new-years-eve', name: "New Year's Eve", kind: 'occasion', leadDays: 42, date: iso(year, 12, 31), fromHour: 18, toHour: 24, advice: 'Ticketed or walk-in, decide early. Late finishes run past midnight: check rest periods into New Year\'s Day.' },
  ];
  return list
    .map((o) => ({ ...o, bankHoliday: holidayDates.has(o.date) }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
}

/** Occasions falling between two dates, inclusive. */
export function occasionsBetween(from: string, to: string): Occasion[] {
  const out: Occasion[] = [];
  for (let y = parseISODate(from).getUTCFullYear(); y <= parseISODate(to).getUTCFullYear(); y++) {
    out.push(...occasions(y).filter((o) => o.date >= from && o.date <= to));
  }
  return out;
}

export interface OccasionEffect {
  /** What the occasion's hours took last time against a normal day of the same weekday then. */
  factor: number;
  lastDate: string;
  lastSales: number;
  normalSales: number;
}

/**
 * How the site traded the occasion last year, against the level it was trading
 * at then, so a year's growth is not counted again on top of the trend. Null
 * when the site has no history for it.
 */
export function occasionEffect(h: SiteHistory, occasion: Occasion, unusual: Set<string>): OccasionEffect | null {
  const year = parseISODate(occasion.date).getUTCFullYear() - 1;
  const last = occasions(year).find((o) => o.key === occasion.key);
  if (!last || !h.days.has(last.date)) return null;
  const from = occasion.fromHour ?? 0;
  const to = occasion.toHour ?? 24;
  const normal = normalSales(h, last.date, unusual, from, to);
  if (!normal) return null;
  const lastSales = salesIn(h, last.date, from, to);
  return { factor: lastSales / normal, lastDate: last.date, lastSales, normalSales: normal };
}
