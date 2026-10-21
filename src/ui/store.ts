import { useEffect, useReducer } from 'react';
import type { RotaState, Shift } from '../engine/types';
import { seedState } from '../engine/seed';
import { weekDates } from '../engine/time';

export type Action =
  | { type: 'upsertShift'; shift: Shift }
  | { type: 'deleteShift'; id: string }
  | { type: 'setShifts'; shifts: Shift[] }
  | { type: 'clearWeek'; siteId: string; weekStart: string }
  | { type: 'publishWeek'; siteId: string; weekStart: string }
  | { type: 'reset' };

const KEY = 'preshift.rota.v1';

function load(): RotaState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as RotaState;
  } catch {
    // Storage blocked or corrupt: fall back to the demo data.
  }
  return seedState();
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
    case 'reset':
      return seedState();
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
