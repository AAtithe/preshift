import { useCallback, useEffect, useState } from 'react';
import type { UnfilledGap } from '../engine/autoschedule';
import type { Issue } from '../engine/compliance';
import type { Absence, Employee, Entity, GeoFence, HrProfile, HrRecord, RotaState, Shift, Site } from '../engine/types';
import { weekDates } from '../engine/time';
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
        return true;
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
        return true;
      }),
    /** Adds a starter or saves changes; the server syncs payroll fields to TeamPay. */
    saveEmployee: (employee: Employee, isNew: boolean) =>
      guard(async () => {
        // Server-managed fields are never sent: the id and payroll link are the server's, and leaving goes through markLeaver.
        const { id, payrollId: _p, status: _s, leaveDate: _l, hr: _h, absences: _a, ...body } = employee;
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
    /**
     * Saves an accepted assistant draft for every site it covered in a single all-or-nothing call.
     * The server refuses it if any site's week changed since the draft began (baselines) or if it
     * would move a shift that has started, and records the instructions in the audit log.
     */
    applyDraft: async (weekStart: string, draft: Shift[], baselines: Record<string, string>, instructions: string[]): Promise<string | null> => {
      const dates = weekDates(weekStart);
      const sites = Object.entries(baselines).map(([siteId, baseline]) => ({
        siteId,
        baseline,
        shifts: draft
          .filter((s) => s.siteId === siteId && dates.includes(s.date))
          .map(({ id, employeeId, roleId, siteId: site, date, startMinute, endMinute, breakMinutes }) => ({
            id, employeeId, roleId, siteId: site, date, startMinute, endMinute, breakMinutes,
          })),
      }));
      try {
        await api.put('/v1/rota/weeks', { weekStart, sites, source: 'assistant', instruction: instructions.join('\n').slice(0, 2000) });
        return null;
      } catch (e) {
        // Returned rather than shown behind the assistant, so the manager sees why and can redraft.
        return (e as Error).message;
      } finally {
        await refreshShifts();
      }
    },
    /** Sets where a site is from its postcode; journeys to and from it are looked up again on refresh. */
    setSiteLocation: (siteId: string, postcode: string) =>
      guard(async () => {
        await api.put<Site>(`/v1/sites/${siteId}/location`, { postcode });
        const sites = await api.get<Site[]>('/v1/sites');
        setState((s) => s && { ...s, sites });
        return sites;
      }),
    /** Plans journeys between every pair of sites with TfL, keeping times set by hand. */
    refreshTravel: () =>
      guard(async () => {
        const res = await api.post<{ sites: Site[]; fromTfl: number; estimated: number; failures: string[] }>('/v1/sites/travel/refresh');
        setState((s) => s && { ...s, sites: res.sites });
        return res;
      }),
    /** Sets a journey time between two sites by hand, both ways, or clears it when minutes is null. */
    setTravel: (siteId: string, toId: string, minutes: number | null) =>
      guard(async () => {
        const sites =
          minutes === null
            ? await api.del<Site[]>(`/v1/sites/${siteId}/travel/${toId}`)
            : await api.put<Site[]>(`/v1/sites/${siteId}/travel/${toId}`, { minutes });
        setState((s) => s && { ...s, sites });
        return sites;
      }),
    /** Replaces a person's personnel file details. */
    saveHrProfile: (employeeId: string, profile: HrProfile) =>
      guard(async () => {
        const employee = await api.put<Employee>(`/v1/employees/${employeeId}/hr`, profile);
        setState((s) => s && { ...s, employees: s.employees.map((x) => (x.id === employeeId ? employee : x)) });
        return employee;
      }),
    /** Records or corrects an absence. Returns the rostered shifts it now clashes with. */
    saveAbsence: (employeeId: string, absence: Absence, isNew: boolean) =>
      guard(async () => {
        const { id, ...body } = absence;
        const res = isNew
          ? await api.post<{ employee: Employee; clashes: string[] }>(`/v1/employees/${employeeId}/absences`, body)
          : await api.patch<{ employee: Employee; clashes: string[] }>(`/v1/employees/${employeeId}/absences/${id}`, body);
        setState((s) => s && { ...s, employees: s.employees.map((x) => (x.id === employeeId ? res.employee : x)) });
        return res;
      }),
    deleteAbsence: (employeeId: string, absenceId: string) =>
      guard(async () => {
        const employee = await api.del<Employee>(`/v1/employees/${employeeId}/absences/${absenceId}`);
        setState((s) => s && { ...s, employees: s.employees.map((x) => (x.id === employeeId ? employee : x)) });
        return employee;
      }),
    guard,
  };

  return { state, error, setError, actions };
}

type RecordInput = Omit<HrRecord, 'id' | 'createdBy' | 'createdAt'>;

/** Personnel file entries, loaded once for the HR screens. Cases arrive only for admins. */
export function useHrRecords(setError: (message: string | null) => void) {
  const [records, setRecords] = useState<HrRecord[] | null>(null);

  useEffect(() => {
    api.get<HrRecord[]>('/v1/hr/records').then(setRecords).catch((e) => { setRecords([]); setError((e as Error).message); });
  }, [setError]);

  const run = async <T,>(fn: () => Promise<T>) => {
    try {
      setError(null);
      return await fn();
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    }
  };

  return {
    records,
    save: (record: HrRecord, isNew: boolean) =>
      run(async () => {
        const { id, createdBy: _b, createdAt: _a, ...body } = record;
        const saved = isNew
          ? await api.post<HrRecord>('/v1/hr/records', body as RecordInput)
          : await api.patch<HrRecord>(`/v1/hr/records/${id}`, body);
        setRecords((list) => (isNew ? [...(list ?? []), saved] : (list ?? []).map((r) => (r.id === id ? saved : r))));
        return saved;
      }),
    remove: (id: string) =>
      run(async () => {
        await api.del(`/v1/hr/records/${id}`);
        setRecords((list) => (list ?? []).filter((r) => r.id !== id));
        return true;
      }),
  };
}

export type HrRecords = ReturnType<typeof useHrRecords>;
