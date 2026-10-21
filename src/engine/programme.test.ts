import { describe, expect, it } from 'vitest';
import { baselineFromHistory, MILESTONES, newProgramme, programmeStatus, type Programme } from './programme';
import { maturity, type Scorecard, type WeekScore } from './scorecard';
import { seedState } from './seed';
import { addDays } from './time';

const START = '2026-08-03'; // a Monday

const week = (over: Partial<WeekScore> = {}): WeekScore => ({
  weekStart: START,
  publishedOnTime: true,
  legal: true,
  plannedLabourPct: 0.27,
  sales: 25000,
  actualLabourPct: 0.27,
  targetPct: 0.28,
  onTarget: true,
  overstaffedShare: 0.04,
  overstaffedHours: 6,
  rosteredHours: 300,
  rotaToPayrollVariance: 0.005,
  forecastWape: 0.1,
  overrideErrorRemoved: 10,
  movesOffered: 3,
  movesTaken: 2,
  expectedSaving: 60,
  realisedSaving: 50,
  ...over,
});

const card = (weeks: WeekScore[]): Scorecard => ({
  siteId: 'mar',
  weeks,
  maturity: maturity(weeks),
  summary: { onTimeRate: 1, onTargetRate: 1, averageOverstaffedShare: 0.04, averageVariance: 0.005, movesTakenRate: 0.66, expectedSaving: 0, realisedSaving: 0 },
});

const baseline = { from: '2025-08-01', to: '2026-07-31', sales: 1_200_000, labourCost: 372_000, overstaffedShare: 0.1, source: 'management_accounts' as const, recordedBy: 'ws', recordedAt: '2026-08-04T10:00:00Z' };

describe('labour programme', () => {
  const state = seedState('2026-10-21');

  it('places the site in its week and phase', () => {
    const p = newProgramme('mar', '2026-08-05');
    expect(p.startWeek).toBe(START);
    expect(programmeStatus(p, card([]), state, addDays(START, -1)).week).toBe(0);
    expect(programmeStatus(p, card([]), state, START).phase?.id).toBe('baseline');
    expect(programmeStatus(p, card([]), state, addDays(START, 7 * 4)).phase?.id).toBe('control');
    expect(programmeStatus(p, card([]), state, addDays(START, 7 * 9)).phase?.id).toBe('optimise');
    expect(programmeStatus(p, card([]), state, addDays(START, 7 * 11)).phase?.id).toBe('embed');
    expect(programmeStatus(p, card([]), state, addDays(START, 7 * 12)).phase).toBeNull();
  });

  it('proves data milestones from the scorecard and waits for sign-off on the rest', () => {
    const p: Programme = { ...newProgramme('mar', START), baseline, signoffs: { kickoff: { by: 'ws lead', at: '2026-08-03T09:00:00Z' } } };
    const status = programmeStatus(p, card([week(), week(), week(), week()]), state, addDays(START, 60));
    const by = (id: string) => status.milestones.find((m) => m.id === id)!;
    expect(by('kickoff').done).toBe(true);
    expect(by('weekly-review').done).toBe(false);
    expect(by('baseline-captured').evidence).toBe('31.0% from 2025-08-01 to 2026-07-31.');
    expect(by('on-time').done).toBe(true);
    expect(by('variance-under-1').done).toBe(true);
    expect(by('moves-habit').done).toBe(true);
    expect(by('saving-verified').done).toBe(false);
    expect(status.milestones).toHaveLength(MILESTONES.length);
  });

  it('estimates the saving from the rota until the accounts sign it off, and only then charges a fee', () => {
    const p: Programme = { ...newProgramme('mar', START), baseline, gainSharePct: 0.2 };
    const estimate = programmeStatus(p, card([week(), week()]), state, addDays(START, 60)).saving;
    expect(estimate.verified).toBe(false);
    expect(estimate.points).toBeCloseTo(0.31 - 0.27);
    expect(estimate.gainShareFee).toBeNull();

    const signed: Programme = {
      ...p,
      verifications: [{ id: 'v1', from: '2026-09-01', to: '2026-09-30', sales: 100_000, labourCost: 28_500, signedBy: 'ws', signedAt: '2026-10-05T12:00:00Z' }],
    };
    const verified = programmeStatus(signed, card([week()]), state, addDays(START, 70)).saving;
    expect(verified.verified).toBe(true);
    expect(verified.currentPct).toBeCloseTo(0.285);
    expect(verified.points).toBeCloseTo(0.025);
    // £100k over 30 days, annualised, at 2.5 points.
    expect(verified.annualSaving).toBeCloseTo(0.025 * (100_000 * 365) / 30, 0);
    expect(verified.gainShareFee).toBeCloseTo(verified.annualSaving! * 0.2, 2);
  });

  it('never verifies or charges on a period with no sales or one overlapping the baseline', () => {
    const p: Programme = {
      ...newProgramme('mar', START),
      baseline,
      gainSharePct: 0.2,
      verifications: [
        { id: 'v0', from: '2026-09-01', to: '2026-09-30', sales: 0, labourCost: 0, signedBy: 'ws', signedAt: '2026-10-05T12:00:00Z' },
        { id: 'v1', from: '2026-07-01', to: '2026-09-30', sales: 300_000, labourCost: 60_000, signedBy: 'ws', signedAt: '2026-10-05T12:00:00Z' },
      ],
    };
    const s = programmeStatus(p, card([week()]), state, addDays(START, 70));
    expect(s.saving.verified).toBe(false);
    expect(s.saving.gainShareFee).toBeNull();
    expect(s.milestones.find((m) => m.id === 'saving-verified')!.done).toBe(false);
  });

  it('refuses a till and payroll baseline that is not whole weeks', () => {
    expect(() => baselineFromHistory(state, [], 'mar', '2026-07-01', '2026-07-31')).toThrow(/Monday to Sunday/);
    expect(baselineFromHistory(state, [], 'mar', '2026-10-05', '2026-10-18').sales).toBeGreaterThan(0);
  });

  it('leaves weeks nobody rostered out of the current labour figure', () => {
    const p: Programme = { ...newProgramme('mar', START), baseline };
    const empty = week({ rosteredHours: 0, plannedLabourPct: 0.03, actualLabourPct: null, sales: 40_000 });
    expect(programmeStatus(p, card([empty, week(), week()]), state, addDays(START, 60)).saving.currentPct).toBeCloseTo(0.27);
  });

  it('tracks the strategy targets against the baseline', () => {
    const p: Programme = { ...newProgramme('mar', START), baseline };
    const t = programmeStatus(p, card([week(), week(), week(), week({ onTarget: false })]), state, addDays(START, 60)).targets;
    expect(t.map((x) => [x.label, x.met])).toEqual([
      ['Rota-to-payroll gap', true],
      ['Weeks within one point of target', false],
      ['Hours over demand, down on baseline', true],
    ]);
  });
});
