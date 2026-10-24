import type { RotaState, TimeEntry } from './types';
import { loadedHourlyRate } from './actuals';
import type { CutCall } from './cutcall';

// The labour flash during service: what labour has cost so far today against what has been taken,
// and where the day will land on the reforecast, with and without the cut call taken. The weekly flash
// in actuals.ts covers closed days; this is the same question asked while it can still be changed.

export interface IntradayFlash {
  now: number;
  salesSoFar: number;
  /** Clocked time to now at loaded rates, plus salaried staff's share of the day. */
  labourSoFar: number;
  labourPctNow: number | null;
  /** Clocked so far plus the rota for the rest of the day. */
  labourDay: number;
  reforecastDay: number;
  labourPctDay: number | null;
  /** The day if every recommended cut is made. */
  labourPctAfterCuts: number | null;
  targetPct: number;
  /** Labour within the target on the reforecast: positive is headroom, negative is over. */
  headroom: number;
  /** People clocked in now, at the site. */
  onShift: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const pctOf = (labour: number, sales: number) => (sales > 0 ? labour / sales : null);

/**
 * Loaded rates price each hour as a payroll would on average (holiday, employer NI and pension), not
 * on the person's whole week: right for a figure that moves through the day. The cut call's savings are
 * worked on the whole week, so "after cuts" takes them as they are.
 */
export function intradayFlash(state: RotaState, entries: TimeEntry[], siteId: string, date: string, now: number, call: CutCall): IntradayFlash {
  const site = state.sites.find((s) => s.id === siteId);
  const byId = new Map(state.employees.map((e) => [e.id, e]));
  const today = entries.filter((t) => t.siteId === siteId && t.date === date && t.status !== 'rejected');
  let labourSoFar = 0;
  let onShift = 0;
  const clockedShiftIds = new Set<string>();
  for (const t of today) {
    const e = byId.get(t.employeeId);
    if (!e || e.payBasis === 'salaried') continue;
    if (t.shiftId) clockedShiftIds.add(t.shiftId);
    const end = t.clockOut ?? Math.max(t.clockIn, now);
    if (t.clockOut === undefined) onShift++;
    const span = Math.max(0, end - t.clockIn);
    const paid = t.clockOut === undefined ? span : Math.max(0, span - t.breakMinutes);
    labourSoFar += (paid / 60) * loadedHourlyRate(e);
  }
  // Rostered time still to come: the rest of shifts in progress, and shifts not started.
  let labourAhead = 0;
  for (const s of state.shifts) {
    if (s.siteId !== siteId || s.date !== date) continue;
    const e = byId.get(s.employeeId);
    if (!e || e.payBasis === 'salaried') continue;
    const from = Math.max(s.startMinute, now);
    if (s.endMinute <= from) continue;
    // A shift that should have started with nobody clocked in is not counted: nobody is being paid for it.
    if (s.startMinute < now && !clockedShiftIds.has(s.id) && !today.some((t) => t.employeeId === s.employeeId && t.clockOut === undefined)) continue;
    const length = s.endMinute - s.startMinute;
    const share = length > 0 ? (s.endMinute - from) / length : 0;
    labourAhead += (Math.max(0, length - s.breakMinutes) / 60) * share * loadedHourlyRate(e);
  }
  // Salaried managers on the site carry a seventh of their week every day.
  const salaried = state.employees
    .filter((e) => e.payBasis === 'salaried' && e.siteId === siteId && e.status !== 'leaver')
    .reduce((sum, e) => sum + e.annualSalary / 52 / 7, 0);
  const dayShare = site ? Math.min(1, Math.max(0, (now - site.openMinute) / Math.max(1, site.closeMinute - site.openMinute))) : 1;
  labourSoFar += salaried * dayShare;
  const labourDay = labourSoFar + labourAhead + salaried * (1 - dayShare);
  const targetPct = site?.labourTargetPct ?? 0;
  return {
    now,
    salesSoFar: round2(call.salesSoFar),
    labourSoFar: round2(labourSoFar),
    labourPctNow: pctOf(labourSoFar, call.salesSoFar),
    labourDay: round2(labourDay),
    reforecastDay: round2(call.reforecastDay),
    labourPctDay: pctOf(labourDay, call.reforecastDay),
    labourPctAfterCuts: pctOf(labourDay - call.totalSaving, call.reforecastDay),
    targetPct,
    headroom: round2(call.reforecastDay * targetPct - labourDay),
    onShift,
  };
}
