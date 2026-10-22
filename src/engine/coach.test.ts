import { describe, expect, it } from 'vitest';
import { moveIssues, realisedSaving, recordOf, weeklyMoves } from './coach';
import { checkWeek } from './compliance';
import { weekCost } from './cost';
import { addDays } from './time';
import type { Employee, HourForecast, RotaState, Shift, TimeEntry } from './types';

const WEEK = '2026-10-19';
const TUE = addDays(WEEK, 1);

const person = (id: string, rate: number, over: Partial<Employee> = {}): Employee => ({
  id,
  name: `${id[0].toUpperCase()}${id.slice(1)} Test`,
  siteId: 'mar',
  entityId: 'wdl',
  coverSiteIds: [],
  roleIds: ['server'],
  payBasis: 'hourly',
  hourlyRate: rate,
  annualSalary: 0,
  dateOfBirth: '1995-01-01',
  contractedHours: 0,
  maxWeeklyHours: 48,
  optedOutOf48: false,
  irregularHours: true,
  pensionEnrolled: true,
  availability: [],
  leave: [],
  ...over,
});

const shift = (id: string, employeeId: string, start: number, end: number, date = TUE): Shift => ({
  id,
  employeeId,
  roleId: 'server',
  siteId: 'mar',
  date,
  startMinute: start * 60,
  endMinute: end * 60,
  breakMinutes: end - start > 6 ? 20 : 0,
});

/** One server needed all day, two from 18:00 to 21:00. */
function state(employees: Employee[], shifts: Shift[]): RotaState {
  const forecast: HourForecast[] = [];
  for (let hour = 11; hour < 23; hour++) {
    const covers = hour >= 18 && hour < 21 ? 20 : 8;
    forecast.push({ siteId: 'mar', date: TUE, hour, sales: covers * 40, covers });
  }
  return {
    entities: [{ id: 'wdl', name: 'West End Dining Ltd', companyNumber: '1', payeReference: '1', intercompanyCode: '1351' }],
    sites: [{ id: 'mar', name: 'Marylebone', entityId: 'wdl', labourTargetPct: 0.28, trackingCode: 'Marylebone', openMinute: 11 * 60, closeMinute: 23 * 60 }],
    roles: [{ id: 'server', name: 'Server', department: 'FOH', nominalCode: '7000' }],
    employees,
    shifts,
    forecast,
    demandRules: [{ siteId: 'mar', roleId: 'server', coversPerHour: 10, minimumWhileOpen: 1, maximum: 4 }],
  };
}

describe('weekly moves', () => {
  it('trims the overstaffed edge, priced at the marginal cost, and leaves the floor covered', () => {
    // Ann covers the day; Ben is on 15:00 to 23:00 but is only needed 18:00 to 21:00.
    const s = state([person('ann', 13), person('ben', 14)], [shift('a', 'ann', 11, 23), shift('b', 'ben', 15, 23)]);
    const result = weeklyMoves(s, 'mar', WEEK);
    expect(result.moves.length).toBeGreaterThan(0);
    const first = result.moves[0];
    expect(first.shiftId).toBe('b');
    // The saving is the drop in the whole week's loaded cost (weekCost rounds each shift, so allow pennies).
    const after = { ...s, shifts: s.shifts.map((x) => (x.id === 'b' ? first.after! : x)) };
    expect(first.saving).toBeCloseTo(weekCost(s, WEEK).total - weekCost(after, WEEK).total, 0);
    expect(first.labourPctAfter).toBeLessThan(first.labourPctBefore);
    expect(first.title).toMatch(/^Tuesday .* over demand on server\. (Start|End) Ben at \d\d:00, save £\d+, labour \d+\.\d%\.$/);
    // No hour is left short after all the moves.
    const final = result.moves.reduce((st, m) => ({ ...st, shifts: st.shifts.map((x) => (x.id === m.shiftId ? m.after! : x)) }), s);
    expect(checkWeek(final, WEEK, 'mar').filter((i) => i.severity === 'block')).toEqual([]);
    expect(result.labourPctAfter).toBeLessThan(result.labourPctBefore);
    expect(new Set(result.moves.map((m) => m.shiftId)).size).toBe(result.moves.length);
  });

  it('takes a shift off when every hour of it is over demand', () => {
    const s = state([person('ann', 13), person('ben', 14)], [shift('a', 'ann', 11, 23), shift('b', 'ben', 12, 16)]);
    const [move] = weeklyMoves(s, 'mar', WEEK).moves;
    expect(move).toMatchObject({ kind: 'drop', shiftId: 'b', after: null });
    expect(move.title).toContain("Take it off");
  });

  it('offers a cheaper trained person who is free, but never someone who would break a rule', () => {
    const s = state(
      [person('ann', 16), person('cat', 12.71), person('dan', 12.71, { leave: [TUE] })],
      [shift('a', 'ann', 11, 23)],
    );
    const moves = weeklyMoves(s, 'mar', WEEK).moves;
    expect(moves[0]).toMatchObject({ kind: 'swap', after: expect.objectContaining({ employeeId: 'cat' }) });
    expect(moves.some((m) => m.after?.employeeId === 'dan')).toBe(false);
  });

  it('refuses a swap that would cut the new person’s rest or push them past their maximum', () => {
    // Cat closes Monday at 23:00, so a Tuesday 11:00 start leaves her 12h: fine. Eve closes at 02:00 Tuesday: 9h rest.
    const mon = WEEK;
    const s = state(
      // Both are on 8 guaranteed hours, so their Monday shifts cost the same worked or not and stay put.
      [person('ann', 16), person('cat', 12.71, { maxWeeklyHours: 10, contractedHours: 8 }), person('eve', 12.71, { contractedHours: 8 })],
      [shift('a', 'ann', 11, 23), shift('c', 'cat', 15, 23, mon), shift('e', 'eve', 18, 26, mon)],
    );
    const moves = weeklyMoves(s, 'mar', WEEK).moves.filter((m) => m.kind === 'swap');
    expect(moves.some((m) => m.after?.employeeId === 'eve')).toBe(false); // daily rest lands on the Tuesday shift
    expect(moves.some((m) => m.after?.employeeId === 'cat')).toBe(false); // 8h + 11.7h is over her 10h maximum
  });

  it('re-checks a move when it is taken, against shifts added since it was offered', () => {
    const s = state([person('ann', 16), person('cat', 12.71)], [shift('a', 'ann', 11, 23)]);
    const swap = weeklyMoves(s, 'mar', WEEK).moves.find((m) => m.kind === 'swap')!;
    expect(moveIssues(s, swap.kind, swap.before, swap.after, WEEK)).toEqual([]);
    // Cat has since been given a Tuesday shift elsewhere: taking the swap now would double-book her.
    const later = { ...s, shifts: [...s.shifts, { ...shift('c', 'cat', 12, 16), siteId: 'mar' }] };
    expect(moveIssues(later, swap.kind, swap.before, swap.after, WEEK).map((i) => i.code)).toContain('double-booked');
  });

  it('trims a shift that runs past midnight against the next day’s demand', () => {
    // Shoreditch-style late finish: Ben 18:00 to 01:00, with nothing forecast after 23:00.
    const s = state([person('ann', 13), person('ben', 14)], [shift('a', 'ann', 11, 23), shift('b', 'ben', 18, 25)]);
    const move = weeklyMoves(s, 'mar', WEEK).moves.find((m) => m.shiftId === 'b' && m.kind === 'trim-end');
    expect(move?.after?.endMinute).toBe(21 * 60);
  });

  it('offers nothing where the saving is not real: guaranteed hours are paid either way', () => {
    const s = state([person('ann', 13), person('ben', 14, { contractedHours: 40 })], [shift('a', 'ann', 11, 23), shift('b', 'ben', 12, 16)]);
    expect(weeklyMoves(s, 'mar', WEEK).moves.filter((m) => m.shiftId === 'b')).toEqual([]);
  });

  it('leaves days already worked alone', () => {
    const s = state([person('ann', 13), person('ben', 14)], [shift('a', 'ann', 11, 23), shift('b', 'ben', 12, 16)]);
    expect(weeklyMoves(s, 'mar', WEEK, { today: addDays(TUE, 1) }).moves).toEqual([]);
  });
});

describe('realised saving', () => {
  const s = state([person('ann', 13), person('ben', 14)], [shift('a', 'ann', 11, 23), shift('b', 'ben', 15, 23)]);
  const move = weeklyMoves(s, 'mar', WEEK).moves.find((m) => m.shiftId === 'b')!;
  const record = { ...recordOf(move, '2026-10-17T09:00:00Z'), status: 'taken' as const };
  const entry = (employeeId: string, from: number, to: number, shiftId?: string): TimeEntry => ({
    id: `${employeeId}${from}`,
    employeeId,
    siteId: 'mar',
    roleId: 'server',
    shiftId,
    date: TUE,
    clockIn: from,
    clockOut: to,
    breakMinutes: to - from > 360 ? 20 : 0,
    status: 'approved',
    source: 'clock',
  });

  it('is unknown until the day has approved time', () => {
    expect(realisedSaving(record, s.employees, [])).toBeNull();
  });

  it('matches the promise when the new times were worked', () => {
    const worked = [entry('ann', 660, 1380, 'a'), entry('ben', move.after!.startMinute, move.after!.endMinute, 'b')];
    expect(realisedSaving(record, s.employees, worked)).toBeCloseTo(move.saving, 1);
  });

  it('is nothing when they stayed to the old finish anyway', () => {
    const worked = [entry('ann', 660, 1380, 'a'), entry('ben', 900, 1380, 'b')];
    expect(realisedSaving(record, s.employees, worked)).toBeCloseTo(0, 1);
  });

  it('waits for the week to end and for every entry to be approved', () => {
    const worked = [entry('ann', 660, 1380, 'a'), entry('ben', move.after!.startMinute, move.after!.endMinute, 'b')];
    expect(realisedSaving(record, s.employees, worked, TUE)).toBeNull();
    const pending = [...worked, { ...entry('ben', 600, 900), date: addDays(TUE, 1), status: 'submitted' as const }];
    expect(realisedSaving(record, s.employees, pending)).toBeNull();
  });

  it('does not count lateness on the rest of the shift as part of the move', () => {
    // Lateness or leaving early on the edge the move did not touch.
    const late = move.kind === 'trim-start'
      ? entry('ben', move.after!.startMinute, move.after!.endMinute - 15, 'b')
      : entry('ben', move.after!.startMinute + 15, move.after!.endMinute, 'b');
    const worked = [entry('ann', 660, 1380, 'a'), late];
    // Within pennies: NI and pension bands make the marginal hour a little cheaper on a shorter week.
    expect(Math.abs(realisedSaving(record, s.employees, worked)! - move.saving)).toBeLessThan(1);
  });

  it('counts unlinked time in the original window against the move', () => {
    const worked = [entry('ann', 660, 1380, 'a'), entry('ben', 900, 1380)];
    expect(realisedSaving(record, s.employees, worked)).toBeCloseTo(0, 1);
  });
});
