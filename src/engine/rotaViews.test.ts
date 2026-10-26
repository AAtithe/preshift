import { describe, expect, it } from 'vitest';
import { weekCost } from './cost';
import { namesOf, weekLines } from './requests';
import {
  costBricks,
  coverGrid,
  fairness,
  fortnight,
  ganttChart,
  pendingNotices,
  restLevel,
  restThreads,
  shiftEffect,
  stationBoard,
} from './rotaViews';
import { seedState } from './seed';
import { addDays, weekDates } from './time';
import type { Employee, RotaState, Shift } from './types';

const TODAY = '2026-10-19'; // a Monday
const WEEK = weekDates(TODAY);
const H = 60;

let n = 0;
const shift = (employeeId: string, date: string, start: number, end: number, extra: Partial<Shift> = {}): Shift => ({
  id: `s${++n}`, employeeId, roleId: 'server', siteId: 'mar', date, startMinute: start, endMinute: end, breakMinutes: 0, ...extra,
});

function state(shifts: Shift[]): RotaState {
  return { ...seedState(TODAY), shifts };
}

const person = (s: RotaState, roleId = 'server', siteId = 'mar') =>
  s.employees.find((e) => e.siteId === siteId && e.roleIds[0] === roleId && e.status !== 'leaver' && e.payBasis === 'hourly')!;

describe('cover grid', () => {
  it('shows every trading hour of the week, short where nobody is on and spare where too many are', () => {
    const base = state([]);
    const grid = coverGrid(base, 'mar', WEEK);
    expect(grid.hours[0]).toBe(11);
    expect(grid.hours.at(-1)).toBe(22);
    expect(grid.days).toHaveLength(7);
    // With nobody rostered, every hour is short by what it needs and nothing is over.
    const monday = grid.days[0];
    expect(monday.cells.every((c) => c.scheduled === 0 && c.short === c.required)).toBe(true);
    expect(grid.over).toBe(0);
    expect(grid.short).toBeGreaterThan(0);
  });

  it('never nets a short role off against a spare one', () => {
    const base = state([]);
    const server = person(base, 'server');
    // Ten servers at 15:00 on Monday, the quietest hour: spare servers, still short of chefs.
    const crowd = Array.from({ length: 10 }, () => shift(server.id, WEEK[0], 15 * H, 16 * H));
    const grid = coverGrid({ ...base, shifts: crowd }, 'mar', WEEK);
    const cell = grid.days[0].cells.find((c) => c.hour === 15)!;
    expect(cell.over).toBeGreaterThan(0);
    expect(cell.short).toBeGreaterThan(0);
    expect(cell.shortRoles.map((r) => r.roleId)).toContain('chef');
    expect(cell.shortRoles.map((r) => r.roleId)).not.toContain('server');
  });

  it('narrows to one role', () => {
    const grid = coverGrid(state([]), 'mar', WEEK, 'chef');
    expect(grid.days[0].cells.every((c) => c.shortRoles.every((r) => r.roleId === 'chef'))).toBe(true);
  });
});

describe('rest thread', () => {
  it('judges rest between days against 11 hours and marks a tight turnaround', () => {
    const base = state([]);
    const e = person(base);
    const shifts = [
      shift(e.id, WEEK[0], 12 * H, 23 * H), // close Monday
      shift(e.id, WEEK[1], 9 * H, 17 * H), // open Tuesday: 10 hours rest
      shift(e.id, WEEK[2], 5 * H + 30, 12 * H), // Wednesday early: 12.5 hours, tight
      shift(e.id, WEEK[3], 12 * H, 18 * H), // Thursday: 24 hours, fine
    ];
    const thread = restThreads({ ...base, shifts }, 'mar', TODAY, 7).find((t) => t.employeeId === e.id)!;
    expect(thread.minRest).toBe(11 * H);
    expect(thread.gaps.map((g) => [g.minutes, g.level])).toEqual([
      [10 * H, 'short'],
      [12 * H + 30, 'tight'],
      [24 * H, 'ok'],
    ]);
    expect(thread.shortest).toBe(10 * H);
    expect(thread.closeThenOpen).toBe(1);
    expect(thread.longestRun).toBe(4);
  });

  it('holds under 18s to 12 hours', () => {
    expect(restLevel(11.5 * H, 12 * H)).toBe('short');
    const base = state([]);
    const young: Employee = { ...person(base), id: 'young', dateOfBirth: '2010-01-01' };
    const shifts = [shift('young', WEEK[0], 12 * H, 20 * H), shift('young', WEEK[1], 7 * H + 30, 12 * H)];
    const thread = restThreads({ ...base, employees: [...base.employees, young], shifts }, 'mar', TODAY, 7).find((t) => t.employeeId === 'young')!;
    expect(thread.minRest).toBe(12 * H);
    expect(thread.gaps[0].level).toBe('short');
  });

  it('shows a split shift without judging it, and reads rest into the window from the day before', () => {
    const base = state([]);
    const e = person(base);
    const shifts = [
      shift(e.id, addDays(TODAY, -1), 14 * H, 23 * H),
      shift(e.id, WEEK[0], 8 * H, 12 * H),
      shift(e.id, WEEK[0], 17 * H, 22 * H),
    ];
    const thread = restThreads({ ...base, shifts }, 'mar', TODAY, 7).find((t) => t.employeeId === e.id)!;
    expect(thread.gaps.map((g) => [g.minutes, g.judged])).toEqual([
      [9 * H, true],
      [5 * H, false],
    ]);
    expect(thread.shortest).toBe(9 * H);
  });

  it('counts a run of days over the window edge', () => {
    const base = state([]);
    const e = person(base);
    const shifts = Array.from({ length: 9 }, (_, i) => shift(e.id, addDays(TODAY, i - 3), 12 * H, 18 * H));
    const thread = restThreads({ ...base, shifts }, 'mar', TODAY, 7).find((t) => t.employeeId === e.id)!;
    expect(thread.longestRun).toBe(9);
  });

  it('puts the shortest rest first', () => {
    const base = state([]);
    const [a, b] = base.employees.filter((e) => e.siteId === 'mar');
    const shifts = [
      shift(a.id, WEEK[0], 12 * H, 20 * H), shift(a.id, WEEK[1], 12 * H, 20 * H),
      shift(b.id, WEEK[0], 12 * H, 23 * H), shift(b.id, WEEK[1], 9 * H, 15 * H),
    ];
    expect(restThreads({ ...base, shifts }, 'mar', TODAY, 7)[0].employeeId).toBe(b.id);
  });
});

describe('station board', () => {
  it('lists who holds each position by hour and counts hours nobody is in a needed one', () => {
    const base = state([]);
    const e = person(base, 'bar');
    const board = stationBoard({ ...base, shifts: [shift(e.id, WEEK[4], 17 * H, 23 * H, { roleId: 'bar' })] }, 'mar', WEEK[4]);
    const bar = board.rows.find((r) => r.roleId === 'bar')!;
    expect(bar.cells.find((c) => c.hour === 18)!.people.map((p) => p.name)).toEqual([e.name]);
    expect(bar.cells.find((c) => c.hour === 12)!.people).toEqual([]);
    expect(bar.empty).toBeGreaterThan(0);
    const order = ['MGMT', 'FOH', 'BAR', 'BOH'];
    const depts = board.rows.map((r) => order.indexOf(r.department));
    expect(depts).toEqual([...depts].sort((x, y) => x - y));
  });

  it('carries a shift from the night before into the early hours', () => {
    const base = state([]);
    const e = person(base, 'bar', 'shd');
    const board = stationBoard({ ...base, shifts: [shift(e.id, WEEK[4], 20 * H, 26 * H, { roleId: 'bar', siteId: 'shd' })] }, 'shd', WEEK[5]);
    const bar = board.rows.find((r) => r.roleId === 'bar')!;
    expect(bar.cells.find((c) => c.hour === 1)?.people.map((p) => p.employeeId)).toEqual([e.id]);
  });
});

describe('gantt', () => {
  it('draws one line per person with their shifts as bars, in department order, with heads on by hour', () => {
    const base = state([]);
    const server = person(base);
    const chef = person(base, 'chef');
    const shifts = [
      shift(server.id, WEEK[0], 11 * H, 15 * H, { breakMinutes: 30, published: true }),
      shift(server.id, WEEK[2], 17 * H, 23 * H),
      shift(chef.id, WEEK[0], 10 * H, 22 * H, { roleId: 'chef' }),
    ];
    const g = ganttChart({ ...base, shifts }, 'mar', WEEK);
    const s = g.rows.find((r) => r.employeeId === server.id)!;
    expect(s.bars.map((b) => [b.day, b.startMinute, b.endMinute])).toEqual([[0, 11 * H, 15 * H], [2, 17 * H, 23 * H]]);
    expect(s.bars[0].published).toBe(true);
    expect(s.hours).toBe(9.5);
    expect(s.days).toBe(2);
    const order = ['MGMT', 'FOH', 'BAR', 'BOH'];
    const rostered = g.rows.filter((r) => r.hours > 0);
    expect(rostered.map((r) => order.indexOf(r.department))).toEqual(rostered.map((r) => order.indexOf(r.department)).sort((x, y) => x - y));
    // Those based here with nothing this week come last, so the idle are seen and not lost.
    expect(g.rows.findIndex((r) => r.hours === 0)).toBeGreaterThan(g.rows.findIndex((r) => r.employeeId === chef.id));
    expect(g.from).toBeLessThanOrEqual(10 * H);
    const monday = g.heads[0].hours;
    expect(monday.find((h) => h.hour === 12)!.on).toBe(2);
    expect(monday.find((h) => h.hour === 16)!.on).toBe(1);
    expect(monday.some((h) => h.required > 0)).toBe(true);
  });

  it('widens the lanes for a shift past midnight and greys shifts worked at another site', () => {
    const base = state([]);
    const e = person(base);
    const shifts = [shift(e.id, WEEK[4], 20 * H, 26 * H), shift(e.id, WEEK[5], 12 * H, 18 * H, { siteId: 'shd' })];
    const g = ganttChart({ ...base, shifts }, 'mar', WEEK);
    expect(g.to).toBeGreaterThanOrEqual(26 * H);
    const row = g.rows.find((r) => r.employeeId === e.id)!;
    expect(row.bars.map((b) => b.away)).toEqual([false, true]);
    expect(row.hours).toBe(6);
  });
});

describe('cost bricks', () => {
  it('lays each shift at its loaded cost and shows what runs past the day target', () => {
    const base = state([]);
    const e = person(base);
    const shifts = [shift(e.id, WEEK[0], 11 * H, 15 * H), shift(person(base, 'chef').id, WEEK[0], 10 * H, 22 * H, { roleId: 'chef' })];
    const s = { ...base, shifts };
    const cost = weekCost(s, TODAY, 'mar');
    const days = costBricks(s, cost, 'mar', WEEK);
    const monday = days[0];
    expect(monday.bricks.map((b) => b.employeeId)).toEqual([shifts[1].employeeId, e.id]);
    expect(monday.bricks[0].cost).toBe(cost.shifts.get(shifts[1].id)!.total);
    expect(monday.cost).toBeCloseTo(monday.unallocated + monday.bricks[0].cost + monday.bricks[1].cost, 6);
    // Only what is spent past the target counts as over it, and never more than the brick itself.
    const over = monday.bricks.reduce((a, b) => a + b.overTarget, 0);
    expect(over).toBeCloseTo(Math.max(0, monday.cost - Math.max(monday.target, monday.unallocated)), 6);
    for (const b of monday.bricks) expect(b.overTarget).toBeLessThanOrEqual(b.cost + 1e-9);
  });
});

describe('changes since published', () => {
  const s = state([]);
  const names = namesOf(s);
  it('sends a first week whole, a change as what was added and taken off, and tells someone taken off altogether', () => {
    const a = shift('a', WEEK[0], 12 * H, 18 * H);
    const b1 = shift('b', WEEK[1], 12 * H, 18 * H);
    const b2 = shift('b', WEEK[2], 12 * H, 18 * H);
    const c = shift('c', WEEK[3], 12 * H, 18 * H);
    const told = {
      b: weekLines([b1, { ...b2, startMinute: 10 * H }], names),
      c: weekLines([c], names),
      d: weekLines([shift('d', WEEK[4], 9 * H, 17 * H)], names),
    };
    const out = pendingNotices(told, [a, b1, b2, c], names);
    expect(out.find((x) => x.employeeId === 'a')).toMatchObject({ kind: 'first', added: weekLines([a], names), removed: [] });
    expect(out.find((x) => x.employeeId === 'b')).toMatchObject({ kind: 'changed', added: weekLines([b2], names) });
    expect(out.find((x) => x.employeeId === 'b')!.removed).toHaveLength(1);
    expect(out.find((x) => x.employeeId === 'c')).toBeUndefined();
    expect(out.find((x) => x.employeeId === 'd')).toMatchObject({ kind: 'removed', added: [] });
  });
});

describe('fairness ledger', () => {
  it('counts weekends, closes, late finishes and hours under contract over four weeks, and marks who carries them', () => {
    const base = state([]);
    const team = base.employees.filter((e) => e.siteId === 'mar' && e.payBasis === 'hourly' && e.status !== 'leaver').slice(0, 4);
    const [heavy, ...rest] = team;
    const weeks = [0, 1, 2, 3].map((w) => addDays(TODAY, -7 * (3 - w)));
    const shifts = weeks.flatMap((ws) => [
      // Every Saturday close falls to one person.
      shift(heavy.id, addDays(ws, 5), 15 * H, 23 * H),
      ...rest.map((e) => shift(e.id, addDays(ws, 1), 11 * H, 17 * H)),
    ]);
    const f = fairness({ ...base, shifts }, 'mar', TODAY);
    expect(f.weekStarts).toEqual(weeks);
    const row = f.rows.find((r) => r.employeeId === heavy.id)!;
    expect(row).toMatchObject({ weekends: 4, closes: 4, lates: 0 });
    expect(row.rostered).toBe(32);
    expect(f.outliers).toEqual(expect.arrayContaining([{ employeeId: heavy.id, measure: 'weekends', value: 4 }, { employeeId: heavy.id, measure: 'closes', value: 4 }]));
    const other = f.rows.find((r) => r.employeeId === rest[0].id)!;
    expect(other.cut).toBe(Math.max(0, rest[0].contractedHours - 6) * 4);
  });

  it('counts contracted hours only for weeks the site has a rota, so weeks before it used Preshift are not hours cut', () => {
    const base = state([]);
    const e = base.employees.find((x) => x.siteId === 'mar' && x.payBasis === 'hourly' && x.contractedHours > 0 && x.status !== 'leaver')!;
    const f = fairness({ ...base, shifts: [shift(e.id, addDays(TODAY, 1), 11 * H, 17 * H)] }, 'mar', TODAY);
    expect(f.rotaWeeks).toEqual([TODAY]);
    const row = f.rows.find((r) => r.employeeId === e.id)!;
    expect(row.contracted).toBe(e.contractedHours);
    expect(row.cut).toBe(Math.max(0, e.contractedHours - 6));
  });
});

describe('a person\'s fortnight', () => {
  const base = state([]);
  const e = person(base);
  it('totals hours and pay before tax, and the rest before each shift', () => {
    const before = shift(e.id, addDays(TODAY, -1), 16 * H, 23 * H);
    const shifts = [shift(e.id, TODAY, 9 * H, 17 * H, { breakMinutes: 30 }), shift(e.id, addDays(TODAY, 3), 12 * H, 20 * H)];
    const f = fortnight(e, shifts, TODAY, before);
    expect(f.paidHours).toBe(15.5);
    expect(f.estimatedPay).toBe(Math.round(15.5 * e.hourlyRate * 100) / 100);
    expect(f.restBefore[shifts[0].id]).toMatchObject({ minutes: 10 * H, level: 'short' });
    expect(f.restBefore[shifts[1].id]).toMatchObject({ minutes: 3 * 24 * H - 5 * H, level: 'ok' });
    expect(f.shortestRest).toBe(10 * H);
    expect(f.daysOff).toBe(12);
  });

  it('shows no pay estimate for salaried staff', () => {
    expect(fortnight({ ...e, payBasis: 'salaried' }, [], TODAY).estimatedPay).toBeNull();
  });

  it('works out what taking a shift does to the week and the rest around it', () => {
    const own = [shift(e.id, WEEK[0], 12 * H, 23 * H), shift(e.id, WEEK[2], 12 * H, 18 * H)];
    const slot = shift(e.id, WEEK[1], 10 * H, 16 * H);
    expect(shiftEffect(e, own, slot)).toEqual({ weekHours: 23, shortestRest: 11 * H, minRest: 11 * H });
  });
});
