import { describe, expect, it } from 'vitest';
import { loadedHourlyRate } from './actuals';
import { replacementCost, RETENTION_ASSUMPTIONS, retentionScores, type SignalId } from './retention';
import { addDays, weekDates } from './time';
import type { Employee, RotaState, Shift, TimeEntry } from './types';

const WEEK = '2026-10-19'; // a Monday: asOf, so the three weeks before it are read
const H = 60;

const person = (id: string, over: Partial<Employee> = {}): Employee => ({
  id,
  name: id,
  siteId: 'mar',
  entityId: 'co',
  coverSiteIds: [],
  roleIds: ['server'],
  payBasis: 'hourly',
  hourlyRate: 14,
  annualSalary: 0,
  dateOfBirth: '1995-01-01',
  contractedHours: 0,
  maxWeeklyHours: 60,
  optedOutOf48: false,
  irregularHours: true,
  pensionEnrolled: true,
  availability: [],
  leave: [],
  startDate: '2023-01-01',
  ...over,
});

let n = 0;
const shift = (employeeId: string, date: string, start: number, end: number, brk = 0): Shift => ({
  id: `s${n++}`,
  employeeId,
  roleId: 'server',
  siteId: 'mar',
  date,
  startMinute: start * H,
  endMinute: end * H,
  breakMinutes: brk,
});

const clocked = (s: Shift, over: Partial<TimeEntry> = {}): TimeEntry => ({
  id: `c-${s.id}`,
  employeeId: s.employeeId,
  siteId: 'mar',
  roleId: s.roleId,
  shiftId: s.id,
  date: s.date,
  clockIn: s.startMinute,
  clockOut: s.endMinute,
  breakMinutes: s.breakMinutes,
  status: 'submitted',
  source: 'clock',
  ...over,
});

/** The organisation's state with its clockings alongside, as the screens hold them. */
type St = RotaState & { clocks: TimeEntry[] };

const state = (employees: Employee[], shifts: Shift[], clocks = shifts.map((s) => clocked(s))): St => ({
  entities: [{ id: 'co', name: 'Co Ltd', companyNumber: '1', payeReference: '1/A', intercompanyCode: '1990' }],
  sites: [{ id: 'mar', name: 'Marylebone', entityId: 'co', labourTargetPct: 0.28, trackingCode: 'Marylebone', openMinute: 11 * H, closeMinute: 23 * H }],
  roles: [{ id: 'server', name: 'Server', department: 'FOH', nominalCode: '7000' }],
  employees,
  shifts,
  forecast: [],
  demandRules: [],
  clocks,
});

const score = (st: St, siteId: string, asOf: string) => retentionScores(st, st.clocks, siteId, asOf);

/** Lunch shifts, 12:00 to 17:00, on the first `days` days of each of the three weeks before WEEK. */
const pattern = (id: string, daysPerWeek: number[]) =>
  daysPerWeek.flatMap((days, i) => weekDates(addDays(WEEK, -7 * (3 - i))).slice(0, days).map((d) => shift(id, d, 12, 17)));

const signals = (st: St, id = 'a') => score(st, 'mar', WEEK).scores.find((s) => s.employeeId === id)?.signals.map((x) => x.id) ?? [];

describe('replacement cost', () => {
  it('adds recruitment, paid shadow shifts for starter and trainer, and lost output while ramping up', () => {
    const e = person('a');
    const rate = loadedHourlyRate(e);
    const a = RETENTION_ASSUMPTIONS;
    expect(replacementCost(e, 'FOH', 30)).toBeCloseTo(a.recruitment.FOH + a.shadowHours.FOH * rate * 2 + a.rampWeeks * 30 * rate * a.rampLoss, 2);
  });
});

describe('signals', () => {
  it('reads a steady regular as low risk', () => {
    const r = score(state([person('a')], pattern('a', [4, 4, 4])), 'mar', WEEK);
    expect(r.scores[0]).toMatchObject({ band: 'low', score: 0 });
  });

  it('flags new starters, most of all in the first month', () => {
    const fresh = score(state([person('a', { startDate: addDays(WEEK, -10) })], pattern('a', [0, 0, 3])), 'mar', WEEK);
    expect(fresh.scores[0].signals[0]).toMatchObject({ id: 'new-starter', points: 25 });
    const settling = score(state([person('a', { startDate: addDays(WEEK, -60) })], pattern('a', [3, 3, 3])), 'mar', WEEK);
    expect(settling.scores[0].signals[0]).toMatchObject({ id: 'new-starter', points: 20 });
  });

  it('flags hours that collapse and swing', () => {
    expect(signals(state([person('a')], pattern('a', [6, 6, 1])))).toEqual(expect.arrayContaining<SignalId>(['hours-drop', 'volatile-hours']));
  });

  it('flags being sent home early repeatedly', () => {
    const shifts = pattern('a', [4, 4, 4]);
    const clocks = shifts.map((s, i) => clocked(s, i % 5 === 0 ? { clockOut: s.endMinute - 2 * H } : {}));
    expect(signals(state([person('a')], shifts, clocks))).toContain('sent-home');
  });

  it('never reads a salaried manager leaving early as being sent home', () => {
    const shifts = pattern('a', [4, 4, 4]);
    const clocks = shifts.map((s, i) => clocked(s, i % 5 === 0 ? { clockOut: s.endMinute - 2 * H } : {}));
    const manager = person('a', { payBasis: 'salaried', annualSalary: 45_000, hourlyRate: 0 });
    expect(signals(state([manager], shifts, clocks))).not.toContain('sent-home');
  });

  it('flags overwork, short rest and missed breaks', () => {
    const long = [0, 1, 2].flatMap((w) =>
      weekDates(addDays(WEEK, -7 * (3 - w))).slice(0, 5).map((d, i) => (i === 1 ? shift('a', d, 7, 18, 30) : shift('a', d, 13, 24, 0))),
    );
    expect(signals(state([person('a')], long))).toEqual(expect.arrayContaining<SignalId>(['overwork', 'short-rest', 'missed-breaks']));
  });

  it('flags someone carrying the closes for the team', () => {
    const closer = [0, 1, 2].flatMap((w) => weekDates(addDays(WEEK, -7 * (3 - w))).slice(0, 4).map((d) => shift('a', d, 18, 23)));
    const lunches = ['b', 'c', 'd'].flatMap((id) => pattern(id, [4, 4, 4]));
    expect(signals(state(['a', 'b', 'c', 'd'].map((id) => person(id)), [...closer, ...lunches]))).toContain('close-load');
  });
});

describe('fairness', () => {
  it('treats being on the legal minimum the same at any age band', () => {
    const young = person('y', { dateOfBirth: '2006-01-01', hourlyRate: 10.85 });
    const older = person('o', { dateOfBirth: '1990-01-01', hourlyRate: 12.71 });
    const st = state([young, older], [...pattern('y', [4, 4, 4]), ...pattern('o', [4, 4, 4])]);
    const by = Object.fromEntries(score(st, 'mar', WEEK).scores.map((s) => [s.employeeId, s]));
    expect(by.y.signals.map((s) => s.id)).toEqual(['pay-floor']);
    expect(by.y.score).toBe(by.o.score);
  });

  it('does not count the minimum against someone still in their first six months', () => {
    const st = state([person('a', { hourlyRate: 12.71, startDate: addDays(WEEK, -120) })], pattern('a', [4, 4, 4]));
    expect(signals(st)).not.toContain('pay-floor');
  });
});

describe('summary', () => {
  // A regular whose hours were cut from 30 to 5 last week, and a steady colleague.
  const st = state([person('a', { startDate: addDays(WEEK, -10) }), person('b')], [...pattern('a', [6, 6, 1]), ...pattern('b', [4, 4, 4])]);
  const r = score(st, 'mar', WEEK);

  it('puts the person whose hours collapsed at the top and prices the high band', () => {
    expect(r.weeksRead).toBe(3);
    expect(r.scores[0]).toMatchObject({ employeeId: 'a', band: 'high' });
    expect(r.costAtRisk).toBeCloseTo(r.scores.filter((s) => s.band === 'high').reduce((sum, s) => sum + s.replacementCost, 0), 2);
  });

  it('shows how much of the risk the rota is driving', () => {
    expect(r.rotaShare).toBeGreaterThan(0.5);
    expect(r.drivers[0].points).toBeGreaterThanOrEqual(r.drivers[r.drivers.length - 1].points);
  });

  it('leaves leavers out', () => {
    const left = { ...st, employees: st.employees.map((e) => (e.id === 'a' ? { ...e, status: 'leaver' as const } : e)) };
    expect(score(left, 'mar', WEEK).scores.map((s) => s.employeeId)).not.toContain('a');
  });
});
