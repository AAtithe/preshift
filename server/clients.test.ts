import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emailSetting } from './mail';
import { kit, tokenOf, type Kit } from './testkit';

// Clients: a WS client partner lists the clients they hold a role in and adds new ones. Each new
// client is its own organisation, with the partner as its WS client partner and an owner invited by
// email only. WS never holds the owner's link, and no client sees another.

const SAM = 'sam.okoro@williamsstanley.example';
const SAM_MFA = 'demo-usr_ws_partner';
const EMAIL = { resendApiKey: 're_test_1234567890abcd', from: 'Preshift <rota@ws.example>', appUrl: 'https://rota.ws.example' };
const OWNER = { email: 'ben@harbour.example', password: 'bens own long password' };

let sent: { to: string[]; text: string }[] = [];
beforeEach(() => {
  sent = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    if (url !== 'https://api.resend.com/emails') throw new Error(`unexpected fetch ${url}`);
    sent.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ id: `mail-${sent.length}` }), { status: 200 });
  });
});
afterEach(() => vi.unstubAllGlobals());

async function setUp(email = true) {
  const k = await kit();
  if (email) await k.store.setSetting(emailSetting('demo'), JSON.stringify(EMAIL));
  const sam = await k.as(SAM, SAM_MFA);
  return { k, sam };
}

const add = (k: Kit, who: string, body: Record<string, string> = { name: 'Harbour Kitchens Ltd', ownerName: 'Ben Shaw', ownerEmail: OWNER.email }) =>
  k.call('POST', '/v1/clients', who, body);

describe('clients', () => {
  it('lists the clients a WS person holds a role in, and only to them', async () => {
    const { k, sam } = await setUp();
    const mine = await k.call('GET', '/v1/clients', sam);
    expect(mine.status).toBe(200);
    expect(mine.body.canAdd).toBe(true);
    expect(mine.body.clients.map((c: { orgId: string }) => c.orgId)).toEqual(['demo']);
    expect(mine.body.clients[0]).toMatchObject({ current: true, roles: ['ws_partner'] });

    // The client's own owner holds no WS role: their list is empty and they cannot add one.
    const olivia = await k.as('olivia@marylebonegroup.example', 'demo-usr_owner');
    expect((await k.call('GET', '/v1/clients', olivia)).body).toEqual({ clients: [], canAdd: false });
    expect((await add(k, olivia)).status).toBe(403);
  });

  it('adds a client with the partner on it and the owner invited by email alone', async () => {
    const { k, sam } = await setUp();
    const res = await add(k, sam);
    expect(res.status).toBe(201);
    expect(res.body.emailed).toBe(true);
    expect(res.raw).not.toMatch(/#invite=/);
    expect(res.body.client).toMatchObject({ name: 'Harbour Kitchens Ltd', stage: 'invited', owner: { name: 'Ben Shaw', status: 'invited' } });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual([OWNER.email]);

    const orgId = res.body.client.orgId as string;
    const client = await k.store.load(orgId);
    expect(client.state.sites).toEqual([]);
    expect(client.users.map((u) => [u.email, u.audience, u.status, u.memberships[0].roleId])).toEqual([
      [SAM, 'ws', 'active', 'ws_partner'],
      [OWNER.email, 'operator', 'invited', 'owner'],
    ]);
    expect((await k.store.getUser(SAM))!.orgs).toContain(orgId);
    // The partner now sees both, and the new one is on their switcher.
    expect((await k.call('GET', '/v1/clients', sam)).body.clients.map((c: { orgId: string }) => c.orgId).sort()).toEqual(['demo', orgId].sort());

    // The owner accepts from their inbox, at home in the new client, and runs its access from there.
    const token = decodeURIComponent(/#invite=([^\s"<]+)/.exec(sent[0].text)![1]);
    expect(tokenOf(`/login#invite=${token}`).startsWith(`${orgId}.`)).toBe(true);
    const accepted = await k.form('/auth/accept', { token, password: OWNER.password, confirm: OWNER.password });
    expect(accepted.location).toBe('/app/');
    expect((await k.store.getUser(OWNER.email))!.orgId).toBe(orgId);
    const after = (await k.call('GET', '/v1/clients', sam)).body.clients.find((c: { orgId: string }) => c.orgId === orgId);
    expect(after).toMatchObject({ stage: 'setting-up', owner: { status: 'active' } });
    // Once accepted, WS cannot send the owner anything more.
    expect((await k.call('POST', `/v1/clients/${orgId}/owner-invite`, sam)).status).toBe(409);
  });

  it('never hands the owner\'s link over: without email nothing is made', async () => {
    const { k, sam } = await setUp(false);
    const res = await add(k, sam);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('email_only');
    expect(res.raw).not.toMatch(/#invite=/);
    expect((await k.store.orgIds()).filter((id) => id.startsWith('org-'))).toEqual([]);
  });

  it('needs the authenticator, a key will not do, and the owner is never the partner', async () => {
    const { k } = await setUp();
    const unproved = await k.as(SAM);
    expect((await add(k, unproved)).status).toBe(403);
    expect((await k.call('GET', '/v1/clients', unproved)).body.canAdd).toBe(false);
    const sam = await k.as(SAM, SAM_MFA);
    expect((await add(k, sam, { name: 'X Ltd', ownerName: 'Sam', ownerEmail: SAM })).status).toBe(422);
    expect((await add(k, sam, { name: 'X Ltd', ownerName: 'Sam', ownerEmail: 'not an email' })).status).toBe(400);
  });

  it('resends only to a waiting owner, only for the partner\'s own clients, at most three an hour', async () => {
    const { k, sam } = await setUp();
    const orgId = (await add(k, sam)).body.client.orgId as string;
    // Creating it was the first send this hour; two more go, the fourth is refused.
    expect((await k.call('POST', `/v1/clients/${orgId}/owner-invite`, sam)).body.emailed).toBe(true);
    expect((await k.call('POST', `/v1/clients/${orgId}/owner-invite`, sam)).status).toBe(200);
    expect((await k.call('POST', `/v1/clients/${orgId}/owner-invite`, sam)).status).toBe(429);
    expect(sent.every((m) => m.to[0] === OWNER.email)).toBe(true);
    // An organisation the partner is not on reads as not found, as does the one they are in.
    expect((await k.call('POST', '/v1/clients/acme/owner-invite', sam)).status).toBe(404);
    expect((await k.call('POST', '/v1/clients/demo/owner-invite', sam)).status).toBe(404);
  });
});
