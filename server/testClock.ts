import { afterEach, beforeEach, vi } from 'vitest';

/**
 * Holds the clock on the sample's own day for every test in the file that calls it. The sample is
 * seeded for a fixed day while the API reads the real clock, so without this a seeded leave date,
 * pay date or week passing in real time changes what the tests see. Only Date is faked, and it
 * runs on from midday, so timers, the dispatcher and anything ordered by time behave as before.
 */
export function holdClock(day = '2026-10-21') {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(new Date(`${day}T12:00:00Z`));
  });
  afterEach(() => vi.useRealTimers());
}
