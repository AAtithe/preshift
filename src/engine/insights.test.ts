import { describe, expect, it } from 'vitest';
import { peopleInsights } from './insights';
import { seedState } from './seed';
import type { Shift, TimeEntry } from './types';

const WEEK = '2026-10-19';
const TODAY = '2026-10-19';

const shift = (id: string, date: string, start: number, end: number, employeeId = 'mar-8', siteId = 'mar'): Shift => ({
  id, employeeId, roleId: 'server', siteId, date, startMinute: start * 60, endMinute: end * 60, breakMinutes: 0,
});
const entry = (shiftId: string, date: string, clockIn: number, siteId = 'mar'): TimeEntry => ({
  id: `t-${shiftId}`, employeeId: 'mar-8', siteId, roleId: 'server', shiftId, date, clockIn, clockOut: clockIn + 240, breakMinutes: 0, status: 'approved', source: 'clock',
});

describe('people insights', () => {
  it('counts weekends, closes, late arrivals and no-shows over the last four weeks', () => {
    const state = seedState(TODAY);
    state.shifts = [
      shift('sat', '2026-10-17', 17, 23), // Saturday close
      shift('sun', '2026-10-11', 12, 18), // Sunday
      shift('tue', '2026-10-13', 12, 16), // weekday, late by 25 minutes
      shift('wed', '2026-10-14', 12, 16), // no clock at all: a no-show
      shift('old', '2026-09-01', 12, 16), // before the window
    ];
    const entries = [entry('sat', '2026-10-17', 17 * 60), entry('sun', '2026-10-11', 12 * 60 + 5), entry('tue', '2026-10-13', 12 * 60 + 25)];
    const oliver = state.employees.find((e) => e.id === 'mar-8')!;
    oliver.rotaNotes = '  Prefers lunches  ';
    const i = peopleInsights(state, [oliver], entries, WEEK, TODAY)['mar-8'];
    expect(i).toMatchObject({ from: '2026-09-21', to: '2026-10-18', weekendShifts: 2, closingShifts: 1, lateArrivals: 1, noShows: 1, notes: 'Prefers lunches' });
    expect(i.averageWeeklyHours).toBeCloseTo(20 / 4, 1);
  });

  it('does not count a day off sick as a no-show', () => {
    const state = seedState(TODAY);
    state.shifts = [shift('mon', '2026-10-12', 12, 16), shift('tue', '2026-10-13', 12, 16)];
    const oliver = state.employees.find((e) => e.id === 'mar-8')!;
    oliver.absences = [{ id: 'a1', type: 'sickness', from: '2026-10-13', to: '2026-10-13' }];
    const i = peopleInsights(state, [oliver], [entry('mon', '2026-10-12', 12 * 60)], WEEK, TODAY)['mar-8'];
    expect(i.noShows).toBe(0);
  });

  it('does not mark anyone late or absent at a site that does not use clocking', () => {
    const state = seedState(TODAY);
    state.shifts = [shift('a', '2026-10-14', 12, 16)];
    const i = peopleInsights(state, state.employees.filter((e) => e.id === 'mar-8'), [], WEEK, TODAY)['mar-8'];
    expect(i.lateArrivals).toBeNull();
    expect(i.noShows).toBeNull();
  });

  it('flags holiday worth planning in when a good balance meets a near year end', () => {
    const state = seedState('2026-11-20');
    const grace = state.employees.find((e) => e.id === 'mar-7')!; // fixed hours, little taken
    const early = peopleInsights(state, [grace], [], '2026-06-01', '2026-06-01')['mar-7'];
    expect(early.holiday?.shouldPlanLeave).toBe(false);
    const late = peopleInsights(state, [grace], [], '2026-11-23', '2026-11-20')['mar-7'];
    expect(late.holiday?.daysToYearEnd).toBeLessThanOrEqual(60);
    expect(late.holiday?.shouldPlanLeave).toBe(true);
  });
});
