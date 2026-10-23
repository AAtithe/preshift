// Looking after the team: what the rota, the clock and the absence record say about each person's
// wellbeing, read early enough for a manager to do something about it. Pure, shared by the API,
// the Wellbeing screen and their tests.
//
// None of this is a compliance rule: the law is enforced in compliance.ts and blocks publication.
// These are the legal patterns that still wear people out (twelve days in a row across a week
// boundary, close then open three times a week, no weekend off in a month, hours cut by half) and
// the things a good operator does about it: a conversation, a safe way home, a meal on a long
// shift, and recognition that turns into something the person can spend through Hospitality Rewards.

import { breakShortfalls } from './breaks';
import { shiftPaidHours } from './cost';
import { employeeStatus } from './employees';
import { workedShifts } from './holiday';
import { absenceDays } from './hr';
import { entriesAsShifts } from './timesheet';
import { addDays, ageOn, daysBetween, weekday, weekStart } from './time';
import type { Employee, Shift, TimeEntry } from './types';

/** What the organisation commits to. Set by someone with settings.manage; every field has a default. */
export interface WelfarePolicy {
  /** A shift ending at or after this minute (past 1440 is after midnight) counts as a late finish. */
  lateFinishMinute: number;
  /** Paid per late finish towards a safe journey home: a taxi, a night bus allowance. Nought means not offered. */
  travelHomeAllowance: number;
  /** Under 18s finishing after 22:00 always get a safe journey home arranged, whatever the allowance. */
  under18TravelHome: boolean;
  /** A shift this many paid hours or longer gets a staff meal. */
  mealFromHours: number;
  /** Food cost of one staff meal, for the weekly cost. */
  mealCost: number;
  /** Recognition points each site may give in a calendar month. */
  pointsPerSiteMonth: number;
  /** The employee assistance programme or helpline shown in the staff app. */
  supportLine?: { name: string; phone?: string; url?: string };
}

export const DEFAULT_WELFARE_POLICY: WelfarePolicy = {
  lateFinishMinute: 23 * 60 + 30,
  travelHomeAllowance: 0,
  under18TravelHome: true,
  mealFromHours: 6,
  mealCost: 3.5,
  pointsPerSiteMonth: 500,
};

export const welfarePolicy = (saved?: Partial<WelfarePolicy>): WelfarePolicy => ({ ...DEFAULT_WELFARE_POLICY, ...(saved ?? {}) });

/** Checks a policy before it is saved; returns what is wrong, or null. */
export function policyProblem(p: Partial<WelfarePolicy>): string | null {
  if (p.lateFinishMinute !== undefined && (!Number.isInteger(p.lateFinishMinute) || p.lateFinishMinute < 20 * 60 || p.lateFinishMinute > 30 * 60)) {
    return 'A late finish is set between 20:00 and 06:00.';
  }
  if (p.travelHomeAllowance !== undefined && !(p.travelHomeAllowance >= 0 && p.travelHomeAllowance <= 100)) return 'The travel home allowance is between £0 and £100 a journey.';
  if (p.mealFromHours !== undefined && !(p.mealFromHours >= 3 && p.mealFromHours <= 12)) return 'A staff meal is given on shifts of 3 to 12 hours.';
  if (p.mealCost !== undefined && !(p.mealCost >= 0 && p.mealCost <= 25)) return 'A staff meal costs between £0 and £25.';
  if (p.pointsPerSiteMonth !== undefined && !(Number.isInteger(p.pointsPerSiteMonth) && p.pointsPerSiteMonth >= 0 && p.pointsPerSiteMonth <= 100_000)) {
    return 'Points per site a month are a whole number up to 100,000.';
  }
  if (p.supportLine && !p.supportLine.name?.trim()) return 'Name the support line, for example your employee assistance programme.';
  if (p.supportLine?.url && !/^https:\/\//.test(p.supportLine.url)) return 'The support line link must start https://.';
  return null;
}

// Signals

/** How far back the signals look, and how far ahead the rota is read. */
export const LOOKBACK_DAYS = 28;
export const LOOKAHEAD_DAYS = 14;
/** Rest between working days below this, though legal at 11 hours, still wears people down when it repeats. */
const TIGHT_TURNAROUND_MINUTES = 12 * 60;
/** Short sickness spells, three of them in 26 weeks, are a wellbeing question before they are a trigger. */
const SHORT_SPELL_DAYS = 3;
const SHORT_SPELLS = 3;

export type WelfareLevel = 'ok' | 'watch' | 'act';

export interface WelfareSignal {
  code: 'long-weeks' | 'run-of-days' | 'tight-turnarounds' | 'late-finishes' | 'no-weekend-off' | 'missed-breaks' | 'no-holiday' | 'hours-drop' | 'short-sickness' | 'asked-for-chat';
  level: Exclude<WelfareLevel, 'ok'>;
  label: string;
  /** What was found, in figures. */
  detail: string;
  /** What a good manager does about it this week. */
  action: string;
}

export interface PersonWelfare {
  employeeId: string;
  siteId: string;
  level: WelfareLevel;
  signals: WelfareSignal[];
  /** Over the last four weeks: paid hours a week on average, days worked, late finishes. */
  averageWeeklyHours: number;
  daysWorked: number;
  lateFinishes: number;
}

/** What only the server holds about the person: a chat they asked for from the staff app. */
export interface WelfareExtras {
  chatRequestedAt?: string;
}

interface Sight {
  /** Reads the personnel file at their site: sickness counts only then. */
  hr: boolean;
}

const hoursOf = (shifts: Shift[]) => shifts.reduce((sum, s) => sum + shiftPaidHours(s), 0);
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Longest run of consecutive dates in a sorted, de-duplicated list. */
function longestRun(dates: string[]): { days: number; from?: string; to?: string } {
  let best = { days: 0, from: undefined as string | undefined, to: undefined as string | undefined };
  let start = 0;
  for (let i = 0; i < dates.length; i++) {
    if (i > 0 && daysBetween(dates[i - 1], dates[i]) !== 1) start = i;
    const days = i - start + 1;
    if (days > best.days) best = { days, from: dates[start], to: dates[i] };
  }
  return best;
}

/** Gaps between one working day's last finish and the next working day's first start, in minutes. */
function restGaps(shifts: Shift[]): number[] {
  const byDay = new Map<string, { start: number; end: number }>();
  for (const s of shifts) {
    const d = byDay.get(s.date);
    byDay.set(s.date, d ? { start: Math.min(d.start, s.startMinute), end: Math.max(d.end, s.endMinute) } : { start: s.startMinute, end: s.endMinute });
  }
  const days = [...byDay.keys()].sort();
  const gaps: number[] = [];
  for (let i = 1; i < days.length; i++) {
    const prev = byDay.get(days[i - 1])!;
    const next = byDay.get(days[i])!;
    gaps.push(daysBetween(days[i - 1], days[i]) * 1440 + next.start - prev.end);
  }
  return gaps;
}

export const isLateFinish = (s: Pick<Shift, 'endMinute'>, policy: WelfarePolicy) => s.endMinute >= policy.lateFinishMinute;

/**
 * One person's wellbeing over the last four weeks and the fortnight ahead. Hours are worked time:
 * approved clocked time where a day has any, the rota otherwise. The rota ahead counts only in
 * weeks already built for their site, so an unbuilt week never reads as hours cut.
 */
export function personWelfare(
  e: Employee,
  shifts: Shift[],
  entries: TimeEntry[],
  today: string,
  policy: WelfarePolicy,
  sight: Sight,
  extras: WelfareExtras = {},
): PersonWelfare {
  const from = addDays(today, -LOOKBACK_DAYS);
  const yesterday = addDays(today, -1);
  const mineRota = shifts.filter((s) => s.employeeId === e.id);
  const mineEntries = entries.filter((t) => t.employeeId === e.id);
  const past = workedShifts(mineRota.filter((s) => s.date >= from && s.date <= yesterday), entriesAsShifts(mineEntries.filter((t) => t.date >= from && t.date <= yesterday)));
  const ahead = mineRota.filter((s) => s.date >= today && s.date <= addDays(today, LOOKAHEAD_DAYS - 1));
  const span = [...past, ...ahead];
  const signals: WelfareSignal[] = [];
  const add = (s: WelfareSignal) => signals.push(s);

  const pastHours = hoursOf(past);
  const average = round1(pastHours / (LOOKBACK_DAYS / 7));
  const days = [...new Set(span.map((s) => s.date))].sort();
  const daysWorked = new Set(past.map((s) => s.date)).size;

  // Long weeks: by rota week, past and ahead. Legal with an opt-out, and still the first sign of burnout.
  const weeks = new Map<string, number>();
  for (const s of span) weeks.set(weekStart(s.date), (weeks.get(weekStart(s.date)) ?? 0) + shiftPaidHours(s));
  const long = [...weeks.entries()].filter(([, h]) => h > 48).sort();
  if (long.length >= 2 || average > 48) {
    add({ code: 'long-weeks', level: 'act', label: 'Long weeks', detail: `${long.length} weeks over 48 hours; ${average}h a week on average over the last four.`, action: 'Take hours out of the next rota and ask how they are coping. If they want the hours, agree a limit together.' });
  } else if (long.length === 1 || average > 45) {
    add({ code: 'long-weeks', level: 'watch', label: 'Long weeks', detail: long.length ? `Week of ${long[0][0]} at ${round1(long[0][1])} hours.` : `${average}h a week on average over the last four.`, action: 'Keep the next week nearer their contracted hours.' });
  }

  // Runs of days: weekly rest is checked within a rota week, so twelve days in a row across a week boundary is legal.
  const run = longestRun(days);
  if (run.days >= 7) {
    add({ code: 'run-of-days', level: 'act', label: 'Days in a row', detail: `${run.days} days in a row, ${run.from} to ${run.to}.`, action: 'Give two clear days together before the run reaches them, or straight after it.' });
  } else if (run.days === 6) {
    add({ code: 'run-of-days', level: 'watch', label: 'Days in a row', detail: `6 days in a row, ${run.from} to ${run.to}.`, action: 'Make sure the next days off are together.' });
  }

  // Tight turnarounds: a close followed by an open with only just the legal rest.
  const tight = restGaps(span).filter((g) => g < TIGHT_TURNAROUND_MINUTES).length;
  if (tight >= 4) add({ code: 'tight-turnarounds', level: 'act', label: 'Close then open', detail: `${tight} turnarounds under 12 hours in six weeks.`, action: 'Stop rostering them to close and then open. Pair closes with late starts.' });
  else if (tight >= 2) add({ code: 'tight-turnarounds', level: 'watch', label: 'Close then open', detail: `${tight} turnarounds under 12 hours in six weeks.`, action: 'Spread the closes and opens across the team.' });

  // Late finishes: getting home safely, and sleep.
  const late = past.filter((s) => isLateFinish(s, policy)).length;
  if (late >= 12) add({ code: 'late-finishes', level: 'act', label: 'Late finishes', detail: `${late} late finishes in four weeks.`, action: 'Share the closes, and check how they get home.' });
  else if (late >= 8) add({ code: 'late-finishes', level: 'watch', label: 'Late finishes', detail: `${late} late finishes in four weeks.`, action: 'Check how they get home, and give them an early week.' });

  // Weekends: a weekend off in four is what lets people keep a life outside work. The last four whole weekends.
  const lastSunday = weekday(yesterday) === 6 ? yesterday : addDays(weekStart(yesterday), -1);
  const weekends = [0, 1, 2, 3].map((i) => {
    const sun = addDays(lastSunday, -7 * i);
    return new Set(past.filter((s) => s.date === sun || s.date === addDays(sun, -1)).map((s) => s.date)).size;
  });
  if (weekends.length === 4 && weekends.every((w) => w === 2)) {
    add({ code: 'no-weekend-off', level: 'act', label: 'No weekend off', detail: 'Worked both days of each of the last four weekends.', action: 'Give them a full weekend off in the next fortnight.' });
  } else if (weekends.length === 4 && weekends.every((w) => w >= 1)) {
    add({ code: 'no-weekend-off', level: 'watch', label: 'No weekend off', detail: 'Worked on each of the last four weekends.', action: 'Plan a full weekend off within the month.' });
  }

  // Breaks: clocked shifts with less than the law gives, or a break taken in pieces.
  const missed = breakShortfalls(mineEntries.filter((t) => t.date >= from && t.date <= yesterday), [e]).length;
  if (missed >= 4) add({ code: 'missed-breaks', level: 'act', label: 'Breaks missed', detail: `${missed} shifts without the full rest break.`, action: 'Find out why: cover, workload or habit. Schedule the break on the rota and protect it.' });
  else if (missed >= 2) add({ code: 'missed-breaks', level: 'watch', label: 'Breaks missed', detail: `${missed} shifts without the full rest break.`, action: 'Ask whether they are getting their break, and cover it.' });

  // Holiday: nobody should go three months without a break.
  const employed = !e.startDate || daysBetween(e.startDate, today) >= 90;
  const recentLeave = e.leave.some((d) => d >= addDays(today, -90) && d <= addDays(today, 30));
  if (employed && !recentLeave && daysWorked > 0) {
    add({ code: 'no-holiday', level: 'watch', label: 'No holiday', detail: 'No leave in the last three months and none booked in the next month.', action: 'Suggest dates on a quiet week and book it with them.' });
  }

  // Hours cut: for someone paid by the hour, a halved rota is a halved wage.
  if (e.payBasis === 'hourly' && average >= 16) {
    const next = addDays(weekStart(today), 7);
    const inNext = (s: Shift) => s.date >= next && s.date <= addDays(next, 6);
    if (shifts.some((s) => s.siteId === e.siteId && inNext(s))) {
      const nextHours = round1(hoursOf(mineRota.filter(inNext)));
      if (nextHours <= average * 0.6) {
        add({ code: 'hours-drop', level: 'watch', label: 'Hours cut', detail: `${nextHours}h next week against ${average}h a week over the last four.`, action: 'Tell them before the rota does, and offer cover shifts at sister sites if they want the hours.' });
      }
    }
  }

  // Short sickness spells, for those who read the personnel file. Spells marked as disability or pregnancy related are left out.
  if (sight.hr) {
    const since = addDays(today, -182);
    const spells = (e.absences ?? []).filter((a) => a.type === 'sickness' && !a.excludeFromTriggers && a.from >= since && a.from <= today && a.to && absenceDays(a, today) <= SHORT_SPELL_DAYS);
    if (spells.length >= SHORT_SPELLS) {
      add({ code: 'short-sickness', level: 'watch', label: 'Short sickness spells', detail: `${spells.length} short spells of sickness in 26 weeks.`, action: 'Hold a supportive conversation first: ask what is behind it and what would help. This is not a trigger meeting.' });
    }
  }

  if (extras.chatRequestedAt) {
    add({ code: 'asked-for-chat', level: 'act', label: 'Asked for a chat', detail: `Asked from the staff app on ${extras.chatRequestedAt.slice(0, 10)}.`, action: 'Find a private moment this week, then mark it done.' });
  }

  const acts = signals.filter((s) => s.level === 'act').length;
  const level: WelfareLevel = acts > 0 || signals.length >= 3 ? 'act' : signals.length > 0 ? 'watch' : 'ok';
  return { employeeId: e.id, siteId: e.siteId, level, signals, averageWeeklyHours: average, daysWorked, lateFinishes: late };
}

/** Everyone working in scope, those who need a conversation first. */
export function teamWelfare(
  employees: Employee[],
  shifts: Shift[],
  entries: TimeEntry[],
  today: string,
  policy: WelfarePolicy,
  sight: (e: Employee) => Sight,
  extras: (e: Employee) => WelfareExtras = () => ({}),
): PersonWelfare[] {
  const rank: Record<WelfareLevel, number> = { act: 0, watch: 1, ok: 2 };
  return employees
    .filter((e) => !e.anonymisedOn && e.status !== 'leaver' && employeeStatus(e, today) !== 'left' && (!e.startDate || e.startDate <= today))
    .map((e) => personWelfare(e, shifts, entries, today, policy, sight(e), extras(e)))
    .sort((a, b) => rank[a.level] - rank[b.level] || b.signals.length - a.signals.length);
}

// A safe way home

export interface TravelHome {
  shiftId: string;
  employeeId: string;
  siteId: string;
  date: string;
  endMinute: number;
  under18: boolean;
  /** What the policy pays towards it. */
  allowance: number;
}

/**
 * Shifts in the fortnight ahead that finish late: past the policy's late finish, or after 22:00 for
 * an under 18. A young worker leaving at midnight is the employer's duty of care, not their parents'.
 */
export function travelHome(employees: Employee[], shifts: Shift[], today: string, policy: WelfarePolicy, days = LOOKAHEAD_DAYS): TravelHome[] {
  const byId = new Map(employees.map((e) => [e.id, e]));
  const out: TravelHome[] = [];
  for (const s of shifts) {
    if (s.date < today || s.date > addDays(today, days - 1)) continue;
    const e = byId.get(s.employeeId);
    if (!e) continue;
    const under18 = e.personalHidden ? !!e.under18 : !!e.dateOfBirth && ageOn(e.dateOfBirth, s.date) < 18;
    const youngLate = under18 && policy.under18TravelHome && s.endMinute > 22 * 60;
    if (!youngLate && !isLateFinish(s, policy)) continue;
    out.push({ shiftId: s.id, employeeId: e.id, siteId: s.siteId, date: s.date, endMinute: s.endMinute, under18, allowance: policy.travelHomeAllowance });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || b.endMinute - a.endMinute);
}

// Staff meals

export interface MealWeek {
  siteId: string;
  meals: number;
  cost: number;
}

/**
 * Staff meals a week by site: one for each shift of the policy's length or longer. Free or
 * subsidised meals on the premises, offered to all staff, are not a taxable benefit (ITEPA 2003
 * s317), unless they are given through salary sacrifice or flexible remuneration.
 */
export function staffMeals(shifts: Shift[], weekStartDate: string, siteIds: string[], policy: WelfarePolicy): MealWeek[] {
  const end = addDays(weekStartDate, 6);
  return siteIds.map((siteId) => {
    const meals = shifts.filter((s) => s.siteId === siteId && s.date >= weekStartDate && s.date <= end && shiftPaidHours(s) >= policy.mealFromHours).length;
    return { siteId, meals, cost: Math.round(meals * policy.mealCost * 100) / 100 };
  });
}

// Milestones and recognition

export type RecognitionCategory = 'guest' | 'team' | 'above-and-beyond' | 'standards' | 'milestone';

export const RECOGNITION_LABEL: Record<RecognitionCategory, string> = {
  guest: 'Great guest moment',
  team: 'Team player',
  'above-and-beyond': 'Above and beyond',
  standards: 'Standards and safety',
  milestone: 'Milestone',
};

/** The most one award may carry, so a month's budget is never spent on one person in one click. */
export const MAX_POINTS_PER_AWARD = 250;

/** 'none': a thank you without points. 'not-connected': given while no rewards platform was connected, so never sent. */
export type RewardsDelivery = 'none' | 'pending' | 'sent' | 'failed' | 'not-connected';

export interface Recognition {
  id: string;
  employeeId: string;
  /** The person's home site when given: the budget it counts against. */
  siteId: string;
  category: RecognitionCategory;
  message: string;
  points: number;
  by: string;
  byId?: string;
  at: string;
  /** Whether the points reached Hospitality Rewards. */
  rewards: { status: RewardsDelivery; ref?: string; error?: string; at?: string };
}

export interface Milestone {
  employeeId: string;
  kind: 'anniversary' | 'birthday' | 'probation';
  date: string;
  label: string;
  /** Points suggested for it, before the manager decides. */
  points: number;
}

/** Points suggested for a work anniversary: 50 a year of service, up to 500. */
export const anniversaryPoints = (years: number) => Math.min(500, years * 50);

/**
 * Milestones in the month ahead, and probations passed in the last fortnight: the moments worth
 * marking. Birthdays only where the reader may see a date of birth; the API blanks it otherwise.
 */
export function milestones(employees: Employee[], today: string, ahead = 30): Milestone[] {
  const out: Milestone[] = [];
  const until = addDays(today, ahead);
  const nextOccurrence = (iso: string) => {
    const thisYear = `${today.slice(0, 4)}${iso.slice(4)}`;
    return thisYear >= today ? thisYear : `${Number(today.slice(0, 4)) + 1}${iso.slice(4)}`;
  };
  for (const e of employees) {
    if (e.anonymisedOn || e.status === 'leaver' || employeeStatus(e, today) === 'left') continue;
    if (e.startDate && e.startDate < today) {
      const on = nextOccurrence(e.startDate);
      const years = Number(on.slice(0, 4)) - Number(e.startDate.slice(0, 4));
      if (years >= 1 && on <= until) out.push({ employeeId: e.id, kind: 'anniversary', date: on, label: `${years} ${years === 1 ? 'year' : 'years'} with you`, points: anniversaryPoints(years) });
    }
    if (e.dateOfBirth && !e.personalHidden) {
      const on = nextOccurrence(e.dateOfBirth);
      if (on <= addDays(today, 14)) out.push({ employeeId: e.id, kind: 'birthday', date: on, label: 'Birthday', points: 25 });
    }
    const passed = e.hr?.probationPassedOn;
    if (passed && passed <= today && passed >= addDays(today, -14)) out.push({ employeeId: e.id, kind: 'probation', date: passed, label: 'Passed probation', points: 50 });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Points a site has given in the calendar month of `on`. */
export function pointsGiven(recognitions: Recognition[], siteId: string, on: string): number {
  const month = on.slice(0, 7);
  return recognitions.filter((r) => r.siteId === siteId && r.at.slice(0, 7) === month).reduce((sum, r) => sum + r.points, 0);
}

/** Checks an award before it is made; returns what is wrong, or null. */
export function recognitionProblem(
  award: { employeeId: string; category: string; message: string; points: number },
  giverEmployeeId: string | undefined,
  given: number,
  policy: WelfarePolicy,
): string | null {
  if (!(award.category in RECOGNITION_LABEL)) return 'Choose what the recognition is for.';
  if (giverEmployeeId && giverEmployeeId === award.employeeId) return 'Recognition is given by someone else. Nobody awards points to themselves.';
  const message = award.message.trim();
  if (message.length < 10) return 'Say what they did, in a sentence: it is what makes recognition land.';
  if (message.length > 280) return 'Keep it to 280 characters.';
  if (!Number.isInteger(award.points) || award.points < 0) return 'Points are a whole number, nought or more.';
  if (award.points > MAX_POINTS_PER_AWARD) return `One award carries at most ${MAX_POINTS_PER_AWARD} points.`;
  if (given + award.points > policy.pointsPerSiteMonth) {
    return `That would take the site past its ${policy.pointsPerSiteMonth} points this month (${given} given). Give fewer points, or a thank you on its own.`;
  }
  return null;
}

// The team pulse

/** Fewer answers than this in a week and nothing is shown, so nobody can work out who said what. */
export const MIN_PULSE_RESPONSES = 5;
/** Pulse answers are kept 13 months: a year's trend, then gone. */
export const PULSE_RETENTION_DAYS = 396;

/** One answer to "How was your week?", stored without the person's id. */
export interface PulseResponse {
  siteId: string;
  /** Monday of the rota week answered. */
  week: string;
  score: 1 | 2 | 3 | 4 | 5;
}

export interface PulseWeek {
  week: string;
  responses: number;
  /** Null below MIN_PULSE_RESPONSES. */
  average: number | null;
}

/** A site's pulse week by week, newest last, with any week too small to show held back. */
export function pulseTrend(responses: PulseResponse[], siteIds: string[], thisWeek: string, weeks = 8): PulseWeek[] {
  return Array.from({ length: weeks }, (_, i) => addDays(thisWeek, -7 * (weeks - 1 - i))).map((week) => {
    const rows = responses.filter((r) => r.week === week && siteIds.includes(r.siteId));
    return {
      week,
      responses: rows.length,
      average: rows.length >= MIN_PULSE_RESPONSES ? round1(rows.reduce((s, r) => s + r.score, 0) / rows.length) : null,
    };
  });
}

/** A request for a private conversation, made from the staff app. The person chose to be named. */
export interface ChatRequest {
  id: string;
  employeeId: string;
  siteId: string;
  at: string;
  status: 'open' | 'done';
  doneBy?: string;
  doneAt?: string;
}

// Hospitality Rewards membership

/** What Hospitality Rewards is told about a person: enough to enrol them, nothing about pay, age or health. */
export interface RewardsMember {
  /** The person's Preshift id: the reference both sides use. */
  ref: string;
  firstName: string;
  lastName: string;
  email?: string;
  site: string;
  company: string;
  startDate?: string;
}

function splitName(name: string) {
  const parts = name.trim().split(/\s+/);
  return parts.length === 1 ? { firstName: parts[0], lastName: '' } : { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
}

/**
 * Who should be enrolled today: everyone employed and started, not anonymised, who has not opted out.
 * A leaver drops off the day after their last day.
 */
export function rewardsMembers(
  employees: Employee[],
  sites: { id: string; name: string }[],
  entities: { id: string; name: string }[],
  today: string,
  optedOut: string[],
): RewardsMember[] {
  const out = new Set(optedOut);
  return employees
    .filter((e) => !e.anonymisedOn && !out.has(e.id) && e.status !== 'leaver' && employeeStatus(e, today) !== 'left' && (!e.startDate || e.startDate <= today) && (!e.leaveDate || e.leaveDate >= today))
    .map((e) => ({
      ref: e.id,
      ...splitName(e.name),
      ...(e.email ? { email: e.email } : {}),
      site: sites.find((s) => s.id === e.siteId)?.name ?? e.siteId,
      company: entities.find((x) => x.id === e.entityId)?.name ?? e.entityId,
      ...(e.startDate ? { startDate: e.startDate } : {}),
    }));
}

/** What a sync must do: enrol or update everyone eligible, remove whoever was enrolled and no longer is. */
export function rewardsChanges(eligible: RewardsMember[], enrolled: string[]): { upsert: RewardsMember[]; remove: string[] } {
  const now = new Set(eligible.map((m) => m.ref));
  return { upsert: eligible, remove: enrolled.filter((ref) => !now.has(ref)) };
}

/** The eligibility file, for providers that onboard by file: one row a person. */
export function eligibilityCsv(members: RewardsMember[]): string {
  const cell = (v: string | undefined) => (v && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v ?? '');
  const rows = members.map((m) => [m.ref, m.firstName, m.lastName, m.email, m.site, m.company, m.startDate].map(cell).join(','));
  return ['Employee reference,First name,Last name,Work email,Site,Company,Start date', ...rows].join('\n');
}
