import type { RotaState, TimeEntry } from './types';
import { realisedSaving, type MoveRecord } from './coach';
import { checkWeek } from './compliance';
import { weekCost } from './cost';
import { dayDemand } from './demand';
import { forecastAccuracy } from './forecast';
import { weekMetrics } from './metrics';
import { entriesAsShifts } from './timesheet';
import { addDays, daysBetween, londonDate, weekDates } from './time';

// The GM scorecard: how a site's rota was run, week by week, and where the
// manager sits on a four-step ladder. The ladder is for coaching. Each rung
// is a habit that has to hold for three weeks out of four before the next one
// counts, and the scorecard says exactly what to do to reach the next rung.

/** When a site's week was published, and by whom. Kept on every publish, so notice can be measured. */
export interface Publication {
  siteId: string;
  weekStart: string;
  publishedAt: string; // ISO date-time
  by: string;
}

export interface ScorecardThresholds {
  /** Days of notice before the week starts that count as on time. */
  noticeDays: number;
  /** Labour within this many points of target (either side) counts as on target. */
  targetBand: number;
  /** Share of rostered hours over demand that still counts as precise. */
  overstaffedShare: number;
  /** Hourly forecast error at or under which the forecast counts as owned. */
  forecastWape: number;
}

export const DEFAULT_THRESHOLDS: ScorecardThresholds = { noticeDays: 7, targetBand: 0.01, overstaffedShare: 0.05, forecastWape: 0.12 };

export interface WeekScore {
  weekStart: string;
  publishedAt?: string;
  /** Whole days between first publishing and the week starting. */
  noticeDays?: number;
  publishedOnTime: boolean;
  /** No blocking compliance issue in the week as rostered. */
  legal: boolean;
  plannedLabourPct: number;
  /** Till sales once traded, otherwise forecast: the weight for averaging labour % across weeks. */
  sales: number;
  /** From approved time and till sales, once both are in. */
  actualLabourPct: number | null;
  targetPct: number;
  /** Actual where known, otherwise planned. */
  onTarget: boolean;
  /** Rostered hours with more people on than the forecast needed, over all rostered hours. */
  overstaffedShare: number;
  overstaffedHours: number;
  /** Person-hours rostered at the site; a week with none has nothing to be precise about. */
  rosteredHours: number;
  /** Approved time cost against the rota's cost: the gap the close has to explain. */
  rotaToPayrollVariance: number | null;
  forecastWape: number | null;
  overrideErrorRemoved: number | null;
  movesOffered: number;
  movesTaken: number;
  expectedSaving: number;
  realisedSaving: number;
}

export interface Rung {
  level: 1 | 2 | 3 | 4;
  label: string;
  met: boolean;
  detail: string;
}

export interface Maturity {
  /** 0 until the first rung holds. */
  level: 0 | 1 | 2 | 3 | 4;
  label: string;
  rungs: Rung[];
  /** The one thing to work on next. */
  next: string;
}

export interface Scorecard {
  siteId: string;
  weeks: WeekScore[];
  maturity: Maturity;
  summary: {
    onTimeRate: number;
    onTargetRate: number;
    averageOverstaffedShare: number;
    averageVariance: number | null;
    movesTakenRate: number | null;
    expectedSaving: number;
    realisedSaving: number;
  };
}

export interface ScorecardInput {
  state: RotaState;
  siteId: string;
  /** The week starts to score, oldest first. Score finished weeks only. */
  weeks: string[];
  publications: Publication[];
  timeEntries: TimeEntry[];
  moves: MoveRecord[];
  thresholds?: Partial<ScorecardThresholds>;
  /** Today in London; realised savings wait until a week has ended. */
  today?: string;
}

const LABELS = ['Not yet on the ladder', 'Rota on time and legal', 'Labour on target', 'Daypart precision', 'Owns the forecast'];
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pctText = (n: number) => `${(n * 100).toFixed(1)}%`;

/** Rostered person-hours over demand, against all rostered person-hours, for a site's week. */
export function overstaffing(state: RotaState, siteId: string, ws: string): { overHours: number; rosteredHours: number } {
  let overHours = 0;
  let rosteredHours = 0;
  for (const date of weekDates(ws)) {
    for (const rule of state.demandRules.filter((r) => r.siteId === siteId)) {
      for (const h of dayDemand(state, siteId, rule.roleId, date)) {
        rosteredHours += h.scheduled;
        overHours += Math.max(0, h.scheduled - h.required);
      }
    }
  }
  return { overHours, rosteredHours };
}

export function scoreWeek(input: ScorecardInput, ws: string): WeekScore {
  const { state, siteId } = input;
  const t = { ...DEFAULT_THRESHOLDS, ...input.thresholds };
  const dates = weekDates(ws);
  const to = addDays(ws, 6);
  const metrics = weekMetrics(state, siteId, ws);

  // Notice is judged on the first publish. Later edits unpublish and republish (taking a weekly move does),
  // and they should not turn an on-time week into a late one.
  const publication = input.publications
    .filter((p) => p.siteId === siteId && p.weekStart === ws)
    .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))[0];
  const noticeDays = publication ? daysBetween(londonDate(publication.publishedAt), ws) : undefined;

  // Actual labour: approved time at this site, priced on each person's whole week, over till sales.
  // Only once every entry at the site that week is approved: part-approved weeks read low.
  const siteEntries = input.timeEntries.filter((e) => e.siteId === siteId && dates.includes(e.date) && e.status !== 'rejected');
  const hasTime = siteEntries.length > 0 && siteEntries.every((e) => e.status === 'approved' && e.clockOut !== undefined);
  const approved = input.timeEntries.filter((e) => e.status === 'approved' && dates.includes(e.date));
  const actualSales = (state.actuals ?? []).filter((a) => a.siteId === siteId && a.date >= ws && a.date <= to);
  const sales = actualSales.reduce((s, a) => s + a.sales, 0);
  const actualCost = hasTime ? weekCost({ employees: state.employees, shifts: entriesAsShifts(approved) }, ws, siteId).total : 0;
  const actualLabourPct = hasTime && sales > 0 ? actualCost / sales : null;
  const rotaToPayrollVariance = hasTime && metrics.labourCost > 0 ? (actualCost - metrics.labourCost) / metrics.labourCost : null;

  const accuracy = forecastAccuracy(state.forecast, state.actuals ?? [], siteId, ws, to);
  const { overHours, rosteredHours } = overstaffing(state, siteId, ws);
  const moves = input.moves.filter((m) => m.siteId === siteId && m.weekStart === ws);
  const taken = moves.filter((m) => m.status === 'taken');
  const labour = actualLabourPct ?? metrics.labourPct;

  return {
    weekStart: ws,
    publishedAt: publication?.publishedAt,
    noticeDays,
    publishedOnTime: noticeDays !== undefined && noticeDays >= t.noticeDays,
    legal: checkWeek(state, ws, siteId).every((i) => i.severity !== 'block'),
    plannedLabourPct: metrics.labourPct,
    sales: actualSales.length ? sales : metrics.forecastSales,
    actualLabourPct,
    targetPct: metrics.targetPct,
    onTarget: labour > 0 && Math.abs(labour - metrics.targetPct) <= t.targetBand + 1e-9,
    overstaffedShare: rosteredHours > 0 ? overHours / rosteredHours : 0,
    overstaffedHours: overHours,
    rosteredHours,
    rotaToPayrollVariance,
    forecastWape: accuracy.measuredDays > 0 ? accuracy.wape : null,
    overrideErrorRemoved: accuracy.measuredDays > 0 && accuracy.overrides.hours > 0 ? accuracy.overrides.errorRemoved : null,
    movesOffered: moves.length,
    movesTaken: taken.length,
    expectedSaving: taken.reduce((s, m) => s + m.expectedSaving, 0),
    realisedSaving: taken.reduce((s, m) => s + (realisedSaving(m, state.employees, input.timeEntries, input.today) ?? 0), 0),
  };
}

/**
 * Where the site sits on the ladder, judged on the last four weeks scored.
 * Rungs are cumulative: a site that hits target but publishes late is on rung
 * zero, because a late rota is the first habit to fix.
 */
export function maturity(weeks: WeekScore[], thresholds: Partial<ScorecardThresholds> = {}): Maturity {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const recent = weeks.slice(-4);
  // Three weeks in four: a site with fewer than three scored weeks has not shown a habit yet.
  const need = 3;
  const count = (f: (w: WeekScore) => boolean) => recent.filter(f).length;
  const measured = recent.filter((w) => w.forecastWape !== null);
  const wape = mean(measured.map((w) => w.forecastWape!));
  const overrideNet = recent.reduce((s, w) => s + (w.overrideErrorRemoved ?? 0), 0);

  const onTime = count((w) => w.publishedOnTime && w.legal);
  const onTarget = count((w) => w.onTarget);
  const precise = count((w) => w.rosteredHours > 0 && w.overstaffedShare <= t.overstaffedShare);
  const owned = measured.length >= 2 && wape <= t.forecastWape && overrideNet >= 0;

  const rungs: Rung[] = [
    { level: 1, label: LABELS[1], met: recent.length > 0 && onTime >= need, detail: `${onTime} of ${recent.length} weeks published ${t.noticeDays}+ days ahead with nothing blocking.` },
    { level: 2, label: LABELS[2], met: recent.length > 0 && onTarget >= need, detail: `${onTarget} of ${recent.length} weeks within ${(t.targetBand * 100).toFixed(0)} point of target.` },
    { level: 3, label: LABELS[3], met: recent.length > 0 && precise >= need, detail: `${precise} of ${recent.length} weeks with ${pctText(t.overstaffedShare)} or less of hours over demand.` },
    {
      level: 4,
      label: LABELS[4],
      met: owned,
      detail: measured.length < 2
        ? 'Needs two weeks of till actuals to measure.'
        : `Forecast error ${pctText(wape)} against ${pctText(t.forecastWape)}; overrides ${overrideNet >= 0 ? 'removed' : 'added'} £${Math.abs(Math.round(overrideNet))} of error.`,
    },
  ];
  let level = 0;
  for (const r of rungs) {
    if (!r.met) break;
    level = r.level;
  }
  const nextRung = rungs[level];
  const nextText: Record<number, string> = {
    1: `Publish each week at least ${t.noticeDays} days before it starts, with every blocking issue cleared. ${rungs[0].detail}`,
    2: `Bring labour within ${(t.targetBand * 100).toFixed(0)} point of target. Take the weekly moves and check the clock matches the rota. ${rungs[1].detail}`,
    3: `Cut the hours rostered over demand: tighten shift starts and finishes around the forecast peaks. ${rungs[2].detail}`,
    4: `Make the forecast yours: check it before you build, override only with a reason, and review how your overrides did. ${rungs[3].detail}`,
  };
  return {
    level: level as Maturity['level'],
    label: LABELS[level],
    rungs,
    next: nextRung ? nextText[nextRung.level] : 'Every rung holds. Keep the habits, and coach the next GM up the ladder.',
  };
}

export function siteScorecard(input: ScorecardInput): Scorecard {
  const weeks = input.weeks.map((ws) => scoreWeek(input, ws));
  const variances = weeks.map((w) => w.rotaToPayrollVariance).filter((v): v is number => v !== null);
  const offered = weeks.reduce((s, w) => s + w.movesOffered, 0);
  return {
    siteId: input.siteId,
    weeks,
    maturity: maturity(weeks, input.thresholds),
    summary: {
      onTimeRate: weeks.length ? weeks.filter((w) => w.publishedOnTime).length / weeks.length : 0,
      onTargetRate: weeks.length ? weeks.filter((w) => w.onTarget).length / weeks.length : 0,
      averageOverstaffedShare: mean(weeks.filter((w) => w.rosteredHours > 0).map((w) => w.overstaffedShare)),
      averageVariance: variances.length ? mean(variances.map(Math.abs)) : null,
      movesTakenRate: offered ? weeks.reduce((s, w) => s + w.movesTaken, 0) / offered : null,
      expectedSaving: weeks.reduce((s, w) => s + w.expectedSaving, 0),
      realisedSaving: weeks.reduce((s, w) => s + w.realisedSaving, 0),
    },
  };
}

/** The last `count` finished weeks before the week containing `today`, oldest first. */
export function finishedWeeks(thisWeekStart: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => addDays(thisWeekStart, -7 * (count - i)));
}

/** One site's line in the league: its scorecard summed over the period, for comparing sites side by side. */
export interface LeagueRow {
  siteId: string;
  rank: number;
  level: Maturity['level'];
  label: string;
  next: string;
  /** Weeks with anything rostered or published: a site that did not trade is not marked down for it. */
  scoredWeeks: number;
  onTimeRate: number;
  legalRate: number;
  onTargetRate: number;
  /** Actual where approved, otherwise planned, weighted by each week's sales. Null with no labour at all. */
  labourPct: number | null;
  targetPct: number | null;
  overstaffedShare: number | null;
  rotaToPayrollVariance: number | null;
  forecastWape: number | null;
  movesTakenRate: number | null;
  realisedSaving: number;
}

/**
 * Sites ranked on the habits, not on the headline: the rung first, because a site on target with a
 * late rota is lucky rather than run; then weeks on target, then hours over demand. Ties keep their order.
 */
export function scorecardLeague(cards: Scorecard[]): LeagueRow[] {
  const rows = cards.map((card): Omit<LeagueRow, 'rank'> => {
    const scored = card.weeks.filter((w) => w.rosteredHours > 0 || w.publishedAt !== undefined || w.plannedLabourPct > 0);
    const rate = (f: (w: WeekScore) => boolean) => (scored.length ? scored.filter(f).length / scored.length : 0);
    const withLabour = scored.filter((w) => (w.actualLabourPct ?? w.plannedLabourPct) > 0 && w.sales > 0);
    const sales = withLabour.reduce((s, w) => s + w.sales, 0);
    const weighted = (f: (w: WeekScore) => number) => (sales > 0 ? withLabour.reduce((s, w) => s + f(w) * w.sales, 0) / sales : null);
    const precise = scored.filter((w) => w.rosteredHours > 0);
    const variances = scored.map((w) => w.rotaToPayrollVariance).filter((v): v is number => v !== null);
    const wapes = scored.map((w) => w.forecastWape).filter((v): v is number => v !== null);
    const offered = scored.reduce((s, w) => s + w.movesOffered, 0);
    return {
      siteId: card.siteId,
      level: card.maturity.level,
      label: card.maturity.label,
      next: card.maturity.next,
      scoredWeeks: scored.length,
      onTimeRate: rate((w) => w.publishedOnTime && w.legal),
      legalRate: rate((w) => w.legal),
      onTargetRate: rate((w) => w.onTarget),
      labourPct: weighted((w) => w.actualLabourPct ?? w.plannedLabourPct),
      targetPct: weighted((w) => w.targetPct),
      overstaffedShare: precise.length ? precise.reduce((s, w) => s + w.overstaffedHours, 0) / precise.reduce((s, w) => s + w.rosteredHours, 0) : null,
      rotaToPayrollVariance: variances.length ? mean(variances.map(Math.abs)) : null,
      forecastWape: wapes.length ? mean(wapes) : null,
      movesTakenRate: offered ? scored.reduce((s, w) => s + w.movesTaken, 0) / offered : null,
      realisedSaving: scored.reduce((s, w) => s + w.realisedSaving, 0),
    };
  });
  const order = rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) =>
      b.r.level - a.r.level ||
      b.r.onTargetRate - a.r.onTargetRate ||
      (a.r.overstaffedShare ?? 1) - (b.r.overstaffedShare ?? 1) ||
      a.i - b.i,
    );
  return order.map(({ r }, n) => ({ ...r, rank: n + 1 }));
}
