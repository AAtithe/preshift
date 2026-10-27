// The week's decisions: what a GM must settle before the rota is safe to run, most urgent first,
// each with the one move that settles it. Worked from the same figures the rota screen shows, so
// the bar above the rota and the rota beneath it never disagree.
import type { Issue } from './compliance';
import type { WeekMetrics } from './metrics';
import type { Employee, Shift } from './types';

export type DecisionKind = 'blocking' | 'empty-days' | 'over-target' | 'under-contract';

/** The move that settles a decision, carried out by the screen. */
export type DecisionAction =
  | { kind: 'issues' }
  | { kind: 'build' }
  | { kind: 'day'; date: string }
  | { kind: 'people' };

export interface Decision {
  kind: DecisionKind;
  /** Urgent stops the week being published or traded; review costs money but the week still runs. */
  severity: 'urgent' | 'review';
  title: string;
  detail: string;
  /** The days it concerns, so the rota can tag them. */
  dates: string[];
  action: DecisionAction;
  /** Pounds behind it, when the reader sees cost: orders decisions of the same kind. */
  amount?: number;
}

export interface WeekBrief {
  decisions: Decision[];
  /** One thing going right, said only when it is plainly true. */
  keep: string | null;
}

interface Input {
  /** The site's shifts for the week. */
  shifts: Shift[];
  employees: Employee[];
  dates: string[];
  metrics: WeekMetrics;
  issues: Issue[];
  showCost: boolean;
  published: boolean;
  /** Days before today are past deciding about. */
  today: string;
}

const DAY = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const pounds = (n: number) => `£${Math.round(n).toLocaleString('en-GB')}`;
const percent = (n: number) => `${(n * 100).toFixed(1)}%`;
const first = (employees: Employee[], id: string) => employees.find((e) => e.id === id)?.name.split(' ')[0] ?? 'Someone';
const hours = (h: number) => (Number.isInteger(h) ? String(h) : h.toFixed(1));

/** Days named the way a person says them: one, a run (Tuesday to Sunday), or a list. */
export function nameDays(dates: string[], all: string[]): string {
  const at = dates.map((d) => all.indexOf(d)).sort((a, b) => a - b);
  const names = at.map((i) => DAY[i]);
  if (names.length === 1) return names[0];
  const run = at.every((i, n) => n === 0 || i === at[n - 1] + 1);
  if (run && names.length > 2) return `${names[0]} to ${names[names.length - 1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Most urgent first: anything that stops the week being published, then days with trade forecast
 * and nobody on, then days running over the labour target (largest overspend first), then hours
 * paid under contract and not rostered. A week can be legal and staffed and still overspend, so the
 * order is what stops the week before what costs it.
 */
export function weekBrief({ shifts, employees, dates, metrics, issues, showCost, published, today }: Input): WeekBrief {
  const decisions: Decision[] = [];
  const ahead = (d: string) => d >= today;
  const staffed = new Set(shifts.map((s) => s.date));

  const blocks = issues.filter((i) => i.severity === 'block');
  if (blocks.length > 0) {
    const n = blocks.length;
    decisions.push({
      kind: 'blocking',
      severity: 'urgent',
      title: `${n} blocking ${n === 1 ? 'issue stops' : 'issues stop'} this week being published`,
      detail: `${first(employees, blocks[0].employeeId)}: ${blocks[0].message}`,
      dates: [...new Set(blocks.map((i) => i.date).filter((d): d is string => !!d))],
      action: { kind: 'issues' },
    });
  }

  const empty = metrics.days.filter((d) => ahead(d.date) && d.forecastSales > 0 && !staffed.has(d.date));
  if (empty.length > 0) {
    const sales = empty.reduce((sum, d) => sum + d.forecastSales, 0);
    const days = nameDays(empty.map((d) => d.date), dates);
    decisions.push({
      kind: 'empty-days',
      severity: 'urgent',
      title: `${days} ${empty.length === 1 ? 'has' : 'have'} no shifts`,
      detail: `${pounds(sales)} of forecast sales with nobody rostered.`,
      dates: empty.map((d) => d.date),
      action: { kind: 'build' },
      amount: sales,
    });
  }

  // Overspend is money, so only those who see cost are told it.
  if (showCost) {
    const over = metrics.days
      .filter((d) => ahead(d.date) && staffed.has(d.date) && d.forecastSales > 0 && d.labourPct > metrics.targetPct)
      .map((d) => ({ d, amount: d.labourCost - metrics.targetPct * d.forecastSales }))
      .sort((a, b) => b.amount - a.amount);
    for (const { d, amount } of over) {
      const day = DAY[dates.indexOf(d.date)];
      decisions.push({
        kind: 'over-target',
        severity: 'review',
        title: `${day} labour is ${percent(d.labourPct)} of sales`,
        detail: `${pounds(d.labourCost)} of labour against ${pounds(d.forecastSales)} of sales: ${pounds(amount)} over the ${percent(metrics.targetPct)} target.`,
        dates: [d.date],
        action: { kind: 'day', date: d.date },
        amount,
      });
    }
  }

  const under = issues.filter((i) => i.code === 'under-contract');
  if (under.length > 0) {
    const people = under.map((i) => {
      const e = employees.find((x) => x.id === i.employeeId);
      const gap = i.gapHours ?? 0;
      const cost = e && !e.payHidden ? gap * e.hourlyRate : 0;
      return { name: first(employees, i.employeeId), contracted: e?.contractedHours ?? 0, gap, cost };
    });
    const listed = people
      .slice(0, 4)
      .map((p) => `${p.name} ${hours(Math.max(0, p.contracted - p.gap))} of ${hours(p.contracted)}`)
      .join(', ');
    const more = people.length > 4 ? ` and ${people.length - 4} more` : '';
    const cost = people.reduce((sum, p) => sum + p.cost, 0);
    const n = people.length;
    decisions.push({
      kind: 'under-contract',
      severity: 'review',
      title: `${n} ${n === 1 ? 'person is' : 'people are'} below contracted hours`,
      detail: `${listed}${more}. ${showCost && cost > 0 ? `${pounds(cost)} paid either way` : 'You pay the gap either way'}, so give them hours first.`,
      dates: [],
      action: { kind: 'people' },
      ...(showCost && cost > 0 ? { amount: cost } : {}),
    });
  }

  let keep: string | null = null;
  // With no forecast there is nothing to judge staffing or labour against, so nothing is praised.
  if (decisions.length === 0 && metrics.forecastSales > 0) {
    keep = showCost ? 'Nothing to decide: the week is staffed, legal and inside the labour target.' : 'Nothing to decide: the week is staffed and legal.';
  } else if (decisions.length > 0 && published && blocks.length === 0) {
    keep = 'Published: the team can see this week.';
  }
  return { decisions, keep };
}
