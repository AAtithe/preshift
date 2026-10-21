import { describe, expect, it } from 'vitest';
import { autoScheduleSites } from './autoschedule';
import { rotaJournal } from './journal';
import { scopeMetrics } from './metrics';
import { labourByRole, labourTrend, rotaVsActual } from './reports';
import { seedState } from './seed';
import { addDays } from './time';
import type { Shift, TimeEntry } from './types';

const WEEK = '2026-10-19'; // a Monday
const all = ['mar', 'fitz', 'shd'];
const base = seedState('2026-10-21');
const built = { ...base, shifts: autoScheduleSites(base, all, WEEK).shifts };

describe('labour trend', () => {
  it('runs oldest first and each week matches the KPI bar for that week', () => {
    const trend = labourTrend(built, all, WEEK, 4);
    expect(trend.map((w) => w.weekStart)).toEqual([addDays(WEEK, -21), addDays(WEEK, -14), addDays(WEEK, -7), WEEK]);
    expect(trend[3].metrics.labourCost).toBeCloseTo(scopeMetrics(built, all, WEEK).labourCost, 2);
  });
});

describe('labour by role', () => {
  const report = labourByRole(built, all, WEEK);

  it('adds up to the scope labour cost the KPI bar shows', () => {
    expect(report.total).toBeCloseTo(scopeMetrics(built, all, WEEK).labourCost, 0);
    expect(report.departments.reduce((s, d) => s + d.total, 0)).toBeCloseTo(report.total, 1);
    for (const d of report.departments) expect(d.gross + d.holiday + d.employerNi + d.pension).toBeCloseTo(d.total, 0);
  });

  it('ties each wages nominal to the accrual journal', () => {
    const journal = rotaJournal(built, WEEK);
    const nominal = (code: string) => journal.filter((l) => l.accountCode === code).reduce((s, l) => s + l.amount, 0);
    const grossFor = (code: string) =>
      report.departments.flatMap((d) => d.roles).filter((r) => built.roles.find((x) => x.id === r.roleId)?.nominalCode === code).reduce((s, r) => s + r.gross, 0);
    for (const code of ['7000', '7001', '7002', '7003']) expect(grossFor(code)).toBeCloseTo(nominal(code), 0);
  });

  it('puts salaried pay with no shifts in the person’s primary role', () => {
    const empty = labourByRole({ ...base, shifts: [] }, ['mar'], WEEK);
    const unrostered = empty.departments.flatMap((d) => d.roles).reduce((s, r) => s + r.unrostered, 0);
    expect(unrostered).toBeCloseTo(empty.total, 2);
    expect(empty.paidHours).toBe(0);
  });
});

describe('rota vs actual', () => {
  const today = addDays(WEEK, 6);
  const marShifts = built.shifts.filter((s) => s.siteId === 'mar');
  const entry = (s: Shift, over: Partial<TimeEntry> = {}): TimeEntry => ({
    id: `te-${s.id}`,
    employeeId: s.employeeId,
    siteId: s.siteId,
    roleId: s.roleId,
    shiftId: s.id,
    date: s.date,
    clockIn: s.startMinute,
    clockOut: s.endMinute,
    breakMinutes: s.breakMinutes,
    status: 'approved',
    source: 'clock',
    ...over,
  });

  it('shows no variance when the floor worked the rota exactly, and the rota side is the KPI bar', () => {
    // Every site is clocked: people who also cover elsewhere keep their true on-costs.
    const r = rotaVsActual(built, built.shifts.map((s) => entry(s)), ['mar'], WEEK, today);
    expect(r.costVariance).toBeCloseTo(0, 1);
    expect(r.rotaCost).toBeCloseTo(scopeMetrics(built, ['mar'], WEEK).labourCost, 0);
    expect(r.people.every((p) => p.noShows === 0 && p.unrostered === 0)).toBe(true);
  });

  it('prices overrun as loaded cost and flags no-shows', () => {
    const [late, ...rest] = marShifts;
    const missing = rest.find((s) => s.employeeId !== late.employeeId)!;
    const entries = built.shifts.filter((s) => s.id !== missing.id).map((s) => (s.id === late.id ? entry(s, { clockOut: s.endMinute + 60 }) : entry(s)));
    const r = rotaVsActual(built, entries, ['mar'], WEEK, today);
    const p = r.people.find((x) => x.employeeId === late.employeeId)!;
    expect(p.hoursVariance).toBeCloseTo(1, 2);
    expect(r.people.find((x) => x.employeeId === missing.employeeId)!.noShows).toBeGreaterThan(0);
    // Each person's figures add up to the site's, so the report reconciles top to bottom.
    expect(r.people.reduce((s, x) => s + x.costVariance, 0)).toBeCloseTo(r.costVariance, 0);
  });

  it('keeps the rota for days not yet worked and for people still clocked in', () => {
    const monday = marShifts.find((s) => s.date === WEEK)!;
    const r = rotaVsActual(built, [entry(monday, { clockOut: undefined, status: 'open' })], ['mar'], WEEK, WEEK);
    expect(r.workedTo).toBe(WEEK);
    expect(r.stillOpen).toBe(1);
    // Nothing has closed yet, so the estimate is still the rota.
    expect(r.costVariance).toBeCloseTo(0, 1);
    expect(r.people.every((p) => p.noShows === 0)).toBe(true);
    const rostered = marShifts.filter((s) => s.date === WEEK);
    expect(r.people.reduce((s, p) => s + p.rosteredHours, 0)).toBeCloseTo(
      rostered.reduce((s, x) => s + (x.endMinute - x.startMinute - x.breakMinutes) / 60, 0),
      1,
    );
  });

  it('drops a past shift nobody clocked from the estimate', () => {
    const monday = marShifts.find((s) => s.date === WEEK && built.employees.find((e) => e.id === s.employeeId)?.payBasis === 'hourly')!;
    const entries = marShifts.filter((s) => s.id !== monday.id && s.date === WEEK).map((s) => entry(s));
    const r = rotaVsActual(built, entries, ['mar'], WEEK, addDays(WEEK, 1));
    expect(r.costVariance).toBeLessThan(0);
  });
});
