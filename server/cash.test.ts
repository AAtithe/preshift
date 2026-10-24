import { describe, expect, it } from 'vitest';
import { MemoryStore } from './store';
import { kit, TODAY } from './testkit';

const person = (key: string, userId: string) => ({ key, orgId: 'demo', name: `${key} key`, scopes: ['*'] as ['*'], userId, mfa: true });

async function boot() {
  const store = new MemoryStore(['demo'], TODAY);
  const k = await kit({
    store,
    accounts: false,
    keys: [person('fd', 'usr_fd'), person('ma', 'usr_ws_ma'), person('gm', 'usr_gm_mar'), { key: 'system', orgId: 'demo', name: 'System', scopes: ['*'] }],
    now: () => new Date(`${TODAY}T09:00:00Z`),
  });
  const as = (key: string) => async (method: string, url: string, body?: unknown) => {
    const res = await k.call(method, url, { key }, body);
    return { status: res.status, body: res.body, raw: res.raw };
  };
  return { store, fd: as('fd'), ma: as('ma'), gm: as('gm'), system: as('system') };
}

describe('the labour cash calendar', () => {
  it('shows finance and the WS accountant every company’s payments, and refuses a GM', async () => {
    const t = await boot();
    const cal = await t.fd('GET', '/v1/finance/cash-calendar');
    expect(cal.status).toBe(200);
    expect(cal.body.weeks).toHaveLength(13);
    expect(cal.body.entities.map((e: { id: string }) => e.id).sort()).toEqual(['eck', 'wdl']);
    const kinds = new Set(cal.body.items.map((i: { kind: string }) => i.kind));
    expect([...kinds].sort()).toEqual(['hmrc', 'net-pay', 'pension']);
    // Every payment falls on a working day, inside the window.
    for (const i of cal.body.items) {
      expect(i.date >= cal.body.from && i.date <= cal.body.to).toBe(true);
      expect([0, 6]).not.toContain(new Date(`${i.date}T12:00:00Z`).getUTCDay());
    }
    expect((await t.ma('GET', '/v1/finance/cash-calendar')).status).toBe(200);
    expect((await t.gm('GET', '/v1/finance/cash-calendar')).status).toBe(403);
  });

  it('narrows to one company, and refuses one that does not exist', async () => {
    const t = await boot();
    const one = await t.fd('GET', '/v1/finance/cash-calendar?entityIds=wdl&weeks=6');
    expect(one.body.weeks).toHaveLength(6);
    expect(new Set(one.body.items.map((i: { entityId: string }) => i.entityId))).toEqual(new Set(['wdl']));
    expect((await t.fd('GET', '/v1/finance/cash-calendar?entityIds=nope')).status).toBe(404);
  });

  it('moves pay days when a company changes its schedule, which only a settings person may do', async () => {
    const t = await boot();
    expect((await t.fd('PUT', '/v1/entities/wdl/pay-schedule', { frequency: 'monthly', monthlyPayDay: 'last-working' })).status).toBe(403);
    expect((await t.system('PUT', '/v1/entities/wdl/pay-schedule', { frequency: 'fortnightly', anchor: '2026-04-07' })).status).toBe(422);
    const set = await t.system('PUT', '/v1/entities/wdl/pay-schedule', { frequency: 'monthly', monthlyPayDay: 'last-working' });
    expect(set.body.paySchedule).toMatchObject({ frequency: 'monthly', monthlyPayDay: 'last-working' });
    const cal = await t.fd('GET', '/v1/finance/cash-calendar?entityIds=wdl');
    const pays = cal.body.items.filter((i: { kind: string }) => i.kind === 'net-pay').map((i: { date: string }) => i.date);
    // October, November and December, each on its last working day.
    expect(pays).toEqual(['2026-10-30', '2026-11-30', '2026-12-31']);
    expect(cal.body.entities.find((e: { id: string }) => e.id === 'wdl').scheduleSet).toBe(true);
    expect((await t.store.load('demo')).audit.some((a) => a.action === 'entity.pay_schedule_changed')).toBe(true);
  });

  it('downloads the calendar as a CSV', async () => {
    const t = await boot();
    const csv = await t.fd('GET', '/v1/finance/cash-calendar.csv');
    expect(csv.status).toBe(200);
    expect(csv.raw.split('\n')[0]).toBe('Date,Company,Payment,Amount,Covers from,Covers to,People,Basis');
    expect(csv.raw.split('\n').length).toBeGreaterThan(10);
  });
});
