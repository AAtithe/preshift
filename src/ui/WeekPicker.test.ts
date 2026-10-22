import { describe, expect, it } from 'vitest';
import { relativeWeek, weekRange } from './WeekPicker';

describe('week picker labels', () => {
  it('names a week against the current one', () => {
    const now = '2026-10-19';
    expect(relativeWeek(now, now)).toBe('This week');
    expect(relativeWeek('2026-10-26', now)).toBe('Next week');
    expect(relativeWeek('2026-10-12', now)).toBe('Last week');
    expect(relativeWeek('2026-11-09', now)).toBe('In 3 weeks');
    expect(relativeWeek('2026-09-28', now)).toBe('3 weeks ago');
  });

  it('puts the month on both ends of a week that crosses a month end', () => {
    expect(weekRange('2026-10-26')).toBe('Mon 26 Oct to Sun 1 Nov');
  });
});
