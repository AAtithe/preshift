import { describe, expect, it } from 'vitest';
import { enrol, kit } from './testkit';

const OWNER = { email: 'owner@ws.example', password: 'correct horse battery' };

// The first account becomes the owner. Set-up needs settings.manage, a strong permission, so the
// owner proves an authenticator first, as they would to change any other organisation setting.
async function boot() {
  const k = await kit({ accounts: false, keys: [{ key: 'integration', orgId: 'demo', name: 'Integration', scopes: ['*'] }] });
  const created = await k.form('/auth/setup', { email: OWNER.email, password: OWNER.password, confirm: OWNER.password, next: '/app/' });
  const { cookie } = await enrol(k, created.cookie!);
  const unproved = created.cookie!;
  const call = async (method: string, url: string, body?: unknown, who: { cookie?: string; key?: string } = { cookie }) => {
    const r = await k.call(method, url, who, body);
    return { status: r.status, body: r.body };
  };
  return { call, store: k.store, unproved };
}

const company = { id: 'co_ck', name: 'Clerkenwell Kitchen Ltd', companyNumber: '12345678', payeReference: '120/CK12345', intercompanyCode: '' };
const site = {
  id: 'site_ck', name: 'Clerkenwell', entityId: 'co_ck', labourTargetPct: 0.28, trackingCode: '', openMinute: 720, closeMinute: 1380,
  salesProfile: { dailySales: [3000, 3000, 3500, 4000, 6000, 7000, 4500], averageSpend: 40 },
};
const roles = [{ id: 'chef', name: 'Chef', department: 'BOH', nominalCode: '7001' }];
const rules = [{ roleId: 'chef', siteId: 'site_ck', coversPerHour: 22, minimumWhileOpen: 1, maximum: 4 }];
const draft = { entities: [company], sites: [site], roles, demandRules: rules };

describe('set-up', () => {
  it('starts on the sample group and clears it while nothing real exists', async () => {
    const { call, store } = await boot();
    expect((await call('GET', '/v1/setup/status')).body).toMatchObject({ sample: true, canStartFresh: true, startFreshBlocks: [] });
    expect((await call('POST', '/v1/setup/start-fresh')).status).toBe(200);
    expect((await call('GET', '/v1/sites')).body).toEqual([]);
    expect((await call('GET', '/v1/setup/status')).body).toMatchObject({ empty: true, canStartFresh: false });
    const org = await store.load('demo');
    // The sample's fictional people and HR files go with it; the real owner stays.
    expect(org.users.map((u) => u.email)).toEqual([OWNER.email]);
    expect(org.hrRecords).toEqual([]);
  });

  it('will not clear the sample once a real person has access tied to one of its sites', async () => {
    const { call, store } = await boot();
    const org = await store.load('demo');
    const owner = org.users.find((u) => u.email === OWNER.email)!;
    org.users.push({ ...owner, id: 'usr_real_gm', email: 'gm@client.example', name: 'Real GM', memberships: [{ ...owner.memberships[0], id: 'm_gm', roleId: 'general_manager', siteIds: ['mar'] }] });
    await store.save(org);
    const fresh = await call('POST', '/v1/setup/start-fresh');
    expect(fresh.status).toBe(409);
    expect(fresh.body.details.join(' ')).toMatch(/Real GM has access tied to a sample site/);
  });

  it('saves a business, forecasts from the typical week, and then takes starters through payroll', async () => {
    const { call } = await boot();
    await call('POST', '/v1/setup/start-fresh');
    const saved = await call('PUT', '/v1/setup', draft);
    expect(saved.status).toBe(200);
    expect(saved.body.sites[0].trackingCode).toBe('Clerkenwell');
    const forecast = (await call('GET', '/v1/forecast?siteId=site_ck&from=2026-10-19&to=2026-10-25')).body;
    expect(forecast.reduce((s: number, f: { sales: number }) => s + f.sales, 0)).toBe(31000);

    const starter = await call('POST', '/v1/employees', { name: 'Sam Cook', siteId: 'site_ck', roleIds: ['chef'], payBasis: 'hourly', hourlyRate: 15, dateOfBirth: '1990-01-01' });
    expect(starter.status).toBe(201);
    expect(starter.body.entityId).toBe('co_ck');
    const build = await call('POST', '/v1/rota/build', { siteId: 'site_ck', weekStart: '2026-12-28' });
    expect(build.body.added.length).toBeGreaterThan(0);
  });

  it('refuses to clear once real people exist, and refuses to remove what is in use', async () => {
    const { call } = await boot();
    await call('POST', '/v1/setup/start-fresh');
    await call('PUT', '/v1/setup', draft);
    await call('POST', '/v1/employees', { name: 'Sam Cook', siteId: 'site_ck', roleIds: ['chef'], payBasis: 'hourly', hourlyRate: 15, dateOfBirth: '1990-01-01' });
    const fresh = await call('POST', '/v1/setup/start-fresh');
    expect(fresh.status).toBe(409);
    expect(fresh.body.details).toContain('People of your own have been added.');
    const drop = await call('PUT', '/v1/setup', { ...draft, roles: [{ id: 'kp', name: 'Kitchen Porter', department: 'BOH', nominalCode: '7001' }], demandRules: [] });
    expect(drop.status).toBe(409);
    expect(drop.body.details.join(' ')).toMatch(/Chef is held by 1 person/);
  });

  it('rejects a blank trading week, keeps fields set-up does not own, and never marks pushed figures as profile', async () => {
    const { call } = await boot();
    const blank = await call('PUT', '/v1/setup', { ...draft, sites: [{ ...site, salesProfile: { dailySales: [0, 0, 0, 0, 0, 0, 0], averageSpend: 0 } }] });
    expect(blank.status).toBe(422);

    await call('PUT', '/v1/sites/mar/geofence', { lat: 51.52, lng: -0.15, radiusMetres: 80 });
    const sample = (await call('GET', '/v1/sites')).body;
    const entities = (await call('GET', '/v1/entities')).body.map((e: Record<string, unknown>) => ({ id: e.id, name: e.name, companyNumber: e.companyNumber, payeReference: e.payeReference, intercompanyCode: e.intercompanyCode }));
    const sites = sample.map(({ geofence: _g, ...s }: Record<string, unknown>) => ({ ...s, salesProfile: { dailySales: [1000, 1000, 1000, 1000, 1000, 1000, 1000], averageSpend: 30 } }));
    const kept = await call('PUT', '/v1/setup', { entities, sites, roles: (await call('GET', '/v1/roles')).body, demandRules: (await call('GET', '/v1/demand-rules')).body });
    expect(kept.status).toBe(200);
    expect(kept.body.sites.find((s: { id: string }) => s.id === 'mar').geofence).toMatchObject({ radiusMetres: 80 });
    expect(kept.body.entities.find((e: { id: string }) => e.id === 'wdl').employmentAllowance).toBeDefined();

    await call('PUT', '/v1/forecast', { rows: [{ siteId: 'mar', date: '2026-11-02', hour: 12, sales: 5, covers: 1, source: 'profile' }] });
    const row = (await call('GET', '/v1/forecast?siteId=mar&from=2026-11-02&to=2026-11-02')).body.find((f: { hour: number }) => f.hour === 12);
    expect(row.source).toBeUndefined();
  });

  it('needs a person with settings.manage and a proved authenticator, never an integration key', async () => {
    const { call, unproved } = await boot();
    const refused = await call('POST', '/v1/setup/start-fresh', undefined, { cookie: unproved });
    expect(refused.status).toBe(403);
    expect(refused.body.message).toMatch(/authenticator/);
    expect((await call('PUT', '/v1/setup', draft, { key: 'integration' })).status).toBe(403);
    expect((await call('POST', '/v1/setup/start-fresh', undefined, { key: 'integration' })).status).toBe(403);
  });
});
