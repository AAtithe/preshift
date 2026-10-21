import { describe, expect, it } from 'vitest';
import { checkWeek } from './compliance';
import { seedState } from './seed';
import { estimateMinutes, haversineKm, journeyBetween, travelIssues } from './travel';
import type { Employee, Shift } from './types';

const WEEK = '2026-10-19';

describe('travel between sites', () => {
  it('measures distance and estimates a city journey', () => {
    const mar = { lat: 51.520957, lng: -0.153565 };
    const shd = { lat: 51.526419, lng: -0.078249 };
    expect(haversineKm(mar, shd)).toBeCloseTo(5.2, 1);
    expect(estimateMinutes(5.2)).toBe(43);
    expect(estimateMinutes(0.8)).toBe(10);
  });

  it('uses a held time either way round, then an estimate, then nothing', () => {
    const s = seedState(WEEK);
    expect(journeyBetween(s.sites, 'mar', 'shd')).toMatchObject({ source: 'estimate', minutes: 43 });
    s.sites = s.sites.map((x) => (x.id === 'shd' ? { ...x, travel: { mar: { minutes: 41, source: 'tfl', mode: 'tube, bus', checkedAt: WEEK } } } : x));
    expect(journeyBetween(s.sites, 'mar', 'shd')).toMatchObject({ minutes: 41, source: 'tfl', label: 'TfL, tube, bus' });
    s.sites = s.sites.map(({ location: _l, travel: _t, ...x }) => x);
    expect(journeyBetween(s.sites, 'mar', 'shd')).toBeNull();
  });

  it('blocks an impossible move, warns on a tight one and ignores separate trips', () => {
    const s = seedState(WEEK);
    const person = { id: 'p', name: 'Pat Lee', siteId: 'shd' } as Employee;
    const shift = (id: string, siteId: string, start: number, end: number, date = WEEK): Shift =>
      ({ id, employeeId: 'p', roleId: 'server', siteId, date, startMinute: start * 60, endMinute: end * 60, breakMinutes: 0 }) as Shift;
    const codes = (shifts: Shift[]) => travelIssues(person, shifts, s.sites).map((i) => `${i.shiftId}:${i.code}`);
    expect(codes([shift('a', 'shd', 12, 17), shift('b', 'mar', 17.5, 21)])).toEqual(['b:travel']);
    expect(codes([shift('a', 'shd', 12, 17), shift('b', 'mar', 17.75, 21)])).toEqual(['b:travel-tight']);
    expect(codes([shift('a', 'shd', 12, 17), shift('b', 'mar', 18, 21)])).toEqual([]);
    expect(codes([shift('a', 'shd', 8, 10), shift('b', 'mar', 17, 21)])).toEqual([]);
    expect(codes([shift('a', 'mar', 12, 16), shift('b', 'mar', 16, 20)])).toEqual([]);
    // Across midnight: a late finish at one site and an early start at another the next day.
    expect(codes([shift('a', 'shd', 18, 24), shift('b', 'mar', 0.25, 4, '2026-10-20')])).toEqual(['b:travel']);
  });

  it('is part of the week check every view and the server use', () => {
    const s = seedState(WEEK);
    const dev = s.employees.find((e) => e.name === 'Dev Kapoor')!;
    s.shifts = [
      { id: 'a', employeeId: dev.id, roleId: 'bar', siteId: 'shd', date: WEEK, startMinute: 12 * 60, endMinute: 17 * 60, breakMinutes: 0 },
      { id: 'b', employeeId: dev.id, roleId: 'bar', siteId: 'mar', date: WEEK, startMinute: 17 * 60 + 15, endMinute: 21 * 60, breakMinutes: 0 },
    ];
    expect(checkWeek(s, WEEK, ['mar']).find((i) => i.shiftId === 'b' && i.code === 'travel')?.severity).toBe('block');
  });
});
