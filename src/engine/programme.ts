import { tradingDate } from './demand';
import type { RotaState, TimeEntry } from './types';
import { weekCost } from './cost';
import type { Scorecard } from './scorecard';
import { overstaffing } from './scorecard';
import { entriesAsShifts } from './timesheet';
import { addDays, daysBetween, weekday, weekStart } from './time';

// The labour programme: twelve weeks, four phases, run by WS with the site's GM
// and owner. Software alone does not change how a GM rosters; a programme with
// a baseline, a weekly rhythm and a result signed off in the management
// accounts does. Milestones are proved by the site's own data where they can
// be, and signed off by the partner lead where they cannot.

export type PhaseId = 'baseline' | 'control' | 'optimise' | 'embed';

export interface Phase {
  id: PhaseId;
  label: string;
  /** Programme weeks, 1-based and inclusive. */
  fromWeek: number;
  toWeek: number;
  purpose: string;
}

export const PHASES: Phase[] = [
  { id: 'baseline', label: 'Baseline', fromWeek: 1, toWeek: 2, purpose: 'Measure true labour from the ledger: labour % by site and daypart, clocked time against the rota, hours over demand.' },
  { id: 'control', label: 'Control', fromWeek: 3, toWeek: 6, purpose: 'Build from the forecast, publish on time with nothing blocking, review variance with the GM every week.' },
  { id: 'optimise', label: 'Optimise', fromWeek: 7, toWeek: 10, purpose: 'Hit target, tighten shift edges by daypart, take the weekly moves, use cross-site cover.' },
  { id: 'embed', label: 'Embed', fromWeek: 11, toWeek: 12, purpose: 'Own the forecast, close labour by working day 3, sign the saving off in the accounts, hand over.' },
];

export const PROGRAMME_WEEKS = 12;

export type Proof = 'data' | 'signoff';

export interface MilestoneDef {
  id: string;
  phase: PhaseId;
  label: string;
  proof: Proof;
}

export const MILESTONES: MilestoneDef[] = [
  { id: 'kickoff', phase: 'baseline', label: 'Kick-off held with the owner and GM; targets agreed', proof: 'signoff' },
  { id: 'baseline-captured', phase: 'baseline', label: 'Baseline labour % recorded from the management accounts or till and payroll', proof: 'data' },
  { id: 'actuals-loaded', phase: 'baseline', label: 'Eight weeks of hourly till sales loaded for the forecast', proof: 'data' },
  { id: 'variance-measured', phase: 'baseline', label: 'Clocked time measured against the rota on a worked week', proof: 'data' },
  { id: 'on-time', phase: 'control', label: 'Rota published on time and legal, three weeks in four', proof: 'data' },
  { id: 'weekly-review', phase: 'control', label: 'Weekly variance review held with the GM four weeks running', proof: 'signoff' },
  { id: 'on-target', phase: 'optimise', label: 'Labour within one point of target, three weeks in four', proof: 'data' },
  { id: 'precision', phase: 'optimise', label: 'Hours over demand at or under five per cent, three weeks in four', proof: 'data' },
  { id: 'moves-habit', phase: 'optimise', label: 'Half or more of the weekly moves taken', proof: 'data' },
  { id: 'cover-agreed', phase: 'optimise', label: 'Cross-site cover agreed with the people willing to do it', proof: 'signoff' },
  { id: 'forecast-owned', phase: 'embed', label: 'Forecast error under target and overrides adding value', proof: 'data' },
  { id: 'variance-under-1', phase: 'embed', label: 'Clocked time within one per cent of the rota', proof: 'data' },
  { id: 'day3-close', phase: 'embed', label: 'Labour closed by working day 3', proof: 'signoff' },
  { id: 'saving-verified', phase: 'embed', label: 'Saving signed off in the management accounts', proof: 'data' },
];

/** Labour before the programme, taken from the books for a stated period. */
export interface Baseline {
  from: string;
  to: string;
  sales: number;
  labourCost: number;
  /** Share of rostered hours over demand before the programme, where it could be measured. */
  overstaffedShare?: number;
  source: 'management_accounts' | 'till_and_payroll';
  recordedBy: string;
  recordedAt: string;
}

/** A period's labour, signed off by the accounting partner from the management accounts. This is the proof. */
export interface Verification {
  id: string;
  from: string;
  to: string;
  sales: number;
  labourCost: number;
  signedBy: string;
  signedAt: string;
  note?: string;
}

export interface Signoff {
  by: string;
  at: string;
  note?: string;
}

export interface Programme {
  siteId: string;
  /** The Monday of programme week 1. */
  startWeek: string;
  baseline?: Baseline;
  signoffs: Record<string, Signoff>;
  verifications: Verification[];
  /** Share of the verified annual saving charged as a fee, if the engagement is priced that way. */
  gainSharePct?: number;
}

export interface MilestoneStatus extends MilestoneDef {
  done: boolean;
  evidence: string;
  signoff?: Signoff;
}

export interface Target {
  label: string;
  value: number | null;
  target: number;
  met: boolean | null;
  /** How the figure reads: as a percentage or a share of weeks. */
  unit: 'pct' | 'share';
}

export interface Saving {
  baselinePct: number | null;
  currentPct: number | null;
  /** Labour points taken out: baseline minus current. Positive is good. */
  points: number | null;
  annualSales: number | null;
  annualSaving: number | null;
  /** True when the current figure comes from a signed-off verification, not the rota. */
  verified: boolean;
  gainShareFee: number | null;
}

export interface ProgrammeStatus {
  siteId: string;
  /** 1 to 12 while running; above 12 once finished. 0 before it starts. */
  week: number;
  phase: Phase | null;
  milestones: MilestoneStatus[];
  /** Done over total milestones. */
  progress: number;
  targets: Target[];
  saving: Saving;
}

export const newProgramme = (siteId: string, startWeek: string): Programme => ({ siteId, startWeek: weekStart(startWeek), signoffs: {}, verifications: [] });

/**
 * Labour for a past period from the site's own till and approved time, for a
 * site whose accounts do not split labour by site. Each week is priced on the
 * whole week, as payroll pays it.
 */
export function baselineFromHistory(state: RotaState, timeEntries: TimeEntry[], siteId: string, from: string, to: string): { sales: number; labourCost: number; overstaffedShare: number | null } {
  // Fixed pay (salaries, guaranteed hours) is a whole week's cost, so the period must be whole weeks.
  if (!wholeWeeks(from, to)) throw new Error('A baseline from till and payroll must run Monday to Sunday');
  // By trading day, so the period's last night keeps its hours after midnight and its first gives up the night before's.
  const site = state.sites.find((s) => s.id === siteId);
  const sales = (state.actuals ?? []).filter((a) => a.siteId === siteId && tradingDate(site, a) >= from && tradingDate(site, a) <= to).reduce((s, a) => s + a.sales, 0);
  const approved = timeEntries.filter((e) => e.status === 'approved' && e.date >= from && e.date <= to);
  const shifts = entriesAsShifts(approved);
  let labourCost = 0;
  let over = 0;
  let rostered = 0;
  for (let ws = weekStart(from); ws <= to; ws = addDays(ws, 7)) {
    labourCost += weekCost({ employees: state.employees, shifts }, ws, siteId).total;
    const o = overstaffing(state, siteId, ws);
    over += o.overHours;
    rostered += o.rosteredHours;
  }
  return { sales, labourCost: Math.round(labourCost * 100) / 100, overstaffedShare: rostered > 0 ? over / rostered : null };
}

/** Monday to Sunday, so weekly fixed pay lines up with the sales it is set against. */
export const wholeWeeks = (from: string, to: string) => to >= from && weekday(from) === 0 && weekday(to) === 6;

/** Labour over sales; null when there are no sales, so a zero never reads as a perfect labour %. */
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
const annualise = (sales: number, from: string, to: string) => (sales * 365) / Math.max(1, daysBetween(from, to) + 1);

export function programmeStatus(programme: Programme, scorecard: Scorecard, state: RotaState, today: string): ProgrammeStatus {
  const elapsed = daysBetween(programme.startWeek, today);
  const week = elapsed < 0 ? 0 : Math.floor(elapsed / 7) + 1;
  const phase = PHASES.find((p) => week >= p.fromWeek && week <= p.toWeek) ?? null;
  const recent = scorecard.weeks.slice(-4);
  const rung = (level: number) => scorecard.maturity.rungs.find((r) => r.level === level)!;
  const variances = recent.map((w) => w.rotaToPayrollVariance).filter((v): v is number => v !== null);
  const avgVariance = variances.length ? variances.reduce((s, v) => s + Math.abs(v), 0) / variances.length : null;
  const offered = recent.reduce((s, w) => s + w.movesOffered, 0);
  const takenRate = offered ? recent.reduce((s, w) => s + w.movesTaken, 0) / offered : null;
  const actualDays = new Set((state.actuals ?? []).filter((a) => a.siteId === programme.siteId).map((a) => a.date)).size;

  const evidence: Record<string, { done: boolean; evidence: string }> = {
    'baseline-captured': programme.baseline
      ? { done: true, evidence: `${((ratio(programme.baseline.labourCost, programme.baseline.sales) ?? 0) * 100).toFixed(1)}% from ${programme.baseline.from} to ${programme.baseline.to}.` }
      : { done: false, evidence: 'No baseline recorded yet.' },
    'actuals-loaded': { done: actualDays >= 56, evidence: `${actualDays} days of hourly till sales.` },
    'variance-measured': { done: scorecard.weeks.some((w) => w.rotaToPayrollVariance !== null), evidence: variances.length ? `Latest gap ${(variances[variances.length - 1] * 100).toFixed(1)}%.` : 'No worked week with approved time yet.' },
    'on-time': { done: rung(1).met, evidence: rung(1).detail },
    'on-target': { done: rung(2).met, evidence: rung(2).detail },
    precision: { done: rung(3).met, evidence: rung(3).detail },
    'moves-habit': { done: takenRate !== null && takenRate >= 0.5, evidence: takenRate === null ? 'No moves offered yet.' : `${Math.round(takenRate * 100)}% of moves taken over the last four weeks.` },
    'forecast-owned': { done: rung(4).met, evidence: rung(4).detail },
    'variance-under-1': { done: avgVariance !== null && avgVariance < 0.01, evidence: avgVariance === null ? 'Not measured yet.' : `Average gap ${(avgVariance * 100).toFixed(2)}% over the last four weeks.` },
    'saving-verified': (() => {
      const v = programme.verifications.filter((x) => x.sales > 0 && x.from >= programme.startWeek && (!programme.baseline || x.from > programme.baseline.to)).at(-1);
      return { done: !!v, evidence: v ? `Signed off by ${v.signedBy} for ${v.from} to ${v.to}.` : 'Not yet signed off in the accounts for a period after the baseline.' };
    })(),
  };

  const milestones = MILESTONES.map((m) => {
    if (m.proof === 'signoff') {
      const s = programme.signoffs[m.id];
      return { ...m, done: !!s, evidence: s ? `Signed off by ${s.by}${s.note ? `: ${s.note}` : ''}.` : 'Awaiting sign-off by the partner lead.', signoff: s };
    }
    return { ...m, ...evidence[m.id] };
  });

  // The saving: baseline against the latest signed-off period after the baseline, or against the last four
  // weeks' rota (weighted by sales) while unverified. A period that overlaps the baseline proves nothing.
  const baselinePct = programme.baseline ? ratio(programme.baseline.labourCost, programme.baseline.sales) : null;
  const counts = (v: Verification) => v.sales > 0 && v.from >= programme.startWeek && (!programme.baseline || v.from > programme.baseline.to);
  const latest = [...programme.verifications].filter(counts).sort((a, b) => a.to.localeCompare(b.to)).at(-1);
  // Only weeks that were rostered or worked say anything about labour.
  const run = recent.filter((w) => w.rosteredHours > 0 || w.actualLabourPct !== null);
  const weightedSales = run.reduce((s, w) => s + w.sales, 0);
  const recentPct = weightedSales > 0 ? run.reduce((s, w) => s + (w.actualLabourPct ?? w.plannedLabourPct) * w.sales, 0) / weightedSales : null;
  const currentPct = latest ? ratio(latest.labourCost, latest.sales) : recentPct;
  const annualSales = latest ? annualise(latest.sales, latest.from, latest.to) : programme.baseline ? annualise(programme.baseline.sales, programme.baseline.from, programme.baseline.to) : null;
  const points = baselinePct !== null && currentPct !== null ? baselinePct - currentPct : null;
  const annualSaving = points !== null && annualSales !== null ? points * annualSales : null;
  const verified = !!latest;

  const rostered = recent.filter((w) => w.rosteredHours > 0);
  const recentOver = rostered.length ? rostered.reduce((s, w) => s + w.overstaffedShare, 0) / rostered.length : null;
  const baseOver = programme.baseline?.overstaffedShare;
  const targets: Target[] = [
    { label: 'Clocked time against the rota', value: avgVariance, target: 0.01, met: avgVariance === null ? null : avgVariance < 0.01, unit: 'pct' },
    { label: 'Weeks within one point of target', value: recent.length ? recent.filter((w) => w.onTarget).length / recent.length : null, target: 0.8, met: recent.length ? recent.filter((w) => w.onTarget).length / recent.length >= 0.8 : null, unit: 'share' },
    {
      label: 'Hours over demand, down on baseline',
      value: baseOver && recentOver !== null ? 1 - recentOver / baseOver : null,
      target: 0.3,
      met: baseOver && recentOver !== null ? 1 - recentOver / baseOver >= 0.3 : null,
      unit: 'share',
    },
  ];

  return {
    siteId: programme.siteId,
    week,
    phase,
    milestones,
    progress: milestones.filter((m) => m.done).length / milestones.length,
    targets,
    saving: {
      baselinePct,
      currentPct,
      points,
      annualSales,
      annualSaving,
      verified,
      // A fee is only ever charged on a saving signed off in the accounts.
      gainShareFee: verified && annualSaving !== null && annualSaving > 0 && programme.gainSharePct ? annualSaving * programme.gainSharePct : null,
    },
  };
}
