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
