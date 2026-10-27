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
  it('keeps one note per site per day, replaces it, and removes it when emptied', async () => {
    const k = await kit({ keys: KEYS });
    const first = await k.call('PUT', '/v1/day-notes', olivia, { siteId: 'fitz', date: '2026-11-07', text: 'Party of 40 at 8pm. ' });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ siteId: 'fitz', date: '2026-11-07', text: 'Party of 40 at 8pm.' });
    expect(first.body.updatedBy).toBeTruthy();

    await k.call('PUT', '/v1/day-notes', olivia, { siteId: 'fitz', date: '2026-11-07', text: 'Party of 40 at 8pm. Road closed from 6.' });
    const listed = await k.call('GET', '/v1/day-notes?siteId=fitz&from=2026-11-02&to=2026-11-08', olivia);
    expect(listed.body.map((n: { text: string }) => n.text)).toEqual(['Party of 40 at 8pm. Road closed from 6.']);

    await k.call('PUT', '/v1/day-notes', olivia, { siteId: 'fitz', date: '2026-11-07', text: '   ' });
    expect((await k.call('GET', '/v1/day-notes?siteId=fitz&from=2026-11-02&to=2026-11-08', olivia)).body).toEqual([]);
    expect((await k.call('PUT', '/v1/day-notes', olivia, { siteId: 'nowhere', date: '2026-11-07', text: 'x' })).status).toBe(404);
  });

  it("is written only by those who build that site's rota", async () => {
    const k = await kit({ keys: KEYS });
    expect((await k.call('PUT', '/v1/day-notes', priya, { siteId: 'mar', date: '2026-11-07', text: 'Road closed' })).status).toBe(200);
    expect((await k.call('PUT', '/v1/day-notes', priya, { siteId: 'fitz', date: '2026-11-07', text: 'Road closed' })).status).toBe(403);
    expect((await k.call('POST', '/v1/shift-types', priya, { siteId: 'fitz', name: 'Close', startMinute: 1020, endMinute: 1320, breakMinutes: 0 })).status).toBe(403);
    expect((await k.call('GET', '/v1/day-notes', priya)).body.every((n: { siteId: string }) => n.siteId === 'mar')).toBe(true);
  });
});
