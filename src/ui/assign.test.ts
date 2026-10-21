import { describe, expect, it } from 'vitest';
import { seedState } from '../engine/seed';
import { candidates, openingForGap, rangeFromDraw, shortestRole } from './assign';

const WEEK = '2026-10-19';
const state = () => seedState(WEEK);

describe('adding a shift from the timeline', () => {
  it('snaps a drawn range and orders its edges', () => {
    expect(rangeFromDraw(15 * 60 + 52, 11 * 60 + 7, 'server', 'mar', WEEK)).toMatchObject({ startMinute: 11 * 60, endMinute: 15 * 60 + 45 });
  });

  it('treats a click as a four hour block on the hour, and a short drag as at least an hour', () => {
    expect(rangeFromDraw(11 * 60 + 20, 11 * 60 + 22, 'server', 'mar', WEEK)).toMatchObject({ startMinute: 11 * 60, endMinute: 15 * 60 });
    expect(rangeFromDraw(11 * 60, 11 * 60 + 30, 'server', 'mar', WEEK)).toMatchObject({ startMinute: 11 * 60, endMinute: 12 * 60 });
  });

  it('fills a gap with the shortest role, from the clicked hour, within a full shift', () => {
    const s = state();
    s.shifts = [];
    const role = shortestRole(s, 'mar', WEEK, 19 * 60, 20 * 60);
    expect(role).not.toBeNull();
    const opening = openingForGap(s, 'mar', WEEK, 19)!;
    expect(opening.roleId).toBe(role);
    expect(opening.startMinute).toBe(19 * 60);
    expect(opening.endMinute - opening.startMinute).toBeGreaterThanOrEqual(4 * 60);
    expect(opening.endMinute - opening.startMinute).toBeLessThanOrEqual(8 * 60);
  });

  it('ranks people trained and clear first, cheapest first, and blocks leave', () => {
    const s = state();
    s.shifts = [];
    const chloe = s.employees.find((e) => e.name === 'Chloe Dubois')!;
    const leaveDay = chloe.leave[0];
    const list = candidates(s, { siteId: 'mar', roleId: 'bar', date: leaveDay, startMinute: 17 * 60, endMinute: 23 * 60 }, 'new');
    expect(list.find((c) => c.employee.id === chloe.id)?.blocker).toMatch(/approved leave/);
    const rank = (c: (typeof list)[number]) => (c.blocker ? 3 : !c.trained ? 2 : c.warnings.length ? 1 : 0);
    for (let i = 1; i < list.length; i++) {
      const [a, b] = [list[i - 1], list[i]];
      expect(rank(a) < rank(b) || (rank(a) === rank(b) && a.marginal <= b.marginal + 1e-9)).toBe(true);
    }
  });

  it('costs someone short of their contracted hours at nothing extra', () => {
    const s = state();
    s.shifts = [];
    const contracted = s.employees.find((e) => e.siteId === 'mar' && e.payBasis === 'hourly' && e.contractedHours >= 8)!;
    const list = candidates(s, { siteId: 'mar', roleId: contracted.roleIds[0], date: WEEK, startMinute: 12 * 60, endMinute: 16 * 60 }, 'new');
    expect(list.find((c) => c.employee.id === contracted.id)?.marginal).toBeCloseTo(0, 2);
  });

  it('sets the statutory break on the new shift', () => {
    const s = state();
    s.shifts = [];
    const list = candidates(s, { siteId: 'mar', roleId: 'server', date: WEEK, startMinute: 11 * 60, endMinute: 19 * 60 }, 'new');
    const adult = list.find((c) => c.employee.name === 'Grace Mensah')!;
    expect(adult.shift.breakMinutes).toBe(20);
  });

  it('offers other sites as borrowed, only people set up to cover this site, cost landing where they work', () => {
    const s = state();
    s.shifts = [];
    const list = candidates(s, { siteId: 'mar', roleId: 'bar', date: WEEK, startMinute: 17 * 60, endMinute: 21 * 60 }, 'new');
    const away = list.filter((c) => c.borrowed);
    expect(away.length).toBeGreaterThan(0);
    expect(list.filter((c) => !c.borrowed).every((c) => c.employee.siteId === 'mar')).toBe(true);
    for (const c of away) {
      if (!c.employee.coverSiteIds.includes('mar')) expect(c.blocker).toMatch(/Not set up to cover Marylebone/);
    }
    const dev = away.find((c) => c.employee.name === 'Dev Kapoor')!;
    expect(dev.blocker).toBeNull();
    expect(dev.homeSite).toBe('Shoreditch');
    // Shoreditch trades in a different company from Marylebone, so Dev's shift is a recharge.
    expect(dev.intercompany).toBe(true);
    expect(dev.siteCost).toBeCloseTo(dev.marginal, 1);
  });

  it('borrowing someone with unworked contracted hours costs the group nothing but moves cost to the host site', () => {
    const s = state();
    s.shifts = [];
    const contracted = s.employees.find((e) => e.siteId === 'shd' && e.payBasis === 'hourly' && e.contractedHours >= 8)!;
    contracted.coverSiteIds = ['mar'];
    const list = candidates(s, { siteId: 'mar', roleId: contracted.roleIds[0], date: WEEK, startMinute: 12 * 60, endMinute: 16 * 60 }, 'new');
    const c = list.find((x) => x.employee.id === contracted.id)!;
    expect(c.borrowed).toBe(true);
    expect(c.marginal).toBeCloseTo(0, 2);
    expect(c.siteCost).toBeGreaterThan(0);
  });

  it('blocks a double booking across sites and a move with too little time to make the journey', () => {
    const s = state();
    const person = s.employees.find((e) => e.siteId === 'shd' && e.roleIds.includes('server') && e.availability.length === 0)!;
    person.coverSiteIds = ['mar'];
    s.shifts = [{ id: 'home', employeeId: person.id, roleId: 'server', siteId: 'shd', date: WEEK, startMinute: 12 * 60, endMinute: 17 * 60, breakMinutes: 0 }];
    const at = (start: number, end: number) =>
      candidates(s, { siteId: 'mar', roleId: 'server', date: WEEK, startMinute: start, endMinute: end }, 'new').find((c) => c.employee.id === person.id)!;
    expect(at(16 * 60, 20 * 60).blocker).toMatch(/Overlaps/);
    // Shoreditch to Marylebone is about 43 minutes on the straight-line estimate.
    expect(at(17 * 60 + 30, 21 * 60).blocker).toMatch(/Cannot get from Shoreditch \(ends 17:00\) to Marylebone \(starts 17:30\)/);
    expect(at(17 * 60 + 45, 21 * 60).warnings[0]?.code).toBe('travel-tight');
    expect(at(19 * 60, 23 * 60).warnings.find((w) => w.code.startsWith('travel'))).toBeUndefined();
    expect(at(19 * 60, 23 * 60).journey).toMatchObject({ source: 'estimate' });
  });
});
