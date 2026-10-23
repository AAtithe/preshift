import { describe, expect, it } from 'vitest';
import type { HrRecord } from '../src/engine/types';
import { DEMO_TOTP_SECRET } from './seedUsers';
import { enterCode, kit } from './testkit';

// The owner may make API keys. Before these tests a key she made set pay directly, hers included,
// with nobody approving; read the investigation into her; and showed in the audit as the key alone.
// A key now answers to the person who made it.
const KEYS = [
  { key: 'kate', orgId: 'demo', name: 'Kate', scopes: ['*'] as ['*'], userId: 'usr_people', mfa: true }, // people manager
  { key: 'nadia', orgId: 'demo', name: 'Nadia', scopes: ['*'] as ['*'], userId: 'usr_fd', mfa: true }, // finance director
  { key: 'deploy', orgId: 'demo', name: 'Deployment', scopes: ['*'] as ['*'] }, // set in the environment, not made by a person
];
const kate = { key: 'kate' };
const nadia = { key: 'nadia' };
const SELF = 'mar-6'; // the owner is on the payroll

async function ownersKey(scopes: string[]) {
  const k = await kit({ keys: KEYS });
  const org = await k.store.load('demo');
  org.users.find((u) => u.id === 'usr_owner')!.employeeId = SELF;
  org.users.find((u) => u.id === 'usr_fd')!.mfaEnrolled = true;
  await k.store.save(org);
  const cookie = await enterCode(k, await k.as('olivia@marylebonegroup.example'), DEMO_TOTP_SECRET);
  const made = await k.call('POST', '/v1/api-keys', cookie, { name: 'Tevalis EPOS', scopes });
  expect(made.status).toBe(201);
  return { k, key: { key: made.body.key as string } };
}

describe('pay through a key', () => {
  it('is proposed for finance, never set, and names the person who made the key', async () => {
    const { k, key } = await ownersKey(['rota:write', 'employees:read']);
    const before = (await k.call('GET', '/v1/employees/mar-3', kate)).body.hourlyRate;
    const res = await k.call('PATCH', '/v1/employees/mar-3', key, { hourlyRate: 25 });
    expect(res.status).toBe(200);
    expect(res.body.hourlyRate).toBe(before);
    expect(res.body.pendingPay).toMatchObject({ after: { hourlyRate: 25 }, requestedBy: 'API key Tevalis EPOS, made by Olivia Grant' });
    const org = await k.store.load('demo');
    expect(org.audit.at(-1)).toMatchObject({ actor: 'API key Tevalis EPOS, made by Olivia Grant', action: 'pay.change_proposed' });
  });

  it("is never the maker's own", async () => {
    const { k, key } = await ownersKey(['rota:write', 'employees:read']);
    const own = await k.call('PATCH', `/v1/employees/${SELF}`, key, { hourlyRate: 40 });
    expect(own.status).toBe(403);
    expect(own.body.message).toBe('Somebody else changes your own pay.');
    const holiday = await k.call('PATCH', `/v1/employees/${SELF}`, key, { holiday: { carriedOverHours: 200 } });
    expect(holiday.status).toBe(403);
    expect(holiday.body.message).toBe('Somebody else keeps your own staff record.');
  });

  it('is decided by a person, never by a key', async () => {
    const { k, key } = await ownersKey(['rota:write', 'employees:read']);
    const proposed = await k.call('POST', '/v1/employees/mar-3/pay-changes', kate, { hourlyRate: 26 });
    expect(proposed.status).toBe(201);
    const byKey = await k.call('POST', `/v1/pay-changes/${proposed.body.id}/approve`, key, {});
    expect(byKey.status).toBe(403);
    expect(byKey.body.message).toBe('A person decides pay, not an API key.');
    expect((await k.call('POST', `/v1/pay-changes/${proposed.body.id}/approve`, nadia, {})).status).toBe(200);
  });

  it('is still set directly by a deployment key, which no person made', async () => {
    const { k } = await ownersKey(['rota:write']);
    const res = await k.call('PATCH', '/v1/employees/mar-3', { key: 'deploy' }, { hourlyRate: 25 });
    expect(res.body.hourlyRate).toBe(25);
  });
});

describe('cases through a key', () => {
  it('are never shown to or recorded by a system, about its maker or anyone', async () => {
    const { k, key } = await ownersKey(['hr:read', 'hr:write']);
    for (const employeeId of [SELF, 'mar-3']) {
      const opened = await k.call('POST', '/v1/hr/records', kate, { employeeId, kind: 'case', caseType: 'investigation', date: '2026-10-20', title: `Investigation ${employeeId}` });
      expect(opened.status).toBe(201);
    }
    const seen = (await k.call('GET', '/v1/hr/records', key)).body as HrRecord[];
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((r) => r.kind === 'case')).toEqual([]);
    const opened = await k.call('POST', '/v1/hr/records', key, { employeeId: 'mar-3', kind: 'case', caseType: 'grievance', date: '2026-10-21', title: 'x' });
    expect(opened.status).toBe(403);
    expect(opened.body.message).toBe('Cases are recorded by a person, not an API key.');
    // Kate, a person who handles cases, still sees both.
    expect((await k.call('GET', '/v1/hr/records?kind=case', kate)).body.length).toBeGreaterThanOrEqual(2);
  });
});
