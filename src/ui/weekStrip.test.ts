import { describe, expect, it } from 'vitest';
import { weekDates } from '../engine/time';
import { keyDates } from './weekStrip';

describe('key dates along the top of the rota', () => {
  const dates = weekDates('2026-12-21');

  it('marks bank holidays and trading occasions on their day', () => {
    const on = keyDates(dates, [], []);
    expect(on['2026-12-24'].map((k) => k.label)).toEqual(['Christmas Eve']);
    expect(on['2026-12-25']).toMatchObject([{ label: 'Christmas Day', kind: 'bank_holiday' }]);
    expect(on['2026-12-22']).toEqual([]);
  });

  it('adds local events by start time and a school holiday on every day it covers', () => {
    const on = keyDates(
      dates,
      [
        { id: 'b', siteId: 'mar', date: '2026-12-26', name: 'Panto', startMinute: 19 * 60, source: 'manual' },
        { id: 'a', siteId: 'mar', date: '2026-12-26', name: 'Home v Town', startMinute: 15 * 60, source: 'ics' },
      ],
      [{ id: 's', start: '2026-12-19', end: '2027-01-04', name: 'Christmas holidays', kind: 'christmas', source: 'estimate' }],
    );
    expect(on['2026-12-26'].map((k) => k.label)).toEqual(['15:00 Home v Town', '19:00 Panto', 'Christmas holidays']);
    expect(dates.every((d) => on[d].some((k) => k.kind === 'school'))).toBe(true);
  });

  it('shows weddings and functions, a held one marked, and leaves a cancelled one off', () => {
    const base = { siteId: 'mar', source: 'tripleseat', endMinute: 23 * 60, kind: 'wedding' as const, style: 'seated' as const, exclusive: false };
    const on = keyDates(dates, [], [], [
      { ...base, id: 'w', date: '2026-12-22', startMinute: 18 * 60, guests: 90, status: 'confirmed' },
      { ...base, id: 'p', date: '2026-12-22', startMinute: 12 * 60, guests: 30, kind: 'party', style: 'buffet', status: 'provisional' },
      { ...base, id: 'c', date: '2026-12-23', startMinute: 18 * 60, guests: 50, status: 'cancelled' },
    ]);
    expect(on['2026-12-22']).toMatchObject([
      { label: '12:00 Party, 30 buffet (provisional)', kind: 'private held' },
      { label: '18:00 Wedding, 90 seated', kind: 'private' },
    ]);
    expect(on['2026-12-23']).toEqual([]);
  });
});
