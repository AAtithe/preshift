import { describe, expect, it } from 'vitest';
import { reviewEmployee, ruleAge } from '../src/engine/employees';
import type { Employee } from '../src/engine/types';
import { kit } from './testkit';

// Grace Mensah is a supervisor at Marylebone: she sees the rota and records clock-ins. Before these
// tests she could clock a colleague's card in from anywhere at a time of her choosing, and read the
// date of birth, card number and immigration evidence of everyone on her rota.
const KEYS = [
  { key: 'grace', orgId: 'demo', name: 'Grace', scopes: ['*'] as ['*'], userId: 'usr_sup' }, // supervisor
  { key: 'priya', orgId: 'demo', name: 'Priya', scopes: ['*'] as ['*'], userId: 'usr_gm_mar' }, // GM, Marylebone
  { key: 'olivia', orgId: 'demo', name: 'Olivia', scopes: ['*'] as ['*'], userId: 'usr_owner', mfa: true },
  { key: 'reader', orgId: 'demo', name: 'Marylebone door reader', scopes: ['*'] as ['*'] }, // no person behind it
];
const grace = { key: 'grace' };
const priya = { key: 'priya' };
const olivia = { key: 'olivia' };
const reader = { key: 'reader' };
const READING = { lat: 51.4545, lng: -0.9781, accuracyMetres: 10 }; // 60 km from the site
const AT_DOOR = { lat: 51.5205, lng: -0.1527, accuracyMetres: 10 };
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

async function fenced() {
  const k = await kit({ keys: KEYS });
  expect((await k.call('PUT', '/v1/sites/mar/geofence', olivia, { ...AT_DOOR, radiusMetres: 100 })).status).toBe(200);
  expect((await k.call('PUT', '/v1/employees/mar-3/badge', priya, { badgeId: 'CARDMAR3' })).status).toBe(200);
  return k;
}

describe('a card tap', () => {
  it("from a person's screen needs the device on site", async () => {
    const k = await fenced();
    const away = await k.call('POST', '/v1/time-entries/tap', grace, { badgeId: 'CARDMAR3', siteId: 'mar', location: READING });
    expect(away.status).toBe(422);
    expect(away.body.error).toBe('outside_site');
    expect((await k.call('POST', '/v1/time-entries/tap', grace, { badgeId: 'CARDMAR3', siteId: 'mar' })).body.error).toBe('location_required');
    expect((await k.call('POST', '/v1/time-entries/tap', grace, { badgeId: 'CARDMAR3', siteId: 'mar', location: AT_DOOR })).status).toBe(201);
  });

  it('from a reader fixed on site needs no location', async () => {
    const k = await fenced();
    expect((await k.call('POST', '/v1/time-entries/tap', reader, { badgeId: 'CARDMAR3', siteId: 'mar' })).status).toBe(201);
  });
});

describe('the time of a clock', () => {
  it("is the server's when a person clocks, by card or by device", async () => {
    const k = await fenced();
    const backdated = { siteId: 'mar', location: AT_DOOR, at: minutesAgo(180) };
    const tap = await k.call('POST', '/v1/time-entries/tap', grace, { badgeId: 'CARDMAR3', ...backdated });
    expect(tap.status).toBe(422);
    expect(tap.body.error).toBe('time_set_by_server');
    expect((await k.call('POST', '/v1/time-entries/clock-in', grace, { employeeId: 'mar-3', ...backdated })).body.error).toBe('time_set_by_server');
    // A screen's own clock a few seconds out is not a backdated clock.
    expect((await k.call('POST', '/v1/time-entries/clock-in', grace, { employeeId: 'mar-3', siteId: 'mar', location: AT_DOOR, at: minutesAgo(0.5) })).status).toBe(201);
  });

  it('may be sent by a fixed reader for a tap held offline, never one in the future', async () => {
    const k = await fenced();
    expect((await k.call('POST', '/v1/time-entries/tap', reader, { badgeId: 'CARDMAR3', siteId: 'mar', at: minutesAgo(-60) })).status).toBe(422);
    expect((await k.call('POST', '/v1/time-entries/tap', reader, { badgeId: 'CARDMAR3', siteId: 'mar', at: minutesAgo(20) })).status).toBe(201);
  });
});

describe('personal details on the employee list', () => {
  const find = (list: Employee[], name: string) => list.find((e) => e.name === name)!;

  it('are withheld from a supervisor, keeping what the rota needs', async () => {
    const k = await fenced();
    const list = (await k.call('GET', '/v1/employees', grace)).body as Employee[];
    expect(list.length).toBeGreaterThan(0);
    for (const e of list) {
      expect(e).toMatchObject({ dateOfBirth: '', personalHidden: true });
      expect(typeof e.under18).toBe('boolean');
      expect(e.badgeId).toBeUndefined();
      expect(e.holiday).toBeUndefined();
      expect(e.rightToWork?.evidence).toBeUndefined();
      expect(e.rightToWork?.checkedOn).toBeUndefined();
      expect(e.rightToWork?.documents).toBeUndefined();
    }
    // An expiry inside the rota's reach stays, so a shift after it is still blocked.
    expect(find(list, 'Mateo Garcia').rightToWork).toEqual({ checked: true, expiry: expect.any(String) });
    const raw = JSON.stringify(list);
    expect(raw).not.toContain('Share code');
    expect(raw).not.toContain('CARDMAR3');
    expect(raw).not.toContain('2001-09-23');
  });

  it('say only checked or not when the expiry is beyond the rota', async () => {
    const k = await fenced();
    const org = await k.store.load('demo');
    const mateo = org.state.employees.find((e) => e.name === 'Mateo Garcia')!;
    mateo.rightToWork = { ...mateo.rightToWork!, expiry: '2028-06-30' };
    await k.store.save(org);
    const list = (await k.call('GET', '/v1/employees', grace)).body as Employee[];
    expect(find(list, 'Mateo Garcia').rightToWork).toEqual({ checked: true });
  });

  it('stay with the GM, who manages the team', async () => {
    const k = await fenced();
    const list = (await k.call('GET', '/v1/employees', priya)).body as Employee[];
    const mateo = find(list, 'Mateo Garcia');
    expect(mateo.personalHidden).toBeUndefined();
    expect(mateo.dateOfBirth).toBe('2001-09-23');
    expect(mateo.rightToWork?.evidence).toBe('Share code');
    expect(list.find((e) => e.id === 'mar-3')!.badgeId).toBe('CARDMAR3');
  });
});

describe('a record without personal details', () => {
  it('keeps the young worker rules and raises no false alarms', async () => {
    const k = await fenced();
    const org = await k.store.load('demo');
    org.state.employees.find((e) => e.id === 'mar-3')!.dateOfBirth = '2010-03-01';
    await k.store.save(org);
    const list = (await k.call('GET', '/v1/employees', grace)).body as Employee[];
    const young = list.find((e) => e.id === 'mar-3')!;
    expect(young.under18).toBe(true);
    expect(ruleAge(young, '2026-10-22')).toBeLessThan(18);
    const codes = list.flatMap((e) => reviewEmployee(e, '2026-10-22').map((c) => c.code));
    expect(codes).not.toContain('dob');
    expect(codes).not.toContain('right-to-work-copy');
    expect(codes).not.toContain('right-to-work-date');
  });
});
