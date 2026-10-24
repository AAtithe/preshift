import { describe, expect, it } from 'vitest';
import { defaultRounds, goingStatus, minutesUntil, nextRoundOffers, roundDue, roundOf, wasAsked } from './cover';
import type { OpenShift } from './types';

const going = (over: Partial<OpenShift> = {}): OpenShift => ({
  id: 'o', siteId: 'mar', roleId: 'bar', date: '2026-10-24', startMinute: 17 * 60, endMinute: 23 * 60, breakMinutes: 30,
  status: 'open', postedBy: 'Priya', postedAt: '2026-10-21T10:00:00.000Z',
  rounds: { size: 2, everyMinutes: 30 },
  nextRoundAt: '2026-10-21T10:30:00.000Z',
  offers: ['a', 'b', 'c', 'd', 'e'].map((employeeId, i) => ({ employeeId, marginal: 50 + i, borrowed: false, round: roundOf(i, { size: 2, everyMinutes: 30 }), ...(i < 2 ? { offeredAt: '2026-10-21T10:00:00.000Z' } : {}) })),
  ...over,
});
const at = (iso: string) => ({ iso, london: { date: iso.slice(0, 10), minute: Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16)) + 60 } });

describe('shifts going in rounds', () => {
  it('splits people into rounds in the order given, cheapest first', () => {
    expect([0, 1, 2, 3, 4].map((i) => roundOf(i, { size: 2, everyMinutes: 30 }))).toEqual([1, 1, 2, 2, 3]);
    expect(roundOf(7, undefined)).toBe(1);
  });

  it('goes when its time comes, when everyone asked has said no, and all at once when time is short', () => {
    const early = at('2026-10-21T10:29:00.000Z');
    expect(roundDue(going(), early.iso, early.london)).toBeNull();
    const due = at('2026-10-21T10:30:00.000Z');
    expect(roundDue(going(), due.iso, due.london)).toBe('time');
    const o = going();
    o.offers![0].declinedAt = '2026-10-21T10:05:00.000Z';
    o.offers![1].refused = 'On leave';
    expect(roundDue(o, early.iso, early.london)).toBe('all_declined');
    // Someone who asked for it and is waiting for a manager has not said no.
    expect(roundDue(o, early.iso, early.london, new Set(['b']))).toBeNull();
    const closing = { iso: '2026-10-24T15:31:00.000Z', london: { date: '2026-10-24', minute: 16 * 60 + 31 } };
    expect(roundDue(going(), closing.iso, closing.london)).toBe('closing');
    expect(roundDue(going({ status: 'filled' }), due.iso, due.london)).toBeNull();
    expect(roundDue(going({ rounds: undefined }), due.iso, due.london)).toBeNull();
  });

  it('asks the next round, or everyone left', () => {
    expect(nextRoundOffers(going()).map((x) => x.employeeId)).toEqual(['c', 'd']);
    expect(nextRoundOffers(going(), true).map((x) => x.employeeId)).toEqual(['c', 'd', 'e']);
    const o = going();
    o.offers![2].skipped = 'On leave';
    expect(nextRoundOffers(o).map((x) => x.employeeId)).toEqual(['d']);
  });

  it('defaults to three every half hour only with time to spare and more than three to ask', () => {
    expect(defaultRounds(8, 24 * 60)).toEqual({ size: 3, everyMinutes: 30 });
    expect(defaultRounds(3, 24 * 60)).toBeUndefined();
    expect(defaultRounds(8, 5 * 60)).toBeUndefined();
    expect(minutesUntil({ date: '2026-10-23', minute: 1430 }, { date: '2026-10-24', minute: 10 })).toBe(20);
  });
});

describe('who a shift going is for', () => {
  it('is for everyone eligible when untargeted, and only those asked, who have not said no, when targeted', () => {
    expect(wasAsked(going({ offers: undefined }), 'z')).toBe(true);
    const o = going();
    expect(wasAsked(o, 'a')).toBe(true);
    expect(wasAsked(o, 'c')).toBe(false);
    o.offers![0].declinedAt = '2026-10-21T10:05:00.000Z';
    expect(wasAsked(o, 'a')).toBe(false);
  });

  it('expires once it starts unfilled', () => {
    expect(goingStatus(going(), { date: '2026-10-24', minute: 17 * 60 - 1 })).toBe('open');
    expect(goingStatus(going(), { date: '2026-10-24', minute: 17 * 60 })).toBe('expired');
    expect(goingStatus(going({ status: 'withdrawn' }), { date: '2026-10-20', minute: 0 })).toBe('withdrawn');
  });
});
