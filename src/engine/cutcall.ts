import type { RotaState, Shift } from './types';
import { blendedShifts } from './actuals';
import { requiredBreakMinutes } from './compliance';
import { employeeWeekCost, shiftsInWeek } from './cost';
import { headcountAt, requiredHeadcount } from './demand';
import { ageOn, weekStart } from './time';

export interface CutOptions {
  /** Share of the day's forecast that must have traded before the call is trusted. */
  minTradedShare: number;
  /** Trading pace is clamped to this range so one odd hour cannot empty the floor. */
  paceFloor: number;
  paceCeiling: number;
  /** Not worth sending someone home with less than this left on their shift. */
  minMinutesSaved: number;
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
  /** Loaded saving to the week, after guaranteed hours and on-cost thresholds. */
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
  /** False until enough of the day has traded to trust the pace. */
  confident: boolean;
  recommendations: CutRecommendation[];
  totalSaving: number;
  /** People whose shift could be cut but who cost nothing extra to keep, so they stay. */
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
  siteId: string,
  date: string,
  now: number,
  options: Partial<CutOptions> = {},
): CutCall {
  const opts = { ...DEFAULT_CUT_OPTIONS, ...options };
  const site = state.sites.find((s) => s.id === siteId);
  const forecast = state.forecast.filter((f) => f.siteId === siteId && f.date === date);
  const forecastDay = forecast.reduce((sum, f) => sum + f.sales, 0);
  const traded = (hour: number) => (hour + 1) * 60 <= now;
  const forecastSoFar = forecast.filter((f) => traded(f.hour)).reduce((sum, f) => sum + f.sales, 0);
  const salesSoFar = state.actuals
    .filter((a) => a.siteId === siteId && a.date === date && traded(a.hour))
    .reduce((sum, a) => sum + a.sales, 0);
  const rawPace = forecastSoFar > 0 ? salesSoFar / forecastSoFar : 1;
  const pace = Math.min(opts.paceCeiling, Math.max(opts.paceFloor, rawPace));
  const confident = forecastDay > 0 && forecastSoFar / forecastDay >= opts.minTradedShare;
  const reforecastDay = salesSoFar + (forecastDay - forecastSoFar) * pace;

  const empty: CutCall = {
    now,
    forecastSoFar,
    salesSoFar,
    pace,
    forecastDay,
    reforecastDay,
    confident,
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
    if (!rule || hour >= 24) return 0;
    const f = byHour.get(hour);
    const scaled = f ? { ...f, sales: f.sales * pace, covers: f.covers * pace } : undefined;
    return requiredHeadcount(rule, site, scaled, hour);
  };

  const nextHour = Math.ceil(now / 60);
  let shifts = [...state.shifts];
  const short: ShortHour[] = [];
  for (const rule of rules) {
    for (let hour = nextHour; hour < 24; hour++) {
      const gap = required(rule.roleId, hour) - headcountAt(shifts, date, hour, rule.roleId, siteId);
      if (gap > 0) short.push({ roleId: rule.roleId, hour, short: gap });
    }
  }
  if (!confident) return { ...empty, short };

  const ws = weekStart(date);
  const weekOf = (all: Shift[], employeeId: string) =>
    shiftsInWeek(blendedShifts({ shifts: all, clocks: state.clocks }, date), ws).filter((s) => s.employeeId === employeeId);
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
        if (headcountAt(others, date, hour, shift.roleId, siteId) < required(shift.roleId, hour)) {
          covered = false;
          break;
        }
      }
      if (!covered) continue;

      const length = newEnd - shift.startMinute;
      const neededBreak = requiredBreakMinutes(length, ageOn(employee.dateOfBirth, date));
      const newBreakMinutes = neededBreak > 0 ? Math.min(shift.breakMinutes, length) : 0;
      const next: Shift = { ...shift, endMinute: newEnd, breakMinutes: newBreakMinutes };
      const before = employeeWeekCost(employee, weekOf(shifts, employee.id)).total;
      const after = employeeWeekCost(employee, weekOf(shifts.map((s) => (s.id === shift.id ? next : s)), employee.id)).total;
      const saving = round2(before - after);
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
        minutesSaved: shift.endMinute - newEnd,
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
