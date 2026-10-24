import { describe, expect, it } from 'vitest';
import { eligibleFor } from './requests';
import { CHEAPEST_WAVE, minutesUntil, offeredTo, offerWaves, rankOffer, tierOf, tooCloseForWaves, withinBudget } from './offers';
import { seedState } from './seed';
import { addDays, weekStart } from './time';
import type { OpenShift, RotaState, Shift } from './types';

const TODAY = '2026-10-21';

function setup(): { state: RotaState; slot: Shift } {
  const state = seedState(TODAY);
  const day = addDays(weekStart(TODAY), 16);
  state.shifts = state.shifts.filter((s) => s.date < addDays(day, -2) || s.date > addDays(day, 9));
  const slot: Shift = { id: 'open:x', employeeId: '', siteId: 'mar', roleId: 'bar', date: day, startMinute: 18 * 60, endMinute: 23 * 60, breakMinutes: 20 };
  return { state, slot };
}

describe('ranking an open shift offer', () => {
  it('puts people short of their contracted hours first, then the cheapest few, then the rest by cost', () => {
    const { state, slot } = setup();
    for (const e of state.employees) e.contractedHours = 0;
    const short = eligibleFor(state, slot)[0];
    Object.assign(short, { payBasis: 'hourly', contractedHours: 30 });
    const ranks = rankOffer(state, slot, eligibleFor(state, slot));
    expect(ranks[0]).toMatchObject({ employeeId: short.id, tier: 'contracted', shortHours: 30 });
    // Inside contracted hours the shift is already paid for: it costs at most the on-costs.
    expect(ranks[0].marginal).toBeLessThan(ranks[1].marginal);
    const cheapest = ranks.filter((r) => r.tier === 'cheapest');
    const rest = ranks.filter((r) => r.tier === 'everyone');
    expect(cheapest.length).toBeLessThanOrEqual(CHEAPEST_WAVE);
    expect(Math.max(...cheapest.map((r) => r.marginal))).toBeLessThanOrEqual(Math.min(...rest.map((r) => r.marginal)));
    expect(offerWaves(ranks).map((w) => w.tier)).toEqual(['contracted', 'cheapest', 'everyone']);
  });

  it('leaves out empty waves, and says who has been offered it', () => {
    const { state, slot } = setup();
    for (const e of state.employees) e.contractedHours = 0;
    const waves = offerWaves(rankOffer(state, slot, eligibleFor(state, slot)));
    expect(waves[0].tier).toBe('cheapest');
    const o = { offer: { waves, released: 1, told: waves[0].employeeIds } } as unknown as OpenShift;
    expect(offeredTo(o, waves[0].employeeIds[0])).toBe(true);
    const later = waves.at(-1)!.employeeIds[0];
    expect(offeredTo(o, later)).toBe(false);
    expect(tierOf(o, later)).toBe('everyone');
    expect(offeredTo({ ...o, offer: { ...o.offer!, released: waves.length } }, later)).toBe(true);
    expect(offeredTo({} as OpenShift, later)).toBe(true);
  });
});

describe('timing and budget', () => {
  it('counts the minutes to the start across days', () => {
    expect(minutesUntil({ date: '2026-10-22', startMinute: 600 }, { date: '2026-10-21', minute: 1200 })).toBe(840);
    expect(tooCloseForWaves({ date: '2026-10-22', startMinute: 600 }, { date: '2026-10-21', minute: 1200 })).toBe(true);
    expect(tooCloseForWaves({ date: '2026-10-24', startMinute: 600 }, { date: '2026-10-21', minute: 1200 })).toBe(false);
  });

  it('is within budget only with a forecast, and while labour stays at or under target', () => {
    const { state, slot } = setup();
    const shift = { ...slot, employeeId: eligibleFor(state, slot)[0].id };
    const ws = weekStart(slot.date);
    state.forecast = state.forecast.filter((f) => !(f.siteId === 'mar' && f.date >= ws && f.date <= addDays(ws, 6)));
    expect(withinBudget(state, shift).ok).toBe(false);
    state.forecast.push({ siteId: 'mar', date: slot.date, hour: 19, sales: 100_000, covers: 2000 });
    expect(withinBudget(state, shift).ok).toBe(true);
    state.sites.find((s) => s.id === 'mar')!.labourTargetPct = 0.00001;
    expect(withinBudget(state, shift).ok).toBe(false);
  });
});
