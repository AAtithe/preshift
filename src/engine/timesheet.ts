import type { Employee, Entity, RotaState, Shift, Site, TimeEntry } from './types';
import { shiftPaidHours } from './cost';
import { travelMinutesInto, travelPay, travelRate } from './travel';

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
  /** All travel, paid at the company's travel rate where it differs from the person's normal rate. */
  travel?: boolean;
  rate: number;
  /** Entries that make up this line, for audit back to the clock. */
  entryIds: string[];
}

/** Days off sick in the period on which SSP is due, so payroll can pay it, with our estimate to check against. */
export interface PayrollSicknessLine {
  employeeId: string;
  payrollId?: string;
  /** Qualifying days of sickness in the period. */
  dates: string[];
  /** Days a week the person normally works, which sets the daily rate. */
  qualifyingDaysPerWeek: number;
  sspEstimate: number;
}

/** A one-off sum added to someone's gross pay, such as back pay from a pay change approved late. */
export interface PayrollAdjustment {
  employeeId: string;
  payrollId?: string;
  amount: number;
  /** What it is, for the payslip: the pay change it comes from and the dates it covers. */
  description: string;
  /** The pay change, so payroll never pays the same arrears twice. */
  reference: string;
}

export interface PayrollHoursBatch {
  periodStart: string;
  periodEnd: string;
  lines: PayrollHoursLine[];
  /** Sickness on which SSP is due in the period. Absent on batches sent before SSP was checked. */
  sickness?: PayrollSicknessLine[];
  /** Back pay and other one-off sums. Absent on batches sent before back pay was carried. */
  adjustments?: PayrollAdjustment[];
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
  /** Companies, for the rate travel is paid at; without them it is the normal rate. */
  entities: Entity[] = [],
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
    const lineFor = (rate: number, travelOnly: boolean) => {
      const key = `${entry.employeeId}|${entry.siteId}|${entry.roleId}|${rate}`;
      const line = lines.get(key) ?? {
        employeeId: employee.id,
        payrollId: employee.payrollId,
        siteId: entry.siteId,
        roleId: entry.roleId,
        hours: 0,
        travelHours: 0,
        rate,
        ...(travelOnly ? { travel: true } : {}),
        entryIds: [],
      };
      if (!line.entryIds.includes(entry.id)) line.entryIds.push(entry.id);
      lines.set(key, line);
      return line;
    };
    lineFor(employee.hourlyRate, false).hours += entryPaidHours(entry);
    const travelled = (travel.get(`te:${entry.id}`) ?? 0) / 60;
    if (travelled > 0) {
      // Travel at the normal rate joins the hours line; at another rate it is a line of its own.
      const rate = travelRate(employee, entities, entry.date);
      const line = lineFor(rate, rate !== employee.hourlyRate);
      line.hours += travelled;
      line.travelHours = (line.travelHours ?? 0) + travelled;
    }
  }
  const out = [...lines.values()].map((l) => ({ ...l, hours: round2(l.hours), travelHours: round2(l.travelHours ?? 0) }));
  // A company averaging travel below the minimum wage tops the period up on the travel line itself,
  // so payroll pays exactly what keeps the period's average pay legal. Worked on the rounded hours
  // payroll pays, so rounding cannot leave the period short.
  for (const employee of employees) {
    const mine = out.filter((l) => l.employeeId === employee.id);
    const travelLines = mine.filter((l) => l.travel);
    const travelHours = travelLines.reduce((sum, l) => sum + l.hours, 0);
    if (travelHours <= 0) continue;
    const work = mine.filter((l) => !l.travel);
    const { pay, topUp } = travelPay(
      employee,
      entities,
      periodStart,
      { workHours: work.reduce((sum, l) => sum + l.hours, 0), workPay: work.reduce((sum, l) => sum + l.hours * l.rate, 0), travelHours },
    );
    if (topUp <= 0) continue;
    // Rounded up to the penny: rounding down would leave the period a fraction under.
    const rate = Math.ceil(((pay + topUp) / travelHours) * 100) / 100;
    for (const l of travelLines) l.rate = rate;
  }
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
  /** Statutory Sick Pay paid in the run, when the payroll reports it. */
  ssp?: number;
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
