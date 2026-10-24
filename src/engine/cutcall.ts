import type { RotaState, Shift, TimeEntry } from './types';
import { blendedShifts, loadedHourlyRate } from './actuals';
import { breakFor } from './compliance';
import { employeeWeekCost, shiftsInWeek } from './cost';
import { calendarHour, headcountAt, requiredHeadcount, tradingDayHours } from './demand';
import { shortNoticeCompensation, type EraPolicy } from './era';
import { assessShortNotice, snapshot, type EraSettings } from './employmentRights';
import { addDays, weekStart } from './time';

export interface CutOptions {
  /** Share of the day's forecast that must have traded before the call is trusted. */
  minTradedShare: number;
  /** Trading pace is clamped to this range so one odd hour cannot empty the floor. */
  paceFloor: number;
  paceCeiling: number;
  /** Not worth sending someone home with less than this left on their shift. */
  minMinutesSaved: number;
  /**
   * When set, cuts are priced with Employment Rights Act short-notice
   * compensation. A cut on the day is always short notice.
   */
  era?: EraPolicy;
  /**
   * The organisation's Employment Rights Act settings and the moment of the call. A cut to a published
   * shift for a covered worker is priced with the short notice pay it owes once the measure has started,
   * and shown as what it would owe before then. Takes the place of `era` when given.
   */
  rights?: { settings: EraSettings; at: Date };
}

export const DEFAULT_CUT_OPTIONS: CutOptions = { minTradedShare: 0.1, paceFloor: 0.5, paceCeiling: 1.5, minMinutesSaved: 45 };

export interface CutRecommendation {
  shiftId: string;
  employeeId: string;
  roleId: string;
  currentEnd: number;
  newEnd: number;
  /** The shift has not started: stand the person down rather than send them home. */
  standDown: boolean;
  newBreakMinutes: number;
  minutesSaved: number;
  /** Short-notice compensation owed for the cut, when Employment Rights Act pricing is on. */
  compensation: number;
  /** Short notice pay the cut would owe once the measure starts: shown, not deducted. */
  wouldOwe?: number;
  /** Loaded saving to the week, after guaranteed hours, on-cost thresholds and any compensation. */
  saving: number;
}

export interface ShortHour {
  roleId: string;
  hour: number;
  short: number;
}

export interface CutCall {
  now: number;
  forecastSoFar: number;
  salesSoFar: number;
  /** Actual over forecast for the hours traded, clamped. */
  pace: number;
  forecastDay: number;
  reforecastDay: number;
  /** False until enough of the day has traded to trust the pace, and always false without hourly till figures. */
  confident: boolean;
  /** Why there is no call, when there is none. */
  reason?: string;
  recommendations: CutRecommendation[];
  totalSaving: number;
  /** People whose shift could be cut but whose early finish saves nothing, so they stay. */
  keptAtNoCost: string[];
  /** Hours still to come that are short on the reforecast: call someone in or move people. */
  short: ShortHour[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The afternoon call every GM makes on instinct, made on numbers. Trading so
 * far against forecast gives the pace; the rest of the day is reforecast at
 * that pace and turned back into headcount per role. Anyone not needed for the
 * rest of their shift is a candidate to send home at the next hour, and the
 * people whose early finish saves the most go first. The saving is worked on
 * the person's whole week, so someone still inside their guaranteed hours
 * saves nothing and stays.
 */
export function cutCall(
  state: RotaState,
  entries: TimeEntry[],
  siteId: string,
  date: string,
  now: number,
  options: Partial<CutOptions> = {},
): CutCall {
  const opts = { ...DEFAULT_CUT_OPTIONS, ...options };
  const site = state.sites.find((s) => s.id === siteId);
  // The trading day runs from opening to closing, past midnight where the site trades late or round
  // the clock: hours from 24 are the next date's early hours, and `now` counts on from 1440 after midnight.
  const hours = site ? tradingDayHours(site) : 24;
  const inDay = (h: number) => !site || (h * 60 >= site.openMinute && h * 60 < site.closeMinute);
  const next = addDays(date, 1);
  const forecast = state.forecast
    .filter((f) => f.siteId === siteId && (f.date === date || (hours > 24 && f.date === next)))
    .map((f) => (f.date === date ? f : { ...f, hour: f.hour + 24 }))
    .filter((f) => f.hour < hours && (f.hour < 24 || inDay(f.hour)));
  const forecastDay = forecast.reduce((sum, f) => sum + f.sales, 0);
  const traded = (hour: number) => (hour + 1) * 60 <= now;
  const forecastSoFar = forecast.filter((f) => traded(f.hour)).reduce((sum, f) => sum + f.sales, 0);
  // Hourly takings come from a connected till. Without them there is no pace to read, and a missing
  // figure must never be read as a quiet day: that would send the whole floor home.
  const lateTill = hours > 24 ? (state.sales?.find((d) => d.siteId === siteId && d.date === next)?.hours ?? []).map((h) => ({ ...h, hour: h.hour + 24 })).filter((h) => inDay(h.hour)) : [];
  const tillHours = [...(state.sales?.find((d) => d.siteId === siteId && d.date === date)?.hours ?? []), ...lateTill];
  const salesSoFar = tillHours.filter((h) => traded(h.hour)).reduce((sum, h) => sum + h.netSales, 0);
  const rawPace = forecastSoFar > 0 ? salesSoFar / forecastSoFar : 1;
  const pace = tillHours.length ? Math.min(opts.paceCeiling, Math.max(opts.paceFloor, rawPace)) : 1;
  const enoughTraded = forecastDay > 0 && forecastSoFar / forecastDay >= opts.minTradedShare;
  const confident = tillHours.length > 0 && enoughTraded;
  const reason = forecastDay > 0 && forecastSoFar === 0
    ? 'Nothing has traded yet today. The first call comes once a tenth of the day forecast is in.'
    : !tillHours.length
      ? 'No hourly takings from the till for today, so there is no trading pace to call on.'
      : !enoughTraded
        ? 'Too early to call: under a tenth of the day forecast has traded.'
        : undefined;
  const reforecastDay = salesSoFar + (forecastDay - forecastSoFar) * pace;

  const empty: CutCall = {
    now,
    forecastSoFar,
    salesSoFar,
    pace,
    forecastDay,
    reforecastDay,
    confident,
    reason,
    recommendations: [],
    totalSaving: 0,
    keptAtNoCost: [],
    short: [],
  };
  if (!site) return empty;

  const byHour = new Map(forecast.map((f) => [f.hour, f]));
  const rules = state.demandRules.filter((r) => r.siteId === siteId);
  const required = (roleId: string, hour: number) => {
    const rule = rules.find((r) => r.roleId === roleId);
    if (!rule || hour >= hours) return 0;
    const f = byHour.get(hour);
    const scaled = f ? { ...f, sales: f.sales * pace, covers: f.covers * pace } : undefined;
    return requiredHeadcount(rule, site, scaled, hour);
  };

  const nextHour = Math.ceil(now / 60);
  let shifts = [...state.shifts];
  // Headcount at an hour of the trading day, reading the next date for the small hours.
  const onAt = (all: Shift[], hour: number, roleId: string) => {
    const at = calendarHour(date, hour);
    return headcountAt(all, at.date, at.hour, roleId, siteId);
  };
  const short: ShortHour[] = [];
  for (const rule of rules) {
    for (let hour = nextHour; hour < hours; hour++) {
      const gap = required(rule.roleId, hour) - onAt(shifts, hour, rule.roleId);
      if (gap > 0) short.push({ roleId: rule.roleId, hour, short: gap });
    }
  }
  if (!confident) return { ...empty, short };

  const ws = weekStart(date);
  const weekOf = (all: Shift[], employeeId: string) =>
    shiftsInWeek(blendedShifts({ shifts: all }, entries, date), ws).filter((s) => s.employeeId === employeeId);
  const recommendations: CutRecommendation[] = [];
  const keptAtNoCost = new Set<string>();

  for (let guard = 0; guard < 50; guard++) {
    let best: { rec: CutRecommendation; next: Shift } | null = null;
    for (const shift of shifts) {
      if (shift.siteId !== siteId || shift.date !== date || recommendations.some((r) => r.shiftId === shift.id)) continue;
      const employee = state.employees.find((e) => e.id === shift.employeeId);
      if (!employee || employee.payBasis === 'salaried') continue;
      const newEnd = Math.max(nextHour * 60, shift.startMinute);
      if (shift.endMinute - newEnd < opts.minMinutesSaved) continue;

      // Everyone else must still cover every remaining hour of this shift.
      const others = shifts.filter((s) => s.id !== shift.id);
      let covered = true;
      for (let hour = Math.floor(newEnd / 60); hour * 60 < shift.endMinute; hour++) {
        if (onAt(others, hour, shift.roleId) < required(shift.roleId, hour)) {
          covered = false;
          break;
        }
      }
      if (!covered) continue;

      const length = newEnd - shift.startMinute;
      // Main's rule: children, young workers and adults, without reading a date of birth the reader may not see.
      const neededBreak = breakFor(employee, date, length);
      const newBreakMinutes = neededBreak > 0 ? Math.min(shift.breakMinutes, length) : 0;
      const next: Shift = { ...shift, endMinute: newEnd, breakMinutes: newBreakMinutes };
      const before = employeeWeekCost(employee, weekOf(shifts, employee.id)).total;
      const after = employeeWeekCost(employee, weekOf(shifts.map((s) => (s.id === shift.id ? next : s)), employee.id)).total;
      const minutesSaved = shift.endMinute - newEnd;
      let compensation = opts.era && !opts.rights ? shortNoticeCompensation(minutesSaved, loadedHourlyRate(employee), opts.era) : 0;
      let wouldOwe: number | undefined;
      if (opts.rights && shift.published) {
        const owed = assessShortNotice(snapshot(shift), snapshot(next), employee, opts.rights.at, opts.rights.settings);
        // Pay owed carries on-costs like any pay, so it is priced at the person's loaded rate.
        if (owed?.owed) compensation = round2(owed.amount * (employee.hourlyRate > 0 ? loadedHourlyRate(employee) / employee.hourlyRate : 1));
        else if (owed) wouldOwe = owed.amount;
      }
      const saving = round2(before - after - compensation);
      if (saving <= 0) {
        keptAtNoCost.add(employee.id);
        continue;
      }
      const rec: CutRecommendation = {
        shiftId: shift.id,
        employeeId: employee.id,
        roleId: shift.roleId,
        currentEnd: shift.endMinute,
        newEnd,
        standDown: newEnd <= shift.startMinute,
        newBreakMinutes,
        minutesSaved,
        compensation,
        ...(wouldOwe ? { wouldOwe } : {}),
        saving,
      };
      if (!best || rec.saving > best.rec.saving) best = { rec, next };
    }
    if (!best) break;
    recommendations.push(best.rec);
    keptAtNoCost.delete(best.rec.employeeId);
    shifts = shifts.map((s) => (s.id === best!.rec.shiftId ? best!.next : s));
  }

  return {
    ...empty,
    recommendations,
    totalSaving: round2(recommendations.reduce((sum, r) => sum + r.saving, 0)),
    keptAtNoCost: [...keptAtNoCost],
    short,
  };
}
