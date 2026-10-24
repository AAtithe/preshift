import { registerWeek } from './RiskView';

describe('the week Compliance risk reads', () => {
  const asOf = '2026-10-22'; // a Thursday

  it('reads the last closed week when the week picked is still trading', () => {
    expect(registerWeek('2026-10-19', asOf, false)).toEqual({ week: '2026-10-12', closed: true, substituted: true });
    // A week to come has nothing in it at all: the last closed week too.
    expect(registerWeek('2026-10-26', asOf, false)).toMatchObject({ week: '2026-10-12', substituted: true });
  });

  it('reads the open week so far when asked, and a closed week as picked', () => {
    expect(registerWeek('2026-10-19', asOf, true)).toEqual({ week: '2026-10-19', closed: false, substituted: false });
    expect(registerWeek('2026-10-12', asOf, false)).toEqual({ week: '2026-10-12', closed: true, substituted: false });
    expect(registerWeek('2026-09-07', asOf, false)).toMatchObject({ week: '2026-09-07', substituted: false });
  });

  it('counts a week closed from the Monday after its Sunday', () => {
    expect(registerWeek('2026-10-19', '2026-10-25', false)).toMatchObject({ week: '2026-10-12', substituted: true });
    expect(registerWeek('2026-10-19', '2026-10-26', false)).toMatchObject({ week: '2026-10-19', substituted: false });
  });
});
