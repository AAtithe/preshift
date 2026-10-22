import { describe, expect, it } from 'vitest';
import { loadedHourlyRate } from './actuals';
import { replacementCost, RETENTION_ASSUMPTIONS, retentionScores, type SignalId } from './retention';
import { seedDemo } from './simulate';
import { addDays, weekDates } from './time';
import type { ClockRecord, Employee, RotaState, Shift } from './types';

const WEEK = '2026-10-19'; // a Monday: asOf, so the three weeks before it are read
const H = 60;

const person = (id: string, over: Partial<Employee> = {}): Employee => ({
  id,
  name: id,
  siteId: 'mar',
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
  startedOn: '2023-01-01',
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

const clocked = (s: Shift, over: Partial<ClockRecord> = {}): ClockRecord => ({
  id: `c-${s.id}`,
  employeeId: s.employeeId,
  siteId: 'mar',
  roleId: s.roleId,
  shiftId: s.id,
  date: s.date,
  clockIn: s.startMinute,
  clockOut: s.endMinute,
  breakMinutes: s.breakMinutes,
  source: 'geofence',
  ...over,
});

const state = (employees: Employee[], shifts: Shift[], clocks = shifts.map((s) => clocked(s))): RotaState => ({
  sites: [{ id: 'mar', name: 'Marylebone', labourTargetPct: 0.28, trackingCode: 'Marylebone', openMinute: 11 * H, closeMinute: 23 * H }],
  roles: [{ id: 'server', name: 'Server', department: 'FOH', nominalCode: '7000' }],
  employees,
  shifts,
  forecast: [],
  demandRules: [],
  clocks,
  actuals: [],
  tips: [],
  troncSchemes: [],
});

/** Lunch shifts, 12:00 to 17:00, on the first `days` days of each of the three weeks before WEEK. */
const pattern = (id: string, daysPerWeek: number[]) =>
  daysPerWeek.flatMap((days, i) => weekDates(addDays(WEEK, -7 * (3 - i))).slice(0, days).map((d) => shift(id, d, 12, 17)));

const signals = (st: RotaState, id = 'a') => retentionScores(st, 'mar', WEEK).scores.find((s) => s.employeeId === id)?.signals.map((x) => x.id) ?? [];

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
    const r = retentionScores(state([person('a')], pattern('a', [4, 4, 4])), 'mar', WEEK);
    expect(r.scores[0]).toMatchObject({ band: 'low', score: 0 });
  });

  it('flags new starters, most of all in the first month', () => {
    const fresh = retentionScores(state([person('a', { startedOn: addDays(WEEK, -10) })], pattern('a', [0, 0, 3])), 'mar', WEEK);
    expect(fresh.scores[0].signals[0]).toMatchObject({ id: 'new-starter', points: 25 });
    const settling = retentionScores(state([person('a', { startedOn: addDays(WEEK, -60) })], pattern('a', [3, 3, 3])), 'mar', WEEK);
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
    const by = Object.fromEntries(retentionScores(st, 'mar', WEEK).scores.map((s) => [s.employeeId, s]));
    expect(by.y.signals.map((s) => s.id)).toEqual(['pay-floor']);
    expect(by.y.score).toBe(by.o.score);
  });

  it('does not count the minimum against someone still in their first six months', () => {
    const st = state([person('a', { hourlyRate: 12.71, startedOn: addDays(WEEK, -120) })], pattern('a', [4, 4, 4]));
    expect(signals(st)).not.toContain('pay-floor');
  });
});

describe('summary and demo', () => {
  const demo = seedDemo('2026-10-21');
  const r = retentionScores(demo, 'mar', '2026-10-21');

  it('puts the regular whose hours were cut at the top', () => {
    expect(r.weeksRead).toBe(3);
    const top = r.scores[0];
    expect(top.band).toBe('high');
    expect(top.signals.map((s) => s.id)).toContain('hours-drop');
    expect(r.costAtRisk).toBeCloseTo(r.scores.filter((s) => s.band === 'high').reduce((sum, s) => sum + s.replacementCost, 0), 2);
  });

  it('shows how much of the risk the rota is driving', () => {
    expect(r.rotaShare).toBeGreaterThan(0.5);
    expect(r.drivers[0].points).toBeGreaterThanOrEqual(r.drivers[r.drivers.length - 1].points);
  });
});
