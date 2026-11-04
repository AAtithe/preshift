import { describe, expect, it } from 'vitest';
import { kit } from './testkit';

// Shifts brought across from another rota system arrive as a draft, each checked as one added by hand.

const KEYS = [
  { key: 'olivia', orgId: 'demo', name: 'Olivia', scopes: ['*'] as ['*'], userId: 'usr_owner', mfa: true },
  { key: 'priya', orgId: 'demo', name: 'Priya', scopes: ['*'] as ['*'], userId: 'usr_gm_mar' }, // GM, Marylebone
];

describe('POST /v1/rota/import', () => {
  it('adds a draft, skips what is already on the rota, and refuses what a GM may not roster, with the reason', async () => {
    const k = await kit({ keys: KEYS });
    const org = await k.store.load('demo');
    const mar = org.state.employees.find((e) => e.siteId === 'mar' && e.status !== 'leaver' && e.rightToWork?.checked)!;
    const shd = org.state.employees.find((e) => e.siteId === 'shd' && !e.coverSiteIds.includes('mar'))!;
    const day = '2027-03-10';
    const shift = (e: typeof mar, siteId: string, startMinute = 600) => ({ employeeId: e.id, roleId: e.roleIds[0], siteId, date: day, startMinute, endMinute: startMinute + 360, breakMinutes: 20 });

    const res = await k.call('POST', '/v1/rota/import', { key: 'priya' }, {
      shifts: [shift(mar, 'mar'), shift(mar, 'mar'), shift(shd, 'mar'), shift(mar, 'shd', 900), { ...shift(mar, 'mar', 1000), roleId: 'nope' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.added).toBe(1);
    expect(res.body.skipped).toBe(1);
    expect(res.body.weeks).toEqual(['2027-03-08']);
    expect(res.body.refused.map((r: { index: number }) => r.index)).toEqual([2, 3, 4]);
    expect(res.body.refused[0].reason).toMatch(/has not agreed to cover/);
    expect(res.body.refused[2].reason).toMatch(/Role nope/);

    const after = await k.store.load('demo');
    const added = after.state.shifts.filter((s) => s.date === day && s.employeeId === mar.id);
    expect(added).toHaveLength(1);
    expect(added[0].published).toBe(false);
    expect(after.audit.at(-1)).toMatchObject({ action: 'rota.imported' });
  });
});
