import { describe, expect, it } from 'vitest';
import { autoScheduleSites } from './autoschedule';
import { rotaJournal } from './journal';
import { scopeMetrics } from './metrics';
import { accrualAccuracy, labourByRole, latestShifts, parseCoversCsv, parseTakingsCsv, performanceTrend, rotaVsActual, salesEstimate, type PayRunSummary } from './reports';
import { seedState } from './seed';
import { addDays } from './time';
import type { Shift, TimeEntry } from './types';

const WEEK = '2026-10-19'; // a Monday
const all = ['mar', 'fitz', 'shd'];
const base = seedState('2026-10-21');
const built = { ...base, shifts: autoScheduleSites(base, all, WEEK).shifts };

describe('takings', () => {
  it('uses the till where it has a figure and the forecast for the rest', () => {
    const dates = Array.from({ length: 7 }, (_, i) => addDays(WEEK, i));
    const e = salesEstimate(base, 'mar', dates);
    // Seeded takings run to the day before 21 October: Monday and Tuesday.
    expect(e.actualDays).toBe(2);
    const rung = (base.sales ?? []).filter((x) => x.siteId === 'mar' && dates.includes(x.date)).reduce((t, x) => t + x.netSales, 0);
    const forecastRest = base.forecast.filter((f) => f.siteId === 'mar' && f.date >= addDays(WEEK, 2) && f.date <= addDays(WEEK, 6)).reduce((t, f) => t + f.sales, 0);
    expect(e.estimate).toBeCloseTo(rung + forecastRest, 2);
  });
});

describe('performance trend', () => {
  it('runs oldest first, and with no clocking its labour is the rota the KPI bar shows', () => {
    const trend = performanceTrend(built, [], all, WEEK, 4, '2026-10-21');
    expect(trend.map((w) => w.weekStart)).toEqual([addDays(WEEK, -21), addDays(WEEK, -14), addDays(WEEK, -7), WEEK]);
    expect(trend[3].labour).toBeCloseTo(scopeMetrics(built, all, WEEK).labourCost, 0);
    expect(trend[3].labourBasis).toBe('rota');
  });

  it('flexes the target with takings', () => {
    const lower = { ...built, sales: built.forecast.filter((f) => f.date >= WEEK && f.date <= addDays(WEEK, 6)).reduce((acc, f) => {
      const row = acc.find((r) => r.siteId === f.siteId && r.date === f.date);
      if (row) row.netSales += f.sales * 0.8;
      else acc.push({ siteId: f.siteId, date: f.date, netSales: f.sales * 0.8, source: 'manual' as const });
      return acc;
    }, [] as NonNullable<typeof built.sales>) };
    const [at] = performanceTrend({ ...built, sales: [] }, [], ['mar'], WEEK, 1, addDays(WEEK, 7)).slice(-1);
    const [down] = performanceTrend(lower, [], ['mar'], WEEK, 1, addDays(WEEK, 7)).slice(-1);
    expect(down.sales).toBeCloseTo(at.forecastSales * 0.8, 0);
    expect(down.targetCost).toBeCloseTo(at.targetCost * 0.8, 0);
    expect(down.labourPct).toBeGreaterThan(at.labourPct);
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

describe('latest estimate', () => {
  it('keeps the rota for a site that does not clock', () => {
    const mar = built.shifts.find((s) => s.siteId === 'mar' && s.date === WEEK)!;
    const entries: TimeEntry[] = [{ id: 't1', employeeId: mar.employeeId, siteId: 'mar', roleId: mar.roleId, date: WEEK, clockIn: mar.startMinute, clockOut: mar.endMinute, breakMinutes: mar.breakMinutes, status: 'approved', source: 'clock' }];
    const latest = latestShifts(built, entries, WEEK, addDays(WEEK, 3));
    const fitzRota = built.shifts.filter((s) => s.siteId === 'fitz' && s.date >= WEEK && s.date <= addDays(WEEK, 6));
    expect(latest.filter((s) => s.siteId === 'fitz')).toEqual(fitzRota);
    // Marylebone clocks, so its past days are the clock only.
    expect(latest.filter((s) => s.siteId === 'mar' && s.date < addDays(WEEK, 3))).toHaveLength(1);
  });
});

describe('rota vs actual across sites', () => {
  it('does not flag people at a site that does not clock', () => {
    const mar = built.shifts.find((s) => s.siteId === 'mar' && s.date === WEEK)!;
    const entries: TimeEntry[] = [{ id: 't1', employeeId: mar.employeeId, siteId: 'mar', roleId: mar.roleId, date: WEEK, clockIn: mar.startMinute, clockOut: mar.endMinute, breakMinutes: mar.breakMinutes, status: 'approved', source: 'clock' }];
    const r = rotaVsActual(built, entries, all, WEEK, addDays(WEEK, 3));
    expect(r.unclockedSiteIds).toEqual(['fitz', 'shd']);
    const fitzPeople = new Set(built.shifts.filter((s) => s.siteId === 'fitz').map((s) => s.employeeId));
    const marPeople = new Set(built.shifts.filter((s) => s.siteId === 'mar').map((s) => s.employeeId));
    for (const p of r.people.filter((x) => fitzPeople.has(x.employeeId) && !marPeople.has(x.employeeId))) {
      expect(p.noShows).toBe(0);
      expect(p.rosteredHours).toBe(0);
    }
    // Fitzrovia's hours are its rota. Its cost can still move a little: someone who also works at
    // Marylebone and missed shifts there earns less in the week, so less employer NI falls on Fitzrovia.
    const fitz = r.sites.find((s) => s.siteId === 'fitz')!;
    expect(Math.abs(fitz.costVariance)).toBeLessThan(fitz.rotaCost * 0.002);
  });
});

describe('accrual accuracy', () => {
  const run = (id: string, periodStart: string, accrued: number, actual: number, lines: [string, number][] = []): PayRunSummary => ({
    id,
    entityId: 'wdl',
    periodStart,
    periodEnd: addDays(periodStart, 6),
    variance: {
      accrued,
      actual,
      variance: actual - accrued,
      variancePct: (actual - accrued) / accrued,
      lines: lines.map(([employeeId, variance]) => ({ employeeId, accrued: 0, actual: variance, variance })),
    },
  });

  it('counts runs inside tolerance and does not let misses cancel out', () => {
    const r = accrualAccuracy([run('b', '2026-10-12', 10000, 9800), run('a', '2026-10-05', 10000, 10050)]);
    expect(r.runs.map((x) => x.id)).toEqual(['a', 'b']);
    expect(r.within).toBe(1);
    expect(r.variance).toBe(-150);
    expect(r.meanAbsolutePct).toBeCloseTo(0.0125, 4);
  });

  it('counts only the latest run when a period is rerun', () => {
    const r = accrualAccuracy([
      { ...run('first', '2026-10-05', 10000, 10400), receivedAt: '2026-10-07T09:00:00Z' },
      { ...run('rerun', '2026-10-05', 10000, 10020), receivedAt: '2026-10-08T09:00:00Z' },
      { ...run('other company', '2026-10-05', 5000, 5000), entityId: 'eck' },
    ]);
    expect(r.runs.map((x) => x.id).sort()).toEqual(['other company', 'rerun']);
    expect(r.superseded).toBe(1);
    expect(r.within).toBe(2);
  });

  it('names people who miss the same way run after run', () => {
    const r = accrualAccuracy([
      run('a', '2026-10-05', 10000, 10000, [['e1', 40], ['e2', 30]]),
      run('b', '2026-10-12', 10000, 10000, [['e1', 35], ['e2', -30]]),
    ]);
    expect(r.repeatOffenders).toEqual([{ employeeId: 'e1', runs: 2, variance: 75 }]);
  });
});

describe('takings import', () => {
  const sites = base.sites;
  it('reads names, codes and UK dates, and reports what it cannot read', () => {
    const csv = 'Date,Site,Net sales,Covers\n19/10/2026,Marylebone,"£5,120.50",130\n2026-10-19,shd,3100\n20/10/2026,Nowhere,10\nyesterday,mar,10\n2026-10-20,Fitzrovia,abc\n';
    const r = parseTakingsCsv(csv, sites);
    expect(r.rows).toEqual([
      { siteId: 'mar', date: '2026-10-19', netSales: 5120.5, covers: 130 },
      { siteId: 'shd', date: '2026-10-19', netSales: 3100 },
    ]);
    expect(r.errors).toHaveLength(3);
    expect(r.errors[0]).toContain('Line 4');
  });
});

describe('covers import', () => {
  it('adds up one line per booking into covers per site and day, and rejects part guests', () => {
    const csv = 'Date,Restaurant,Party size\n19/10/2026,Marylebone,4\n19/10/2026,Marylebone,2\n2026-10-19,shd,6\n20/10/2026,Marylebone,2.5\n20/10/2026,Nowhere,2\n';
    const r = parseCoversCsv(csv, base.sites);
    expect(r.rows).toEqual([
      { siteId: 'mar', date: '2026-10-19', covers: 6 },
      { siteId: 'shd', date: '2026-10-19', covers: 6 },
    ]);
    expect(r.errors).toHaveLength(2);
  });
});
