import { describe, expect, it } from 'vitest';
import { account, kit, tokenOf, type Kit } from './testkit';

const KEYS = [
  { key: 'owner', orgId: 'demo', name: 'Owner key', scopes: ['*' as const], userId: 'usr_owner', mfa: true },
  { key: 'gm', orgId: 'demo', name: 'Priya key', scopes: ['users:manage' as const], userId: 'usr_gm_mar', mfa: true },
  { key: 'rota', orgId: 'demo', name: 'Rota only', scopes: ['rota:read' as const] },
  { key: 'other', orgId: 'acme', name: 'Other org', scopes: ['*' as const] },
];

let current: Kit;

async function setup() {
  current = await kit({ keys: KEYS as never });
  return async (method: string, url: string, body?: unknown, key: string | null = 'owner') => current.call(method, url, key ? { key } : null, body);
}

describe('users and access', () => {
  it('needs the users scope, and keeps organisations apart', async () => {
    const call = await setup();
    expect((await call('GET', '/v1/users', undefined, 'rota')).status).toBe(403);
    // An integration key never manages people, in its own organisation or any other.
    expect((await call('GET', '/v1/users', undefined, 'other')).status).toBe(403);
    expect((await call('GET', '/v1/users/usr_owner', undefined, 'other')).status).toBe(403);
  });

  it('shows a GM only the people at their site', async () => {
    const call = await setup();
    const list = (await call('GET', '/v1/users', undefined, 'gm')).body as { id: string }[];
    const ids = list.map((u) => u.id);
    expect(ids).toContain('usr_sup');
    expect(ids).not.toContain('usr_gm_shd');
    expect(ids).not.toContain('usr_ws_partner');
  });

  it('invites, accepts once, and records every step', async () => {
    const call = await setup();
    const res = await call('POST', '/v1/users', { email: 'New.Host@Example.com', name: 'Ama Boateng', audience: 'operator', roleId: 'supervisor', siteIds: ['shd'] });
    expect(res.status).toBe(201);
    expect(res.body.user.status).toBe('invited');
    expect(res.body.user.email).toBe('new.host@example.com');
    const token = tokenOf(res.body.inviteUrl);
    expect((await call('POST', '/v1/users', { email: 'new.host@example.com', name: 'Again', audience: 'operator', roleId: 'viewer' })).status).toBe(409);
    const accept = await current.form('/auth/accept', { token, password: 'long enough password', confirm: 'long enough password' });
    expect(accept.location).toBe('/app/');
    expect((await current.form('/auth/accept', { token, password: 'long enough password', confirm: 'long enough password' })).location).toMatch(/error=badlink/);
    const trail = (await call('GET', `/v1/access/audit?userId=${res.body.user.id}`)).body.map((e: { action: string }) => e.action);
    expect(trail).toEqual(['invite.accepted', 'user.invited', 'membership.granted']);
  });

  it('refuses a broken grant without creating the account', async () => {
    const call = await setup();
    const res = await call('POST', '/v1/users', { email: 'aud@example.com', name: 'Auditor', audience: 'external', roleId: 'external_auditor' });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/end date/);
    expect((await call('GET', '/v1/users')).body.some((u: { email: string }) => u.email === 'aud@example.com')).toBe(false);
  });

  it('asks for confirmation on paired duties and keeps the accepted reason', async () => {
    const call = await setup();
    const first = await call('POST', '/v1/users/usr_ops/grants', { roleId: 'payroll_manager', siteIds: null });
    expect(first.status).toBe(409);
    expect(first.body.error).toBe('needs_confirmation');
    const second = await call('POST', '/v1/users/usr_ops/grants', { roleId: 'payroll_manager', acceptWarnings: true });
    expect(second.status).toBe(201);
    expect(second.body.note).toMatch(/ghost employee/);
  });

  it('stops people changing their own access and protects the last administrator', async () => {
    const call = await setup();
    expect((await call('POST', '/v1/users/usr_owner/suspend')).body.message).toMatch(/Somebody else/);
    // Remove the other two administrators, then the system key cannot remove the owner either.
    // Someone signed in with no access record acts organisation-wide, and is still bound by the rule.
    await current.store.createUser(account('norecord@example.com'));
    const norecord = await current.as('norecord@example.com');
    expect((await current.call('POST', '/v1/users/bulk', norecord, { action: 'suspend', userIds: ['usr_ops', 'usr_ws_partner', 'usr_owner'] })).body).toMatchObject({ done: 2, failed: 1 });
    const last = await current.call('DELETE', '/v1/users/usr_owner/grants/mem_owner_1', norecord);
    expect(last.status).toBe(403);
    expect(last.body.message).toMatch(/nobody able to manage access/);
  });

  it('extends and revokes roles, keeping the record', async () => {
    const call = await setup();
    expect((await call('PATCH', '/v1/users/usr_gm_mar', { employeeId: null })).body.employeeId).toBeUndefined();
    const ext = await call('PATCH', '/v1/users/usr_auditor/grants/mem_auditor_1', { ends: '2027-01-31' });
    expect(ext.body.ends).toBe('2027-01-31');
    const rev = await call('DELETE', '/v1/users/usr_sup/grants/mem_sup_1', undefined, 'gm');
    expect(rev.status).toBe(200);
    expect(rev.body).toMatchObject({ active: false, revokedBy: 'Priya Shah' });
  });

  it('resends and withdraws invitations, with a limit on resends', async () => {
    const call = await setup();
    for (let i = 0; i < 3; i++) expect((await call('POST', '/v1/users/usr_am_shd/resend-invite')).status).toBe(200);
    expect((await call('POST', '/v1/users/usr_am_shd/resend-invite')).status).toBe(429);
    expect((await call('DELETE', '/v1/users/usr_am_shd/invite')).status).toBe(200);
    expect((await call('GET', '/v1/users/usr_am_shd')).status).toBe(404);
    expect((await call('DELETE', '/v1/users/usr_sup/invite')).status).toBe(409);
  });

  it('reports health and records reviews', async () => {
    const call = await setup();
    const health = (await call('GET', '/v1/access/health')).body;
    expect(health.attention.some((a: { kind: string }) => a.kind === 'self_approval')).toBe(true);
    expect(health.coverage.sites.mar['time.approve']).toContain('usr_gm_mar');
    expect((await call('POST', '/v1/access/reviews', { note: 'Q4 review' })).status).toBe(201);
    expect((await call('GET', '/v1/access/health')).body.attention.some((a: { kind: string }) => a.kind === 'review_due')).toBe(false);
    expect((await call('GET', '/v1/me')).body.user.id).toBe('usr_owner');
  });
});
