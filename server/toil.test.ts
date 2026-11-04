import { describe, expect, it } from 'vitest';
import { kit } from './testkit';

// Time off in lieu through the API: entries added, never edited, one opening balance, and kept from those who do not see holiday.

const KEYS = [
  { key: 'olivia', orgId: 'demo', name: 'Olivia', scopes: ['*'] as ['*'], userId: 'usr_owner', mfa: true },
  { key: 'priya', orgId: 'demo', name: 'Priya', scopes: ['*'] as ['*'], userId: 'usr_gm_mar' },
];

describe('POST /v1/employees/:id/toil', () => {
  it('opens a balance once, records hours earned and taken, and returns what is owed', async () => {
    const k = await kit({ keys: KEYS });
    const org = await k.store.load('demo');
    const e = org.state.employees.find((x) => x.siteId === 'mar' && x.status !== 'leaver' && x.id !== 'mar-1')!;
    const post = (body: unknown) => k.call('POST', `/v1/employees/${e.id}/toil`, { key: 'olivia' }, body);
    const today = k.store.todayISO();

    expect((await post({ kind: 'opening', date: today, hours: 6, note: 'From the old system' })).status).toBe(201);
    expect((await post({ kind: 'opening', date: today, hours: 2 })).status).toBe(409);
    expect((await post({ kind: 'earned', date: today, hours: -1 })).status).toBe(422);
    const taken = await post({ kind: 'taken', date: today, hours: -2.5 });
    expect(taken.status).toBe(201);
    expect(taken.body.balance).toMatchObject({ hours: 3.5, earned: 6, taken: 2.5 });

    const after = await k.store.load('demo');
    expect(after.state.employees.find((x) => x.id === e.id)!.toil).toHaveLength(2);
    expect(after.audit.at(-1)).toMatchObject({ action: 'toil.recorded' });
  });

  it('is refused on your own record', async () => {
    const k = await kit({ keys: KEYS });
    const res = await k.call('POST', '/v1/employees/mar-1/toil', { key: 'priya' }, { kind: 'earned', date: k.store.todayISO(), hours: 2 });
    expect(res.status).toBe(403);
  });
});
