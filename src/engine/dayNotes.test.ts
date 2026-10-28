import { describe, expect, it } from 'vitest';
import { notesOn, occursOn, overlaps } from './dayNotes';
import type { DayNote } from './types';

const note = (over: Partial<DayNote> = {}): DayNote => ({ id: 'n', siteId: 'mar', date: '2026-11-03', kind: 'other', text: 'x', ...over });

describe('day notes', () => {
  it('a one-off note is for its own day only', () => {
    expect(occursOn(note(), '2026-11-03')).toBe(true);
    expect(occursOn(note(), '2026-11-10')).toBe(false);
  });

  it('a weekly note is for the same weekday from its first day to its last', () => {
    const tuesdays = note({ weekly: true, until: '2026-11-17' });
    expect(['2026-10-27', '2026-11-03', '2026-11-04', '2026-11-10', '2026-11-17', '2026-11-24'].map((d) => occursOn(tuesdays, d))).toEqual([false, true, false, true, true, false]);
    expect(occursOn(note({ weekly: true }), '2027-06-01')).toBe(true);
  });

  it('finds a note in a range without walking it', () => {
    expect(overlaps(note(), '2026-11-02', '2026-11-08')).toBe(true);
    expect(overlaps(note(), '2026-11-09', '2026-11-15')).toBe(false);
    expect(overlaps(note({ weekly: true }), '2027-01-04', '2027-01-10')).toBe(true);
    expect(overlaps(note({ weekly: true, until: '2026-11-17' }), '2026-11-23', '2026-11-29')).toBe(false);
  });

  it("lists a site's notes for a day, all-day first then by time, and the team's alone when asked", () => {
    const notes = [
      note({ id: 'party', startMinute: 1170, team: true }),
      note({ id: 'delivery', date: '2026-10-27', startMinute: 420, weekly: true }),
      note({ id: 'allday', kind: 'closure' }),
      note({ id: 'other site', siteId: 'shd' }),
    ];
    expect(notesOn(notes, 'mar', '2026-11-03').map((n) => n.id)).toEqual(['allday', 'delivery', 'party']);
    expect(notesOn(notes, 'mar', '2026-11-03', { team: true }).map((n) => n.id)).toEqual(['party']);
  });
});
