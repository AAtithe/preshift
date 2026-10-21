import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { seedState } from '../src/engine/seed';
import { MemoryStore, PgStore, type Query, type Store } from './store';
import { account, kit, tokenOf, TODAY } from './testkit';

// Signing in and access records are one system: a session is its person's roles.

const WEEK = '2026-10-19';
// The owner's personal key: access is managed by people, never by an integration key.
const OWNER_KEY = { key: 'dev-usr_owner', orgId: 'demo', name: 'Demo owner', scopes: ['*'] as ['*'], userId: 'usr_owner', mfa: true };
const SYSTEM = { key: 'system', orgId: 'demo', name: 'System', scopes: ['*'] as ['*'] };

async function boot(store: Store = new MemoryStore(['demo'], TODAY)) {
  const k = await kit({ store, keys: [SYSTEM, OWNER_KEY] });
  /** as: an email signs in with a cookie; 'owner' or 'system' use those keys; null is nobody. */
  const call = async (method: string, url: string, as: string | null, body?: unknown) =>
    k.call(method, url, as === 'owner' ? { key: OWNER_KEY.key } : as === 'system' ? { key: SYSTEM.key } : as ? await k.as(as) : null, body);
  return { ...k, call };
}

const pg = (): Query => {
  const db = new PGlite();
  return async (text, params) => (await db.query(text, params)).rows as Record<string, unknown>[];
};

describe('sessions and access records', () => {
  it('holds a signed-in person with a record to their roles', async () => {
    const { call } = await boot();
    const me = await call('GET', '/v1/me', 'priya@marylebonegroup.example');
    expect(me.body.user.id).toBe('usr_gm_mar');
    expect(me.body.withoutRecord).toBe(false);
    expect((await call('GET', '/v1/sites', 'priya@marylebonegroup.example')).body.map((s: { id: string }) => s.id)).toEqual(['mar']);
    expect((await call('POST', '/v1/rota/publish', 'priya@marylebonegroup.example', { siteId: 'shd', weekStart: WEEK })).status).toBe(403);
  });

  it('keeps full access for a person with an account and no record, and lists them as a finding', async () => {
    const k = await boot();
    await k.store.createUser(account('founder@example.com'));
    const me = await k.call('GET', '/v1/me', 'founder@example.com');
    expect(me.body.withoutRecord).toBe(true);
    expect(me.body.user).toBeUndefined();
    expect((await k.call('GET', '/v1/sites', 'founder@example.com')).body).toHaveLength(seedState(TODAY).sites.length);
    expect((await k.call('GET', '/v1/access/health', 'owner')).body.signInsWithoutRecord).toEqual(['founder@example.com']);
  });

  it('lists demo people only to a demo key, never to a session or a deployment', async () => {
    const { call } = await boot();
    expect((await call('GET', '/v1/dev/people', 'priya@marylebonegroup.example')).status).toBe(404);
    expect((await call('GET', '/v1/dev/people', 'system')).status).toBe(404);
    expect((await call('GET', '/v1/dev/people', 'owner')).status).toBe(200);
    process.env.VERCEL = '1';
    try {
      expect((await call('GET', '/v1/dev/people', 'owner')).status).toBe(404);
    } finally {
      delete process.env.VERCEL;
    }
  });

  it('refuses a suspended person who signs in', async () => {
    const { call } = await boot();
    const res = await call('GET', '/v1/shifts', 'chris@marylebonegroup.example');
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/suspended/);
  });

  it('accepts an invitation the first time an existing account signs in, and remembers it', async () => {
    // Postgres, not memory: only a real save proves the acceptance outlives the request that made it.
    const k = await boot(new PgStore(pg(), ['demo'], TODAY));
    const invited = await k.call('POST', '/v1/users', 'owner', { email: 'ama@example.com', name: 'Ama Boateng', audience: 'operator', roleId: 'supervisor', siteIds: ['shd'] });
    expect(invited.body.user.status).toBe('invited');
    // An account made some other way (before invitations had links) signs in: a read accepts it, so it is saved on a GET.
    await k.store.createUser(account('ama@example.com'));
    expect((await k.call('GET', '/v1/me', 'ama@example.com')).body.user.status).toBe('active');
    expect((await k.call('GET', `/v1/users/${invited.body.user.id}`, 'owner')).body.status).toBe('active');
    const trail = (await k.call('GET', `/v1/access/audit?userId=${invited.body.user.id}`, 'owner')).body.map((e: { action: string }) => e.action);
    expect(trail[0]).toBe('invite.accepted');
  });

  it('resets someone active with no account by a link that makes one', async () => {
    const k = await kit({ keys: [OWNER_KEY], accounts: false });
    const reset = await k.call('POST', '/v1/users/usr_gm_mar/reset-password', { key: OWNER_KEY.key });
    expect(reset.body).toMatchObject({ emailed: false });
    expect(reset.body.inviteUrl).toMatch(/^\/login#invite=/);
    const token = tokenOf(reset.body.inviteUrl);
    expect((await k.call('POST', '/auth/link', null, { token })).body).toMatchObject({ email: 'priya@marylebonegroup.example', kind: 'reset' });
    expect((await k.form('/auth/accept', { token, password: 'long enough password', confirm: 'long enough password' })).location).toBe('/app/');
    expect(await k.store.getUser('priya@marylebonegroup.example')).toMatchObject({ orgId: 'demo' });
  });

  it('records when a person was last seen, even if they only read', async () => {
    const k = await boot(new PgStore(pg(), ['demo'], TODAY));
    await k.call('GET', '/v1/shifts', 'daniel@marylebonegroup.example');
    const daniel = (await k.call('GET', '/v1/users/usr_area', 'owner')).body;
    expect(Date.now() - Date.parse(daniel.lastSeenAt)).toBeLessThan(60_000);
  });

  it('refuses an expired invitation at sign-in', async () => {
    const { call } = await boot();
    const res = await call('GET', '/v1/me', 'zoe@marylebonegroup.example');
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/expired/);
  });

  it('keeps access records, invitations and reviews in Postgres across a cold start', async () => {
    const query = pg();
    const first = await boot(new PgStore(query, ['demo'], TODAY));
    const invited = await first.call('POST', '/v1/users', 'owner', { email: 'ama@example.com', name: 'Ama Boateng', audience: 'operator', roleId: 'supervisor', siteIds: ['shd'] });
    expect((await first.call('POST', '/v1/access/reviews', 'owner', { note: 'Q4' })).status).toBe(201);
    const token = tokenOf(invited.body.inviteUrl);

    const second = await boot(new PgStore(query, ['demo'], TODAY));
    expect((await second.call('GET', `/v1/users/${invited.body.user.id}`, 'owner')).body.status).toBe('invited');
    expect((await second.call('GET', '/v1/access/reviews', 'owner')).body[0].note).toBe('Q4');
    expect((await second.form('/auth/accept', { token, password: 'long enough password', confirm: 'long enough password' })).location).toBe('/app/');

    const third = await boot(new PgStore(query, ['demo'], TODAY));
    const ama = (await third.call('GET', `/v1/users/${invited.body.user.id}`, 'owner')).body;
    expect(ama.status).toBe('active');
    expect(ama.account).toMatchObject({ exists: true });
  });

  it('loads an organisation saved before access management with nobody on record', async () => {
    const query = pg();
    const store = new PgStore(query, [], TODAY);
    await store.load('legacy');
    // Strip what this branch added, as a row written by the previous release would lack it.
    await query(`update preshift.orgs set data = data - 'users' - 'accessReviews' - 'inviteTokens' - 'inviteSends' - 'authenticators' where org_id = 'legacy'`, []);
    const org = await new PgStore(query, [], TODAY).load('legacy');
    expect(org.users).toEqual([]);
    expect(org.inviteTokens).toEqual({});
    expect(org.authenticators).toEqual({});
  });
});
