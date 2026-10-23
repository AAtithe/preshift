import { describe, expect, it } from 'vitest';
import { seedUsers } from '../../server/seedUsers';
import { accessHealth, can, checkAuthority, checkGrant, type Actor, type User } from './access';
import { seedState } from './seed';
import { mailAttention, type MailView } from './mail';

const TODAY = '2026-10-21';

function world() {
  const { users, reviews } = seedUsers(TODAY);
  const state = seedState(TODAY);
  const by = (id: string) => users.find((u) => u.id === id)!;
  const as = (id: string): Actor => ({ kind: 'user', user: by(id) });
  const fresh = (audience: User['audience'] = 'operator'): User => ({
    id: 'usr_new', email: 'new@example.com', name: 'New Person', audience, status: 'invited', mfaEnrolled: false, createdAt: TODAY, memberships: [],
  });
  return { users, reviews, state, by, as, fresh };
}

describe('permissions', () => {
  it('scopes site roles to their sites and switches strong rights off without an authenticator', () => {
    const { by } = world();
    by('usr_fd').mfaEnrolled = false;
    expect(can(by('usr_gm_mar'), 'rota.publish', TODAY, 'mar')).toBe(true);
    expect(can(by('usr_gm_mar'), 'rota.publish', TODAY, 'shd')).toBe(false);
    // Nadia's role needs an authenticator she has not set up: she can read cost but not send pay.
    expect(can(by('usr_fd'), 'costs.view', TODAY)).toBe(true);
    expect(can(by('usr_fd'), 'payroll.send', TODAY)).toBe(false);
    expect(can(by('usr_viewer'), 'rota.view', TODAY)).toBe(false);
  });

  it('ends access on the end date', () => {
    const { by } = world();
    const auditor = by('usr_auditor');
    expect(can(auditor, 'audit.view', TODAY)).toBe(true);
    expect(can(auditor, 'audit.view', '2026-12-01')).toBe(false);
  });
});

describe('granting', () => {
  it('lets the owner appoint a payroll manager without holding payroll rights herself', () => {
    const { as, fresh } = world();
    const check = checkGrant(as('usr_owner'), fresh(), { roleId: 'payroll_manager', siteIds: null, starts: TODAY }, TODAY);
    expect(check.errors).toEqual([]);
    expect(check.gains).toContain('payroll.send');
  });

  it('stops anyone granting beyond their own access, or to themselves', () => {
    const { as, by, fresh } = world();
    // The ops director manages access but cannot set pay, so cannot make a people manager.
    expect(checkGrant(as('usr_ops'), fresh(), { roleId: 'people_manager', siteIds: null, starts: TODAY }, TODAY).errors[0]).toMatch(/cannot grant what they do not hold/);
    expect(checkGrant(as('usr_ops'), by('usr_ops'), { roleId: 'viewer', siteIds: null, starts: TODAY }, TODAY).errors[0]).toMatch(/Somebody else/);
  });

  it('lets a GM give site roles at their own site only', () => {
    const { as, fresh } = world();
    expect(checkGrant(as('usr_gm_mar'), fresh(), { roleId: 'supervisor', siteIds: ['mar'], starts: TODAY }, TODAY).errors).toEqual([]);
    expect(checkGrant(as('usr_gm_mar'), fresh(), { roleId: 'supervisor', siteIds: ['shd'], starts: TODAY }, TODAY).errors[0]).toMatch(/sites you manage/);
    expect(checkGrant(as('usr_gm_mar'), fresh(), { roleId: 'viewer', siteIds: null, starts: TODAY }, TODAY).errors[0]).toMatch(/site roles only/);
  });

  it('refuses pay rates with payroll, warns on lesser pairs, and checks across roles', () => {
    const { as, by } = world();
    const system: Actor = { kind: 'system', name: 'Test' };
    // Kate sets pay; adding payroll would let her pay herself a rise.
    expect(checkGrant(system, by('usr_people'), { roleId: 'payroll_manager', siteIds: null, starts: TODAY }, TODAY).errors[0]).toMatch(/^Refused/);
    // James runs the team; adding payroll is the ghost employee risk, allowed only with the warning accepted.
    const warn = checkGrant(as('usr_owner'), by('usr_ops'), { roleId: 'payroll_manager', siteIds: null, starts: TODAY }, TODAY);
    expect(warn.errors).toEqual([]);
    expect(warn.warnings.join(' ')).toMatch(/ghost employee/);
  });

  it('keeps WS and operator appointments apart and requires end dates for outsiders', () => {
    const { as, fresh } = world();
    expect(checkGrant(as('usr_owner'), fresh('ws'), { roleId: 'ws_payroll', siteIds: null, starts: TODAY }, TODAY).errors[0]).toMatch(/WS client partner/);
    expect(checkGrant(as('usr_ws_partner'), fresh('ws'), { roleId: 'ws_payroll', siteIds: null, starts: TODAY }, TODAY).errors).toEqual([]);
    expect(checkGrant(as('usr_ws_partner'), fresh(), { roleId: 'viewer', siteIds: null, starts: TODAY }, TODAY).errors[0]).toMatch(/never appoints inside/);
    expect(checkGrant(as('usr_owner'), fresh('external'), { roleId: 'investor', siteIds: null, starts: TODAY }, TODAY).errors[0]).toMatch(/end date/);
  });
});

describe('removing access', () => {
  it('never leaves the organisation without someone who manages access', () => {
    const { users, by } = world();
    const system: Actor = { kind: 'system', name: 'Test' };
    const others = users.filter((u) => u.id === 'usr_owner' || !u.memberships.some((m) => ['ops_director', 'ws_partner'].includes(m.roleId)));
    expect(checkAuthority(system, by('usr_owner'), others, TODAY, { removesAccess: true })).toMatch(/nobody able to manage access/);
    expect(checkAuthority(system, by('usr_owner'), users, TODAY, { removesAccess: true })).toBeNull();
  });

  it('lets a GM change people at their site but nobody else', () => {
    const { users, as, by } = world();
    expect(checkAuthority(as('usr_gm_mar'), by('usr_sup'), users, TODAY)).toBeNull();
    expect(checkAuthority(as('usr_gm_mar'), by('usr_gm_shd'), users, TODAY)).toMatch(/whole organisation/);
  });
});

describe('health', () => {
  it('finds the control issues a reviewer should see', () => {
    const { users, reviews, state, by } = world();
    // The demo's finance director is set up; take her authenticator away to see the flag.
    by('usr_fd').mfaEnrolled = false;
    const kinds = accessHealth(users, state.sites, state.employees, reviews, TODAY).map((a) => `${a.kind}:${a.userId ?? a.siteId ?? ''}`);
    expect(kinds).toContain('must_enrol:usr_fd');
    expect(kinds).toContain('self_approval:usr_gm_mar');
    expect(kinds).toContain('paired_warn:usr_people');
    expect(kinds).toContain('dormant:usr_area');
    expect(kinds).toContain('invite_expired:usr_am_shd');
    expect(kinds).toContain('ending_soon:usr_auditor');
    expect(kinds).toContain('review_due:');
    expect(kinds).not.toContain('must_enrol:usr_viewer');
  });
});

describe('emails that did not arrive', () => {
  const person = (over: Partial<User>): User => ({ id: 'u1', email: 'ama@example.com', name: 'Ama', audience: 'operator', status: 'invited', mfaEnrolled: false, createdAt: '', memberships: [], ...over });
  const mail = (over: Partial<MailView>): Map<string, MailView> =>
    new Map([['u1', { id: 'm1', to: 'ama@example.com', kind: 'invite', userId: 'u1', sentAt: '2026-10-20T09:00:00Z', by: 'Tom', status: 'bounced', at: '2026-10-20T09:01:00Z', ...over }]]);

  it('flags a bounced invitation while it is unaccepted, and nothing once the person is in or suspended', () => {
    expect(mailAttention([person({})], mail({}))[0]).toMatchObject({ kind: 'email_bounced', severity: 'warn', userId: 'u1' });
    expect(mailAttention([person({ status: 'active' })], mail({}))).toEqual([]);
    expect(mailAttention([person({ status: 'suspended' })], mail({}))).toEqual([]);
    expect(mailAttention([person({})], mail({ status: 'delivered' }))).toEqual([]);
  });

  it('flags a reset that did not arrive only until the person signs in after it', () => {
    const reset = mail({ kind: 'reset', status: 'complained' });
    expect(mailAttention([person({ status: 'active', lastSeenAt: '2026-10-19T08:00:00Z' })], reset)[0].kind).toBe('email_complained');
    expect(mailAttention([person({ status: 'active', lastSeenAt: '2026-10-20T10:00:00Z' })], reset)).toEqual([]);
  });
});
