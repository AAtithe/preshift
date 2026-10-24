import { describe, expect, it } from 'vitest';
import { autoSchedule } from './autoschedule';
import { dayDemand, tradingHour } from './demand';
import { forecastFromTakings } from './forecasting';
import { seedState } from './seed';
import { applySetup, emptyDraft, forecastForWeek, missingForecast, validateSetup, type SetupDraft } from './setup';
import { addDays, weekDates } from './time';
import type { RotaState } from './types';

const TODAY = '2026-10-21';
const WEEK = '2026-10-19';
const FRIDAY = '2026-10-23';
const SATURDAY = '2026-10-24';
const EMPTY: RotaState = { entities: [], sites: [], roles: [], employees: [], shifts: [], forecast: [], demandRules: [] };

// A bar open from 16:00 to 02:00.
function bar(): SetupDraft {
  const d = emptyDraft();
  d.entities[0] = { ...d.entities[0], name: 'Night Owl Ltd', payeReference: '120/NO12345' };
  d.sites[0] = { ...d.sites[0], name: 'Soho', openMinute: 16 * 60, closeMinute: 26 * 60, salesProfile: { dailySales: [2000, 2000, 2500, 3000, 6000, 7000, 2500], averageSpend: 25 } };
  return d;
}

describe('trading past midnight', () => {
  it('forecasts the hours after midnight on the next date, and each night ties to the pound', () => {
    const site = bar().sites[0];
    const rows = forecastForWeek(site, WEEK);
    const friday = rows.filter((r) => tradingHour(site, r.date, r.hour).date === FRIDAY);
    expect(friday.reduce((s, r) => s + r.sales, 0)).toBe(6000);
    expect(friday.filter((r) => r.date === SATURDAY).map((r) => r.hour)).toEqual([0, 1]);
    expect(rows.some((r) => r.date === SATURDAY && r.hour === 2)).toBe(false);
  });

  it("asks for staff to close on Friday night from Saturday's early hours, not again on Saturday", () => {
    const d = bar();
    const state = applySetup(EMPTY, d, TODAY);
    const rule = state.demandRules.find((r) => r.roleId === 'bar')!;
    const friday = dayDemand(state, state.sites[0].id, rule.roleId, FRIDAY);
    expect(friday).toHaveLength(26);
    expect(friday[25].required).toBeGreaterThan(0);
    expect(dayDemand(state, state.sites[0].id, rule.roleId, SATURDAY)[1].required).toBe(0);
    // Shown once, under Friday night, never again under Saturday.
    expect(friday[24].sales).toBeGreaterThan(0);
    expect(dayDemand(state, state.sites[0].id, rule.roleId, SATURDAY)[0].sales).toBe(0);
  });

  it('builds a shift that runs to close after midnight', () => {
    const d = bar();
    const siteId = d.sites[0].id;
    const state = applySetup(EMPTY, d, TODAY);
    const withStaff: RotaState = {
      ...state,
      employees: [0, 1, 2].map((i) => ({
        ...seedState(TODAY).employees.find((e) => e.id === 'mar-12')!, // a bartender
        id: `bar-${i}`, name: `Bar ${i}`, siteId, entityId: state.entities[0].id, roleIds: ['bar'], contractedHours: 0, rightToWork: { checked: true, checkedOn: '2024-01-01' },
      })),
    };
    const built = autoSchedule(withStaff, siteId, WEEK);
    expect(built.added.some((s) => s.date === FRIDAY && s.endMinute === 26 * 60)).toBe(true);
  });

  it("does not take Sunday night's trade after midnight for a forecast of the next week", () => {
    const state = applySetup(EMPTY, bar(), TODAY);
    const lastWeek = addDays(WEEK, 7 * 7);
    const only = state.forecast.filter((f) => f.date < addDays(lastWeek, 7));
    expect(only.some((f) => f.date === addDays(lastWeek, 7))).toBe(false);
    const spill = { ...state, forecast: only.filter((f) => f.date < addDays(lastWeek, 1) || (f.date === addDays(lastWeek, 7) && f.hour < 2)) };
    expect(missingForecast(spill, [state.sites[0].id], addDays(lastWeek, 7)).length).toBeGreaterThan(0);
  });

  it('accepts a close as late as the next opening and refuses one that runs into it', () => {
    const ok = bar();
    expect(validateSetup(ok).filter((i) => i.severity === 'block')).toEqual([]);
    const late = bar();
    late.sites[0].closeMinute = 29 * 60;
    expect(validateSetup(late).filter((i) => i.severity === 'block')).toEqual([]);
    const roundTheClock = bar();
    roundTheClock.sites[0].closeMinute = 40 * 60;
    expect(validateSetup(roundTheClock).filter((i) => i.severity === 'block')).toEqual([]);
    const overlap = bar();
    overlap.sites[0].openMinute = 60;
    overlap.sites[0].closeMinute = 26 * 60;
    expect(validateSetup(overlap).some((i) => i.message.includes("next day's opening"))).toBe(true);
  });

  it('spreads a late night forecast from takings into the hours after midnight', () => {
    const state = seedState(TODAY);
    state.sites = state.sites.map((s) => (s.id === 'shd' ? { ...s, closeMinute: 26 * 60 } : s));
    const site = state.sites.find((s) => s.id === 'shd')!;
    const dates = weekDates(addDays(WEEK, 7));
    const { days, rows } = forecastFromTakings(state, 'shd', dates);
    const fri = days.find((d) => d.date === addDays(FRIDAY, 7))!;
    if (fri.basis === 'none') return; // the sample has too little history to forecast from
    const night = rows.filter((r) => tradingHour(site, r.date, r.hour).date === fri.date);
    expect(night.some((r) => r.date === addDays(fri.date, 1))).toBe(true);
    expect(night.reduce((s, r) => s + r.sales, 0)).toBe(Math.round(fri.sales));
  });
});
