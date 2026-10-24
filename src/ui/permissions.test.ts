import { describe, expect, it } from 'vitest';
import type { Me } from './access/model';
import { allowFor, heldOnceVerified } from './permissions';

// A new owner, straight from sign-up: they hold set-up, but it is off until their authenticator is proved.
const owner = (mfaEnrolled: boolean) =>
  ({
    user: {
      id: 'u', email: 'ben@harbour.example', name: 'Ben Shaw', audience: 'operator', status: 'active', mfaEnrolled, createdAt: '2026-10-24',
      memberships: [{ id: 'm', roleId: 'owner', siteIds: null, starts: '2026-01-01', active: true, grantedBy: 'Sign-up', grantedAt: '2026-10-24' }],
    },
  }) as unknown as Me;

describe('rights waiting on the authenticator', () => {
  it('sees set-up as held, though not yet on, for an owner without an authenticator', () => {
    expect(allowFor(owner(false))('settings.manage')).toBe(false);
    expect(heldOnceVerified(owner(false))('settings.manage')).toBe(true);
    expect(allowFor(owner(true))('settings.manage')).toBe(true);
  });

  it('grants nothing a role does not hold', () => {
    const sup = owner(false);
    sup.user!.memberships = [{ ...sup.user!.memberships[0], roleId: 'supervisor', siteIds: ['a'] }];
    expect(heldOnceVerified(sup)('settings.manage')).toBe(false);
  });
});
