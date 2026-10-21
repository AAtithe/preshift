import { useCallback, useEffect, useState } from 'react';
import type { UnfilledGap } from '../engine/autoschedule';
import type { Issue } from '../engine/compliance';
import type { Employee, Entity, GeoFence, RotaState, Shift, Site } from '../engine/types';
import type { Me } from './access/model';
import { api } from './api';

/**
 * Loads the organisation from the API and writes every change back through it.
 * The engine also runs in the browser on the same data, so costs and
 * compliance update as you type, and the server re-checks on save.
 */
export function useRotaStore() {
  const [state, setState] = useState<RotaState | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setMe(await api.get<Me>('/v1/me'));
      const [entities, sites, roles, demandRules, employees, shifts, forecast] = await Promise.all([
        api.get<RotaState['entities']>('/v1/entities'),
        api.get<RotaState['sites']>('/v1/sites'),
        api.get<RotaState['roles']>('/v1/roles'),
        api.get<RotaState['demandRules']>('/v1/demand-rules'),
        api.get<RotaState['employees']>('/v1/employees'),
        api.get<Shift[]>('/v1/shifts'),
        api.get<RotaState['forecast']>('/v1/forecast'),
      ]);
      setState({ entities, sites, roles, demandRules, employees, shifts, forecast });
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
    build: (siteIds: string[], weekStart: string) =>
      guard(async () => {
        const res = await api.post<{ unfilled: UnfilledGap[] }>('/v1/rota/build', { siteIds, weekStart });
        await refreshShifts();
        return res.unfilled;
      }),
    clear: (siteIds: string[], weekStart: string) =>
      guard(async () => {
        await api.post('/v1/rota/clear', { siteIds, weekStart });
        await refreshShifts();
      }),
    publish: (siteIds: string[], weekStart: string) =>
      guard(async () => {
        await api.post('/v1/rota/publish', { siteIds, weekStart });
        await refreshShifts();
      }),
    /** Adds a starter or saves changes; the server syncs payroll fields to TeamPay. */
    saveEmployee: (employee: Employee, isNew: boolean, withPay = true) =>
      guard(async () => {
        // Server-managed fields are never sent: the id and payroll link are the server's, and leaving goes through markLeaver.
        const { id, payrollId: _p, status: _s, leaveDate: _l, payHidden, ...fields } = employee;
        // Pay this reader never received is left out, never sent back as nought; without pay rights it is not sent at all.
        const { hourlyRate: _r, annualSalary: _a, ...unpaid } = fields;
        const body = payHidden || !withPay ? unpaid : fields;
        const saved = isNew
          ? await api.post<Employee>('/v1/employees', body)
          : await api.patch<Employee>(`/v1/employees/${id}`, body);
        setState((s) => s && { ...s, employees: isNew ? [...s.employees, saved] : s.employees.map((x) => (x.id === id ? saved : x)) });
        await refreshShifts();
        return saved;
      }),
    /** Marks a leaver: the server removes later shifts and tells TeamPay. */
    markLeaver: (id: string, leaveDate: string) =>
      guard(async () => {
        const res = await api.post<{ employee: Employee; shiftsRemoved: number }>(`/v1/employees/${id}/leaver`, { leaveDate });
        setState((s) => s && { ...s, employees: s.employees.map((x) => (x.id === id ? res.employee : x)) });
        await refreshShifts();
        return res;
      }),
    /** Sets or clears the area staff must be inside to clock in on a device. Errors are left to the caller to show. */
    setGeofence: async (siteId: string, fence: GeoFence | null) => {
      const site = fence
        ? await api.put<Site>(`/v1/sites/${siteId}/geofence`, fence)
        : await api.del<Site>(`/v1/sites/${siteId}/geofence`);
      setState((s) => s && { ...s, sites: s.sites.map((x) => (x.id === siteId ? site : x)) });
      return site;
    },
    /** Enrols or removes a person's RFID card. Errors are left to the caller to show. */
    setBadge: async (employeeId: string, badgeId: string | null) => {
      const employee = badgeId
        ? await api.put<Employee>(`/v1/employees/${employeeId}/badge`, { badgeId })
        : await api.del<Employee>(`/v1/employees/${employeeId}/badge`);
      setState((s) => s && { ...s, employees: s.employees.map((x) => (x.id === employeeId ? employee : x)) });
      return employee;
    },
    /** Sets the first day of a company's leave year (MM-DD); every holiday balance in it moves with it. */
    setLeaveYearStart: (entityId: string, leaveYearStart: string) =>
      guard(async () => {
        const entity = await api.patch<Entity>(`/v1/entities/${entityId}`, { leaveYearStart });
        setState((s) => s && { ...s, entities: s.entities.map((x) => (x.id === entityId ? entity : x)) });
        return entity;
      }),
    /** Writes the assistant's draft through the API: removals first, so moved shifts never clash. */
    applyDraft: (current: Shift[], draft: Shift[]) =>
      guard(async () => {
        const before = new Map(current.map((s) => [s.id, s]));
        const after = new Map(draft.map((s) => [s.id, s]));
        const fields = (s: Shift) => {
          const { employeeId, roleId, siteId, date, startMinute, endMinute, breakMinutes } = s;
          return { employeeId, roleId, siteId, date, startMinute, endMinute, breakMinutes };
        };
        try {
          for (const id of before.keys()) if (!after.has(id)) await api.del(`/v1/shifts/${id}`);
          for (const [id, shift] of after) {
            const old = before.get(id);
            if (!old) await api.post('/v1/shifts', { id, ...fields(shift) });
            else if (JSON.stringify(fields(old)) !== JSON.stringify(fields(shift))) await api.patch(`/v1/shifts/${id}`, fields(shift));
          }
        } finally {
          await refreshShifts();
        }
      }),
    guard,
  };

  return { state, me, error, setError, actions };
}
