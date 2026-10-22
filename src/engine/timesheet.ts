import type { Employee, RotaState, Shift, Site, TimeEntry } from './types';
import { shiftPaidHours } from './cost';
import { travelMinutesInto } from './travel';

const round2 = (n: number) => Math.round(n * 100) / 100;

export function entryPaidHours(entry: TimeEntry): number {
  if (entry.clockOut === undefined) return 0;
  return Math.max(0, entry.clockOut - entry.clockIn - entry.breakMinutes) / 60;
}

/** Approved time as shifts, so the cost engine can price actuals exactly as it prices the rota. */
export function entriesAsShifts(entries: TimeEntry[]): Shift[] {
  return entries
    .filter((e) => e.status === 'approved' && e.clockOut !== undefined)
    .map((e) => ({
      id: `te:${e.id}`,
      employeeId: e.employeeId,
      roleId: e.roleId,
      siteId: e.siteId,
      date: e.date,
      startMinute: e.clockIn,
      endMinute: e.clockOut!,
      breakMinutes: e.breakMinutes,
    }));
}

/** One line of hours sent to payroll: a person, at a site, in a role, at a rate. */
export interface PayrollHoursLine {
  employeeId: string;
  payrollId?: string;
  siteId: string;
  roleId: string;
  hours: number;
  /** Of which paid travel to this site from another site the same day. Absent on older batches. */
  travelHours?: number;
  rate: number;
  /** Entries that make up this line, for audit back to the clock. */
  entryIds: string[];
}

export interface PayrollHoursBatch {
  periodStart: string;
  periodEnd: string;
  lines: PayrollHoursLine[];
  /** Approved entries skipped because their person is salaried (paid by salary, not hours). */
  salariedEntryIds: string[];
  totalHours: number;
}

/**
 * Builds the hours batch for a pay period from approved time only. Lines are
 * split by site and role so payroll can cost them to the right place. Salaried
 * people are paid their salary by payroll, so their hours are not sent.
 */
export function payrollHours(
  employees: Employee[],
  entries: TimeEntry[],
  periodStart: string,
  periodEnd: string,
  /** Sites, so travel between them within a day is paid; without them it is not added. */
  sites: Site[] = [],
): PayrollHoursBatch {
  const byId = new Map(employees.map((e) => [e.id, e]));
  // Travel is working time: it is paid on the line for the site and role travelled to.
  const travel = travelMinutesInto(entriesAsShifts(entries.filter((e) => e.date >= periodStart && e.date <= periodEnd)), sites);
  const lines = new Map<string, PayrollHoursLine>();
  const salariedEntryIds: string[] = [];

  for (const entry of entries) {
    if (entry.status !== 'approved' || entry.date < periodStart || entry.date > periodEnd) continue;
    const employee = byId.get(entry.employeeId);
    if (!employee) continue;
    if (employee.payBasis === 'salaried') {
      salariedEntryIds.push(entry.id);
      continue;
    }
    const key = `${entry.employeeId}|${entry.siteId}|${entry.roleId}`;
    const line = lines.get(key) ?? {
      employeeId: employee.id,
      payrollId: employee.payrollId,
      siteId: entry.siteId,
      roleId: entry.roleId,
      hours: 0,
      travelHours: 0,
      rate: employee.hourlyRate,
      entryIds: [],
    };
    const travelled = (travel.get(`te:${entry.id}`) ?? 0) / 60;
    line.hours += entryPaidHours(entry) + travelled;
    line.travelHours = (line.travelHours ?? 0) + travelled;
    line.entryIds.push(entry.id);
    lines.set(key, line);
  }
  const out = [...lines.values()].map((l) => ({ ...l, hours: round2(l.hours), travelHours: round2(l.travelHours ?? 0) }));
  return {
    periodStart,
    periodEnd,
    lines: out,
    salariedEntryIds,
    totalHours: round2(out.reduce((s, l) => s + l.hours, 0)),
  };
}

export interface RosterVsActual {
  employeeId: string;
  rosteredHours: number;
  actualHours: number;
  variance: number;
}

/** Rostered against clocked hours per person: where the rota and the floor disagree. */
export function rosterVsActual(state: RotaState, entries: TimeEntry[], dates: string[], siteId?: string): RosterVsActual[] {
  const inScope = (x: { date: string; siteId: string }) => dates.includes(x.date) && (!siteId || x.siteId === siteId);
  const ids = new Set([
    ...state.shifts.filter(inScope).map((s) => s.employeeId),
    ...entries.filter(inScope).map((e) => e.employeeId),
  ]);
  return [...ids].map((employeeId) => {
    const rosteredHours = state.shifts
      .filter((s) => s.employeeId === employeeId && inScope(s))
      .reduce((sum, s) => sum + shiftPaidHours(s), 0);
    const actualHours = entries
      .filter((e) => e.employeeId === employeeId && inScope(e) && e.status !== 'rejected')
      .reduce((sum, e) => sum + entryPaidHours(e), 0);
    return {
      employeeId,
      rosteredHours: round2(rosteredHours),
      actualHours: round2(actualHours),
      variance: round2(actualHours - rosteredHours),
    };
  });
}

/** What payroll actually cost for one person in a pay run. */
export interface PayRunEmployee {
  employeeId: string;
  gross: number;
  holidayPay: number;
  employerNi: number;
  employerPension: number;
}

export interface PayrollVarianceLine {
  employeeId: string;
  accrued: number;
  actual: number;
  variance: number;
}

export interface PayrollVariance {
  accrued: number;
  actual: number;
  variance: number;
  variancePct: number;
  lines: PayrollVarianceLine[];
}

/**
 * Accrued labour (our estimate, posted at week end) against what payroll
 * actually cost. This is the number that proves the rota can be trusted in the
 * close: it should sit under 1% of labour.
 */
export function payrollVariance(
  accruedByEmployee: Map<string, number>,
  payRun: PayRunEmployee[],
): PayrollVariance {
  const actualByEmployee = new Map(
    payRun.map((p) => [p.employeeId, p.gross + p.holidayPay + p.employerNi + p.employerPension]),
  );
  const ids = new Set([...accruedByEmployee.keys(), ...actualByEmployee.keys()]);
  const lines = [...ids]
    .map((employeeId) => {
      const accrued = round2(accruedByEmployee.get(employeeId) ?? 0);
      const actual = round2(actualByEmployee.get(employeeId) ?? 0);
      return { employeeId, accrued, actual, variance: round2(actual - accrued) };
    })
    .sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance));
  const accrued = round2(lines.reduce((s, l) => s + l.accrued, 0));
  const actual = round2(lines.reduce((s, l) => s + l.actual, 0));
  return {
    accrued,
    actual,
    variance: round2(actual - accrued),
    variancePct: accrued ? (actual - accrued) / accrued : 0,
    lines,
  };
}
