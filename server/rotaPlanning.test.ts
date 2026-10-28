import { describe, expect, it } from 'vitest';
import { kit } from './testkit';

const KEYS = [
  { key: 'olivia', orgId: 'demo', name: 'Olivia', scopes: ['*'] as ['*'], userId: 'usr_owner', mfa: true },
  { key: 'priya', orgId: 'demo', name: 'Priya', scopes: ['*'] as ['*'], userId: 'usr_gm_mar' }, // GM, Marylebone
];
const olivia = { key: 'olivia' };
const priya = { key: 'priya' };

describe('shift types', () => {
  it('saves a pattern at a site, lists it, refuses a duplicate name and removes it', async () => {
    const k = await kit({ keys: KEYS });
    const before = await k.call('GET', '/v1/shift-types?siteId=mar', olivia);
    expect(before.status).toBe(200);
    const seeded = before.body.length;

    const made = await k.call('POST', '/v1/shift-types', olivia, { siteId: 'mar', name: ' Late bar ', startMinute: 18 * 60, endMinute: 25 * 60, breakMinutes: 30, roleId: 'bar' });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ siteId: 'mar', name: 'Late bar', startMinute: 1080, endMinute: 1500, breakMinutes: 30, roleId: 'bar' });

    expect((await k.call('GET', '/v1/shift-types?siteId=mar', olivia)).body).toHaveLength(seeded + 1);
    expect((await k.call('POST', '/v1/shift-types', olivia, { siteId: 'mar', name: 'late bar', startMinute: 600, endMinute: 900, breakMinutes: 0 })).status).toBe(409);
    expect((await k.call('POST', '/v1/shift-types', olivia, { siteId: 'mar', name: 'Backwards', startMinute: 900, endMinute: 600, breakMinutes: 0 })).status).toBe(422);
    expect((await k.call('POST', '/v1/shift-types', olivia, { siteId: 'mar', name: 'Nobody', startMinute: 600, endMinute: 900, breakMinutes: 0, roleId: 'astronaut' })).status).toBe(404);

    expect((await k.call('DELETE', `/v1/shift-types/${made.body.id}`, olivia)).status).toBe(204);
    expect((await k.call('GET', '/v1/shift-types?siteId=mar', olivia)).body).toHaveLength(seeded);
  });
});

describe('day notes', () => {
  const note = (over: object = {}) => ({ siteId: 'fitz', date: '2026-11-07', kind: 'booking', text: 'Party of 40 at 8pm. ', ...over });

  it('holds several notes on a day, each changed or removed on its own', async () => {
    const k = await kit({ keys: KEYS });
    const party = await k.call('POST', '/v1/day-notes', olivia, note({ startMinute: 1200, team: true }));
    expect(party.status).toBe(201);
    expect(party.body).toMatchObject({ siteId: 'fitz', date: '2026-11-07', kind: 'booking', text: 'Party of 40 at 8pm.', startMinute: 1200, team: true, updatedBy: expect.any(String) });
    const road = await k.call('POST', '/v1/day-notes', olivia, note({ kind: 'closure', text: 'Road closed from 6.' }));
    const week = '/v1/day-notes?siteId=fitz&from=2026-11-02&to=2026-11-08';
    expect((await k.call('GET', week, olivia)).body).toHaveLength(2);

    // A rewrite sends the whole note: what is left out, the time and the team, goes.
    const changed = await k.call('PUT', `/v1/day-notes/${party.body.id}`, olivia, note({ text: 'Party of 45 at 8pm.' }));
    expect(changed.status).toBe(200);
    expect(changed.body.text).toBe('Party of 45 at 8pm.');
    expect(changed.body.startMinute).toBeUndefined();
    expect(changed.body.team).toBeUndefined();

    expect((await k.call('DELETE', `/v1/day-notes/${road.body.id}`, olivia)).status).toBe(204);
    expect((await k.call('GET', week, olivia)).body.map((n: { text: string }) => n.text)).toEqual(['Party of 45 at 8pm.']);
  });

  it('repeats a weekly note and lists it for any week it falls in', async () => {
    const k = await kit({ keys: KEYS });
    const delivery = await k.call('POST', '/v1/day-notes', olivia, note({ date: '2026-11-03', kind: 'delivery', text: 'Bidfood at 7.', weekly: true, until: '2026-11-24' }));
    expect(delivery.status).toBe(201);
    const ids = async (from: string, to: string) => (await k.call('GET', `/v1/day-notes?siteId=fitz&from=${from}&to=${to}`, olivia)).body.map((n: { id: string }) => n.id);
    expect(await ids('2026-11-16', '2026-11-22')).toContain(delivery.body.id);
    expect(await ids('2026-11-30', '2026-12-06')).not.toContain(delivery.body.id);
    expect(await ids('2026-10-26', '2026-11-01')).not.toContain(delivery.body.id);
  });

  it('refuses a note with nothing in it, or an end date that does not fit', async () => {
    const k = await kit({ keys: KEYS });
    expect((await k.call('POST', '/v1/day-notes', olivia, note({ text: '   ' }))).status).toBe(422);
    expect((await k.call('POST', '/v1/day-notes', olivia, note({ until: '2026-12-01' }))).status).toBe(422);
    expect((await k.call('POST', '/v1/day-notes', olivia, note({ weekly: true, until: '2026-11-01' }))).status).toBe(422);
    expect((await k.call('POST', '/v1/day-notes', olivia, note({ kind: 'gossip' }))).status).toBe(400);
    expect((await k.call('POST', '/v1/day-notes', olivia, note({ siteId: 'nowhere' }))).status).toBe(404);
    expect((await k.call('PUT', '/v1/day-notes/dn_missing', olivia, note())).status).toBe(404);
  });

  it("is written only by those who build that site's rota", async () => {
    const k = await kit({ keys: KEYS });
    expect((await k.call('POST', '/v1/day-notes', priya, note({ siteId: 'mar' }))).status).toBe(201);
    expect((await k.call('POST', '/v1/day-notes', priya, note())).status).toBe(403);
    const fitz = (await k.call('POST', '/v1/day-notes', olivia, note())).body.id;
    expect((await k.call('PUT', `/v1/day-notes/${fitz}`, priya, note({ siteId: 'mar' }))).status).toBe(403);
    expect((await k.call('DELETE', `/v1/day-notes/${fitz}`, priya)).status).toBe(403);
    expect((await k.call('POST', '/v1/shift-types', priya, { siteId: 'fitz', name: 'Close', startMinute: 1020, endMinute: 1320, breakMinutes: 0 })).status).toBe(403);
    expect((await k.call('GET', '/v1/day-notes', priya)).body.every((n: { siteId: string }) => n.siteId === 'mar')).toBe(true);
  });
});
