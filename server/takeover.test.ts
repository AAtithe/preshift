import { describe, expect, it } from 'vitest';
import { emailSetting } from './mail';
import { enrol, kit, tokenOf } from './testkit';

// Resetting a password or an authenticator, or sending a fresh invitation, can end with whoever holds
// the link holding the account. These tests walk the takeover that was possible before: the operations
// director reset the people manager's password and authenticator, had the link handed to him, set a
// password, enrolled his own phone and read every case.
const KEYS = [
  { key: 'james', orgId: 'demo', name: 'James', scopes: ['*'] as ['*'], userId: 'usr_ops', mfa: true }, // operations director
  { key: 'olivia', orgId: 'demo', name: 'Olivia', scopes: ['*'] as ['*'], userId: 'usr_owner', mfa: true }, // owner
  { key: 'sam', orgId: 'demo', name: 'Sam', scopes: ['*'] as ['*'], userId: 'usr_ws_partner', mfa: true }, // WS client partner
];
const james = { key: 'james' };
const olivia = { key: 'olivia' };
const sam = { key: 'sam' };
const EMAIL = { resendApiKey: 're_test_1234567890abcd', from: 'Preshift <rota@ws.example>', appUrl: 'https://rota.ws.example' };

describe('taking over an account that holds more than you could grant', () => {
  it('stops the operations director at the first step, for the people manager and the owner', async () => {
    const k = await kit({ keys: KEYS });
    for (const id of ['usr_people', 'usr_owner']) {
      const pw = await k.call('POST', `/v1/users/${id}/reset-password`, james, { handOver: true });
      expect(pw.status).toBe(403);
      expect(pw.body.message).toContain('could hand you their account');
      expect(pw.raw).not.toMatch(/#reset=/);
      expect((await k.call('POST', `/v1/users/${id}/reset-authenticator`, james, {})).status).toBe(403);
    }
    // In bulk too: each person is checked on their own.
    const bulk = await k.call('POST', '/v1/users/bulk', james, { action: 'reset-authenticator', userIds: ['usr_owner', 'usr_area'] });
    expect(bulk.body.results.map((r: { ok: boolean }) => r.ok)).toEqual([false, true]);
  });

  it('still lets him reset someone whose roles he could grant, and hand that link over', async () => {
    const k = await kit({ keys: KEYS });
    const pw = await k.call('POST', '/v1/users/usr_gm_mar/reset-password', james, { handOver: true });
    expect(pw.status).toBe(200);
    expect(pw.body.inviteUrl).toMatch(/#reset=/);
    expect((await k.call('POST', '/v1/users/usr_area/reset-authenticator', james, {})).status).toBe(200);
  });

  it('sends a link to an account with strong rights only to its own email, even when the owner asks', async () => {
    const k = await kit({ keys: KEYS });
    // The owner may reset the finance director, but never be handed the link: it opens sending pay.
    const noEmail = await k.call('POST', '/v1/users/usr_fd/reset-password', olivia, {});
    expect(noEmail.status).toBe(409);
    expect(noEmail.body.error).toBe('email_only');
    expect(noEmail.raw).not.toMatch(/#reset=/);
    await k.store.setSetting(emailSetting('demo'), JSON.stringify(EMAIL));
    const handed = await k.call('POST', '/v1/users/usr_fd/reset-password', olivia, { handOver: true });
    expect(handed.status).toBe(409);
    expect(handed.body.message).toContain('It cannot be handed over');
    expect(handed.raw).not.toMatch(/#reset=/);
  });

  it('applies the same to a fresh invitation for a powerful role', async () => {
    const k = await kit({ keys: KEYS });
    // Inviting is unchanged: the owner can still hand over the first link for a new payroll manager.
    const made = await k.call('POST', '/v1/users', olivia, { email: 'pm@example.com', name: 'New Payroll', audience: 'operator', roleId: 'payroll_manager' });
    expect(made.status).toBe(201);
    const id = made.body.user?.id ?? made.body.id;
    // A resend could hand over the identity before the real person accepts.
    expect((await k.call('POST', `/v1/users/${id}/resend-invite`, james, { handOver: true })).status).toBe(403);
    const resent = await k.call('POST', `/v1/users/${id}/resend-invite`, olivia, { handOver: true });
    expect(resent.status).toBe(409);
    expect(resent.raw).not.toMatch(/#invite=/);
  });

  it('keeps Williams, Stanley & Co. out of a client\'s own accounts, and lets it run its own', async () => {
    const k = await kit({ keys: KEYS });
    for (const [method, url] of [
      ['POST', '/v1/users/usr_owner/reset-password'],
      ['POST', '/v1/users/usr_owner/reset-authenticator'],
      ['POST', '/v1/users/usr_gm_mar/suspend'],
    ] as const) {
      const res = await k.call(method, url, sam, { handOver: true });
      expect(res.status).toBe(403);
      expect(res.body.message).toContain("never changes the accounts of a client's own people");
    }
    expect((await k.call('POST', '/v1/users/usr_ws_ma/reset-authenticator', sam, {})).status).toBe(200);
  });

  it('cannot be completed end to end any more', async () => {
    const k = await kit({ keys: KEYS });
    const pw = await k.call('POST', '/v1/users/usr_people/reset-password', james, { handOver: true });
    expect(pw.body.inviteUrl).toBeUndefined();
    // For contrast, the same chain on someone he may reset gives him only what he already holds.
    const gm = await k.call('POST', '/v1/users/usr_gm_mar/reset-password', james, { handOver: true });
    const done = await k.call('POST', '/auth/reset', null, { token: tokenOf(gm.body.inviteUrl), password: 'a passphrase james chose' });
    expect(done.status).toBe(200);
    let session = done.cookie!;
    try {
      session = (await enrol(k, session)).cookie;
    } catch {
      // A GM's role does not need an authenticator; the session works without one.
    }
    expect((await k.call('GET', '/v1/hr/records?kind=case', session)).body).toEqual([]);
  });
});
