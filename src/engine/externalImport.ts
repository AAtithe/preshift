// Moving from another rota or HR system: the team and the rota exported from it as a CSV, read into
// Preshift without retyping.
//
// Every system names its columns differently, so columns are found by name, not position, from the
// names rota, HR and payroll exports commonly use (Team Member, Employee, Position, Area, Job role,
// Hourly rate, Hire date, Shift start...). What was matched to what is always shown before anything is
// saved, and any column can be pointed at by hand when the guess is wrong.
//
// The rules:
// - Nothing is invented. A row without what the record needs is held back with the reason, never
//   filled with a default that looks real (no made-up date of birth, no £0 rate).
// - People go through the same starter route as a paste or People, so pay waits for approval, the
//   minimum wage check runs, and anyone without a right to work check is added but cannot be rostered.
// - Shifts arrive as a draft, never published: the GM checks them against the forecast and the
//   compliance engine, then publishes as normal. A shift already on the rota is not added twice.
// - People, roles and sites named in a file but not set up here are counted, not created: the
//   manager adds them in Set-up (one role called "FOH" should not become forty roles by accident).

import { parseCsv, parseDateTime, parseTime } from './bookingImport';
import { holidayBalance, holidayBasis } from './holiday';
import type { PastedPerson } from './setup';
import { parseUkDate } from './setup';
import type { Availability, Employee, HolidayRecord, Role, RotaState, Shift, Site } from './types';
import { normaliseBadge } from './clocking';
import { ageOn } from './time';

/** Fields of a person's record a team file may also give, beyond the essentials. */
export type TeamExtras = Partial<Pick<Employee, 'optedOutOf48' | 'maxWeeklyHours' | 'pensionEnrolled' | 'payFrequency' | 'availability' | 'coverSiteIds'>>;

export const yesNo = (v: string): boolean | null => (/^(y|yes|true|1|signed|x|opted out)$/i.test(v.trim()) ? true : /^(n|no|false|0|not signed|-)$/i.test(v.trim()) ? false : null);

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/**
 * Weekly availability as people write it: "Any", "Mon-Fri 09:00-17:00", "Mon-Fri 9-5; Sat 10:00-16:00",
 * "Weekends". An empty list means any time, as it does on the record. Null when it cannot be read.
 */
export function availabilityOf(raw: string): Availability[] | null {
  const v = raw.trim().toLowerCase();
  if (/^(any|anytime|any time|all|open|full|flexible|fully flexible)$/.test(v)) return [];
  const out: Availability[] = [];
  for (const part of v.split(/[;\n]+|,(?=\s*[a-z])/).map((x) => x.trim()).filter(Boolean)) {
    const m = part.match(/^([a-z]+)(?:\s*(?:-|to)\s*([a-z]+))?\s*(?:(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?)\s*(?:-|to)\s*(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?))?$/);
    if (!m) return null;
    const dayOf = (w: string) => DAYS.indexOf(w.slice(0, 3));
    let days: number[];
    if (/^weekends?$/.test(m[1])) days = [5, 6];
    else if (/^weekdays?$/.test(m[1])) days = [0, 1, 2, 3, 4];
    else {
      const a = dayOf(m[1]);
      const b = m[2] ? dayOf(m[2]) : a;
      if (a < 0 || b < 0) return null;
      days = [];
      for (let d = a; ; d = (d + 1) % 7) {
        days.push(d);
        if (d === b) break;
      }
    }
    // "9-5" reads as 09:00 to 17:00: an hour below the start is afternoon.
    const time = (t: string | undefined, end: boolean, start?: number) => {
      if (!t) return end ? 24 * 60 : 0;
      const p = parseTime(t.replace('.', ':'));
      if (p === null) return null;
      return end && start !== undefined && p <= start && !/am|pm/.test(t) && p < 12 * 60 ? p + 12 * 60 : p;
    };
    const from = time(m[3], false);
    const to = from === null ? null : time(m[4], true, from);
    if (from === null || to === null || to <= from) return null;
    for (const weekday of days) out.push({ weekday, fromMinute: from, toMinute: to });
  }
  return out.length ? out : null;
}

export type PeopleField =
  | 'name' | 'firstName' | 'lastName' | 'email' | 'roles' | 'rate' | 'salary' | 'dateOfBirth' | 'contractedHours' | 'startDate' | 'site' | 'rightToWork'
  | 'optedOut' | 'maxHours' | 'pension' | 'payFrequency' | 'availability' | 'coverSites' | 'badge';
export type ShiftField = 'name' | 'firstName' | 'lastName' | 'email' | 'date' | 'start' | 'end' | 'breakMinutes' | 'role' | 'site';

/** Ids, numbers and codes: "Employee ID" is never a name, "Location Code" never a site. */
const IDENTIFIER = /\b(id|number|no|code|ref|reference|key|uuid)$/;

export const normal = (h: string) => h.toLowerCase().replace(/^﻿/, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** Column names, normalised, that each field is found under. First match wins, so the most specific come first. */
export const PEOPLE_COLUMNS: Record<PeopleField, string[]> = {
  name: ['full name', 'employee name', 'staff name', 'team member', 'team member name', 'display name', 'name', 'employee', 'staff member'],
  firstName: ['first name', 'forename', 'given name', 'firstname'],
  lastName: ['last name', 'surname', 'family name', 'lastname'],
  email: ['email', 'email address', 'work email', 'e mail'],
  roles: ['roles', 'role', 'job role', 'job roles', 'position', 'positions', 'job title', 'job', 'employee group', 'employee groups', 'training'],
  rate: ['hourly rate', 'pay rate', 'base rate', 'base pay rate', 'rate', 'hourly wage', 'wage', 'rate per hour', 'hourly pay'],
  salary: ['annual salary', 'salary', 'yearly salary'],
  dateOfBirth: ['date of birth', 'dob', 'birth date', 'birthday', 'birthdate'],
  contractedHours: ['contracted hours', 'contract hours', 'contracted hours per week', 'weekly hours', 'hours per week', 'contracted weekly hours', 'min hours'],
  startDate: ['start date', 'employment start date', 'hire date', 'date hired', 'date started', 'joined', 'join date', 'employment start'],
  site: ['site', 'location', 'home location', 'main location', 'venue', 'store', 'branch', 'department', 'restaurant'],
  rightToWork: ['right to work checked on', 'right to work date', 'right to work checked', 'rtw checked on', 'rtw date', 'rtw checked', 'right to work'],
  optedOut: ['48 hour opt out', '48 hour opt out signed', 'opt out', 'opted out', 'working time opt out', 'wtr opt out', '48hr opt out', '48 hr opt out'],
  maxHours: ['maximum weekly hours', 'max weekly hours', 'maximum hours', 'max hours', 'max hours per week'],
  pension: ['pension enrolled', 'auto enrolled', 'pension', 'auto enrolment', 'pension status', 'workplace pension'],
  payFrequency: ['pay frequency', 'pay cycle', 'paid', 'payroll frequency'],
  availability: ['availability', 'available', 'available hours', 'availability pattern'],
  coverSites: ['cover sites', 'also works at', 'other sites', 'secondary sites', 'additional sites'],
  badge: ['clock card', 'clock card number', 'card number', 'badge', 'badge id', 'rfid', 'fob', 'swipe card'],
};

export const SHIFT_COLUMNS: Record<ShiftField, string[]> = {
  name: ['full name', 'employee name', 'staff name', 'team member', 'team member name', 'display name', 'name', 'employee', 'staff member', 'user'],
  firstName: ['first name', 'forename', 'given name', 'firstname'],
  lastName: ['last name', 'surname', 'family name', 'lastname'],
  email: ['email', 'email address', 'work email', 'e mail'],
  date: ['shift date', 'date', 'day', 'start date', 'roster date'],
  start: ['start time', 'shift start', 'start', 'from', 'time in', 'starts', 'begin'],
  end: ['end time', 'shift end', 'end', 'to', 'time out', 'finish', 'finish time', 'ends'],
  breakMinutes: ['unpaid break', 'break minutes', 'break mins', 'break duration', 'break length', 'meal break', 'break', 'breaks', 'unpaid break minutes', 'break hours'],
  role: ['role', 'position', 'job role', 'area', 'job', 'employee group', 'department role', 'operational unit'],
  site: ['site', 'location', 'venue', 'store', 'branch', 'department', 'restaurant', 'schedule'],
};

export interface ColumnMatch<F extends string> {
  /** Field to column index; absent when the file has no such column. */
  columns: Partial<Record<F, number>>;
  headers: string[];
  /** Headers read for nothing, shown so the manager can point one at a field. */
  unused: string[];
}

/** Finds each field's column by its header, a hand-picked header taking precedence. A column is used for one field only. */
export function matchColumns<F extends string>(headers: string[], aliases: Record<F, string[]>, chosen: Partial<Record<F, string>> = {}): ColumnMatch<F> {
  const names = headers.map(normal);
  const taken = new Set<number>();
  const columns: Partial<Record<F, number>> = {};
  for (const [field, header] of Object.entries(chosen) as [F, string | undefined][]) {
    const i = header ? names.indexOf(normal(header)) : -1;
    if (i >= 0) {
      columns[field] = i;
      taken.add(i);
    }
  }
  for (const field of Object.keys(aliases) as F[]) {
    if (field in chosen) continue;
    for (const alias of aliases[field]) {
      const i = names.findIndex((n, k) => n === alias && !taken.has(k));
      if (i >= 0) {
        columns[field] = i;
        taken.add(i);
        break;
      }
    }
  }
  // Then headers that carry a unit or a qualifier, "Unpaid Break (mins)" or "Hourly Rate GBP": the alias
  // as whole words inside the header. Never a header another field names exactly ("First Name" is not a name).
  const exact = new Set(Object.values(aliases).flat() as string[]);
  for (const field of Object.keys(aliases) as F[]) {
    if (field in chosen || columns[field] !== undefined) continue;
    for (const alias of aliases[field]) {
      const i = names.findIndex((n, k) => !taken.has(k) && !exact.has(n) && !IDENTIFIER.test(n) && ` ${n} `.includes(` ${alias} `));
      if (i >= 0) {
        columns[field] = i;
        taken.add(i);
        break;
      }
    }
  }
  return { columns, headers, unused: headers.filter((_, i) => !taken.has(i) && headers[i].trim()) };
}

/**
 * The table from CSV text or a sheet's rows, starting at its header row. Exports often put a title,
 * a date range or a blank line above the headers, so the header is the row among the first ten that
 * names the most fields. `at` is how many rows were above it, for row numbers that match the file.
 */
export function table(input: string | string[][], aliases: Record<string, string[]>): { rows: string[][]; at: number } {
  const rows = typeof input === 'string' ? parseCsv(input) : input.filter((r) => r.some((c) => String(c ?? '').trim()));
  const known = new Set(Object.values(aliases).flat());
  let best = 0;
  let score = -1;
  rows.slice(0, 10).forEach((r, i) => {
    const n = r.filter((c) => known.has(normal(String(c ?? '')))).length;
    if (n > score) {
      best = i;
      score = n;
    }
  });
  return { rows: rows.slice(best).map((r) => r.map((c) => String(c ?? ''))), at: best };
}

/** A date in any style the exports use; with usDates, 11/09/2026 is 9 November. */
export function dateOf(raw: string, usDates: boolean): string | null {
  const v = raw.trim();
  if (!v) return null;
  return parseDateTime(v, usDates)?.date ?? parseUkDate(v);
}

/** An unpaid break: minutes (30), hours and minutes (0:30), or hours (0.5; any whole number up to 4 is hours, as no break is 2 minutes). */
export function breakOf(raw: string, inHours = false): number | null {
  const v = raw.trim().toLowerCase().replace(/\s*(mins?|minutes|m)$/, '');
  if (!v) return 0;
  const hm = v.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) return Number(hm[1]) * 60 + Number(hm[2]);
  const hours = v.match(/^([\d.]+)\s*(h|hrs?|hours?)$/);
  if (hours) return Math.round(Number(hours[1]) * 60);
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  if (inHours || !Number.isInteger(n) || n <= 4) return Math.round(n * 60);
  return Math.round(n);
}

const money = (raw: string) => {
  let v = raw.replace(/[£$€\s]|per hour|\/h(ou)?r?|p\.?a\.?|per annum/gi, '');
  // A decimal comma, as European exports write it: 12,71 is twelve pounds seventy-one, and 1.234,56 a thousand and more.
  if (/^\d{1,3}(\.\d{3})*,\d{1,2}$/.test(v) || /^\d+,\d{1,2}$/.test(v)) v = v.replace(/\./g, '').replace(',', '.');
  else v = v.replace(/,/g, '');
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * A number as exports write it: 1,234.56 or, from European systems, 1.234,56 and 7,5. Currency signs and
 * spaces are ignored. NaN when it is not a number at all.
 */
export function numberOf(raw: string): number {
  let v = raw.trim().replace(/[£$€\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  if (/^-?\d{1,3}(\.\d{3})*,\d{1,2}$/.test(v) || /^-?\d+,\d{1,2}$/.test(v)) v = v.replace(/\./g, '').replace(',', '.');
  else v = v.replace(/,/g, '');
  return v === '' ? NaN : Number(v);
}

/** The totals line most reports end with: never a person. */
export const isTotalRow = (name: string) => /^(grand\s+)?totals?\b|^sub\s*-?totals?\b|^total\s+(hours|for|of)\b/i.test(name.trim());

export const fullName = (cell: (f: string) => string) => {
  const whole = cell('name');
  if (whole) return whole.replace(/\s+/g, ' ').trim();
  return [cell('firstName'), cell('lastName')].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
};

/** Names looked up as people write them: case, spacing and "Surname, First" all match. */
export const nameKey = (n: string) => {
  const t = n.toLowerCase().replace(/\s+/g, ' ').trim();
  const comma = t.match(/^([^,]+),\s*(.+)$/);
  return comma ? `${comma[2]} ${comma[1]}` : t;
};

export function finder<T extends { id: string; name: string }>(items: T[]) {
  const by = new Map(items.map((x) => [nameKey(x.name), x.id]));
  for (const x of items) by.set(x.id.toLowerCase(), x.id);
  return (raw: string) => by.get(nameKey(raw));
}

export const tally = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
export const sorted = (map: Map<string, number>) => [...map].sort((a, b) => b[1] - a[1]).map(([name, rows]) => ({ name, rows }));

export interface PeopleImport extends ColumnMatch<PeopleField> {
  people: (PastedPerson & { siteId?: string; email?: string; extra: TeamExtras; badge?: string; notes: string[] })[];
  errors: string[];
  /** Roles and sites named in the file but not set up here, with how many rows named each. */
  unknownRoles: { name: string; rows: number }[];
  unknownSites: { name: string; rows: number }[];
  /** Already on Preshift by name, so left out. */
  existing: string[];
}

/**
 * Reads a team export. Each person needs a name, a role set up here, pay, and a date of birth (for
 * the minimum wage band and young worker rules). Roles are separated by commas, slashes or semicolons.
 */
export function importPeople(text: string | string[][], state: Pick<RotaState, 'roles' | 'sites' | 'employees'>, options: { usDates?: boolean; today?: string; columns?: Partial<Record<PeopleField, string>> } = {}): PeopleImport {
  const { rows, at } = table(text, PEOPLE_COLUMNS);
  const match = matchColumns(rows[0] ?? [], PEOPLE_COLUMNS, options.columns);
  const result: PeopleImport = { ...match, people: [], errors: [], unknownRoles: [], unknownSites: [], existing: [] };
  if (!rows.length) return result;
  const c = match.columns;
  if (c.name === undefined && c.firstName === undefined) result.errors.push('No name column found. Choose which column holds the name.');
  if (c.roles === undefined) result.errors.push('No role column found. Choose which column holds the role or position.');
  if (result.errors.length) return result;

  const role = finder(state.roles as Role[]);
  const site = finder(state.sites as Site[]);
  const already = new Set(state.employees.filter((e) => e.status !== 'leaver').map((e) => nameKey(e.name)));
  const badgesHeld = new Set(state.employees.map((e) => e.badgeId).filter(Boolean) as string[]);
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const seen = new Set<string>();
  const unknownRoles = new Map<string, number>();
  const unknownSites = new Map<string, number>();
  const us = !!options.usDates;

  rows.slice(1).forEach((cells, i) => {
    const line = at + i + 2;
    const cell = (f: string) => {
      const k = c[f as PeopleField];
      return k === undefined ? '' : (cells[k] ?? '').trim();
    };
    const name = fullName(cell);
    const where = `Row ${line}${name ? ` (${name})` : ''}`;
    if (isTotalRow(name)) return;
    if (!name) return void result.errors.push(`${where}: no name.`);
    if (already.has(nameKey(name))) return void result.existing.push(name);
    if (seen.has(nameKey(name))) return void result.errors.push(`${where}: listed twice in the file; the first is used.`);
    const problems: string[] = [];

    const roleIds: string[] = [];
    for (const r of cell('roles').split(/[,/;|]/).map((x) => x.trim()).filter(Boolean)) {
      const id = role(r);
      if (id) {
        if (!roleIds.includes(id)) roleIds.push(id);
      } else tally(unknownRoles, r);
    }
    if (!roleIds.length) problems.push(cell('roles') ? `no role set up here called ${cell('roles')}.` : 'no role given.');

    const salary = c.salary !== undefined ? money(cell('salary')) : null;
    const rate = c.rate !== undefined ? money(cell('rate')) : null;
    // Anything over £1,000 in the rate column is a salary, as in a paste.
    const annual = salary ?? (rate && rate > 1000 ? rate : null);
    const hourly = annual ? null : rate;
    if (!annual && !hourly) problems.push(`pay "${cell('rate') || cell('salary')}" is not a number.`);

    const dob = dateOf(cell('dateOfBirth'), us);
    if (!dob) problems.push(cell('dateOfBirth') ? `date of birth "${cell('dateOfBirth')}" not recognised.` : 'no date of birth, needed for the minimum wage band.');
    const startDate = cell('startDate') ? dateOf(cell('startDate'), us) : undefined;
    if (startDate === null) problems.push(`start date "${cell('startDate')}" not recognised.`);
    const rtw = cell('rightToWork');
    const checkedOn = rtw && !/^(no|n|false|0)$/i.test(rtw) ? dateOf(rtw, us) : undefined;

    let siteId: string | undefined;
    if (cell('site')) {
      siteId = site(cell('site'));
      if (!siteId) tally(unknownSites, cell('site'));
    }

    // The working time, pension and pattern fields: left at Preshift's defaults where the file is silent.
    const notes: string[] = [];
    const extra: TeamExtras = {};
    const under18 = dob ? ageOn(dob, today) < 18 : false;
    if (cell('optedOut')) {
      const v = yesNo(cell('optedOut'));
      if (v === null) notes.push(`48 hour opt-out "${cell('optedOut')}" not read as yes or no; left as not opted out.`);
      else if (v && under18) problems.push('under 18s cannot opt out of the 48 hour week.');
      else extra.optedOutOf48 = v;
    }
    if (cell('maxHours')) {
      const n = Number(cell('maxHours').replace(/\s*(h|hrs?|hours?)$/i, ''));
      if (Number.isFinite(n) && n > 0 && n <= 100) extra.maxWeeklyHours = n;
      else notes.push(`Maximum hours "${cell('maxHours')}" not a number of hours; left at 48.`);
    }
    if (cell('pension')) {
      const v = /opted? out|not eligible|ceased|no\b|false|n$/i.test(cell('pension')) ? false : yesNo(cell('pension')) ?? (/enrol|member|active|opted? in|eligible/i.test(cell('pension')) ? true : null);
      if (v === null) notes.push(`Pension "${cell('pension')}" not read; left as enrolled.`);
      else extra.pensionEnrolled = v;
    }
    if (cell('payFrequency')) {
      const v = normal(cell('payFrequency'));
      if (/^(weekly|week|w)$/.test(v)) extra.payFrequency = 'weekly';
      else if (/^(monthly|month|m|calendar monthly)$/.test(v)) extra.payFrequency = 'monthly';
      else notes.push(`Paid "${cell('payFrequency')}": only weekly or monthly set the minimum wage pay period here, so it is left as weekly. Set the company's pay schedule under Pay periods.`);
    }
    if (cell('availability')) {
      const a = availabilityOf(cell('availability'));
      if (a === null) notes.push(`Availability "${cell('availability')}" not read; left open. Set it on their record.`);
      else extra.availability = a;
    }
    if (cell('coverSites')) {
      const ids: string[] = [];
      for (const n of cell('coverSites').split(/[,;/|]/).map((x) => x.trim()).filter(Boolean)) {
        const id = site(n);
        if (id) ids.push(id);
        else notes.push(`Cover site "${n}" is not set up here; left off.`);
      }
      if (ids.length) extra.coverSiteIds = [...new Set(ids)];
    }
    let badge: string | undefined;
    if (cell('badge')) {
      const b = normaliseBadge(cell('badge'));
      if (b.length < 4) notes.push(`Clock card "${cell('badge')}" is too short to be a card number; left off.`);
      else if (badgesHeld.has(b)) notes.push(`Clock card ${b} is already someone else's; left off.`);
      else (badge = b), badgesHeld.add(b);
    }
    if (problems.length) return void result.errors.push(`${where}: ${problems.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ')}`);
    seen.add(nameKey(name));
    const contracted = Math.max(0, Number(cell('contractedHours').replace(/[^\d.]/g, '')) || 0);
    result.people.push({
      line,
      ...(siteId ? { siteId } : {}),
      ...(cell('email') ? { email: cell('email') } : {}),
      person: {
        name,
        roleIds,
        payBasis: annual ? 'salaried' : 'hourly',
        hourlyRate: hourly ?? 0,
        annualSalary: annual ?? 0,
        dateOfBirth: dob!,
        contractedHours: contracted,
        irregularHours: contracted === 0,
        ...(startDate ? { startDate } : {}),
        // A yes with no date is not a statutory excuse: the check is recorded with its date, or not at all.
        rightToWork: checkedOn ? { checked: true, checkedOn } : { checked: false },
      },
      extra,
      ...(badge ? { badge } : {}),
      notes,
    });
  });
  result.unknownRoles = sorted(unknownRoles);
  result.unknownSites = sorted(unknownSites);
  return result;
}

export interface ShiftImport extends ColumnMatch<ShiftField> {
  /** Shifts ready to add as a draft, without ids. */
  shifts: Omit<Shift, 'id'>[];
  errors: string[];
  /** Rows matching a shift already on the rota, left out. */
  duplicates: number;
  /** Names in the file with nobody here to match, with how many shifts each. */
  unknownPeople: { name: string; rows: number }[];
  unknownRoles: { name: string; rows: number }[];
  unknownSites: { name: string; rows: number }[];
  /** The Mondays of the weeks the shifts fall in. */
  weeks: string[];
  /** Shifts given the person's own role because the file named none, or one not set up here. */
  roleFromPerson: number;
}

const mondayOf = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

/**
 * Reads a rota export, one shift per row. Each needs a person on Preshift (by email, or by name), a
 * date, a start and an end. A finish at or before the start runs past midnight. Without a site
 * column, every shift is at `siteId`; without a role, or one not set up here, the person's own role is used.
 */
export function importShifts(
  text: string | string[][],
  state: Pick<RotaState, 'roles' | 'sites' | 'employees' | 'shifts'>,
  options: { siteId?: string; usDates?: boolean; columns?: Partial<Record<ShiftField, string>> } = {},
): ShiftImport {
  const { rows, at } = table(text, SHIFT_COLUMNS);
  const match = matchColumns(rows[0] ?? [], SHIFT_COLUMNS, options.columns);
  const result: ShiftImport = { ...match, shifts: [], errors: [], duplicates: 0, unknownPeople: [], unknownRoles: [], unknownSites: [], weeks: [], roleFromPerson: 0 };
  if (!rows.length) return result;
  const c = match.columns;
  if (c.name === undefined && c.firstName === undefined && c.email === undefined) result.errors.push('No employee column found. Choose which column holds the name.');
  if (c.start === undefined) result.errors.push('No start column found. Choose which column holds the shift start.');
  if (c.end === undefined) result.errors.push('No end column found. Choose which column holds the shift end.');
  if (c.site === undefined && !options.siteId) result.errors.push('No site column found. Choose the site these shifts are for.');
  if (result.errors.length) return result;

  const people = state.employees.filter((e) => !e.anonymisedOn);
  const person = finder(people as Employee[]);
  const byEmail = new Map<string, string>();
  for (const e of people as (Employee & { email?: string })[]) if (e.email) byEmail.set(e.email.toLowerCase(), e.id);
  const role = finder(state.roles as Role[]);
  const site = finder(state.sites as Site[]);
  const onRota = new Set(state.shifts.map((s) => `${s.employeeId}|${s.date}|${s.startMinute}`));
  const inFile = new Set<string>();
  const unknownPeople = new Map<string, number>();
  const unknownRoles = new Map<string, number>();
  const unknownSites = new Map<string, number>();
  const weeks = new Set<string>();
  const us = !!options.usDates;
  const breakInHours = c.breakMinutes !== undefined && /hour|hrs/.test(normal(match.headers[c.breakMinutes]));

  rows.slice(1).forEach((cells, i) => {
    const line = at + i + 2;
    const cell = (f: string) => {
      const k = c[f as ShiftField];
      return k === undefined ? '' : (cells[k] ?? '').trim();
    };
    const name = fullName(cell);
    const where = `Row ${line}${name ? ` (${name})` : ''}`;
    // Open or unassigned shifts carry no person: nothing to import for them yet.
    if (isTotalRow(name)) return;
    if (!name && !cell('email')) return void result.errors.push(`${where}: no person named, so it is an open shift. Post it from the rota instead.`);
    const employeeId = (cell('email') && byEmail.get(cell('email').toLowerCase())) || (name ? person(name) : undefined);
    if (!employeeId) return void tally(unknownPeople, name || cell('email'));
    const employee = people.find((e) => e.id === employeeId)!;

    // The start may carry its own date ("09/11/2026 09:00"), so a separate date column is optional.
    const startAt = parseDateTime(cell('start'), us);
    const endAt = parseDateTime(cell('end'), us);
    const date = (cell('date') ? dateOf(cell('date'), us) : null) ?? startAt?.date ?? null;
    const startMinute = startAt?.minute ?? parseTime(cell('start'));
    let endMinute = endAt?.minute ?? parseTime(cell('end'));
    if (!date) return void result.errors.push(`${where}: date "${cell('date') || cell('start')}" not recognised.`);
    if (startMinute === null || startMinute === undefined) return void result.errors.push(`${where}: start "${cell('start')}" not recognised.`);
    if (endMinute === null || endMinute === undefined) return void result.errors.push(`${where}: end "${cell('end')}" not recognised.`);
    // A finish on the next day, or at or before the start, runs past midnight.
    if ((endAt?.date && endAt.date > date) || endMinute <= startMinute) endMinute += 24 * 60;
    if (endMinute - startMinute > 16 * 60) return void result.errors.push(`${where}: a shift of more than 16 hours is almost certainly a mistake in the file.`);
    const breakMinutes = breakOf(cell('breakMinutes'), breakInHours);
    if (breakMinutes === null || breakMinutes >= endMinute - startMinute) return void result.errors.push(`${where}: break "${cell('breakMinutes')}" not recognised.`);

    let siteId = options.siteId;
    if (cell('site')) {
      const found = site(cell('site'));
      if (!found) return void tally(unknownSites, cell('site'));
      siteId = found;
    }
    if (!siteId) return void result.errors.push(`${where}: no site.`);

    let roleId = cell('role') ? role(cell('role')) : undefined;
    if (cell('role') && !roleId) tally(unknownRoles, cell('role'));
    if (!roleId || !employee.roleIds.includes(roleId)) {
      if (!roleId && employee.roleIds[0]) {
        roleId = employee.roleIds[0];
        result.roleFromPerson++;
      }
    }
    if (!roleId) return void result.errors.push(`${where}: ${employee.name} has no role on Preshift yet.`);

    const key = `${employeeId}|${date}|${startMinute}`;
    if (onRota.has(key)) return void result.duplicates++;
    if (inFile.has(key)) return void result.errors.push(`${where}: the same shift is in the file twice; the first is used.`);
    inFile.add(key);
    weeks.add(mondayOf(date));
    result.shifts.push({ employeeId, roleId, siteId, date, startMinute, endMinute, breakMinutes, published: false });
  });
  result.unknownPeople = sorted(unknownPeople);
  result.unknownRoles = sorted(unknownRoles);
  result.unknownSites = sorted(unknownSites);
  result.weeks = [...weeks].sort();
  return result;
}

export type HolidayField = 'name' | 'firstName' | 'lastName' | 'email' | 'accrued' | 'taken' | 'carriedOver' | 'remaining' | 'entitlementWeeks';

export const HOLIDAY_COLUMNS: Record<HolidayField, string[]> = {
  name: ['full name', 'employee name', 'staff name', 'team member', 'name', 'employee', 'staff member'],
  firstName: ['first name', 'forename', 'given name'],
  lastName: ['last name', 'surname', 'family name'],
  email: ['email', 'email address', 'work email'],
  accrued: ['accrued hours', 'holiday accrued', 'accrued', 'hours accrued', 'accrued this year', 'accrued to date', 'earned', 'holiday earned'],
  taken: ['taken hours', 'holiday taken', 'taken', 'hours taken', 'used', 'taken this year', 'taken to date', 'used to date'],
  carriedOver: ['carried over hours', 'carried over', 'carry over', 'brought forward', 'carried forward from last year'],
  remaining: ['remaining hours', 'remaining', 'balance', 'holiday balance', 'hours remaining', 'available', 'left', 'balance hours'],
  entitlementWeeks: ['entitlement weeks', 'entitlement in weeks', 'weeks entitlement', 'contractual weeks'],
};

export interface HolidayRow {
  line: number;
  employeeId: string;
  name: string;
  /** The holiday record to save, the person's own entitlement and day hours kept. */
  holiday: HolidayRecord;
  /** What Preshift will show as remaining for the leave year once saved (to date for irregular hours staff), before any leave booked on Preshift. */
  remainingHours: number;
  note?: string;
}

export interface HolidayImport extends ColumnMatch<HolidayField> {
  rows: HolidayRow[];
  errors: string[];
  unknownPeople: { name: string; rows: number }[];
  /** True when the figures were read as days and turned into hours. */
  inDays: boolean;
}

/**
 * Reads holiday balances at go-live, in hours, or in days where the column headers say days (turned
 * into hours on the person's contracted day: contracted hours over five). Preshift then carries on
 * from the opening position.
 *
 * - Irregular hours staff accrue 12.07% of hours worked. Their opening accrued and taken this leave year
 *   are kept as given; a balance alone becomes an opening accrual of that balance.
 * - Fixed hours staff earn their entitlement evenly over the year from the dates, so accrued is
 *   Preshift's to work out, not imported. Taken this year is kept; a balance alone is read as the
 *   year's entitlement left, as HR systems show it, and turned into the taken figure that leaves exactly that.
 * Carried over from last year is kept for both, and a contractual entitlement in weeks for fixed hours staff.
 */
export function importHoliday(
  input: string | string[][],
  state: Pick<RotaState, 'employees' | 'entities'>,
  today: string,
  options: { columns?: Partial<Record<HolidayField, string>> } = {},
): HolidayImport {
  const { rows, at } = table(input, HOLIDAY_COLUMNS);
  const match = matchColumns(rows[0] ?? [], HOLIDAY_COLUMNS, options.columns);
  const result: HolidayImport = { ...match, rows: [], errors: [], unknownPeople: [], inDays: false };
  if (!rows.length) return result;
  const c = match.columns;
  if (c.name === undefined && c.firstName === undefined && c.email === undefined) result.errors.push('No employee column found. Choose which column holds the name.');
  if (c.accrued === undefined && c.taken === undefined && c.remaining === undefined && c.carriedOver === undefined) {
    result.errors.push('No holiday figures found. Choose the columns for accrued, taken, carried over or remaining.');
  }
  if (result.errors.length) return result;
  const used = [c.accrued, c.taken, c.carriedOver, c.remaining].filter((i): i is number => i !== undefined).map((i) => normal(match.headers[i]));
  result.inDays = used.some((h) => /\bdays?\b/.test(h)) && !used.some((h) => /\bhours?\b|\bhrs\b/.test(h));

  const people = state.employees.filter((e) => !e.anonymisedOn && e.status !== 'leaver');
  const person = finder(people);
  const byEmail = new Map<string, string>();
  for (const e of people) if (e.email) byEmail.set(e.email.toLowerCase(), e.id);
  const unknown = new Map<string, number>();
  const seen = new Set<string>();
  const round = (n: number) => Math.round(n * 100) / 100;

  rows.slice(1).forEach((cells, i) => {
    const line = at + i + 2;
    const cell = (f: string) => {
      const k = c[f as HolidayField];
      return k === undefined ? '' : (cells[k] ?? '').trim();
    };
    const name = fullName(cell);
    const where = `Row ${line}${name ? ` (${name})` : ''}`;
    if (!name && !cell('email')) return;
    const id = (cell('email') && byEmail.get(cell('email').toLowerCase())) || (name ? person(name) : undefined);
    if (!id) return void tally(unknown, name || cell('email'));
    if (seen.has(id)) return void result.errors.push(`${where}: listed twice; the first is used.`);
    const e = people.find((x) => x.id === id)!;
    const dayHours = e.contractedHours > 0 ? e.contractedHours / 5 : null;
    const figure = (f: HolidayField): number | null | 'bad' => {
      const raw = cell(f).replace(/\s*(hours?|hrs?|h|days?|d)$/i, '');
      if (!raw) return null;
      const n = numberOf(raw);
      if (!Number.isFinite(n)) return 'bad';
      return n;
    };
    const values: Partial<Record<HolidayField, number>> = {};
    for (const f of ['accrued', 'taken', 'carriedOver', 'remaining', 'entitlementWeeks'] as HolidayField[]) {
      const v = figure(f);
      if (v === 'bad') return void result.errors.push(`${where}: ${f === 'carriedOver' ? 'carried over' : f} "${cell(f)}" is not a number.`);
      if (v !== null) values[f] = v;
    }
    if (result.inDays) {
      if (!dayHours) return void result.errors.push(`${where}: figures are in days, but ${e.name} has no contracted hours to turn a day into hours. Give hours for them.`);
      for (const f of ['accrued', 'taken', 'carriedOver', 'remaining'] as HolidayField[]) if (values[f] !== undefined) values[f] = round(values[f]! * dayHours);
    }
    for (const f of ['accrued', 'taken', 'carriedOver'] as HolidayField[]) {
      if ((values[f] ?? 0) < 0) return void result.errors.push(`${where}: a negative ${f === 'carriedOver' ? 'carry over' : f} figure is not an opening balance.`);
    }
    if (values.entitlementWeeks !== undefined && values.entitlementWeeks < 5.6) return void result.errors.push(`${where}: an entitlement of ${values.entitlementWeeks} weeks is below the statutory 5.6.`);

    const basis = holidayBasis(e);
    const holiday: HolidayRecord = { ...(e.holiday ?? {}) };
    delete holiday.openingAccruedHours;
    delete holiday.openingTakenHours;
    if (values.carriedOver !== undefined) holiday.carriedOverHours = round(values.carriedOver);
    if (basis === 'fixed' && values.entitlementWeeks !== undefined) holiday.entitlementWeeks = values.entitlementWeeks;
    let note: string | undefined;
    // Preshift's own view of the year so far, with no opening position and no shifts: the base the import completes.
    // Each company sets its own leave year.
    const yearStart = state.entities.find((x) => x.id === e.entityId)?.leaveYearStart;
    const base = (h: HolidayRecord) => holidayBalance({ ...e, leave: [], holiday: h }, [], today, yearStart);
    if (basis === 'accrual') {
      if (values.accrued !== undefined) holiday.openingAccruedHours = round(values.accrued);
      if (values.taken !== undefined) holiday.openingTakenHours = round(values.taken);
      if (values.accrued === undefined && values.remaining !== undefined) {
        holiday.openingAccruedHours = round(Math.max(0, values.remaining + (values.taken ?? 0) - (holiday.carriedOverHours ?? 0)));
        note = 'Irregular hours: the balance is carried in as accrued.';
      }
      if (values.accrued !== undefined && values.remaining !== undefined) {
        const implied = values.accrued + (holiday.carriedOverHours ?? 0) - (values.taken ?? 0);
        if (Math.abs(implied - values.remaining) > 0.5) note = `Accrued less taken comes to ${round(implied)}h, not the ${round(values.remaining)}h balance in the file. The accrued and taken figures are used.`;
      }
    } else {
      if (values.accrued !== undefined) note = 'Fixed hours: Preshift works out what is accrued from the dates, so the accrued figure is not used.';
      if (values.taken !== undefined) holiday.openingTakenHours = round(values.taken);
      else if (values.remaining !== undefined) {
        // A fixed hours balance is the year's entitlement left, as HR systems and payslips show it.
        const b = base(holiday);
        const taken = b.entitlementHours + (holiday.carriedOverHours ?? 0) - values.remaining;
        if (taken < -0.5) note = `The ${round(values.remaining)}h balance is more than the ${round(b.entitlementHours + (holiday.carriedOverHours ?? 0))}h entitlement this leave year. Check the start date, contracted hours, entitlement or carry over.`;
        holiday.openingTakenHours = round(Math.max(0, taken));
      }
    }
    const b = base(holiday);
    seen.add(id);
    result.rows.push({ line, employeeId: id, name: e.name, holiday, remainingHours: round(b.entitlementHours + b.carriedOverHours - b.takenHours), ...(note ? { note } : {}) });
  });
  result.unknownPeople = sorted(unknown);
  return result;
}
