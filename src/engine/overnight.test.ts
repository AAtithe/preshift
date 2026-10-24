import { describe, expect, it } from 'vitest';
import { autoSchedule } from './autoschedule';
import { dayDemand, headcountAt, isAroundTheClock, tradingDayHours } from './demand';
import { forecastForWeek, validateSetup } from './setup';
import { addDays } from './time';
import type { DemandRule, Employee, Entity, Role, RotaState, Site } from './types';

const WEEK = '2027-03-01';
// A hotel bar open round the clock: 06:00 to 06:00 the next day.
const site: Site = {
  id: 'htl', name: 'Hotel bar', entityId: 'co', labourTargetPct: 0.3, trackingCode: 'Hotel', openMinute: 6 * 60, closeMinute: 30 * 60,
  salesProfile: { dailySales: [4000, 4000, 4000, 4000, 6000, 6000, 4000], averageSpend: 20 },
};
const entity: Entity = { id: 'co', name: 'Company', companyNumber: '1', payeReference: '1/A', intercompanyCode: '1100' };
const role: Role = { id: 'bar', name: 'Bartender', department: 'BAR', nominalCode: '7002' } as Role;
const rule: DemandRule = { siteId: 'htl', roleId: 'bar', salesPerLabourHour: 200, minimumWhileOpen: 1, maximum: 4 };
const people: Employee[] = Array.from({ length: 12 }, (_, i) => ({
  id: `p${i}`, name: `Person ${i}`, siteId: 'htl', entityId: 'co', coverSiteIds: [], roleIds: ['bar'], payBasis: 'hourly', hourlyRate: 12.71, annualSalary: 0,
  dateOfBirth: '1990-01-01', contractedHours: 0, maxWeeklyHours: 48, optedOutOf48: false, irregularHours: true, pensionEnrolled: true, availability: [], leave: [],
}));

describe('trading round the clock', () => {
  it('is accepted in set-up, closing at the next opening and no later', () => {
    const draft = { entities: [entity], sites: [site], roles: [role], demandRules: [rule] };
    expect(isAroundTheClock(site)).toBe(true);
    expect(validateSetup(draft).filter((i) => i.severity === 'block' && /closing|trading/.test(i.message))).toEqual([]);
    const tooLate = validateSetup({ ...draft, sites: [{ ...site, closeMinute: site.closeMinute + 30 }] });
    expect(tooLate.some((i) => i.severity === 'block' && /next day's opening/.test(i.message))).toBe(true);
  });

  it('forecasts every hour of the trading day, the small hours dated the next morning', () => {
    const rows = forecastForWeek(site, WEEK).filter((r) => r.date === WEEK || (r.date === addDays(WEEK, 1) && r.hour < 6));
    expect(rows).toHaveLength(24);
    expect(rows.some((r) => r.date === addDays(WEEK, 1) && r.hour === 3 && r.sales > 0)).toBe(true);
  });

  it('needs cover all night and the auto-build rosters it', () => {
    const state = { sites: [site], entities: [entity], roles: [role], demandRules: [rule], employees: people, shifts: [], forecast: forecastForWeek(site, WEEK) } as unknown as RotaState;
    expect(tradingDayHours(site)).toBe(30);
    const demand = dayDemand(state, 'htl', 'bar', WEEK);
    expect(demand.filter((h) => h.hour >= 6 && h.hour < 30).every((h) => h.required >= 1)).toBe(true);
    const built = autoSchedule(state, 'htl', WEEK);
    // Someone is on at 03:00 on Tuesday morning, which is Monday's trading day.
    expect(headcountAt(built.shifts, addDays(WEEK, 1), 3, 'bar', 'htl')).toBeGreaterThanOrEqual(1);
    expect(built.shifts.some((s) => s.endMinute > 1440)).toBe(true);
  });
});
