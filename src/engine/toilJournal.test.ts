import { describe, expect, it } from 'vitest';
import { toilLines } from './journal';
import type { RotaState } from './types';

// TOIL owed in the weekly reversing accrual: the full balance each week, so the P&L takes the movement.

const state = {
  entities: [{ id: 'co', name: 'Co' }, { id: 'hold', name: 'Holdings' }],
  sites: [{ id: 'ck', name: 'Clerkenwell', entityId: 'co', trackingCode: 'CK' }],
  employees: [
    { id: 'a', name: 'A', entityId: 'co', siteId: 'ck', payBasis: 'hourly', hourlyRate: 12, contractedHours: 40, toil: [{ id: 't', kind: 'opening', date: '2026-10-01', hours: 10, by: 'x', at: 'x' }] },
    { id: 'b', name: 'B', entityId: 'hold', siteId: 'ck', payBasis: 'hourly', hourlyRate: 20, contractedHours: 40, toil: [{ id: 't', kind: 'earned', date: '2026-10-01', hours: 5, by: 'x', at: 'x' }, { id: 'u', kind: 'taken', date: '2026-11-20', hours: -5, by: 'x', at: 'x' }] },
    { id: 'c', name: 'C', entityId: 'co', siteId: 'ck', payBasis: 'hourly', hourlyRate: 12, contractedHours: 40 },
  ],
} as unknown as RotaState;

describe('TOIL in the labour accrual', () => {
  it('posts each employer the TOIL owed at the week end, with employer NI, balanced, tracked where it can be', () => {
    const lines = toilLines(state, '2026-11-08', 'Preshift Rota labour accrual w/e 2026-11-08');
    expect(lines.map((l) => [l.entityId, l.description, l.accountCode, l.amount, l.trackingOption])).toEqual([
      ['co', 'TOIL owed', '7008', 138, 'CK'],
      ['co', 'TOIL accrual', '2210', -138, 'CK'],
      ['hold', 'TOIL owed (Clerkenwell)', '7008', 115, ''],
      ['hold', 'TOIL accrual (Clerkenwell)', '2210', -115, ''],
    ]);
  });

  it('posts nothing once the TOIL is taken', () => {
    expect(toilLines(state, '2026-11-22', 'x').filter((l) => l.entityId === 'hold')).toEqual([]);
  });
});
