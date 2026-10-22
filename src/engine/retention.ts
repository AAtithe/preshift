import type { Department, Employee, RotaState } from './types';
import { actualCompliance, actualShifts, loadedHourlyRate, weekVariance } from './actuals';
import { shiftPaidMinutes, shiftsInWeek } from './cost';
import { addDays, ageOn, daysBetween, weekStart } from './time';
import { minimumWageFor, UK_RATES_2026_27 } from './ukRates';

/**
 * What it costs to replace someone. These are planning assumptions, not
 * measurements: replace them with each client's own agency fees, advert spend
 * and training plan before the figure is used in a decision.
 */
export interface RetentionAssumptions {
  /** Advert, agency or referral fee and the admin of hiring, by department. */
  recruitment: Record<Department, number>;
  /** Paid shadow hours for the new starter, each one also taking a trainer's time. */
  shadowHours: Record<Department, number>;
  /** Weeks a new starter takes to reach full speed, and the share of their output lost meanwhile. */
  rampWeeks: number;
  rampLoss: number;
  /** Weeks of clocked history the score reads. */
  windowWeeks: number;
}

export const RETENTION_ASSUMPTIONS: RetentionAssumptions = {
  recruitment: { FOH: 500, BAR: 500, BOH: 900, MGMT: 4_000 },
  shadowHours: { FOH: 16, BAR: 20, BOH: 30, MGMT: 60 },
  rampWeeks: 6,
  rampLoss: 0.3,
  windowWeeks: 8,
};

export type SignalId =
  | 'new-starter'
  | 'sent-home'
  | 'hours-drop'
  | 'volatile-hours'
  | 'overwork'
  | 'short-rest'
  | 'missed-breaks'
  | 'close-load'
  | 'pay-floor';

/** Each signal, what it means, and whether the rota is what drives it. */
export const SIGNALS: Record<SignalId, { label: string; action: string; rota: boolean }> = {
  'new-starter': { label: 'New starter', action: 'A buddy, check-ins at two and six weeks, and steady shifts while they settle.', rota: false },
  'sent-home': { label: 'Sent home early', action: 'Cut the rota before it is published, not people on the day.', rota: true },
  'hours-drop': { label: 'Hours dropped', action: 'Ask whether it was their choice. If not, it reads as being frozen out.', rota: true },
  'volatile-hours': { label: 'Unpredictable hours', action: 'Give a consistent core pattern and flex around it.', rota: true },
  overwork: { label: 'Overworked', action: 'Bring hours down and spread the load before it becomes a resignation.', rota: true },
  'short-rest': { label: 'Close then open', action: 'Stop rostering a close followed by an open.', rota: true },
  'missed-breaks': { label: 'Breaks not taken', action: 'Protect the break: cover it on the rota, not on goodwill.', rota: true },
  'close-load': { label: 'Always on the close', action: 'Share the closes across the team.', rota: true },
  'pay-floor': { label: 'Still on the minimum', action: 'A small step after probation costs less than a replacement.', rota: false },
};

export interface Signal {
  id: SignalId;
  points: number;
  detail: string;
}

export interface RetentionScore {
  employeeId: string;
  department: Department;
  score: number;
  band: 'high' | 'medium' | 'low';
  signals: Signal[];
  averageWeeklyHours: number;
  replacementCost: number;
}

export interface RetentionSummary {
  weeksRead: number;
  scores: RetentionScore[];
  high: number;
  medium: number;
  /** Replacement cost of everyone in the high band. */
  costAtRisk: number;
  /** Share of all risk points that come from signals the rota controls. */
  rotaShare: number;
  drivers: { id: SignalId; people: number; points: number }[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const NEW_STARTER_DAYS = 90;
const PAY_FLOOR_MARGIN = 0.01;

function hourlyCost(employee: Employee): number {
  if (employee.payBasis === 'hourly') return loadedHourlyRate(employee);
  // A salaried manager's time, at a 45 hour week, loaded with employer NI and pension.
  return (employee.annualSalary / 52 / 45) * (1 + UK_RATES_2026_27.employerNiRate + UK_RATES_2026_27.employerPensionRate);
}

/** Recruitment, paid shadow shifts for the starter and their trainer, and lost output while they get up to speed. */
export function replacementCost(employee: Employee, department: Department, averageWeeklyHours: number, a: RetentionAssumptions = RETENTION_ASSUMPTIONS): number {
  const rate = hourlyCost(employee);
  return round2(a.recruitment[department] + a.shadowHours[department] * rate * 2 + a.rampWeeks * averageWeeklyHours * rate * a.rampLoss);
}

/**
 * A retention score for everyone at a site, read from what the system already
 * holds: clocked hours, early finishes, Working Time breaches, the closes
 * people get, tenure and pay. It is a set of transparent rules with stated
 * points, not a model: every point comes with the reason and the fix, and the
 * weights should be recalibrated once real leaver data exists.
 *
 * It deliberately ignores age, immigration status and anything else that
 * could stand in for a protected characteristic. It is for support
 * conversations, never for discipline, dismissal or selection.
 */
export function retentionScores(state: RotaState, siteId: string, asOf: string, a: RetentionAssumptions = RETENTION_ASSUMPTIONS): RetentionSummary {
  const site = state.sites.find((s) => s.id === siteId);
  const clocked = actualShifts(state).filter((s) => s.siteId === siteId);
  const current = weekStart(asOf);
  const weeks = Array.from({ length: a.windowWeeks }, (_, i) => addDays(current, -7 * (a.windowWeeks - i)))
    .filter((w) => clocked.some((s) => shiftsInWeek([s], w).length > 0));
  const empty: RetentionSummary = { weeksRead: weeks.length, scores: [], high: 0, medium: 0, costAtRisk: 0, rotaShare: 0, drivers: [] };
  if (!site || weeks.length === 0) return empty;

  const variance = weeks.flatMap((w) => weekVariance(state, w, addDays(w, 7), siteId).items);
  const issues = weeks.flatMap((w) => actualCompliance(state, w, addDays(w, 7), siteId));
  const inWindow = clocked.filter((s) => s.date >= weeks[0] && s.date < addDays(weeks[weeks.length - 1], 7));
  const closes = (shifts: typeof inWindow) => shifts.filter((s) => s.endMinute >= site.closeMinute).length;
  const teamCloseShare = inWindow.length ? closes(inWindow) / inWindow.length : 0;

  const scores: RetentionScore[] = [];
  for (const employee of state.employees.filter((e) => e.siteId === siteId)) {
    const mine = inWindow.filter((s) => s.employeeId === employee.id);
    const tenure = employee.startedOn ? daysBetween(employee.startedOn, asOf) : Infinity;
    if (mine.length === 0 && tenure >= NEW_STARTER_DAYS) continue;
    const department = state.roles.find((r) => r.id === employee.roleIds[0])?.department ?? 'FOH';
    const weekly = weeks.map((w) => shiftsInWeek(mine, w).reduce((sum, s) => sum + shiftPaidMinutes(s), 0) / 60);
    const average = weekly.reduce((s, h) => s + h, 0) / weeks.length;
    const signals: Signal[] = [];
    const add = (id: SignalId, points: number, detail: string) => signals.push({ id, points, detail });

    if (tenure < NEW_STARTER_DAYS) {
      add('new-starter', tenure < 30 ? 25 : 20, `Started ${tenure} days ago. Most leavers go in their first three months.`);
    }

    // Only hourly staff are sent home: a salaried manager leaving early loses no pay.
    const sentHome = variance.filter((i) => i.employeeId === employee.id && i.kind === 'early-finish');
    if (sentHome.length && employee.payBasis === 'hourly') {
      const lost = -sentHome.reduce((s, i) => s + i.minutes, 0) / 60;
      add('sent-home', sentHome.length >= 2 ? 15 : 6, `Sent home early ${sentHome.length} time${sentHome.length > 1 ? 's' : ''} in ${weeks.length} weeks, ${lost.toFixed(1)}h of pay lost.`);
    }

    if (weeks.length >= 3 && employee.payBasis === 'hourly') {
      const prior = weekly.slice(0, -1);
      const priorAverage = prior.reduce((s, h) => s + h, 0) / prior.length;
      const last = weekly[weekly.length - 1];
      if (priorAverage >= 8 && last < priorAverage * 0.6) {
        add('hours-drop', 15, `${last.toFixed(1)}h last week against ${priorAverage.toFixed(1)}h before.`);
      }
      const sd = Math.sqrt(weekly.reduce((s, h) => s + (h - average) ** 2, 0) / weekly.length);
      const cv = average > 0 ? sd / average : 0;
      if (cv > 0.2 && average >= 8) {
        add('volatile-hours', cv > 0.35 ? 15 : 8, `Weekly hours ran from ${Math.min(...weekly).toFixed(1)}h to ${Math.max(...weekly).toFixed(1)}h.`);
      }
    }

    if (average > 48 || (average > 45 && !employee.optedOutOf48)) {
      add('overwork', 12, `Averaging ${average.toFixed(1)}h a week.`);
    }
    const rest = issues.filter((i) => i.employeeId === employee.id && i.code === 'daily-rest').length;
    if (rest) add('short-rest', 10, `${rest} turnaround${rest > 1 ? 's' : ''} with less than the legal rest between shifts.`);
    const breaks = issues.filter((i) => i.employeeId === employee.id && i.code === 'break').length;
    if (breaks) add('missed-breaks', breaks >= 2 ? 10 : 5, `Worked through a required break ${breaks} time${breaks > 1 ? 's' : ''}.`);

    if (mine.length >= 4) {
      const share = closes(mine) / mine.length;
      if (share >= teamCloseShare + 0.3) {
        add('close-load', 8, `Closes ${Math.round(share * 100)}% of their shifts against a team average of ${Math.round(teamCloseShare * 100)}%.`);
      }
    }

    if (employee.payBasis === 'hourly' && tenure > 180) {
      const band = minimumWageFor(ageOn(employee.dateOfBirth, asOf));
      if (band && employee.hourlyRate <= band.hourly * (1 + PAY_FLOOR_MARGIN)) {
        add('pay-floor', 5, `Still on the legal minimum for their band after ${Math.floor(tenure / 30)} months.`);
      }
    }

    const score = Math.min(100, signals.reduce((s, x) => s + x.points, 0));
    scores.push({
      employeeId: employee.id,
      department,
      score,
      band: score >= 40 ? 'high' : score >= 20 ? 'medium' : 'low',
      signals: signals.sort((x, y) => y.points - x.points),
      averageWeeklyHours: round2(average),
      replacementCost: replacementCost(employee, department, average, a),
    });
  }
  scores.sort((x, y) => y.score - x.score || y.replacementCost - x.replacementCost);

  const totals = new Map<SignalId, { people: number; points: number }>();
  for (const s of scores) for (const sig of s.signals) {
    const t = totals.get(sig.id) ?? { people: 0, points: 0 };
    t.people += 1;
    t.points += sig.points;
    totals.set(sig.id, t);
  }
  const allPoints = [...totals.values()].reduce((s, t) => s + t.points, 0);
  const rotaPoints = [...totals].filter(([id]) => SIGNALS[id].rota).reduce((s, [, t]) => s + t.points, 0);
  return {
    weeksRead: weeks.length,
    scores,
    high: scores.filter((s) => s.band === 'high').length,
    medium: scores.filter((s) => s.band === 'medium').length,
    costAtRisk: round2(scores.filter((s) => s.band === 'high').reduce((sum, s) => sum + s.replacementCost, 0)),
    rotaShare: allPoints ? rotaPoints / allPoints : 0,
    drivers: [...totals].map(([id, t]) => ({ id, ...t })).sort((x, y) => y.points - x.points),
  };
}
