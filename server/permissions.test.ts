import { describe, expect, it } from 'vitest';
import { seedState } from '../src/engine/seed';
import { can, visibleState, type Membership } from './permissions';

const m = (role: Membership['role'], siteIds: string[] | null = null, employeeId: string | null = null): Membership => ({ role, siteIds, employeeId });

describe('permissions', () => {
  it('scopes a GM to their sites', () => {
    expect(can(m('gm', ['mar']), 'rota.edit', 'mar')).toBe(true);
    expect(can(m('gm', ['mar']), 'rota.edit', 'shd')).toBe(false);
  });

  it('keeps the tronc scheme out of the owner’s hands', () => {
    expect(can(m('owner'), 'tronc.edit', 'mar')).toBe(false);
    expect(can(m('troncmaster', ['mar'], 'mar-8'), 'tronc.edit', 'mar')).toBe(true);
  });

  it('separates approving labour from creating it', () => {
    expect(can(m('finance'), 'clock.approve', 'mar')).toBe(true);
    expect(can(m('finance'), 'rota.edit', 'mar')).toBe(false);
  });

  it('shows staff only themselves', () => {
    const state = seedState('2026-10-21');
    const seen = visibleState(state, m('staff', ['mar'], 'mar-13'));
    expect(seen.employees.map((e) => e.id)).toEqual(['mar-13']);
    expect(seen.forecast).toEqual([]);
    expect(seen.troncSchemes).toEqual([]);
  });
});
