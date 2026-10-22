import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { newAccount } from './routes/access';
import { DEMO_TOTP_SECRET } from './seedUsers';
import { cookieFrom, createSession, readSession } from './session';
import { MemoryStore, PgStore, type Store } from './store';
import { enrol, enterCode, kit, tokenOf, TODAY, type Kit } from './testkit';

// One person, several organisations: a Williams, Stanley & Co. manager across clients, or a group
// owner with two companies. One account, one password, one authenticator; each organisation
// holds its own access record and controls only that.

const DEMO_OWNER = { key: 'dev-usr_owner', orgId: 'demo', name: 'Demo owner', scopes: ['*'] as ['*'], userId: 'usr_owner', mfa: true };
const AMA = { email: 'ama@ws.example', name: 'Ama Boateng', password: 'amas own long password' };
const BOSS = { email: 'boss@acme.example', password: 'acme owners password' };

const orgOf = async (k: Kit, cookie: string) => (await readSession(cookieFrom(cookie), await k.store.sessionSecret()))!.orgId;

async function twoOrganisations() {
  const store: Store = new MemoryStore(['demo'], TODAY);
  const k = await kit({ store, keys: [DEMO_OWNER] });
  const demoOwner = { key: DEMO_OWNER.key };
  const login = (email: string, password: string) => k.form('/auth/login', { email, password, next: '/app/' });

  // A second organisation with its own owner, whose account is at home there.
  await store.createUser(await newAccount(BOSS.email, 'acme', BOSS.password));
  const acme = await store.load('acme');
  const at = new Date().toISOString();
  acme.users.push({
    id: 'usr_acme_boss', email: BOSS.email, name: 'Acme owner', audience: 'operator', status: 'active', mfaEnrolled: false, createdAt: at, activatedAt: at,
    memberships: [{ id: 'mem_acme_boss', roleId: 'owner', siteIds: null, starts: TODAY, active: true, grantedBy: 'Set-up', grantedAt: at }],
  });
  await store.save(acme);
  const boss = (await enrol(k, (await login(BOSS.email, BOSS.password)).cookie!)).cookie;

  // Ama joins the demo first, so her account is at home there.
  const invited = await k.call('POST', '/v1/users', demoOwner, { email: AMA.email, name: AMA.name, audience: 'operator', roleId: 'viewer' });
  await k.form('/auth/accept', { token: tokenOf(invited.body.inviteUrl), password: AMA.password, confirm: AMA.password });
  const amaInDemo = invited.body.user.id as string;

  // Then Acme invites her as its people manager, a role that needs the authenticator.
  const second = await k.call('POST', '/v1/users', boss, { email: AMA.email, name: AMA.name, audience: 'operator', roleId: 'people_manager' });
  expect(second.status).toBe(201);
  return { k, store, boss, demoOwner, login, amaInDemo, amaInAcme: second.body.user.id as string, acmeLink: second.body.inviteUrl as string };
}

/** Ama accepts Acme's invitation with her own password; returns her session there. */
async function joined(t: Awaited<ReturnType<typeof twoOrganisations>>) {
  const res = await t.k.form('/auth/accept', { token: tokenOf(t.acmeLink), password: AMA.password });
  expect(res.location).toBe('/app/');
  return res.cookie!;
}

describe('one person in several organisations', () => {
  it('accepts a second organisation with the password the person already has, never a new one', async () => {
    const t = await twoOrganisations();
    const token = tokenOf(t.acmeLink);
    expect((await t.k.call('POST', '/auth/link', null, { token })).body).toMatchObject({ email: AMA.email, existing: true });
    // Whoever holds the link cannot choose a password for her: without hers, nothing happens.
    expect((await t.k.form('/auth/accept', { token, password: 'a password chosen by the inviter', confirm: 'a password chosen by the inviter' })).location).toMatch(/error=invalid/);
    expect((await t.login(AMA.email, 'a password chosen by the inviter')).location).toMatch(/error=invalid/);

    const acme = await joined(t);
    expect(await orgOf(t.k, acme)).toBe('acme');
    expect((await t.k.call('GET', '/v1/me', acme)).body.user.id).toBe(t.amaInAcme);
    // Her password is unchanged, and still opens the demo too.
    expect((await t.login(AMA.email, AMA.password)).location).toBe('/app/');
  });

  it('counts wrong passwords on an invitation towards the lockout', async () => {
    const t = await twoOrganisations();
    for (let i = 0; i < 5; i++) await t.k.form('/auth/accept', { token: tokenOf(t.acmeLink), password: 'not her password at all' });
    expect((await t.k.form('/auth/accept', { token: tokenOf(t.acmeLink), password: AMA.password })).location).toMatch(/error=locked/);
  });

  it('lists her organisations to her alone, and switches the session between them', async () => {
    const t = await twoOrganisations();
    const acme = await joined(t);
    const me = (await t.k.call('GET', '/auth/me', acme)).body;
    expect(me.organisations.map((o: { orgId: string }) => o.orgId)).toEqual(['demo', 'acme']);
    expect(me.organisations.find((o: { current: boolean }) => o.current).orgId).toBe('acme');
    expect(me.organisations[0].name).toMatch(/West End Dining/);

    const switched = await t.k.call('POST', '/auth/switch', acme, { orgId: 'demo' });
    expect(switched.status).toBe(200);
    expect(await orgOf(t.k, switched.cookie!)).toBe('demo');
    expect((await t.k.call('GET', '/v1/me', switched.cookie!)).body.user.id).toBe(t.amaInDemo);
    expect((await t.k.call('POST', '/auth/switch', acme, { orgId: 'nowhere' })).status).toBe(403);
    // A cookie naming an organisation she has not joined is no session at all.
    const forged = `ps_session=${await createSession({ email: AMA.email, orgId: 'elsewhere' }, await t.store.sessionSecret())}`;
    expect((await t.k.call('GET', '/v1/sites', forged)).status).toBe(401);
  });

  it('signs her back in where she last worked, and elsewhere once that organisation suspends her', async () => {
    const t = await twoOrganisations();
    await joined(t);
    expect(await orgOf(t.k, (await t.login(AMA.email, AMA.password)).cookie!)).toBe('acme');
    await t.k.call('POST', `/v1/users/${t.amaInAcme}/suspend`, t.boss);
    expect(await orgOf(t.k, (await t.login(AMA.email, AMA.password)).cookie!)).toBe('demo');
  });

  it("keeps a suspension to the organisation that made it: the other organisation's session carries on", async () => {
    const t = await twoOrganisations();
    const acme = await joined(t);
    const demo = (await t.k.call('POST', '/auth/switch', acme, { orgId: 'demo' })).cookie!;
    await t.k.call('POST', `/v1/users/${t.amaInAcme}/suspend`, t.boss);
    expect((await t.k.call('GET', '/v1/me', acme)).status).toBe(403);
    expect((await t.k.call('GET', '/v1/me', demo)).status).toBe(200);
    expect((await t.k.call('POST', '/auth/switch', demo, { orgId: 'acme' })).status).toBe(403);
  });

  it('lets only the home organisation reset her password or authenticator, and never hands a shared reset over', async () => {
    const t = await twoOrganisations();
    await joined(t);
    expect((await t.k.call('POST', `/v1/users/${t.amaInAcme}/reset-password`, t.boss)).body.error).toBe('managed_elsewhere');
    // At home, a reset of an account that opens another organisation only ever goes by email.
    const home = await t.k.call('POST', `/v1/users/${t.amaInDemo}/reset-password`, t.demoOwner);
    expect(home.body.error).toBe('email_only');
    expect((await t.k.call('POST', `/v1/users/${t.amaInDemo}/reset-password`, t.demoOwner, { handOver: true })).body.error).toBe('email_only');
    // Nothing was changed by the refusals.
    expect((await t.login(AMA.email, AMA.password)).location).toBe('/app/');
  });

  it('tells Acme nothing about where else she works', async () => {
    const t = await twoOrganisations();
    await joined(t);
    const seen = await t.k.call('GET', `/v1/users/${t.amaInAcme}`, t.boss);
    expect(seen.body.account).toMatchObject({ exists: true, managedHere: false });
    expect(seen.raw).not.toMatch(/demo|marylebone|West End/i);
    expect((await t.k.call('GET', '/v1/access/health', t.boss)).body.signInsWithoutRecord).toEqual([]);
  });

  it('gives an account no access in an organisation it joined but holds no record in', async () => {
    const t = await twoOrganisations();
    await t.store.updateUser(AMA.email, { orgs: ['demo', 'acme'] });
    // Her home is the demo; in Acme, before the invitation is accepted, she has nothing.
    const early = `ps_session=${await createSession({ email: AMA.email, orgId: 'acme' }, await t.store.sessionSecret())}`;
    const acme = await t.store.load('acme');
    acme.users = acme.users.filter((u) => u.email !== AMA.email);
    await t.store.save(acme);
    expect((await t.k.call('GET', '/v1/sites', early)).status).toBe(403);
    expect((await t.k.call('GET', '/v1/me', early)).body.withoutRecord).toBeUndefined();
  });

  it('has one authenticator for every organisation: set up once, proved once a session', async () => {
    const t = await twoOrganisations();
    const acme = await joined(t);
    // Acme's people manager role needs it; she sets it up in the demo, where her viewer role does not.
    const demo = (await t.k.call('POST', '/auth/switch', acme, { orgId: 'demo' })).cookie!;
    const { cookie: provedInDemo } = await enrol(t.k, demo);
    const back = (await t.k.call('POST', '/auth/switch', provedInDemo, { orgId: 'acme' })).cookie!;
    const me = (await t.k.call('GET', '/v1/me', back)).body;
    expect(me.authenticator).toMatchObject({ enrolled: true, verified: true });
    expect(me.permissions).toContain('pay.edit');
    expect((await t.k.call('GET', `/v1/users/${t.amaInAcme}`, t.boss)).body.mfaEnrolled).toBe(true);
    // Acme cannot reset it: whoever then set up a new one with her password would hold her access everywhere.
    expect((await t.k.call('POST', `/v1/users/${t.amaInAcme}/reset-authenticator`, t.boss)).body.error).toBe('managed_elsewhere');
    // Reset at home, it is gone everywhere, and the proof with it.
    expect((await t.k.call('POST', `/v1/users/${t.amaInDemo}/reset-authenticator`, t.demoOwner)).status).toBe(200);
    expect((await t.k.call('GET', '/v1/me', back)).body.authenticator).toMatchObject({ enrolled: false, verified: false });
    expect((await t.k.call('GET', `/v1/users/${t.amaInAcme}`, t.boss)).body.mfaEnrolled).toBe(false);
  });

  it("moves an authenticator kept in the organisation to the person's account the first time it is used", async () => {
    const k = await kit({ keys: [DEMO_OWNER] });
    const james = await k.as('james@marylebonegroup.example');
    expect((await k.store.load('demo')).authenticators.usr_ops).toBeDefined();
    const proved = await enterCode(k, james, DEMO_TOTP_SECRET);
    expect((await k.store.getUser('james@marylebonegroup.example'))!.authenticator?.id).toBe('demo-usr_ops');
    expect((await k.store.load('demo')).authenticators.usr_ops).toBeUndefined();
    // The session proved against it still counts.
    expect((await k.call('GET', '/v1/me', proved)).body.authenticator.verified).toBe(true);
  });
});

describe('organisations kept apart', () => {
  it("never shares one organisation's data with another, even when both start from the demo", async () => {
    const store = new MemoryStore(['demo', 'acme'], TODAY);
    const acme = await store.load('acme');
    acme.state.entities[1].name = 'Acme Kitchen Ltd';
    acme.state.sites[0].name = 'Acme Marylebone';
    const demo = await store.load('demo');
    expect(demo.state.entities[1].name).toBe('East Canteen & Kitchen Ltd');
    expect(demo.state.sites[0].name).toBe('Marylebone');
  });
});

describe('accounts in Postgres', () => {
  it('lists an account that has joined an organisation with the organisation, and an older row at home', async () => {
    const db = new PGlite();
    const store = new PgStore(async (text, params) => (await db.query(text, params)).rows as Record<string, unknown>[], [], TODAY);
    await store.createUser(await newAccount('home@acme.example', 'acme', BOSS.password));
    await store.createUser(await newAccount(AMA.email, 'demo', AMA.password));
    await store.updateUser(AMA.email, { orgs: ['demo', 'acme'] });
    expect((await store.listUsers('acme')).map((a) => a.email).sort()).toEqual([AMA.email, 'home@acme.example']);
    expect((await store.listUsers('demo')).map((a) => a.email)).toEqual([AMA.email]);
    expect(await store.listUsers('elsewhere')).toEqual([]);
  });
});
