import { describe, expect, it } from 'vitest';
import { hashPassword } from './passwords';
import { account, kit, type Kit } from './testkit';

// A person's own account: ending their other sessions, and an email address changed for them.

const GRACE = 'grace@marylebonegroup.example';
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('sign out of other devices', () => {
  it('ends every other session and keeps this one', async () => {
    const k = await kit();
    const phone = await k.as(GRACE);
    const laptop = await k.as(GRACE);
    await tick();
    const res = await k.call('POST', '/auth/sessions/end-others', laptop);
    expect(res.status).toBe(200);
    expect(res.cookie).toBeTruthy();
    expect((await k.call('GET', '/v1/me', phone)).status).toBe(401);
    expect((await k.call('GET', '/v1/me', res.cookie!)).body.user.id).toBe('usr_sup');
    // The password still works, and the step is on the person's record.
    expect((await k.store.getUser(GRACE))?.hash).toBeTruthy();
    const org = await k.store.load('demo');
    expect(org.audit.at(-1)).toMatchObject({ action: 'access.other_sessions_ended', detail: { userId: 'usr_sup' } });
  });

  it('needs a session', async () => {
    const k = await kit();
    expect((await k.call('POST', '/auth/sessions/end-others', null)).status).toBe(401);
  });
});

const OWNER = { key: 'owner' };
const KEYS = [{ key: 'owner', orgId: 'demo', name: 'Owner key', scopes: ['*' as const], userId: 'usr_owner', mfa: true }];
const PRIYA = 'priya@marylebonegroup.example';
const NEW = 'priya.shah@example.com';
const PASSWORD = 'a long enough password';
const tokenOf = (url: string) => decodeURIComponent(url.split('#email=')[1]);

async function withPriya(): Promise<Kit> {
  const k = await kit({ keys: KEYS as never });
  await k.store.updateUser(PRIYA, await hashPassword(PASSWORD));
  return k;
}

describe('changing a person\'s email', () => {
  it('moves the account and its record once the person confirms with their password', async () => {
    const k = await withPriya();
    const before = await k.as(PRIYA);
    const asked = await k.call('POST', '/v1/users/usr_gm_mar/email', OWNER, { email: ' Priya.Shah@Example.com ' });
    expect(asked.status).toBe(200);
    // Email is not set up in the tests, so the link comes back to hand over.
    expect(asked.body).toMatchObject({ to: NEW, emailed: false });
    const token = tokenOf(asked.body.inviteUrl);
    expect((await k.call('GET', '/v1/users/usr_gm_mar', OWNER)).body.pendingEmail).toMatchObject({ to: NEW, requestedBy: 'Olivia Grant' });

    // The link says who it is for, and nothing changes until the password is given.
    expect((await k.call('POST', '/auth/email-change', null, { token })).body).toMatchObject({ name: 'Priya Shah', from: PRIYA, to: NEW, needsPassword: true });
    expect((await k.call('POST', '/auth/email-change', null, { token, password: 'not it' })).status).toBe(400);
    expect(await k.store.getUser(PRIYA)).not.toBeNull();

    const done = await k.call('POST', '/auth/email-change', null, { token, password: PASSWORD });
    expect(done.status).toBe(200);
    expect(done.body.signedIn).toBe(true);
    expect(await k.store.getUser(PRIYA)).toBeNull();
    expect((await k.store.getUser(NEW))?.hash).toBeTruthy();
    // The old session is over; the new one is the same person, roles and all.
    expect((await k.call('GET', '/v1/me', before)).status).toBe(401);
    const me = (await k.call('GET', '/v1/me', done.cookie!)).body;
    expect(me.user).toMatchObject({ id: 'usr_gm_mar', email: NEW });
    expect(me.permissions).toContain('rota.publish');
    // The link works once, and the change is on the record.
    expect((await k.call('POST', '/auth/email-change', null, { token, password: PASSWORD })).status).toBe(410);
    const trail = (await k.call('GET', '/v1/access/audit?userId=usr_gm_mar', OWNER)).body.map((e: { action: string }) => e.action);
    expect(trail.slice(0, 2)).toEqual(['user.email_changed', 'user.email_change_requested']);
  });

  it('refuses a change nobody else asked for, an address in use, and one the person did not confirm', async () => {
    const k = await withPriya();
    const priya = await k.as(PRIYA);
    // Nobody changes their own email, so a stolen session cannot move an account.
    expect((await k.call('POST', '/v1/users/usr_owner/email', OWNER, { email: 'olivia@example.com' })).status).toBe(403);
    expect((await k.call('POST', '/v1/users/usr_gm_mar/email', priya, { email: NEW })).status).toBe(403);
    expect((await k.call('POST', '/v1/users/usr_gm_mar/email', OWNER, { email: 'grace@marylebonegroup.example' })).status).toBe(409);
    await k.store.createUser(account('taken@example.com', 'acme'));
    expect((await k.call('POST', '/v1/users/usr_gm_mar/email', OWNER, { email: 'taken@example.com' })).body.error).toBe('exists');
    expect((await k.call('POST', '/v1/users/usr_gm_mar/email', OWNER, { email: 'not an email' })).status).toBe(400);

    // Withdrawn before it was confirmed: the link stops working and nothing moves.
    const asked = await k.call('POST', '/v1/users/usr_gm_mar/email', OWNER, { email: NEW });
    expect((await k.call('DELETE', '/v1/users/usr_gm_mar/email', OWNER)).status).toBe(200);
    expect((await k.call('POST', '/auth/email-change', null, { token: tokenOf(asked.body.inviteUrl), password: PASSWORD })).status).toBe(410);
    expect(await k.store.getUser(PRIYA)).not.toBeNull();
    expect((await k.call('POST', '/auth/email-change', null, { token: 'demo.forged' })).status).toBe(410);
  });

  it('moves an invitation that has not been accepted without asking for a password', async () => {
    const k = await withPriya();
    const invite = await k.call('POST', '/v1/users', OWNER, { email: 'typo@exmaple.com', name: 'Ama Boateng', audience: 'operator', roleId: 'supervisor', siteIds: ['shd'] });
    const id = invite.body.user.id;
    const asked = await k.call('POST', `/v1/users/${id}/email`, OWNER, { email: 'ama@example.com' });
    const token = tokenOf(asked.body.inviteUrl);
    expect((await k.call('POST', '/auth/email-change', null, { token })).body.needsPassword).toBe(false);
    const done = await k.call('POST', '/auth/email-change', null, { token, password: '' });
    expect(done.body).toMatchObject({ ok: true, signedIn: false });
    expect((await k.call('GET', `/v1/users/${id}`, OWNER)).body.email).toBe('ama@example.com');
  });
});
