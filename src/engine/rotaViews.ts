import type { WeekCost } from './cost';
import { shiftPaidHours } from './cost';
import { dayDemand, forecastSalesForDay, isOpenHour, tradingDayHours } from './demand';
import { isEmployedOn, ruleAge } from './employees';
import { weekChange, weekLines, type ShiftNames } from './requests';
import { absoluteMinute, addDays, weekday, weekDates } from './time';
import type { Department, Employee, RotaState, Shift } from './types';

// The figures behind the rota's other ways of looking at a week: cover against demand as one
// grid, each person's shifts as a Gantt chart, rest between shifts as a line per person,
// positions by hour, each shift's cost against the day's sales, what the next publish will tell people, and how the hard shifts have been
// shared. Each one answers a decision the grid by person and the timeline leave to the eye.

const H = 60;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Legal daily rest between shifts on different days: 11 hours, 12 for under 18s. */
export const minRestMinutes = (employee: Pick<Employee, 'dateOfBirth' | 'personalHidden' | 'under18'>, on: string) =>
  (ruleAge(employee, on) < 18 ? 12 : 11) * H;

// Cover grid --------------------------------------------------------------------------------

export interface CoverCell {
  hour: number;
  required: number;
  scheduled: number;
  /** Positive = short, negative = over. Shortfalls in one role are never netted off against spare people in another. */
  short: number;
  over: number;
  /** The roles short this hour, deepest first. */
  shortRoles: { roleId: string; short: number }[];
}

export interface CoverGrid {
  /** Trading hours shown, the same for every day so the columns line up. Hours past 23 are the early hours after. */
  hours: number[];
  days: { date: string; cells: CoverCell[]; short: number; over: number }[];
  short: number;
  over: number;
}

/**
 * Heads on against heads needed for every trading hour of the week at one site, worked from the
 * same demand rules the timeline and the auto-build use. `roleId` narrows it to one role.
 */
export function coverGrid(state: RotaState, siteId: string, dates: string[], roleId?: string): CoverGrid {
  const site = state.sites.find((s) => s.id === siteId);
  const rules = state.demandRules.filter((r) => r.siteId === siteId && (!roleId || r.roleId === roleId));
  if (!site || rules.length === 0) return { hours: [], days: dates.map((date) => ({ date, cells: [], short: 0, over: 0 })), short: 0, over: 0 };
  const byDay = dates.map((date) => rules.map((r) => ({ roleId: r.roleId, rows: dayDemand(state, siteId, r.roleId, date) })));
  // Every hour the site trades, plus any hour someone is rostered outside it (set-up, close down).
  const used = new Set<number>();
  for (let h = 0; h < tradingDayHours(site); h++) if (isOpenHour(site, h)) used.add(h);
  for (const day of byDay) for (const { rows } of day) for (const r of rows) if (r.scheduled > 0 || r.required > 0) used.add(r.hour);
  const hours = [...used].sort((a, b) => a - b);
  const span = hours.length ? Array.from({ length: hours[hours.length - 1] - hours[0] + 1 }, (_, i) => hours[0] + i) : [];
  const days = dates.map((date, d) => {
    const cells = span.map((hour) => {
      let required = 0;
      let scheduled = 0;
      let short = 0;
      let over = 0;
      const shortRoles: CoverCell['shortRoles'] = [];
      for (const { roleId: id, rows } of byDay[d]) {
        const row = rows.find((r) => r.hour === hour);
        if (!row) continue;
        required += row.required;
        scheduled += row.scheduled;
        if (row.gap > 0) {
          short += row.gap;
          shortRoles.push({ roleId: id, short: row.gap });
        } else over -= row.gap;
      }
      shortRoles.sort((a, b) => b.short - a.short);
      return { hour, required, scheduled, short, over, shortRoles };
    });
    return { date, cells, short: sum(cells.map((c) => c.short)), over: sum(cells.map((c) => c.over)) };
  });
  return { hours: span, days, short: sum(days.map((d) => d.short)), over: sum(days.map((d) => d.over)) };
}

// Rest thread -------------------------------------------------------------------------------

export type RestLevel = 'ok' | 'tight' | 'short';

export interface RestGap {
  /** Minutes from midnight at the start of the window. */
  from: number;
  to: number;
  minutes: number;
  /** Rest between shifts on different days, which the law measures. Gaps within a day (split shifts) are shown but not judged. */
  judged: boolean;
  level: RestLevel;
}

export interface RestBlock {
  shiftId: string;
  siteId: string;
  date: string;
  from: number;
  to: number;
  /** Ends at or after the site's close: a close. */
  close: boolean;
}

export interface RestThread {
  employeeId: string;
  name: string;
  department: Department | null;
  minRest: number;
  blocks: RestBlock[];
  gaps: RestGap[];
  /** Shortest judged rest in the window, or null with fewer than two shifts on different days. */
  shortest: number | null;
  /** Most days worked in a row, counting across the window's edges. */
  longestRun: number;
  /** A close followed by the next day's shift with under 12 hours between. */
  closeThenOpen: number;
}

/** Rest within this many minutes of the legal minimum reads as tight: legal, but tiring. */
export const TIGHT_MARGIN = 2 * H;

export function restLevel(minutes: number, minRest: number): RestLevel {
  return minutes < minRest ? 'short' : minutes < minRest + TIGHT_MARGIN ? 'tight' : 'ok';
}

/**
 * Each person's shifts and the rest between them across a window of days (a fortnight: the week
 * before and the week being built), at every site they work, since rest belongs to the person.
 * People are those rostered at the site in the window, or based there.
 */
export function restThreads(state: RotaState, siteId: string, from: string, days = 14): RestThread[] {
  const to = addDays(from, days - 1);
  const windowDates = new Set(Array.from({ length: days }, (_, i) => addDays(from, i)));
  const people = state.employees.filter(
    (e) =>
      e.status !== 'leaver' &&
      (state.shifts.some((s) => s.employeeId === e.id && s.siteId === siteId && windowDates.has(s.date)) ||
        (e.siteId === siteId && isEmployedOn(e, to))),
  );
  const closeOf = (id: string) => state.sites.find((s) => s.id === id)?.closeMinute ?? 24 * H;
  const roleDept = (id: string) => state.roles.find((r) => r.id === id)?.department ?? null;
  return people
    .map((e) => {
      const minRest = minRestMinutes(e, to);
      // A day either side, so the rest into the first day and out of the last is seen.
      const mine = state.shifts
        .filter((s) => s.employeeId === e.id && s.date >= addDays(from, -1) && s.date <= addDays(to, 1))
        .sort((a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute);
      const blocks: RestBlock[] = mine.map((s) => ({
        shiftId: s.id,
        siteId: s.siteId,
        date: s.date,
        from: absoluteMinute(from, s.date, s.startMinute),
        to: absoluteMinute(from, s.date, s.endMinute),
        close: s.endMinute >= closeOf(s.siteId),
      }));
      const gaps: RestGap[] = [];
      let closeThenOpen = 0;
      for (let i = 1; i < mine.length; i++) {
        const minutes = blocks[i].from - blocks[i - 1].to;
        if (minutes <= 0) continue;
        const judged = mine[i].date !== mine[i - 1].date;
        gaps.push({ from: blocks[i - 1].to, to: blocks[i].from, minutes, judged, level: judged ? restLevel(minutes, minRest) : 'ok' });
        if (judged && blocks[i - 1].close && minutes < 12 * H) closeThenOpen++;
      }
      const inWindow = (g: RestGap) => g.to > 0 && g.from < days * 24 * H;
      const judged = gaps.filter((g) => g.judged && inWindow(g));
      const worked = new Set(state.shifts.filter((s) => s.employeeId === e.id && s.date >= addDays(from, -7) && s.date <= addDays(to, 7)).map((s) => s.date));
      let longestRun = 0;
      for (let d = -7; d <= days + 7; d++) {
        let run = 0;
        while (worked.has(addDays(from, d + run))) run++;
        // Only runs that touch the window count; the look either side is for runs over its edges.
        if (run && d <= days - 1 && d + run - 1 >= 0) longestRun = Math.max(longestRun, run);
        if (run) d += run - 1;
      }
      return {
        employeeId: e.id,
        name: e.name,
        department: roleDept(e.roleIds[0]),
        minRest,
        blocks: blocks.filter((b) => b.to > 0 && b.from < days * 24 * H),
        gaps: gaps.filter(inWindow),
        shortest: judged.length ? Math.min(...judged.map((g) => g.minutes)) : null,
        longestRun,
        closeThenOpen,
      };
    })
    .sort((a, b) => (a.shortest ?? Infinity) - (b.shortest ?? Infinity) || a.name.localeCompare(b.name));
}

// Station board -----------------------------------------------------------------------------

export interface StationRow {
  roleId: string;
  name: string;
  department: Department;
  cells: { hour: number; people: { employeeId: string; name: string; shiftId: string }[]; required: number }[];
  /** Hours somebody is needed in this position and nobody is in it. */
  empty: number;
  /** Hours with fewer in this position than needed, the empty ones included. */
  short: number;
}

/**
 * One day by position: each role at the site down the side, the trading hours across, and who
 * holds the position in each hour. A role with no demand rule shows only who is in it.
 */
export function stationBoard(state: RotaState, siteId: string, date: string): { hours: number[]; rows: StationRow[] } {
  const site = state.sites.find((s) => s.id === siteId);
  if (!site) return { hours: [], rows: [] };
  const dayShifts = state.shifts.filter((s) => s.siteId === siteId && (s.date === date || (s.date === addDays(date, -1) && s.endMinute > 24 * H)));
  const roleIds = [...new Set([...state.demandRules.filter((r) => r.siteId === siteId).map((r) => r.roleId), ...dayShifts.map((s) => s.roleId)])];
  const hours: number[] = [];
  // A shift from the night before is on only until it ends in today's early hours.
  const onAt = (s: Shift, hour: number) => (s.date === date ? s.startMinute < (hour + 1) * H && s.endMinute > hour * H : s.endMinute - 24 * H > hour * H);
  const demand = new Map(roleIds.map((id) => [id, dayDemand(state, siteId, id, date)]));
  for (let h = 0; h < tradingDayHours(site); h++) if (isOpenHour(site, h) || dayShifts.some((s) => onAt(s, h))) hours.push(h);
  const span = hours.length ? Array.from({ length: hours[hours.length - 1] - hours[0] + 1 }, (_, i) => hours[0] + i) : [];
  const rows = roleIds
    .map((roleId) => {
      const role = state.roles.find((r) => r.id === roleId);
      const cells = span.map((hour) => {
        const people = dayShifts
          .filter((s) => s.roleId === roleId && onAt(s, hour))
          .sort((a, b) => a.startMinute - b.startMinute)
          .map((s) => ({ employeeId: s.employeeId, name: state.employees.find((e) => e.id === s.employeeId)?.name ?? s.employeeId, shiftId: s.id }));
        const required = demand.get(roleId)?.find((r) => r.hour === hour)?.required ?? 0;
        return { hour, people, required };
      });
      return {
        roleId,
        name: role?.name ?? roleId,
        department: role?.department ?? 'FOH',
        cells,
        empty: cells.filter((c) => c.required > 0 && c.people.length === 0).length,
        short: cells.filter((c) => c.people.length < c.required).length,
      };
    })
    .sort((a, b) => DEPT_ORDER.indexOf(a.department) - DEPT_ORDER.indexOf(b.department) || a.name.localeCompare(b.name));
  return { hours: span, rows };
}

const DEPT_ORDER: Department[] = ['MGMT', 'FOH', 'BAR', 'BOH'];

// Gantt -------------------------------------------------------------------------------------

export interface GanttBar {
  shiftId: string;
  date: string;
  /** Which day of the week shown, from 0. */
  day: number;
  siteId: string;
  roleId: string;
  startMinute: number;
  endMinute: number;
  breakMinutes: number;
  paidHours: number;
  published: boolean;
  /** Worked at another site: drawn so the person's week reads whole, but not this site's labour. */
  away: boolean;
}

export interface GanttRow {
  employeeId: string;
  name: string;
  department: Department;
  /** Based at another site and borrowed in. */
  borrowed: boolean;
  bars: GanttBar[];
  /** Paid hours and days worked at this site in the week. */
  hours: number;
  days: number;
  contractedHours: number;
}

export interface Gantt {
  /** Minutes of the day every lane covers, the same for every day so the week lines up. Past 1440 is the early hours after. */
  from: number;
  to: number;
  /** Everyone rostered at the site in the week, by department and first start, then those based here with nothing this week. */
  rows: GanttRow[];
  /** Heads on at the site and heads the forecast needs, by hour of each day's lane. */
  heads: { date: string; hours: { hour: number; on: number; required: number }[] }[];
}

/**
 * The week as a Gantt chart: one line per person, their shifts as bars against the clock. Lanes
 * cover trading hours with an hour either side, widened for any shift outside them.
 */
export function ganttChart(state: RotaState, siteId: string, dates: string[]): Gantt {
  const site = state.sites.find((s) => s.id === siteId);
  if (!site || dates.length === 0) return { from: 0, to: 24 * H, rows: [], heads: [] };
  const inWeek = new Set(dates);
  const here = state.shifts.filter((s) => s.siteId === siteId && inWeek.has(s.date));
  const from = Math.max(0, Math.floor(Math.min(site.openMinute - H, ...here.map((s) => s.startMinute)) / H) * H);
  const to = Math.ceil(Math.max(site.closeMinute + H, ...here.map((s) => s.endMinute)) / H) * H;
  const last = dates[dates.length - 1];
  const people = state.employees.filter(
    (e) => here.some((s) => s.employeeId === e.id) || (e.siteId === siteId && e.status !== 'leaver' && isEmployedOn(e, last)),
  );
  const deptOf = (roleId: string) => state.roles.find((r) => r.id === roleId)?.department ?? 'FOH';
  const rows = people.map((e) => {
    const bars = state.shifts
      .filter((s) => s.employeeId === e.id && inWeek.has(s.date))
      .sort((a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute)
      .map((s) => ({
        shiftId: s.id,
        date: s.date,
        day: dates.indexOf(s.date),
        siteId: s.siteId,
        roleId: s.roleId,
        startMinute: s.startMinute,
        endMinute: s.endMinute,
        breakMinutes: s.breakMinutes,
        paidHours: round1(shiftPaidHours(s)),
        published: !!s.published,
        away: s.siteId !== siteId,
      }));
    const mine = bars.filter((b) => !b.away);
    return {
      employeeId: e.id,
      name: e.name,
      // The role worked here says where the person stands on this week's chart; their primary role otherwise.
      department: deptOf(mine[0]?.roleId ?? e.roleIds[0]),
      borrowed: e.siteId !== siteId,
      bars,
      hours: round1(sum(mine.map((b) => b.paidHours))),
      days: new Set(mine.map((b) => b.date)).size,
      contractedHours: e.contractedHours,
    };
  });
  const firstStart = (r: GanttRow) => {
    const b = r.bars.find((x) => !x.away);
    return b ? b.day * 24 * H + b.startMinute : Infinity;
  };
  rows.sort(
    (a, b) =>
      Number(a.hours === 0) - Number(b.hours === 0) ||
      DEPT_ORDER.indexOf(a.department) - DEPT_ORDER.indexOf(b.department) ||
      firstStart(a) - firstStart(b) ||
      a.name.localeCompare(b.name),
  );
  const rules = state.demandRules.filter((r) => r.siteId === siteId);
  const heads = dates.map((date) => {
    const demand = rules.map((r) => dayDemand(state, siteId, r.roleId, date));
    const hours: Gantt['heads'][number]['hours'] = [];
    for (let m = from; m < to; m += H) {
      const hour = m / H;
      const on = here.filter((s) => s.date === date && s.startMinute < m + H && s.endMinute > m).length;
      const required = sum(demand.map((rows) => rows.find((r) => r.hour === hour)?.required ?? 0));
      hours.push({ hour, on, required });
    }
    return { date, hours };
  });
  return { from, to, rows, heads };
}

// Cost bricks -------------------------------------------------------------------------------

export interface CostBrick {
  shiftId: string;
  employeeId: string;
  name: string;
  roleId: string;
  startMinute: number;
  endMinute: number;
  paidHours: number;
  cost: number;
  perHour: number;
  /** The part of this shift's cost past the day's target labour spend, once the day's earlier shifts are paid for. */
  overTarget: number;
}

export interface CostDay {
  date: string;
  sales: number;
  /** Labour spend that keeps the day on target. */
  target: number;
  /** People paid but not rostered, spread evenly over the week, as the P&L rail does. */
  unallocated: number;
  bricks: CostBrick[];
  cost: number;
  labourPct: number;
}

/**
 * Each day's shifts as bricks of fully loaded cost, in the order the day runs, against the day's
 * forecast sales and the spend that keeps it on target. Paid-not-rostered cost sits first, since
 * it is spent before anyone is rostered.
 */
export function costBricks(state: RotaState, cost: WeekCost, siteId: string, dates: string[]): CostDay[] {
  const site = state.sites.find((s) => s.id === siteId);
  const targetPct = site?.labourTargetPct ?? 0;
  const unallocated = cost.unallocated / 7;
  return dates.map((date) => {
    const sales = forecastSalesForDay(state, siteId, date);
    const target = sales * targetPct;
    let running = unallocated;
    const bricks = state.shifts
      .filter((s) => s.siteId === siteId && s.date === date)
      .sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute)
      .map((s) => {
        const c = cost.shifts.get(s.id)?.total ?? 0;
        const paidHours = shiftPaidHours(s);
        const before = running;
        running += c;
        return {
          shiftId: s.id,
          employeeId: s.employeeId,
          name: state.employees.find((e) => e.id === s.employeeId)?.name ?? s.employeeId,
          roleId: s.roleId,
          startMinute: s.startMinute,
          endMinute: s.endMinute,
          paidHours,
          cost: c,
          perHour: paidHours > 0 ? c / paidHours : 0,
          overTarget: Math.max(0, running - Math.max(target, before)),
        };
      });
    return { date, sales, target, unallocated, bricks, cost: running, labourPct: sales > 0 ? running / sales : 0 };
  });
}

// Changes since published -------------------------------------------------------------------

export interface PendingNotice {
  employeeId: string;
  /** first: never told about this week here, so the next publish sends the whole week. */
  kind: 'first' | 'changed' | 'removed';
  added: string[];
  removed: string[];
}

/**
 * What the next publish of a site's week will tell each person, worked exactly as the publish
 * does: their week as it now stands against what they were last told. `told` holds the lines
 * each person was last told for this site and week, by employee id.
 */
export function pendingNotices(told: Record<string, string[]>, shifts: Shift[], names: ShiftNames): PendingNotice[] {
  const byPerson = new Map<string, Shift[]>();
  for (const s of shifts) byPerson.set(s.employeeId, [...(byPerson.get(s.employeeId) ?? []), s]);
  const out: PendingNotice[] = [];
  for (const employeeId of new Set([...byPerson.keys(), ...Object.keys(told)])) {
    const now = weekLines(byPerson.get(employeeId) ?? [], names);
    const was = told[employeeId];
    if (!was) {
      if (now.length) out.push({ employeeId, kind: 'first', added: now, removed: [] });
      continue;
    }
    const { added, removed } = weekChange(was, now);
    if (added.length || removed.length) out.push({ employeeId, kind: now.length ? 'changed' : 'removed', added, removed });
  }
  return out;
}

// Fairness ledger ---------------------------------------------------------------------------

export interface FairnessRow {
  employeeId: string;
  name: string;
  payBasis: Employee['payBasis'];
  contracted: number;
  rostered: number;
  /** Saturday and Sunday shifts. */
  weekends: number;
  /** Shifts that end at or after the site's close. */
  closes: number;
  /** Shifts that end after midnight. */
  lates: number;
  /** Hours below contracted hours, summed over the weeks it happened, for hourly staff only. */
  cut: number;
}

export type FairnessMeasure = 'weekends' | 'closes' | 'lates' | 'cut';

export interface Fairness {
  weekStarts: string[];
  /** Weeks with a rota at the site. Weeks before the site used Preshift say nothing about hours, so only these count. */
  rotaWeeks: string[];
  rows: FairnessRow[];
  average: Record<FairnessMeasure, number>;
  /** People well above the team on a measure: at least double the average and two more. */
  outliers: { employeeId: string; measure: FairnessMeasure; value: number }[];
}

/**
 * How the hard shifts have been shared over the last `weeks` weeks up to and including the one
 * given: weekends, closes and late finishes, and hours below contract. People are those based at
 * the site or rostered there; their shifts at every site count, since the toll is on the person.
 */
export function fairness(state: RotaState, siteId: string, lastWeekStart: string, weeks = 4): Fairness {
  const weekStarts = Array.from({ length: weeks }, (_, i) => addDays(lastWeekStart, -7 * (weeks - 1 - i)));
  const dates = new Set(weekStarts.flatMap(weekDates));
  const closeOf = (id: string) => state.sites.find((s) => s.id === id)?.closeMinute ?? 24 * H;
  const people = state.employees.filter(
    (e) =>
      e.status !== 'leaver' &&
      (e.siteId === siteId || state.shifts.some((s) => s.employeeId === e.id && s.siteId === siteId && dates.has(s.date))),
  );
  const rotaWeeks = weekStarts.filter((ws) => state.shifts.some((s) => s.siteId === siteId && s.date >= ws && s.date <= addDays(ws, 6)));
  const rows = people.map((e) => {
    const mine = state.shifts.filter((s) => s.employeeId === e.id && dates.has(s.date));
    let cut = 0;
    let contracted = 0;
    for (const ws of rotaWeeks) {
      if (!weekDates(ws).some((d) => isEmployedOn(e, d))) continue;
      contracted += e.contractedHours;
      const worked = sum(mine.filter((s) => s.date >= ws && s.date <= addDays(ws, 6)).map(shiftPaidHours));
      if (e.payBasis === 'hourly') cut += Math.max(0, e.contractedHours - worked);
    }
    return {
      employeeId: e.id,
      name: e.name,
      payBasis: e.payBasis,
      contracted,
      rostered: round1(sum(mine.map(shiftPaidHours))),
      weekends: mine.filter((s) => weekday(s.date) >= 5).length,
      closes: mine.filter((s) => s.endMinute >= closeOf(s.siteId)).length,
      lates: mine.filter((s) => s.endMinute > 24 * H).length,
      cut: round1(cut),
    };
  });
  const measures: FairnessMeasure[] = ['weekends', 'closes', 'lates', 'cut'];
  // Averages over the people who worked at all, so someone on leave all month does not drag them down.
  const working = rows.filter((r) => r.rostered > 0);
  const average = Object.fromEntries(
    measures.map((m) => [m, working.length ? round1(sum(working.map((r) => r[m])) / working.length) : 0]),
  ) as Record<FairnessMeasure, number>;
  const outliers = rows.flatMap((r) =>
    measures.filter((m) => r[m] >= 2 && r[m] >= 2 * average[m] && r[m] - average[m] >= 2).map((m) => ({ employeeId: r.employeeId, measure: m, value: r[m] })),
  );
  return { weekStarts, rotaWeeks, rows: rows.sort((a, b) => a.name.localeCompare(b.name)), average, outliers };
}

// A person's fortnight ----------------------------------------------------------------------

export interface Fortnight {
  paidHours: number;
  /** Before tax, for hourly staff; null for salaried staff, whose pay does not move with the rota. */
  estimatedPay: number | null;
  minRest: number;
  /** Rest before each shift since the one before it, by shift id; absent for the first with nothing before it in reach. */
  restBefore: Record<string, { minutes: number; level: RestLevel; judged: boolean }>;
  shortestRest: number | null;
  daysOff: number;
}

/**
 * The next fortnight for one person, from their own shifts: hours, pay before tax, and the rest
 * between shifts. `before` is their last shift before the fortnight, so the first rest is right.
 */
export function fortnight(employee: Employee, shifts: Shift[], today: string, before?: Shift): Fortnight {
  const mine = [...shifts].sort((a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute);
  const minRest = minRestMinutes(employee, today);
  const paidHours = round1(sum(mine.map(shiftPaidHours)));
  const restBefore: Fortnight['restBefore'] = {};
  const chain = before ? [before, ...mine] : mine;
  for (let i = 1; i < chain.length; i++) {
    const minutes = absoluteMinute(today, chain[i].date, chain[i].startMinute) - absoluteMinute(today, chain[i - 1].date, chain[i - 1].endMinute);
    const judged = chain[i].date !== chain[i - 1].date;
    restBefore[chain[i].id] = { minutes, judged, level: judged ? restLevel(minutes, minRest) : 'ok' };
  }
  const judged = Object.values(restBefore).filter((r) => r.judged).map((r) => r.minutes);
  const worked = new Set(mine.map((s) => s.date));
  return {
    paidHours,
    estimatedPay: employee.payBasis === 'hourly' ? Math.round(paidHours * employee.hourlyRate * 100) / 100 : null,
    minRest,
    restBefore,
    shortestRest: judged.length ? Math.min(...judged) : null,
    daysOff: 14 - Array.from({ length: 14 }, (_, i) => addDays(today, i)).filter((d) => worked.has(d)).length,
  };
}

/**
 * What taking a shift would do to one person: their hours that week with it, and the shortest
 * rest either side of it against their other shifts. Their own shifts only.
 */
export function shiftEffect(employee: Employee, own: Shift[], slot: Shift) {
  const ws = addDays(slot.date, -weekday(slot.date));
  const week = own.filter((s) => s.date >= ws && s.date <= addDays(ws, 6));
  const all = [...own, slot].sort((a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute);
  const i = all.indexOf(slot);
  const gap = (a: Shift, b: Shift) => absoluteMinute(slot.date, b.date, b.startMinute) - absoluteMinute(slot.date, a.date, a.endMinute);
  const rests = [i > 0 && all[i - 1].date !== slot.date ? gap(all[i - 1], slot) : null, i < all.length - 1 && all[i + 1].date !== slot.date ? gap(slot, all[i + 1]) : null].filter(
    (n): n is number => n !== null,
  );
  return {
    weekHours: round1(sum(week.map(shiftPaidHours)) + shiftPaidHours(slot)),
    shortestRest: rests.length ? Math.min(...rests) : null,
    minRest: minRestMinutes(employee, slot.date),
  };
}
