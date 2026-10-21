import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import { seedState } from '../src/engine/seed';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { COOKIE, createSession } from './session';
import { MemoryStore, PgStore, type Query, type Store } from './store';

// Signing in and access records are one system: a session is its person's roles.

const SECRET = 'x'.repeat(48);
const WEEK = '2026-10-19';
const SYSTEM = [{ key: 'system', orgId: 'demo', name: 'System', scopes: ['*' as const] }];

async function boot(store: Store = new MemoryStore(['demo'], '2026-10-21')) {
  const { app } = await buildApp({ apiKeys: SYSTEM, store, provider: new TeamPaySimulator(), autoDispatch: false, env: { SESSION_SECRET: SECRET } });
  const call = async (method: string, url: string, as: string | null, body?: unknown) => {
    const auth = as === 'system' ? { authorization: 'Bearer system' } : as ? { cookie: `${COOKIE}=${await createSession({ email: as, orgId: 'demo' }, SECRET)}` } : {};
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: { ...auth, ...(body ? { 'content-type': 'application/json' } : {}) },
      payload: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  };
  return call;
}

afterEach(() => {
  delete process.env.APP_USERS;
});

describe('sessions and access records', () => {
  it('holds a signed-in person with a record to their roles', async () => {
    const call = await boot();
    const me = await call('GET', '/v1/me', 'priya@marylebonegroup.example');
    expect(me.body.user.id).toBe('usr_gm_mar');
    expect(me.body.withoutRecord).toBe(false);
    expect((await call('GET', '/v1/sites', 'priya@marylebonegroup.example')).body.map((s: { id: string }) => s.id)).toEqual(['mar']);
    expect((await call('POST', '/v1/rota/publish', 'priya@marylebonegroup.example', { siteId: 'shd', weekStart: WEEK })).status).toBe(403);
  });

  it('keeps full access for a person with no record, and lists them as a finding', async () => {
    process.env.APP_USERS = `founder@example.com:${'a'.repeat(32)}:${'b'.repeat(128)}:demo`;
    const call = await boot();
    const me = await call('GET', '/v1/me', 'founder@example.com');
    expect(me.body.withoutRecord).toBe(true);
    expect(me.body.user).toBeUndefined();
    // Every site in the organisation, as every session had before roles.
    expect((await call('GET', '/v1/sites', 'founder@example.com')).body).toHaveLength(seedState('2026-10-21').sites.length);
    const health = await call('GET', '/v1/access/health', 'system');
    expect(health.body.signInsWithoutRecord).toEqual(['founder@example.com']);
  });

  it('refuses a suspended person who signs in', async () => {
    const call = await boot();
    const res = await call('GET', '/v1/shifts', 'chris@marylebonegroup.example');
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/suspended/);
  });

  it('accepts an invitation the first time the person signs in, and remembers it', async () => {
    // Postgres, not memory: only a real save proves the acceptance outlives the request that made it.
    const db = new PGlite();
    const query: Query = async (text, params) => (await db.query(text, params)).rows as Record<string, unknown>[];
    const call = await boot(new PgStore(query, ['demo'], '2026-10-21'));
    const invited = await call('POST', '/v1/users', 'system', { email: 'ama@example.com', name: 'Ama Boateng', audience: 'operator', roleId: 'supervisor', siteIds: ['shd'] });
    expect(invited.body.user.status).toBe('invited');
    // A read accepts it, so the save has to happen on a GET too.
    expect((await call('GET', '/v1/me', 'ama@example.com')).body.user.status).toBe('active');
    const after = await call('GET', `/v1/users/${invited.body.user.id}`, 'system');
    expect(after.body.status).toBe('active');
    const trail = (await call('GET', `/v1/access/audit?userId=${invited.body.user.id}`, 'system')).body.map((e: { action: string }) => e.action);
    expect(trail[0]).toBe('invite.accepted');
  });

  it('records when a person was last seen, even if they only read', async () => {
    const db = new PGlite();
    const query: Query = async (text, params) => (await db.query(text, params)).rows as Record<string, unknown>[];
    const call = await boot(new PgStore(query, ['demo'], '2026-10-21'));
    await call('GET', '/v1/shifts', 'daniel@marylebonegroup.example');
    const daniel = (await call('GET', '/v1/users/usr_area', 'system')).body;
    expect(Date.now() - Date.parse(daniel.lastSeenAt)).toBeLessThan(60_000);
  });

  it('refuses an expired invitation at sign-in', async () => {
    const call = await boot();
    const res = await call('GET', '/v1/me', 'zoe@marylebonegroup.example');
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/expired/);
  });

  it('never creates an organisation from a public invitation token', async () => {
    const store = new MemoryStore(['demo'], '2026-10-21');
    const call = await boot(store);
    expect((await call('POST', '/v1/invites/accept', null, { token: 'someoneelse.forgedtoken123' })).status).toBe(404);
    expect(await store.orgIds()).not.toContain('someoneelse');
  });

  it('keeps access records, invitations and reviews in Postgres across a cold start', async () => {
    const db = new PGlite();
    const query: Query = async (text, params) => (await db.query(text, params)).rows as Record<string, unknown>[];
    const first = await boot(new PgStore(query, ['demo'], '2026-10-21'));
    const invited = await first('POST', '/v1/users', 'system', { email: 'ama@example.com', name: 'Ama Boateng', audience: 'operator', roleId: 'supervisor', siteIds: ['shd'] });
    expect((await first('POST', '/v1/access/reviews', 'system', { note: 'Q4' })).status).toBe(201);
    const token = decodeURIComponent(invited.body.inviteUrl.split('token=')[1]);

    const second = await boot(new PgStore(query, ['demo'], '2026-10-21'));
    expect((await second('GET', `/v1/users/${invited.body.user.id}`, 'system')).body.status).toBe('invited');
    expect((await second('GET', '/v1/access/reviews', 'system')).body[0].note).toBe('Q4');
    expect((await second('POST', '/v1/invites/accept', null, { token })).status).toBe(200);

    const third = await boot(new PgStore(query, ['demo'], '2026-10-21'));
    expect((await third('GET', `/v1/users/${invited.body.user.id}`, 'system')).body.status).toBe('active');
  });

  it('loads an organisation saved before access management with nobody on record', async () => {
    const db = new PGlite();
    const query: Query = async (text, params) => (await db.query(text, params)).rows as Record<string, unknown>[];
    const store = new PgStore(query, [], '2026-10-21');
    await store.load('legacy');
    // Strip what this branch added, as a row written by the previous release would lack it.
    await query(`update preshift.orgs set data = data - 'users' - 'accessReviews' - 'inviteTokens' - 'inviteSends' where org_id = 'legacy'`, []);
    const org = await new PgStore(query, [], '2026-10-21').load('legacy');
    expect(org.users).toEqual([]);
    expect(org.inviteTokens).toEqual({});
  });
});
