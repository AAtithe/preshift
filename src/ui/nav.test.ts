import { can, roleOf, ROLES, type User } from '../engine/access';
import { NAV, NAV_ITEMS, offered, sitesFor, visibleNav } from './nav';
import type { Allow } from './permissions';

describe('management bar', () => {
  it('lists each section once', () => {
    const ids = NAV_ITEMS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has no empty groups', () => {
    for (const g of NAV) expect(g.items.length).toBeGreaterThan(0);
  });

  it('only offers build and clear on week sections', () => {
    for (const t of NAV_ITEMS.filter((t) => t.plans)) expect(t.scope).toBe('week');
  });

  it('never asks for a site on an organisation section', () => {
    for (const t of NAV_ITEMS.filter((t) => t.siteOnly)) expect(t.scope).not.toBe('org');
  });

  it('only gives organisation sections a heading of their own', () => {
    for (const t of NAV_ITEMS.filter((t) => t.title)) expect(t.scope).toBe('org');
  });
});

// What each role is offered, worked out with the same rules the API enforces.
const TODAY = '2026-10-22';
const SITES = ['a', 'b', 'c'];

function person(roleId: string, siteIds: string[] | null = null): User {
  return {
    id: roleId, email: `${roleId}@example.com`, name: roleId, audience: roleOf(roleId)!.audience,
    status: 'active', mfaEnrolled: true, createdAt: TODAY,
    memberships: [{ id: 'm', roleId, siteIds, starts: '2026-01-01', active: true, grantedBy: 'test', grantedAt: TODAY }],
  };
}
const allowFor = (u: User): Allow => (p, s) => can(u, p, TODAY, s);
const seen = (u: User, sites = SITES) => visibleNav(allowFor(u), sites).flatMap((g) => g.items.map((t) => t.label));

describe('who sees which sections', () => {
  it('requires every section to say who it is for', () => {
    for (const t of NAV_ITEMS) {
      if (t.access === 'everyone') continue;
      expect((t.access.scope ?? []).length + (t.access.org ?? []).length).toBeGreaterThan(0);
    }
  });

  it('gives everyone their own profile and the help, whatever their role', () => {
    for (const r of ROLES) {
      const u = person(r.id, r.scope === 'sites' ? ['a'] : null);
      expect(seen(u)).toEqual(expect.arrayContaining(['Your profile', 'How to']));
    }
  });

  it('shows a supervisor the rota and clock in, and nothing with money or people in it', () => {
    const shown = seen(person('supervisor', ['a']));
    expect(shown).toEqual(expect.arrayContaining(['Rota', 'Calendar', 'Clock in']));
    for (const hidden of ['Sites', 'Forecast', 'Demand', 'Coach', 'Staff', 'Messages', 'HR overview', 'Cases', 'Labour cost', 'Reports', 'Programme', 'Close', 'Pay approvals', 'Set-up', 'Access', 'GDPR', 'Integrations', 'Settings']) {
      expect(shown).not.toContain(hidden);
    }
  });

  it('offers Clients to Williams, Stanley & Co. people only, however much else someone holds', () => {
    const clients = (u: User) => visibleNav(allowFor(u), SITES, u.audience).flatMap((g) => g.items.map((t) => t.id)).includes('clients');
    expect(clients(person('ws_partner'))).toBe(true);
    expect(clients(person('ws_accountant'))).toBe(true);
    expect(clients(person('owner'))).toBe(false);
    expect(clients(person('external_auditor'))).toBe(false);
  });

  it('keeps HR files and cases to those who hold them', () => {
    expect(seen(person('viewer'))).not.toContain('HR overview');
    expect(seen(person('finance_director'))).not.toContain('Cases');
    expect(seen(person('people_manager'))).toEqual(expect.arrayContaining(['HR overview', 'Cases']));
  });

  it('offers a site role its section across the group, but only at its own sites', () => {
    const gm = person('general_manager', ['a']);
    expect(seen(gm)).toContain('Rota');
    const rota = NAV_ITEMS.find((t) => t.id === 'rota')!;
    expect(sitesFor(rota, allowFor(gm), SITES)).toEqual(['a']);
    expect(offered(rota, allowFor(gm), ['b', 'c'])).toBe(false);
  });

  it('withholds what needs an authenticator from someone who has not set one up', () => {
    const owner = { ...person('owner'), mfaEnrolled: false };
    const shown = seen(owner);
    for (const strong of ['Close', 'Cases', 'Set-up', 'GDPR']) expect(shown).not.toContain(strong);
  });
});
