import { useEffect, useReducer } from 'react';
import type { ClockRecord, RotaState, Shift, TroncScheme } from '../engine/types';
import { markWeekPaid } from '../engine/tronc';
import { seedDemo } from '../engine/simulate';
import { weekDates } from '../engine/time';

export type Action =
  | { type: 'upsertShift'; shift: Shift }
  | { type: 'deleteShift'; id: string }
  | { type: 'setShifts'; shifts: Shift[] }
  | { type: 'clearWeek'; siteId: string; weekStart: string }
  | { type: 'publishWeek'; siteId: string; weekStart: string }
  | { type: 'applyCut'; shiftId: string; endMinute: number; breakMinutes: number }
  | { type: 'clockIn'; clock: ClockRecord }
  | { type: 'clockOut'; clock: ClockRecord }
  | { type: 'approveClocks'; ids: string[] }
  | { type: 'updateTroncScheme'; scheme: TroncScheme }
  | { type: 'markTipsPaid'; siteId: string; weekStart: string; date: string }
  | { type: 'reset' };

// v4 adds tips and tronc schemes; older saved states fall back to the demo.
const KEY = 'preshift.rota.v4';

function load(): RotaState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as RotaState;
  } catch {
    // Storage blocked or corrupt: fall back to the demo data.
  }
  return seedDemo();
}

function inWeek(shift: Shift, siteId: string, weekStart: string) {
  return shift.siteId === siteId && weekDates(weekStart).includes(shift.date);
}

function reducer(state: RotaState, action: Action): RotaState {
  switch (action.type) {
    case 'upsertShift': {
      const exists = state.shifts.some((s) => s.id === action.shift.id);
      const shift = { ...action.shift, published: false };
      return {
        ...state,
        shifts: exists ? state.shifts.map((s) => (s.id === shift.id ? shift : s)) : [...state.shifts, shift],
      };
    }
    case 'deleteShift':
      return { ...state, shifts: state.shifts.filter((s) => s.id !== action.id) };
    case 'setShifts':
      return { ...state, shifts: action.shifts };
    case 'clearWeek':
      return { ...state, shifts: state.shifts.filter((s) => !inWeek(s, action.siteId, action.weekStart)) };
    case 'publishWeek':
      return {
        ...state,
        shifts: state.shifts.map((s) => (inWeek(s, action.siteId, action.weekStart) ? { ...s, published: true } : s)),
      };
    case 'applyCut':
      // A live change to a published rota: it stays published, the person is told on the floor.
      return {
        ...state,
        shifts: state.shifts.map((s) =>
          s.id === action.shiftId ? { ...s, endMinute: action.endMinute, breakMinutes: action.breakMinutes } : s,
        ),
      };
    case 'clockIn':
      return { ...state, clocks: [...state.clocks, action.clock] };
    case 'clockOut':
      return { ...state, clocks: state.clocks.map((c) => (c.id === action.clock.id ? action.clock : c)) };
    case 'approveClocks': {
      const ids = new Set(action.ids);
      return { ...state, clocks: state.clocks.map((c) => (ids.has(c.id) ? { ...c, approved: true } : c)) };
    }
    case 'updateTroncScheme':
      return { ...state, troncSchemes: state.troncSchemes.map((t) => (t.siteId === action.scheme.siteId ? action.scheme : t)) };
    case 'markTipsPaid':
      return { ...state, tips: markWeekPaid(state.tips, action.siteId, action.weekStart, action.date) };
    case 'reset':
      return seedDemo();
  }
}

export function useRotaStore() {
  const [state, dispatch] = useReducer(reducer, undefined, load);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      // Non-fatal: the rota still works for this session.
    }
  }, [state]);
  return [state, dispatch] as const;
}
