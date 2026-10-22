import type { Employee, RotaState, Shift, TimeEntry } from './types';
import { breakFor, checkEmployeeWeek, complianceOptions, type Issue } from './compliance';
import { employeeWeekCost, shiftsInWeek } from './cost';
import { dayDemand } from './demand';
import { employedShare, isEmployedOn } from './employees';
import { weekMetrics } from './metrics';
import { entriesAsShifts } from './timesheet';
import { absoluteMinute, addDays, formatMinute, weekDates, weekday } from './time';

// The weekly moves: the few changes to a site's rota that save the most money
// without breaking the law or leaving the floor short. Each move is specific,
// priced at what it really saves (the marginal cost, worked on the person's
// whole week the way payroll will), and can be applied in one tap. Once the
// week has been worked, each move taken is measured against the clock, so the
// GM sees what it actually saved, not what it promised.

export type MoveKind = 'trim-start' | 'trim-end' | 'drop' | 'swap';

export interface Move {
  id: string;
  kind: MoveKind;
  siteId: string;
  weekStart: string;
  shiftId: string;
  date: string;
  before: Shift;
  /** The shift as it would be after the move; null when the move removes it. */
  after: Shift | null;
  /** Loaded pounds saved across the week, after holiday, NI and pension. */
  saving: number;
  /** Site labour % before and after this move, with the moves above it already taken. */
  labourPctBefore: number;
  labourPctAfter: number;
  /** One line a GM can act on. */
  title: string;
  /** Why the move is safe to take. */
  detail: string;
}

export interface CoachOptions {
  maxMoves?: number;
  /** Moves worth less than this are noise and are not offered. */
  minSaving?: number;
  /** Never trim a shift shorter than this. */
  minShiftHours?: number;
  /** Days before this are already worked and cannot be changed. */
  today?: string;
}

export interface WeeklyMoves {
  siteId: string;
  weekStart: string;
  moves: Move[];
  labourPctBefore: number;
  labourPctAfter: number;
  saving: number;
}

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const round2 = (n: number) => Math.round(n * 100) / 100;
const pounds = (n: number) => `£${Math.round(n).toLocaleString('en-GB')}`;
const percent = (n: number) => `${(n * 100).toFixed(1)}%`;
const firstName = (e: Employee | undefined) => e?.name.split(' ')[0] ?? 'them';

/** The person's loaded cost for the week on a given set of shifts, at every site they work. */
function personWeekCost(employee: Employee, shifts: Shift[], ws: string): number {
  const own = shiftsInWeek(shifts, ws).filter((s) => s.employeeId === employee.id);
  const share = employedShare(employee, ws);
  if (own.length === 0 && share === 0) return 0;
  return employeeWeekCost(employee, own, undefined, share).total;
}

/** Context the compliance checks need: the week and the day either side. */
const weekContext = (shifts: Shift[], ws: string) => shifts.filter((s) => s.date >= addDays(ws, -1) && s.date <= addDays(ws, 7));

/** Whether one more person than needed is on in this clock hour, for a shift that may run past midnight. */
function overstaffed(state: RotaState, shift: Shift, absHour: number, cache: Map<string, ReturnType<typeof dayDemand>>): number {
  const date = absHour >= 24 ? addDays(shift.date, 1) : shift.date;
  const k = `${date}|${shift.roleId}`;
  let demand = cache.get(k);
  if (!demand) {
    demand = dayDemand(state, shift.siteId, shift.roleId, date);
    cache.set(k, demand);
  }
  const gap = demand[absHour % 24]?.gap ?? 0;
  return gap < 0 ? -gap : 0;
}

function withBreak(shift: Shift, employee: Employee, state: RotaState): Shift {
  const length = shift.endMinute - shift.startMinute;
  const needed = breakFor(employee, shift.date, length, complianceOptions(state, employee).nation);
  // Keep a longer break the manager set; drop it when the shorter shift no longer needs one.
  return { ...shift, breakMinutes: needed > 0 ? Math.max(needed, shift.breakMinutes) : 0 };
}

interface Candidate {
  kind: MoveKind;
  shift: Shift;
  after: Shift | null;
  over: number;
  from: number;
  to: number;
}

/** Every change to one shift worth pricing: trims at either end, dropping it, or giving it to someone cheaper. */
function candidates(state: RotaState, shift: Shift, minShiftHours: number, cache: Map<string, ReturnType<typeof dayDemand>>): Candidate[] {
  const employee = state.employees.find((e) => e.id === shift.employeeId);
  if (!employee) return [];
  const out: Candidate[] = [];
  const firstHour = Math.floor(shift.startMinute / 60);
  const lastHour = Math.floor((shift.endMinute - 1) / 60);
  const over = (h: number) => overstaffed(state, shift, h, cache);

  if ([...Array(lastHour - firstHour + 1).keys()].every((i) => over(firstHour + i) > 0)) {
    const most = Math.max(...[...Array(lastHour - firstHour + 1).keys()].map((i) => over(firstHour + i)));
    out.push({ kind: 'drop', shift, after: null, over: most, from: shift.startMinute, to: shift.endMinute });
  } else {
    const minLength = minShiftHours * 60;
    let start = shift.startMinute;
    let most = 0;
    for (let h = firstHour; h <= lastHour && over(h) > 0; h++) {
      const next = (h + 1) * 60;
      if (shift.endMinute - next < minLength) break;
      most = Math.max(most, over(h));
      start = next;
    }
    if (start > shift.startMinute) {
      out.push({ kind: 'trim-start', shift, after: withBreak({ ...shift, startMinute: start }, employee, state), over: most, from: shift.startMinute, to: start });
    }
    let end = shift.endMinute;
    most = 0;
    for (let h = lastHour; h >= firstHour && over(h) > 0; h--) {
      const next = h * 60;
      if (next - shift.startMinute < minLength) break;
      most = Math.max(most, over(h));
      end = next;
    }
    if (end < shift.endMinute) {
      out.push({ kind: 'trim-end', shift, after: withBreak({ ...shift, endMinute: end }, employee, state), over: most, from: end, to: shift.endMinute });
    }
  }

  // Someone cheaper who could legally do the same shift: the same people the auto-build would consider.
  for (const other of state.employees) {
    if (other.id === employee.id || other.payBasis !== 'hourly') continue;
    if (other.siteId !== shift.siteId && !other.coverSiteIds.includes(shift.siteId)) continue;
    if (!other.roleIds.includes(shift.roleId) || !isEmployedOn(other, shift.date)) continue;
    if (state.shifts.some((s) => s.employeeId === other.id && s.date === shift.date)) continue;
    out.push({ kind: 'swap', shift, after: withBreak({ ...shift, employeeId: other.id }, other, state), over: 0, from: shift.startMinute, to: shift.endMinute });
  }
  return out;
}

const issueKey = (i: Issue) => `${i.code}|${i.shiftId ?? ''}|${i.date ?? ''}`;

/** One pass over the week: the compliance context and each person's issues, worked once and reused for every candidate. */
class WeekCheck {
  private readonly before = new Map<string, Set<string>>();
  readonly context: Shift[];
  constructor(private readonly state: RotaState, private readonly ws: string) {
    this.context = weekContext(state.shifts, ws);
  }
  issuesBefore(e: Employee): Set<string> {
    let set = this.before.get(e.id);
    if (!set) {
      set = new Set(checkEmployeeWeek(e, this.ws, this.context, undefined, complianceOptions(this.state, e)).map(issueKey));
      this.before.set(e.id, set);
    }
    return set;
  }
  /** The person's issues with one shift replaced or removed, checked against only their own shifts. */
  issuesAfter(e: Employee, change: Candidate): Issue[] {
    const own = this.context.filter((s) => s.id !== change.shift.id && s.employeeId === e.id);
    if (change.after && change.after.employeeId === e.id) own.push(change.after);
    return checkEmployeeWeek(e, this.ws, own, undefined, complianceOptions(this.state, e));
  }
}

/** Prices a candidate and checks it is safe. Null if it breaks something or saves nothing. */
function evaluate(state: RotaState, c: Candidate, ws: string, check: WeekCheck): { saving: number; shifts: Shift[] } | null {
  const shifts = c.after ? state.shifts.map((s) => (s.id === c.shift.id ? c.after! : s)) : state.shifts.filter((s) => s.id !== c.shift.id);
  const people = new Set([c.shift.employeeId, c.after?.employeeId].filter((id): id is string => !!id));
  let saving = 0;
  for (const id of people) {
    const e = state.employees.find((x) => x.id === id)!;
    saving += personWeekCost(e, state.shifts, ws) - personWeekCost(e, shifts, ws);
    const before = check.issuesBefore(e);
    const after = check.issuesAfter(e, c);
    // Never a new block for anyone. The person taking a shift over must gain no issue at all, warnings
    // included: rest gaps land on the next day's shift and hours limits on the week, so compare everything.
    const fresh = after.filter((i) => !before.has(issueKey(i)));
    if (fresh.some((i) => i.severity === 'block')) return null;
    if (c.kind === 'swap' && id === c.after?.employeeId && fresh.length > 0) return null;
  }
  return { saving: round2(saving), shifts };
}

/**
 * Re-checks a move at the moment it is taken, against the rota as it is now:
 * the issues it would add for either person. Empty means safe to apply.
 */
export function moveIssues(state: RotaState, kind: MoveKind, before: Shift, after: Shift | null, ws: string): Issue[] {
  const check = new WeekCheck(state, ws);
  const c: Candidate = { kind, shift: before, after, over: 0, from: before.startMinute, to: before.endMinute };
  const out: Issue[] = [];
  for (const id of new Set([before.employeeId, after?.employeeId].filter((x): x is string => !!x))) {
    const e = state.employees.find((x) => x.id === id);
    if (!e) continue;
    const prior = check.issuesBefore(e);
    const fresh = check.issuesAfter(e, c).filter((i) => !prior.has(issueKey(i)));
    out.push(...fresh.filter((i) => i.severity === 'block' || (kind === 'swap' && id === after?.employeeId)));
  }
  return out;
}

function describe(state: RotaState, c: Candidate, saving: number, labourPctAfter: number): { title: string; detail: string } {
  const person = state.employees.find((e) => e.id === c.shift.employeeId);
  const role = state.roles.find((r) => r.id === c.shift.roleId)?.name.toLowerCase() ?? 'role';
  const day = DAY_NAMES[weekday(c.shift.date)];
  const span = `${formatMinute(c.from)} to ${formatMinute(c.to)}`;
  const heads = `${c.over} ${c.over === 1 ? 'head' : 'heads'} over demand`;
  const tail = `save ${pounds(saving)}, labour ${percent(labourPctAfter)}.`;
  switch (c.kind) {
    case 'trim-end':
      return {
        title: `${day} ${span} is ${heads} on ${role}. End ${firstName(person)} at ${formatMinute(c.from)}, ${tail}`,
        detail: 'The forecast still has enough cover after they leave, and no rule is broken.',
      };
    case 'trim-start':
      return {
        title: `${day} ${span} is ${heads} on ${role}. Start ${firstName(person)} at ${formatMinute(c.to)}, ${tail}`,
        detail: 'The forecast still has enough cover before they arrive, and no rule is broken.',
      };
    case 'drop':
      return {
        title: `${day} ${span}: ${firstName(person)}'s ${role} shift is over demand for its whole length. Take it off, ${tail}`,
        detail: 'Every hour of it has more people on than the forecast needs.',
      };
    case 'swap': {
      const other = state.employees.find((e) => e.id === c.after?.employeeId);
      return {
        title: `${day} ${span} ${role}: give ${firstName(person)}'s shift to ${firstName(other)}, ${tail}`,
        detail: `${other?.name ?? 'They'} is trained, free that day and costs less to add this week, with no compliance issue on the shift.`,
      };
    }
  }
}

/**
 * The best few moves for a site's week, chosen one at a time: price every
 * candidate, take the one that saves most, apply it, and look again, so the
 * moves never fight over the same hour and the labour % after each one already
 * includes the ones above it.
 */
export function weeklyMoves(state: RotaState, siteId: string, ws: string, options: CoachOptions = {}): WeeklyMoves {
  const maxMoves = options.maxMoves ?? 3;
  const minSaving = options.minSaving ?? 5;
  const minShiftHours = options.minShiftHours ?? 3;
  const dates = new Set(weekDates(ws));
  const start = weekMetrics(state, siteId, ws).labourPct;
  let current = state;
  let pctBefore = start;
  const moves: Move[] = [];
  const touched = new Set<string>();

  while (moves.length < maxMoves) {
    const cache = new Map<string, ReturnType<typeof dayDemand>>();
    const check = new WeekCheck(current, ws);
    let best: { c: Candidate; saving: number; shifts: Shift[] } | null = null;
    for (const shift of current.shifts) {
      if (shift.siteId !== siteId || !dates.has(shift.date) || touched.has(shift.id)) continue;
      if (options.today && shift.date < options.today) continue;
      for (const c of candidates(current, shift, minShiftHours, cache)) {
        const result = evaluate(current, c, ws, check);
        if (result && result.saving >= minSaving && (!best || result.saving > best.saving)) best = { c, ...result };
      }
    }
    if (!best) break;
    const next = { ...current, shifts: best.shifts };
    const pctAfter = weekMetrics(next, siteId, ws).labourPct;
    const text = describe(current, best.c, best.saving, pctAfter);
    const after = best.c.after;
    moves.push({
      id: `${best.c.kind}:${best.c.shift.id}:${after ? `${after.employeeId}:${after.startMinute}-${after.endMinute}` : 'off'}`,
      kind: best.c.kind,
      siteId,
      weekStart: ws,
      shiftId: best.c.shift.id,
      date: best.c.shift.date,
      before: best.c.shift,
      after,
      saving: best.saving,
      labourPctBefore: pctBefore,
      labourPctAfter: pctAfter,
      ...text,
    });
    touched.add(best.c.shift.id);
    current = next;
    pctBefore = pctAfter;
  }
  return { siteId, weekStart: ws, moves, labourPctBefore: start, labourPctAfter: pctBefore, saving: round2(moves.reduce((s, m) => s + m.saving, 0)) };
}

export type MoveStatus = 'offered' | 'taken' | 'dismissed';

/** A move as offered to a GM, and what became of it. */
export interface MoveRecord {
  id: string;
  kind: MoveKind;
  siteId: string;
  weekStart: string;
  shiftId: string;
  title: string;
  before: Shift;
  after: Shift | null;
  expectedSaving: number;
  status: MoveStatus;
  offeredAt: string;
  decidedAt?: string;
  decidedBy?: string;
  /** Why a move was turned down, in the GM's words: the most useful coaching signal there is. */
  reason?: string;
}

export function recordOf(move: Move, offeredAt: string): MoveRecord {
  return {
    id: move.id,
    kind: move.kind,
    siteId: move.siteId,
    weekStart: move.weekStart,
    shiftId: move.shiftId,
    title: move.title,
    before: move.before,
    after: move.after,
    expectedSaving: move.saving,
    status: 'offered',
    offeredAt,
  };
}

/**
 * What a move taken actually saved, from approved time once the week is done.
 * The week as clocked is compared with the same week had the move not been
 * made: the clocked time against the shift stretched back over the hours the
 * move took off (or, for a swap, worked by the original person instead), all
 * priced on the people's whole week. Lateness on the rest of the shift is the
 * same on both sides, so it is not counted. A trim the person ignored (they
 * stayed to the old finish) saves nothing, which is exactly what the GM needs
 * to see. Null until the week has ended and every entry for the people
 * involved is approved, because on-costs are worked on the whole week.
 */
export function realisedSaving(record: MoveRecord, employees: Employee[], entries: TimeEntry[], today?: string): number | null {
  const ws = record.weekStart;
  if (today && today <= addDays(ws, 6)) return null;
  const dates = new Set(weekDates(ws));
  const people = new Set([record.before.employeeId, record.after?.employeeId].filter((id): id is string => !!id));
  const theirs = entries.filter((e) => dates.has(e.date) && people.has(e.employeeId) && e.status !== 'rejected');
  if (theirs.some((e) => e.status !== 'approved' || e.clockOut === undefined)) return null;
  const approved = entries.filter((e) => e.status === 'approved' && e.clockOut !== undefined && dates.has(e.date));
  if (!approved.some((e) => e.siteId === record.siteId && e.date === record.before.date)) return null;

  const worked = entriesAsShifts(approved);
  const anchor = addDays(ws, -7);
  const window = [absoluteMinute(anchor, record.before.date, record.before.startMinute), absoluteMinute(anchor, record.before.date, record.before.endMinute)];
  // Time clocked against the move: linked to the shift, or unlinked time at the site in the original window.
  const matched = (s: Shift) => {
    if (!people.has(s.employeeId)) return false;
    const entry = approved.find((e) => `te:${e.id}` === s.id)!;
    if (entry.shiftId) return entry.shiftId === record.shiftId;
    if (s.siteId !== record.siteId) return false;
    return absoluteMinute(anchor, s.date, s.startMinute) < window[1] && window[0] < absoluteMinute(anchor, s.date, s.endMinute);
  };
  const hits = worked.filter(matched);
  const others = worked.filter((s) => !matched(s));
  const b = record.before;
  let counterfactual: Shift[];
  if (hits.length === 0) {
    // Nothing clocked against it: had the move not been made, the original shift would have been worked.
    counterfactual = record.kind === 'swap' ? others : [...others, b];
  } else if (record.kind === 'swap') {
    counterfactual = [...others, ...hits.map((s) => ({ ...s, employeeId: b.employeeId }))];
  } else if (record.kind === 'drop') {
    counterfactual = worked; // they worked it anyway
  } else {
    // Stretch only the clocking at the trimmed edge (the first for a later start, the last for an earlier
    // finish) and by no more than the hours the move took off, so leaving early is not credited to the move.
    const removed = record.kind === 'trim-start' ? (record.after?.startMinute ?? b.startMinute) - b.startMinute : b.endMinute - (record.after?.endMinute ?? b.endMinute);
    const order = [...hits].sort((x, y) => absoluteMinute(anchor, x.date, x.startMinute) - absoluteMinute(anchor, y.date, y.startMinute));
    const edge = record.kind === 'trim-start' ? order[0] : order[order.length - 1];
    const stretched =
      record.kind === 'trim-start'
        ? { ...edge, startMinute: Math.min(edge.startMinute, Math.max(b.startMinute, edge.startMinute - removed)) }
        : { ...edge, endMinute: Math.max(edge.endMinute, Math.min(b.endMinute, edge.endMinute + removed)) };
    stretched.breakMinutes = Math.max(edge.breakMinutes, b.breakMinutes);
    counterfactual = [...others, ...hits.filter((h) => h !== edge), stretched];
  }
  let saving = 0;
  for (const id of people) {
    const e = employees.find((x) => x.id === id);
    if (!e) continue;
    saving += personWeekCost(e, counterfactual, ws) - personWeekCost(e, worked, ws);
  }
  return round2(saving);
}
