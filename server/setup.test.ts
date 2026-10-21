import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { MemoryStore } from './store';

const OWNER = { email: 'owner@ws.example', password: 'correct horse battery' };

async function boot() {
  const store = new MemoryStore(['demo'], '2026-10-21');
  const { app } = await buildApp({ apiKeys: [{ key: 'integration', orgId: 'demo', name: 'Integration', scopes: ['*'] }], store, provider: new TeamPaySimulator(), autoDispatch: false });
  const res = await app.inject({
    method: 'POST',
    url: '/auth/setup',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ email: OWNER.email, password: OWNER.password, confirm: OWNER.password, next: '/app/' }).toString(),
  });
  const cookie = String(res.headers['set-cookie']).split(';')[0];
  const call = async (method: string, url: string, body?: unknown, auth: Record<string, string> = { cookie }) => {
    const r = await app.inject({ method: method as 'GET', url, headers: { ...auth, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, payload: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: r.statusCode, body: r.body ? r.json() : undefined };
  };
  return { call, store };
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
    const { call } = await boot();
    expect((await call('GET', '/v1/setup/status')).body).toMatchObject({ sample: true, canStartFresh: true, startFreshBlocks: [] });
    expect((await call('POST', '/v1/setup/start-fresh')).status).toBe(200);
    expect((await call('GET', '/v1/sites')).body).toEqual([]);
    expect((await call('GET', '/v1/setup/status')).body).toMatchObject({ empty: true, canStartFresh: false });
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

  it('is for signed-in admins only, not integration keys', async () => {
    const { call } = await boot();
    expect((await call('PUT', '/v1/setup', draft, { authorization: 'Bearer integration' })).status).toBe(403);
    expect((await call('POST', '/v1/setup/start-fresh', undefined, { authorization: 'Bearer integration' })).status).toBe(403);
  });
});
