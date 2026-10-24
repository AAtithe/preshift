import { describe, expect, it } from 'vitest';
import { finishedWeeks, maturity, overstaffing, scorecardLeague, scoreWeek, type Scorecard, type WeekScore } from './scorecard';
import { seedState } from './seed';
import { autoSchedule } from './autoschedule';
import { addDays, weekDates } from './time';
import type { TimeEntry } from './types';

const WEEK = '2026-10-19';

const week = (over: Partial<WeekScore> = {}): WeekScore => ({
  weekStart: WEEK,
  publishedOnTime: true,
  legal: true,
  plannedLabourPct: 0.28,
  sales: 30000,
  actualLabourPct: null,
  targetPct: 0.28,
  onTarget: true,
  overstaffedShare: 0.03,
  overstaffedHours: 5,
  rosteredHours: 300,
  rotaToPayrollVariance: null,
  forecastWape: 0.1,
  overrideErrorRemoved: 0,
  movesOffered: 3,
  movesTaken: 2,
  expectedSaving: 50,
  realisedSaving: 40,
  ...over,
});

describe('maturity ladder', () => {
  it('climbs only while every lower rung holds three weeks in four', () => {
    expect(maturity([week(), week(), week(), week()]).level).toBe(4);
    const late = maturity([week({ publishedOnTime: false }), week({ publishedOnTime: false }), week(), week()]);
    expect(late.level).toBe(0);
    expect(late.next).toMatch(/^Publish each week at least 7 days/);
    // On target but sloppy at the edges: rung 2, told to tighten the edges.
    const loose = maturity([week({ overstaffedShare: 0.2 }), week({ overstaffedShare: 0.2 }), week(), week()]);
    expect(loose.level).toBe(2);
    expect(loose.next).toMatch(/^Cut the hours rostered over demand/);
  });

  it('needs two measured weeks and overrides that help before the top rung', () => {
    expect(maturity([week({ forecastWape: null }), week({ forecastWape: null }), week({ forecastWape: null }), week()]).level).toBe(3);
    expect(maturity([week(), week(), week(), week({ overrideErrorRemoved: -200 })]).level).toBe(3);
  });

  it('judges a new site on the weeks it has', () => {
    expect(maturity([]).level).toBe(0);
    expect(maturity([week(), week()]).level).toBe(0);
    expect(maturity([week({ forecastWape: null }), week({ forecastWape: null }), week({ forecastWape: null })]).level).toBe(3);
  });
});

describe('week score', () => {
  const today = '2026-10-21';
  const base = seedState(today);
  const built = autoSchedule(base, 'mar', WEEK);
  const state = { ...base, shifts: built.shifts };

  it('measures notice from the publish date and finds no blocks in an auto-built week', () => {
    const score = scoreWeek(
      { state, siteId: 'mar', weeks: [WEEK], publications: [{ siteId: 'mar', weekStart: WEEK, publishedAt: '2026-10-10T18:00:00Z', by: 'gm' }], timeEntries: [], moves: [] },
      WEEK,
    );
    expect(score.noticeDays).toBe(9);
    expect(score.publishedOnTime).toBe(true);
    expect(score.actualLabourPct).toBeNull();
    expect(score.rotaToPayrollVariance).toBeNull();
    expect(score.plannedLabourPct).toBeGreaterThan(0);
  });

  it('judges notice on the first publish, so republishing after a move does not make it late', () => {
    const publications = [
      { siteId: 'mar', weekStart: WEEK, publishedAt: '2026-10-10T18:00:00Z', by: 'gm' },
      { siteId: 'mar', weekStart: WEEK, publishedAt: '2026-10-18T18:00:00Z', by: 'gm' },
    ];
    expect(scoreWeek({ state, siteId: 'mar', weeks: [WEEK], publications, timeEntries: [], moves: [] }, WEEK).publishedOnTime).toBe(true);
    // 00:30 on 12 October in London is still 11 October in UTC: seven days' notice, not eight.
    const midnight = [{ siteId: 'mar', weekStart: WEEK, publishedAt: '2026-10-11T23:30:00Z', by: 'gm' }];
    expect(scoreWeek({ state, siteId: 'mar', weeks: [WEEK], publications: midnight, timeEntries: [], moves: [] }, WEEK).noticeDays).toBe(7);
  });

  it('counts a late publish as late', () => {
    const score = scoreWeek(
      { state, siteId: 'mar', weeks: [WEEK], publications: [{ siteId: 'mar', weekStart: WEEK, publishedAt: '2026-10-17T18:00:00Z', by: 'gm' }], timeEntries: [], moves: [] },
      WEEK,
    );
    expect(score.publishedOnTime).toBe(false);
  });

  it('measures actual labour and the rota-to-payroll gap from approved time and till sales', () => {
    const entries: TimeEntry[] = state.shifts
      .filter((s) => s.siteId === 'mar' && weekDates(WEEK).includes(s.date))
      .map((s) => ({ id: s.id, employeeId: s.employeeId, siteId: s.siteId, roleId: s.roleId, shiftId: s.id, date: s.date, clockIn: s.startMinute, clockOut: s.endMinute, breakMinutes: s.breakMinutes, status: 'approved', source: 'clock' }));
    const actuals = state.forecast.filter((f) => f.siteId === 'mar' && weekDates(WEEK).includes(f.date)).map(({ siteId, date, hour, sales, covers }) => ({ siteId, date, hour, sales, covers }));
    const score = scoreWeek({ state: { ...state, actuals }, siteId: 'mar', weeks: [WEEK], publications: [], timeEntries: entries, moves: [] }, WEEK);
    // One entry still waiting for approval: nothing is measured yet.
    const pending = entries.map((e, i) => (i === 0 ? { ...e, status: 'submitted' as const } : e));
    expect(scoreWeek({ state: { ...state, actuals }, siteId: 'mar', weeks: [WEEK], publications: [], timeEntries: pending, moves: [] }, WEEK).rotaToPayrollVariance).toBeNull();
    // Clocked exactly to the rota, trading exactly to forecast: no gap anywhere.
    expect(score.rotaToPayrollVariance).toBeCloseTo(0, 2);
    expect(score.actualLabourPct).toBeCloseTo(score.plannedLabourPct, 2);
    expect(score.forecastWape).toBe(0);
  });

  it('counts person-hours over demand', () => {
    const { overHours, rosteredHours } = overstaffing(state, 'mar', WEEK);
    expect(rosteredHours).toBeGreaterThan(0);
    expect(overHours / rosteredHours).toBeLessThan(0.5);
  });

  it('lists the finished weeks before this one, oldest first', () => {
    expect(finishedWeeks(WEEK, 2)).toEqual([addDays(WEEK, -14), addDays(WEEK, -7)]);
  });
});

describe('scorecard league', () => {
  const card = (siteId: string, weeks: WeekScore[]): Scorecard => ({ siteId, weeks, maturity: maturity(weeks), summary: {} as Scorecard['summary'] });

  it('ranks on the rung before the labour figure', () => {
    // On target every week but published late: lucky, not run. The site that publishes on time ranks above it.
    const lucky = card('lucky', [week({ publishedOnTime: false }), week({ publishedOnTime: false }), week({ publishedOnTime: false }), week({ publishedOnTime: false })]);
    const run = card('run', [week({ onTarget: false }), week({ onTarget: false }), week({ onTarget: false }), week()]);
    const top = card('top', [week(), week(), week(), week()]);
    const league = scorecardLeague([lucky, run, top]);
    expect(league.map((r) => [r.siteId, r.rank, r.level])).toEqual([['top', 1, 4], ['run', 2, 1], ['lucky', 3, 0]]);
    expect(league[2].onTimeRate).toBe(0);
    expect(league[2].onTargetRate).toBe(1);
  });

  it('weights labour by sales, pools hours over demand, and leaves out weeks that did not trade', () => {
    const [row] = scorecardLeague([
      card('mar', [
        week({ plannedLabourPct: 0.3, actualLabourPct: 0.32, sales: 30000, overstaffedHours: 30, rosteredHours: 300, rotaToPayrollVariance: -0.02 }),
        week({ plannedLabourPct: 0.24, sales: 10000, overstaffedHours: 0, rosteredHours: 100, rotaToPayrollVariance: 0.04, forecastWape: null }),
        week({ plannedLabourPct: 0, sales: 0, rosteredHours: 0, overstaffedHours: 0, publishedAt: undefined, movesOffered: 0, movesTaken: 0, realisedSaving: 0 }),
      ]),
    ]);
    expect(row.scoredWeeks).toBe(2);
    expect(row.labourPct).toBeCloseTo((0.32 * 30000 + 0.24 * 10000) / 40000, 6);
    expect(row.overstaffedShare).toBeCloseTo(30 / 400, 6);
    expect(row.rotaToPayrollVariance).toBeCloseTo(0.03, 6);
    expect(row.forecastWape).toBeCloseTo(0.1, 6);
    expect(row.movesTakenRate).toBeCloseTo(4 / 6, 6);
    expect(row.realisedSaving).toBe(80);
  });

  it('shows a site with nothing scored as blank, not as perfect', () => {
    const [row] = scorecardLeague([card('new', [])]);
    expect(row).toMatchObject({ scoredWeeks: 0, onTimeRate: 0, labourPct: null, overstaffedShare: null, forecastWape: null, movesTakenRate: null });
  });
});
