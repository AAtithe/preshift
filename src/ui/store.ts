import { useCallback, useEffect, useState } from 'react';
import type { RotaState } from '../engine/types';
import { checkClockIn, endClock, startClock } from '../engine/clocking';
import { checkWeek } from '../engine/compliance';
import { seedDemo } from '../engine/simulate';
import { toISODate } from '../engine/time';
import { applyChange, type Change, type Command } from '../shared/commands';
import { api, ApiError } from './api';

// v8 adds the menu, dish sales, purchases and stock counts; older saved states fall back to the demo.
const KEY = 'preshift.rota.v8';

function loadDemo(): RotaState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as RotaState;
  } catch {
    // Storage blocked or corrupt: fall back to the demo data.
  }
  return seedDemo();
}

/**
 * The offline demo's stand-in for the server: the same command, the same
 * rules where the server enforces them, the same changes back. Time comes
 * from the demo clock the screen passes in.
 */
function localChanges(state: RotaState, cmd: Command): Change[] {
  const today = { date: toISODate(new Date()), minute: 0 };
  switch (cmd.type) {
    case 'upsertShift':
      return [{ type: 'upsertShift', shift: { ...cmd.shift, published: false } }];
    case 'deleteShift':
      return [cmd];
    case 'replaceWeek':
      return [cmd];
    case 'clearWeek':
      return [{ type: 'replaceWeek', siteId: cmd.siteId, weekStart: cmd.weekStart, shifts: [] }];
    case 'publishWeek': {
      const blocks = checkWeek(state, cmd.weekStart, cmd.siteId).filter((i) => i.severity === 'block');
      if (blocks.length) throw new ApiError(409, blocks[0].message);
      return [cmd];
    }
    case 'applyCut': {
      // A live change to a published rota: it stays published, the person is told on the floor.
      const shift = state.shifts.find((s) => s.id === cmd.shiftId)!;
      return [{ type: 'upsertShift', shift: { ...shift, endMinute: cmd.endMinute, breakMinutes: cmd.breakMinutes } }];
    }
    case 'clockIn': {
      const { date, minute } = cmd.demoAt ?? today;
      const check = checkClockIn(state, cmd.employeeId, cmd.siteId, date, minute, cmd.position);
      if (!check.ok) throw new ApiError(409, check.reason);
      const employee = state.employees.find((e) => e.id === cmd.employeeId)!;
      return [{ type: 'putClock', clock: startClock(cmd.employeeId, cmd.siteId, employee.roleIds[0], date, minute, check.shift, cmd.position ? 'geofence' : 'manager') }];
    }
    case 'clockOut': {
      const open = state.clocks.find((c) => c.id === cmd.id)!;
      return [{ type: 'putClock', clock: endClock(open, (cmd.demoAt ?? today).minute, cmd.breakMinutes) }];
    }
    case 'approveClocks':
    case 'updateTroncScheme':
    case 'markTipsPaid':
      return [cmd];
    case 'seedDemo':
      return [{ type: 'replaceState', state: seedDemo() }];
  }
}

export interface Store {
  state: RotaState | null;
  /** Runs a command; resolves false if it was refused, with the reason in `error`. */
  run: (cmd: Command) => Promise<boolean>;
  error: string | null;
  clearError: () => void;
}

export function useRotaStore(mode: 'demo' | 'server'): Store {
  const [state, setState] = useState<RotaState | null>(() => (mode === 'demo' ? loadDemo() : null));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== 'server') return;
    api.state().then((r) => setState(r.state), (e: Error) => setError(e.message));
  }, [mode]);

  useEffect(() => {
    if (mode !== 'demo' || !state) return;
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      // Non-fatal: the rota still works for this session.
    }
  }, [mode, state]);

  const run = useCallback(
    async (cmd: Command) => {
      try {
        let changes: Change[];
        if (mode === 'server') changes = (await api.command(cmd)).changes;
        else {
          if (!state) return false;
          changes = localChanges(state, cmd);
        }
        setState((s) => (s ? changes.reduce(applyChange, s) : s));
        setError(null);
        return true;
      } catch (e) {
        setError((e as Error).message);
        // Anything other than a refusal means this copy may be stale: reload from the server.
        if (mode === 'server' && !(e instanceof ApiError && [400, 403, 404, 409].includes(e.status))) {
          api.state().then((r) => setState(r.state), () => undefined);
        }
        return false;
      }
    },
    [mode, state],
  );

  return { state, run, error, clearError: () => setError(null) };
}

