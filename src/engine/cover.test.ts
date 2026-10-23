import { describe, expect, it } from 'vitest';
import { defaultRounds, minutesUntil, nextRoundOffers, roundDue, roundOf, type CoverRequest } from './cover';

const request = (over: Partial<CoverRequest> = {}): CoverRequest => ({
  id: 'r', siteId: 'mar', roleId: 'bar', date: '2026-10-24', startMinute: 17 * 60, endMinute: 23 * 60,
  firstToAccept: true, publish: true, closes: { date: '2026-10-24', minute: 17 * 60 }, status: 'open',
  createdAt: '2026-10-21T10:00:00.000Z', createdBy: 'Priya',
  rounds: { size: 2, everyMinutes: 30 },
  nextRoundAt: '2026-10-21T10:30:00.000Z',
  offers: ['a', 'b', 'c', 'd', 'e'].map((employeeId, i) => ({ employeeId, marginal: 50 + i, borrowed: false, round: roundOf(i, { size: 2, everyMinutes: 30 }), ...(i < 2 ? { offeredAt: '2026-10-21T10:00:00.000Z' } : {}) })),
  ...over,
});
const at = (iso: string) => ({ iso, london: { date: iso.slice(0, 10), minute: Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16)) + 60 } });

describe('cover rounds', () => {
  it('splits people into rounds in the order given, cheapest first', () => {
    expect([0, 1, 2, 3, 4].map((i) => roundOf(i, { size: 2, everyMinutes: 30 }))).toEqual([1, 1, 2, 2, 3]);
    expect(roundOf(7, undefined)).toBe(1);
  });

  it('goes when its time comes, when everyone asked has said no, and all at once when time is short', () => {
    const early = at('2026-10-21T10:29:00.000Z');
    expect(roundDue(request(), early.iso, early.london)).toBeNull();
    const due = at('2026-10-21T10:30:00.000Z');
    expect(roundDue(request(), due.iso, due.london)).toBe('time');
    const r = request();
    r.offers[0].response = 'declined';
    r.offers[1].refused = 'On leave';
    expect(roundDue(r, early.iso, early.london)).toBe('all_declined');
    const closing = { iso: '2026-10-24T15:31:00.000Z', london: { date: '2026-10-24', minute: 16 * 60 + 31 } };
    expect(roundDue(request(), closing.iso, closing.london)).toBe('closing');
    expect(roundDue(request({ status: 'filled' }), due.iso, due.london)).toBeNull();
    expect(roundDue(request({ rounds: undefined }), due.iso, due.london)).toBeNull();
  });

  it('asks the next round, or everyone left', () => {
    expect(nextRoundOffers(request()).map((o) => o.employeeId)).toEqual(['c', 'd']);
    expect(nextRoundOffers(request(), true).map((o) => o.employeeId)).toEqual(['c', 'd', 'e']);
    const r = request();
    r.offers[2].skipped = 'On leave';
    expect(nextRoundOffers(r).map((o) => o.employeeId)).toEqual(['d']);
  });

  it('defaults to three every half hour only with time to spare and more than three to ask', () => {
    expect(defaultRounds(8, 24 * 60)).toEqual({ size: 3, everyMinutes: 30 });
    expect(defaultRounds(3, 24 * 60)).toBeUndefined();
    expect(defaultRounds(8, 5 * 60)).toBeUndefined();
    expect(minutesUntil({ date: '2026-10-23', minute: 1430 }, { date: '2026-10-24', minute: 10 })).toBe(20);
  });
});
