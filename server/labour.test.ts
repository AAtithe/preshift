import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { MemoryStore } from './store';

// Each key stands for its person having entered their authenticator code.
const person = (key: string, userId: string) => ({ key, orgId: 'demo', name: `${key} key`, scopes: ['*' as const], userId, mfa: true });

describe('tips and cost of sales feeds', () => {
  it('show each site only to those who see its labour cost', async () => {
    const store = new MemoryStore(['demo'], '2026-10-21');
    const org = await store.load('demo');
    const [mar, other] = org.state.sites.map((s) => s.id);
    org.state.tips = [mar, other].map((siteId, i) => ({ id: `t${i}`, siteId, date: '2026-10-20', source: 'service-charge' as const, amount: 100 }));
    org.state.purchases = [mar, other].map((siteId, i) => ({ id: `p${i}`, siteId, date: '2026-10-20', supplier: 'Butcher', category: 'food' as const, amount: 50 }));
    const { app } = await buildApp({
      apiKeys: [person('owner', 'usr_owner'), person('priya', 'usr_gm_mar'), person('grace', 'usr_sup')],
      store,
      provider: new TeamPaySimulator(),
      autoDispatch: false,
    });
    const get = (url: string, key: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${key}` } }).then((r) => r.json());

    expect((await get('/v1/tronc', 'owner')).tips).toHaveLength(2);
    // The Marylebone GM sees Marylebone's tips and purchases, and no other site's.
    expect((await get('/v1/tronc', 'priya')).tips.map((t: { siteId: string }) => t.siteId)).toEqual([mar]);
    expect((await get('/v1/prime', 'priya')).purchases.map((p: { siteId: string }) => p.siteId)).toEqual([mar]);
    // A supervisor sees no cost, so no tips or cost of sales either.
    expect(await get('/v1/tronc', 'grace')).toEqual({ tips: [], troncSchemes: [] });
    expect((await get('/v1/prime', 'grace')).purchases).toEqual([]);
  });
});

describe('recording a tronc scheme', () => {
  async function boot() {
    const store = new MemoryStore(['demo'], '2026-10-21');
    const { app } = await buildApp({
      apiKeys: [
        person('ravi', 'usr_ws_payroll'), person('nadia', 'usr_fd'), person('owner', 'usr_owner'), person('priya', 'usr_gm_mar'),
        { key: 'system', orgId: 'demo', name: 'Integration', scopes: ['*' as const] },
      ],
      store,
      provider: new TeamPaySimulator(),
      autoDispatch: false,
    });
    const put = (key: string, body: unknown, siteId = 'mar') =>
      app.inject({ method: 'PUT', url: `/v1/tronc/schemes/${siteId}`, headers: { authorization: `Bearer ${key}` }, payload: body as object });
    return { store, put };
  }
  const scheme = {
    troncmaster: 'Grace Mensah, elected by the team',
    independent: true,
    pointsPerHour: { server: 10, bar: 10, chef: 8, kp: 6 },
    serviceCharge: 'discretionary',
    policyPublishedOn: '2026-01-05',
  };

  it('lets payroll record and change a scheme, stamped and audited', async () => {
    const { store, put } = await boot();
    const first = await put('ravi', scheme);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ siteId: 'mar', troncmaster: scheme.troncmaster, updatedBy: 'Ravi Desai' });

    const changed = await put('ravi', { ...scheme, pointsPerHour: { ...scheme.pointsPerHour, kp: 8 }, departmentShares: { FOH: 0.6, BAR: 0.1, BOH: 0.3 } });
    expect(changed.statusCode).toBe(200);
    const org = await store.load('demo');
    expect(org.state.troncSchemes?.filter((s) => s.siteId === 'mar')).toHaveLength(1);
    expect(org.state.troncSchemes?.[0].pointsPerHour.kp).toBe(8);
    const saved = org.audit.filter((a) => a.action === 'tronc.scheme_saved');
    expect(saved.map((a) => a.detail?.fields)).toEqual([expect.arrayContaining(['troncmaster', 'pointsPerHour']), ['pointsPerHour', 'departmentShares']]);
  });

  it('keeps it from the site and the owner, and from payroll without an authenticator', async () => {
    const { put } = await boot();
    for (const key of ['priya', 'owner']) expect((await put(key, scheme)).statusCode).toBe(403);
    const fd = await put('nadia', scheme);
    expect(fd.statusCode).toBe(403);
    expect(fd.json().message).toMatch(/authenticator/);
    // A system key acts for the organisation, as it does for pay.
    expect((await put('system', scheme)).statusCode).toBe(200);
  });

  it('refuses a scheme that cannot be run as written', async () => {
    const { put } = await boot();
    const bad = await put('ravi', { ...scheme, pointsPerHour: { sommelier: 10 }, departmentShares: { FOH: 0.5, BOH: 0.3 }, lastReviewedOn: '2027-01-01' });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().details.join(' ')).toMatch(/roles that do not exist.*at least one role.*add up to 80%.*in the future/);
    expect((await put('ravi', scheme, 'nowhere')).statusCode).toBe(404);
    expect((await put('ravi', { ...scheme, troncmaster: '' })).statusCode).toBe(400);
  });
});
