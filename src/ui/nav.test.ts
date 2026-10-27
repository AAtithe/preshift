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

  it('says in a line what every section is for', () => {
    for (const t of NAV_ITEMS) expect(t.hint.length, t.id).toBeGreaterThan(10);
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

  it('offers money worked from clocked hours only with both the hours and the cost', () => {
    const costed = ['Cut call', 'Clocked vs rota', 'Tronc', 'Prime cost', 'Compliance risk'];
    // A GM holds both at their site, and only there.
    const gm = person('general_manager', ['a']);
    expect(seen(gm)).toEqual(expect.arrayContaining(costed));
    expect(sitesFor(NAV_ITEMS.find((t) => t.id === 'tronc')!, allowFor(gm), SITES)).toEqual(['a']);
    // Finance reads the hours through payroll.
    expect(seen(person('finance_director'))).toEqual(expect.arrayContaining(costed));
    // Cost without the hours, or the hours without cost: the API would refuse half of it.
    for (const role of ['viewer', 'supervisor']) for (const label of [...costed, 'Retention']) expect(seen(person(role, role === 'supervisor' ? ['a'] : null))).not.toContain(label);
    // Retention also reads personnel files.
    expect(seen(person('area_manager', ['a']))).toContain('Retention');
    expect(seen(person('finance_director'))).not.toContain('Retention');
  });

  it('withholds what needs an authenticator from someone who has not set one up', () => {
    const owner = { ...person('owner'), mfaEnrolled: false };
    const shown = seen(owner);
    for (const strong of ['Close', 'Cases', 'Set-up', 'GDPR']) expect(shown).not.toContain(strong);
  });
});

describe('customers', () => {
  it('is offered to WS customer operations alone, not the owner or a client partner', () => {
    const shown = (u: User) => visibleNav(allowFor(u), SITES, u.audience).flatMap((g) => g.items.map((t) => t.label));
    expect(shown(person('ws_customers'))).toContain('Customers');
    for (const r of ['owner', 'ws_partner', 'ws_accountant', 'finance_director']) expect(shown(person(r))).not.toContain('Customers');
  });
});

describe('features switched off', () => {
  it('leave the bar for everyone, owner included, and nothing else changes', () => {
    const owner = person('owner');
    const before = visibleNav(allowFor(owner), SITES).flatMap((g) => g.items.map((t) => t.id));
    const after = visibleNav(allowFor(owner), SITES, owner.audience, new Set(['tronc', 'hr', 'absence'])).flatMap((g) => g.items.map((t) => t.id));
    expect(before).toEqual(expect.arrayContaining(['tronc', 'hr', 'absence', 'features']));
    expect(after).toEqual(before.filter((t) => !['tronc', 'hr', 'absence'].includes(t)));
    expect(offered(NAV_ITEMS.find((t) => t.id === 'profile')!, allowFor(owner), SITES, owner.audience, new Set(['profile']))).toBe(false);
  });

  it('offers the features screen only to those who manage settings', () => {
    expect(seen(person('owner'))).toContain('Features');
    expect(seen(person('ops_director'))).not.toContain('Features');
    expect(seen(person('general_manager', ['a']))).not.toContain('Features');
  });
});

