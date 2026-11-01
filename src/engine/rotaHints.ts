// Coaching while the rota is written: what the last few weeks at the site say about the week being
// drafted. Mistakes that keep coming back (the same day over target week after week, the same hours
// stacked with more people than the forecast needs), what past takings say about the sales forecast,
// and tips a GM can act on before publishing, such as three chefs all starting at once. Worked from
// the same figures as the rota screen, so a hint never argues with the strip beneath it.
import type { DecisionAction } from './decisions';
import { dayDemand } from './demand';
import { weekMetrics, type WeekMetrics } from './metrics';
import { addDays, formatMinute, weekDates } from './time';
import type { RotaState, Shift } from './types';

export type HintKind = 'over-target-again' | 'over-target-held' | 'stacked' | 'same-start' | 'forecast-low' | 'forecast-high' | 'heavy' | 'light';

export interface RotaHint {
  kind: HintKind;
  /** A mistake made before and made again, a tip for this draft, or a habit worth keeping. */
  tone: 'repeat' | 'tip' | 'keep';
  title: string;
  detail: string;
  dates: string[];
  action?: DecisionAction;
}

export interface HintInput {
  state: RotaState;
  siteId: string;
  /** Monday of the week being drafted. */
  week: string;
  today: string;
  /** Labour cost and percentages are said only to those who see cost. */
  showCost: boolean;
  /** Weeks looked back over. */
  weeks?: number;
  maxHints?: number;
}

const DAY = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const pounds = (n: number) => `£${Math.round(n).toLocaleString('en-GB')}`;
const percent = (n: number) => `${(n * 100).toFixed(1)}%`;
const hours = (h: number) => (Number.isInteger(h) ? String(h) : h.toFixed(1));
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** A forecast this far from what the day took, the same way each time, is worth acting on. */
const FORECAST_MISS = 0.1;
/** Sales per labour hour this far below the day's usual means hours to spare; this far above, a thin floor. */
const HEAVY = 0.85;
const LIGHT = 1.2;
/** People in one role starting at the same minute before it reads as a habit, not a choice. */
const SAME_START = 3;

interface PastDay {
  date: string;
  /** What the day took: till takings where recorded, else the forecast it was rostered to. */
  sales: number;
  forecast: number;
  /** Takings, when the till or a manager recorded them. */
  takings: number | null;
  labourCost: number;
  paidHours: number;
}

/** The same weekday in each of the past weeks, newest first, where the day has traded and anyone was rostered. */
function pastDays(state: RotaState, siteId: string, week: string, today: string, weeks: number): PastDay[][] {
  const byDay: PastDay[][] = DAY.map(() => []);
  for (let k = 1; k <= weeks; k++) {
    const ws = addDays(week, -7 * k);
    if (ws >= today) continue;
    const m = weekMetrics(state, siteId, ws);
    m.days.forEach((d, i) => {
      if (d.date >= today || d.paidHours <= 0) return;
      const recorded = state.sales?.find((s) => s.siteId === siteId && s.date === d.date);
      const takings = recorded ? recorded.netSales : null;
      byDay[i].push({ date: d.date, sales: takings ?? d.forecastSales, forecast: d.forecastSales, takings, labourCost: d.labourCost, paidHours: d.paidHours });
    });
  }
  return byDay;
}

/** Runs of consecutive hours in one role with more people on than the forecast needs. */
function overRuns(state: RotaState, siteId: string, roleId: string, date: string) {
  const runs: { from: number; to: number; most: number; need: number; spare: number }[] = [];
  let run: (typeof runs)[number] | null = null;
  for (const h of dayDemand(state, siteId, roleId, date)) {
    if (h.gap < 0 && h.scheduled >= 2) {
      if (!run) run = { from: h.hour, to: h.hour + 1, most: h.scheduled, need: h.required, spare: 0 };
      run.to = h.hour + 1;
      if (h.scheduled > run.most) run = { ...run, most: h.scheduled, need: h.required };
      run.spare += -h.gap;
    } else if (run) {
      runs.push(run);
      run = null;
    }
  }
  if (run) runs.push(run);
  return runs;
}

/**
 * The hints for a site's draft week, repeats first: the things the GM has done before and is doing
 * again, then tips for this draft, then the habits worth keeping. Each names the day and the move.
 */
export function rotaHints({ state, siteId, week, today, showCost, weeks = 4, maxHints = 5 }: HintInput): RotaHint[] {
  const site = state.sites.find((s) => s.id === siteId);
  if (!site) return [];
  const dates = weekDates(week);
  const ahead = (d: string) => d >= today;
  const now: WeekMetrics = weekMetrics(state, siteId, week);
  const past = pastDays(state, siteId, week, today, weeks);
  const shifts = state.shifts.filter((s) => s.siteId === siteId && dates.includes(s.date));
  const staffed = new Set(shifts.map((s) => s.date));
  const target = now.targetPct;
  const out: RotaHint[] = [];
  const goTo = (date: string): DecisionAction => ({ kind: 'day', date });
  const lastOf = (n: number) => `${n === 1 ? 'last' : `last ${n}`}`;
  /** "3 of the last 4 Fridays", "both of the last 2", "all of the last 3". */
  const countOf = (k: number, n: number, days: string) => `${k === n ? (n === 2 ? 'both' : n === 1 ? 'the' : 'all') : k}${k === n && n === 1 ? '' : ' of the'} ${lastOf(n)} ${n === 1 ? days.slice(0, -1) : days}`;

  dates.forEach((date, i) => {
    if (!ahead(date)) return;
    const day = DAY[i];
    const days = `${day}s`;
    const history = past[i];
    const plan = now.days[i];

    // The same day over the labour target, week after week: the most expensive habit there is.
    if (showCost && target > 0 && staffed.has(date) && plan.forecastSales > 0) {
      const priced = history.filter((p) => p.sales > 0);
      const over = priced.filter((p) => p.labourCost / p.sales > target);
      if (priced.length >= 2 && over.length >= 2) {
        const avg = over.reduce((s, p) => s + p.labourCost / p.sales, 0) / over.length;
        const record = `${day} ran over the ${percent(target)} labour target on ${countOf(over.length, priced.length, days)}, at ${percent(avg)} on average.`;
        if (plan.labourPct > target) {
          out.push({
            kind: 'over-target-again',
            tone: 'repeat',
            title: `${day} is over target again, at ${percent(plan.labourPct)}`,
            detail: `${record} This draft repeats it: ${pounds(plan.labourCost - target * plan.forecastSales)} over. Trim the quietest hours before you publish.`,
            dates: [date],
            action: goTo(date),
          });
        } else {
          out.push({
            kind: 'over-target-held',
            tone: 'keep',
            title: `${day} is inside target this time, at ${percent(plan.labourPct)}`,
            detail: `${record} Hold that line when you make changes to this day.`,
            dates: [date],
            action: goTo(date),
          });
        }
      }
    }

    // The sales forecast against what the day really took: the target the rota is built to.
    if (plan.forecastSales > 0) {
      const pairs = history.filter((p) => p.takings !== null && p.forecast > 0).map((p) => (p.takings! - p.forecast) / p.forecast);
      if (pairs.length >= 2) {
        const mean = pairs.reduce((s, x) => s + x, 0) / pairs.length;
        const sameWay = pairs.every((x) => Math.sign(x) === Math.sign(mean));
        if (sameWay && Math.abs(mean) >= FORECAST_MISS) {
          const by = `${Math.round(Math.abs(mean) * 100)}%`;
          out.push(
            mean > 0
              ? {
                  kind: 'forecast-low',
                  tone: 'repeat',
                  title: `${days} take more than forecast`,
                  detail: `The ${lastOf(pairs.length)} ${days} took ${by} more than the sales forecast. Rostered to the forecast, the floor has been light at the peak: check cover on ${day}, or raise the forecast first.`,
                  dates: [date],
                  action: goTo(date),
                }
              : {
                  kind: 'forecast-high',
                  tone: 'repeat',
                  title: `${days} take less than forecast`,
                  detail: `The ${lastOf(pairs.length)} ${days} took ${by} less than the sales forecast. Roster ${day} to what it really takes, not the target, or bring the forecast down first.`,
                  dates: [date],
                  action: goTo(date),
                },
          );
        }
      }
    }

    // Hours against the pace the day usually runs at: sales per labour hour, from takings where there are any.
    if (staffed.has(date) && plan.forecastSales > 0 && plan.paidHours > 0) {
      const paces = history.filter((p) => p.sales > 0).map((p) => p.sales / p.paidHours);
      if (paces.length >= 2) {
        const usual = median(paces);
        const planned = plan.splh;
        const spare = plan.paidHours - plan.forecastSales / usual;
        if (planned < usual * HEAVY && spare >= 1) {
          out.push({
            kind: 'heavy',
            tone: 'tip',
            title: `${day} has about ${hours(Math.round(spare))} more hours than usual`,
            detail: `Planned at ${pounds(planned)} of sales per labour hour; the ${lastOf(paces.length)} ${days} ran at ${pounds(usual)}. At that pace this day needs ${hours(Math.round(plan.forecastSales / usual))} hours, not ${hours(Math.round(plan.paidHours))}.`,
            dates: [date],
            action: goTo(date),
          });
        } else if (planned > Math.max(...paces) * LIGHT) {
          out.push({
            kind: 'light',
            tone: 'tip',
            title: `${day} is leaner than any recent ${day}`,
            detail: `Planned at ${pounds(planned)} of sales per labour hour; the best of the ${lastOf(paces.length)} ${days} was ${pounds(Math.max(...paces))}. Check the floor is not short at the peak before you publish.`,
            dates: [date],
            action: goTo(date),
          });
        }
      }
    }

    // Roles stacked over demand: three chefs on at once when the forecast needs one.
    for (const role of state.roles) {
      const runs = overRuns(state, siteId, role.id, date);
      if (runs.length === 0) continue;
      const worst = runs.reduce((a, b) => (b.spare > a.spare ? b : a));
      if (worst.most < 3 && worst.spare < 3) continue;
      const repeats = history.filter((p) => overRuns(state, siteId, role.id, p.date).some((r) => r.from < worst.to && worst.from < r.to)).length;
      const name = role.name.toLowerCase();
      const plural = worst.most === 1 ? name : name.endsWith('s') ? name : `${name}s`;
      const span = `${formatMinute((worst.from % 24) * 60)} to ${formatMinute((worst.to % 24) * 60)}`;
      out.push({
        kind: 'stacked',
        tone: repeats >= 2 ? 'repeat' : 'tip',
        title: `Did you know you have ${worst.most} ${plural} on at the same time on ${day}?`,
        detail: `${span}, when the forecast needs ${worst.need}. That is ${hours(worst.spare)} paid ${worst.spare === 1 ? 'hour' : 'hours'} over demand.${
          repeats >= 2 ? ` The same hours were over on ${countOf(repeats, history.length, days)}.` : ''
        } Stagger the starts or move one to the peak.`,
        dates: [date],
        action: goTo(date),
      });
    }

    // Everyone in a role starting together: nobody to cover the open slowly, nobody fresh for the close.
    const byStart = new Map<string, Shift[]>();
    for (const s of shifts.filter((x) => x.date === date)) byStart.set(`${s.roleId}|${s.startMinute}`, [...(byStart.get(`${s.roleId}|${s.startMinute}`) ?? []), s]);
    for (const [key, group] of byStart) {
      if (group.length < SAME_START) continue;
      const role = state.roles.find((r) => r.id === key.split('|')[0]);
      const name = (role?.name ?? 'staff').toLowerCase();
      // Already said as a stack over demand: one hint per problem.
      if (out.some((h) => h.kind === 'stacked' && h.dates[0] === date && h.title.includes(` ${name}`))) continue;
      out.push({
        kind: 'same-start',
        tone: 'tip',
        title: `${group.length} ${name.endsWith('s') ? name : `${name}s`} all start at ${formatMinute(group[0].startMinute)} on ${day}`,
        detail: 'Stagger them to the curve: one to open, the rest arriving as trade builds, so the peak has fresh legs and the quiet hour is not paid three times.',
        dates: [date],
        action: goTo(date),
      });
    }
  });

  const order = { repeat: 0, tip: 1, keep: 2 };
  return out.sort((a, b) => order[a.tone] - order[b.tone] || a.dates[0].localeCompare(b.dates[0])).slice(0, maxHints);
}
