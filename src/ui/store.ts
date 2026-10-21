import { useCallback, useEffect, useState } from 'react';
import type { UnfilledGap } from '../engine/autoschedule';
import type { Issue } from '../engine/compliance';
import type { RotaState, Shift } from '../engine/types';
import { api } from './api';

/**
 * Loads the organisation from the API and writes every change back through it.
 * The engine also runs in the browser on the same data, so costs and
 * compliance update as you type, and the server re-checks on save.
 */
export function useRotaStore() {
  const [state, setState] = useState<RotaState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [sites, roles, demandRules, employees, shifts, forecast] = await Promise.all([
        api.get<RotaState['sites']>('/v1/sites'),
        api.get<RotaState['roles']>('/v1/roles'),
        api.get<RotaState['demandRules']>('/v1/demand-rules'),
        api.get<RotaState['employees']>('/v1/employees'),
        api.get<Shift[]>('/v1/shifts'),
        api.get<RotaState['forecast']>('/v1/forecast'),
      ]);
      setState({ sites, roles, demandRules, employees, shifts, forecast });
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshShifts = useCallback(async () => {
    const shifts = await api.get<Shift[]>('/v1/shifts');
    setState((s) => (s ? { ...s, shifts } : s));
  }, []);

  const guard = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      setError(null);
      return await fn();
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    }
  }, []);

  const actions = {
    reload: load,
    refreshShifts,
    saveShift: (shift: Shift, isNew: boolean) =>
      guard(async () => {
        const { id, employeeId, roleId, siteId, date, startMinute, endMinute, breakMinutes } = shift;
        const body = { employeeId, roleId, siteId, date, startMinute, endMinute, breakMinutes };
        const res = isNew
          ? await api.post<{ shift: Shift; issues: Issue[] }>('/v1/shifts', { id, ...body })
          : await api.patch<{ shift: Shift; issues: Issue[] }>(`/v1/shifts/${id}`, body);
        setState((s) => s && { ...s, shifts: isNew ? [...s.shifts, res.shift] : s.shifts.map((x) => (x.id === id ? res.shift : x)) });
        return res;
      }),
    deleteShift: (id: string) =>
      guard(async () => {
        await api.del(`/v1/shifts/${id}`);
        setState((s) => s && { ...s, shifts: s.shifts.filter((x) => x.id !== id) });
      }),
    build: (siteId: string, weekStart: string) =>
      guard(async () => {
        const res = await api.post<{ unfilled: UnfilledGap[] }>('/v1/rota/build', { siteId, weekStart });
        await refreshShifts();
        return res.unfilled;
      }),
    clear: (siteId: string, weekStart: string) =>
      guard(async () => {
        await api.post('/v1/rota/clear', { siteId, weekStart });
        await refreshShifts();
      }),
    publish: (siteId: string, weekStart: string) =>
      guard(async () => {
        await api.post('/v1/rota/publish', { siteId, weekStart });
        await refreshShifts();
      }),
    guard,
  };

  return { state, error, setError, actions };
}
