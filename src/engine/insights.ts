import { shiftPaidHours } from './cost';
import { holidayBalance, workedShifts } from './holiday';
import { entriesAsShifts } from './timesheet';
import { addDays, daysBetween, weekday } from './time';
import type { Employee, RotaState, TimeEntry } from './types';

/** How late a clock-in can be before it counts as a late arrival. */
export const LATE_AFTER_MINUTES = 10;
/** A shift finishing this close to the site's close counts as a closing shift. */
const CLOSE_WINDOW_MINUTES = 30;
/** Holiday left at or above this many days, within this many days of the year end, is worth planning in. */
const HOLIDAY_NUDGE_DAYS = 2;
const HOLIDAY_NUDGE_WINDOW = 60;

export interface PersonInsight {
  employeeId: string;
  /** The weeks looked back over, ending the day before the week being planned (or today, if sooner). */
  from: string;
  to: string;
  averageWeeklyHours: number;
  weekendShifts: number;
  closingShifts: number;
  /** Counted only at sites that use clocking, so nobody is marked late or absent for want of a clock. */
  lateArrivals: number | null;
  noShows: number | null;
  notes?: string;
  holiday?: {
    remainingHours: number;
    leaveYearEnd: string;
    daysToYearEnd: number;
    /** A good share of holiday left with the year end close: worth offering on quiet days. */
    shouldPlanLeave: boolean;
  };
}

/**
 * What the last few weeks say about each person, for a fair and resilient rota: who has had the
 * weekends and the closes, who arrives late or misses shifts, what their notes say, and who has
 * holiday to use before the leave year ends. Holiday uses the same engine as the Holiday screen.
 */
export function peopleInsights(
  state: Pick<RotaState, 'shifts' | 'sites' | 'entities'>,
  people: Employee[],
  entries: TimeEntry[],
  weekStartDate: string,
  today: string,
  weeks = 4,
): Record<string, PersonInsight> {
  const from = addDays(weekStartDate, -7 * weeks);
  const dayBefore = addDays(weekStartDate, -1);
  const to = dayBefore < today ? dayBefore : addDays(today, -1);
  const span = Math.max(1, daysBetween(from, to) + 1) / 7;
  const inPeriod = (date: string) => date >= from && date <= to;
  const clockingSites = new Set(entries.filter((t) => inPeriod(t.date)).map((t) => t.siteId));
  const worked = workedShifts(state.shifts.filter((s) => s.date <= today), entriesAsShifts(entries));
  const closeOf = (siteId: string) => state.sites.find((s) => s.id === siteId)?.closeMinute ?? 24 * 60;

  const out: Record<string, PersonInsight> = {};
  for (const e of people) {
    const rostered = state.shifts.filter((s) => s.employeeId === e.id && inPeriod(s.date));
    const mine = entries.filter((t) => t.employeeId === e.id && inPeriod(t.date));
    const clocked = rostered.filter((s) => clockingSites.has(s.siteId));
    const late = clocked.filter((s) => {
      const entry = mine.find((t) => t.shiftId === s.id) ?? mine.find((t) => t.date === s.date && t.siteId === s.siteId);
      return entry !== undefined && entry.clockIn > s.startMinute + LATE_AFTER_MINUTES;
    }).length;
    const noShows = clocked.filter((s) => !e.leave.includes(s.date) && !mine.some((t) => t.date === s.date)).length;

    const insight: PersonInsight = {
      employeeId: e.id,
      from,
      to,
      averageWeeklyHours: Math.round((rostered.reduce((sum, s) => sum + shiftPaidHours(s), 0) / span) * 10) / 10,
      weekendShifts: rostered.filter((s) => weekday(s.date) >= 5).length,
      closingShifts: rostered.filter((s) => s.endMinute >= closeOf(s.siteId) - CLOSE_WINDOW_MINUTES).length,
      lateArrivals: clocked.length ? late : null,
      noShows: clocked.length ? noShows : null,
      ...(e.rotaNotes?.trim() ? { notes: e.rotaNotes.trim() } : {}),
    };

    const yearStart = state.entities.find((x) => x.id === e.entityId)?.leaveYearStart ?? '01-01';
    const balance = holidayBalance(e, worked, today, yearStart);
    const daysToYearEnd = daysBetween(today, balance.year.end);
    insight.holiday = {
      remainingHours: Math.round(balance.remainingHours * 10) / 10,
      leaveYearEnd: balance.year.end,
      daysToYearEnd,
      shouldPlanLeave: balance.remainingHours >= HOLIDAY_NUDGE_DAYS * balance.dayHours && daysToYearEnd <= HOLIDAY_NUDGE_WINDOW,
    };
    out[e.id] = insight;
  }
  return out;
}
