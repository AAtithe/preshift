import type { ClockRecord, GeoPoint, RotaState, Shift, TroncScheme } from '../engine/types';
import { markWeekPaid } from '../engine/tronc';
import { weekDates } from '../engine/time';

/** What the app asks for. The server decides whether it is allowed and what actually changes. */
export type Command =
  | { type: 'upsertShift'; shift: Shift }
  | { type: 'deleteShift'; id: string }
  | { type: 'replaceWeek'; siteId: string; weekStart: string; shifts: Shift[] }
  | { type: 'clearWeek'; siteId: string; weekStart: string }
  | { type: 'publishWeek'; siteId: string; weekStart: string }
  | { type: 'applyCut'; shiftId: string; endMinute: number; breakMinutes: number }
  /** `demoAt` sets the time in the offline demo only; the server always uses its own clock. */
  | { type: 'clockIn'; employeeId: string; siteId: string; position?: GeoPoint; demoAt?: { date: string; minute: number } }
  | { type: 'clockOut'; id: string; breakMinutes: number; demoAt?: { date: string; minute: number } }
  | { type: 'approveClocks'; ids: string[] }
  | { type: 'updateTroncScheme'; scheme: TroncScheme }
  | { type: 'markTipsPaid'; siteId: string; weekStart: string; date: string }
  | { type: 'seedDemo' };

/** What changed, applied the same way in the browser whether the server or the offline demo produced it. */
export type Change =
  | { type: 'upsertShift'; shift: Shift }
  | { type: 'deleteShift'; id: string }
  | { type: 'replaceWeek'; siteId: string; weekStart: string; shifts: Shift[] }
  | { type: 'publishWeek'; siteId: string; weekStart: string }
  | { type: 'putClock'; clock: ClockRecord }
  | { type: 'approveClocks'; ids: string[] }
  | { type: 'updateTroncScheme'; scheme: TroncScheme }
  | { type: 'markTipsPaid'; siteId: string; weekStart: string; date: string }
  | { type: 'replaceState'; state: RotaState };

export function inWeek(shift: { siteId: string; date: string }, siteId: string, weekStart: string): boolean {
  return shift.siteId === siteId && weekDates(weekStart).includes(shift.date);
}

export function applyChange(state: RotaState, change: Change): RotaState {
  switch (change.type) {
    case 'upsertShift': {
      const exists = state.shifts.some((s) => s.id === change.shift.id);
      return {
        ...state,
        shifts: exists ? state.shifts.map((s) => (s.id === change.shift.id ? change.shift : s)) : [...state.shifts, change.shift],
      };
    }
    case 'deleteShift':
      return { ...state, shifts: state.shifts.filter((s) => s.id !== change.id) };
    case 'replaceWeek':
      return { ...state, shifts: [...state.shifts.filter((s) => !inWeek(s, change.siteId, change.weekStart)), ...change.shifts] };
    case 'publishWeek':
      return {
        ...state,
        shifts: state.shifts.map((s) => (inWeek(s, change.siteId, change.weekStart) ? { ...s, published: true } : s)),
      };
    case 'putClock': {
      const exists = state.clocks.some((c) => c.id === change.clock.id);
      return {
        ...state,
        clocks: exists ? state.clocks.map((c) => (c.id === change.clock.id ? change.clock : c)) : [...state.clocks, change.clock],
      };
    }
    case 'approveClocks': {
      const ids = new Set(change.ids);
      return { ...state, clocks: state.clocks.map((c) => (ids.has(c.id) ? { ...c, approved: true } : c)) };
    }
    case 'updateTroncScheme':
      return { ...state, troncSchemes: state.troncSchemes.map((t) => (t.siteId === change.scheme.siteId ? change.scheme : t)) };
    case 'markTipsPaid':
      return { ...state, tips: markWeekPaid(state.tips, change.siteId, change.weekStart, change.date) };
    case 'replaceState':
      return change.state;
  }
}
