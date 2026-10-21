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
    expect(list.every((c) => c.employee.siteId === 'mar')).toBe(true);
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
});
