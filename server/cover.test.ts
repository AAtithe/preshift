import { describe, expect, it } from 'vitest';
import { kit } from './testkit';

const WEEK = '2026-10-19';
const KEYS = [
  { key: 'gm-mar', orgId: 'demo', name: 'Priya key', scopes: ['*' as const], userId: 'usr_gm_mar' },
  { key: 'area', orgId: 'demo', name: 'Daniel key', scopes: ['*' as const], userId: 'usr_area', mfa: true },
];

const shift = (employeeId: string, roleId: string, extra: Record<string, unknown> = {}) => ({
  employeeId, roleId, siteId: 'mar', date: WEEK, startMinute: 600, endMinute: 900, breakMinutes: 0, ...extra,
});

describe('rostering other sites\' people', () => {
  it('lets a site manager borrow only people who have agreed to cover their site', async () => {
    const k = await kit({ keys: KEYS as never });
    const gm = { key: 'gm-mar' };
    // Dev Kapoor (Shoreditch) has agreed to cover Marylebone; Kwame Asante (Shoreditch) has not.
    expect((await k.call('POST', '/v1/shifts', gm, shift('shd-12', 'bar'))).status).toBe(201);
    const refused = await k.call('POST', '/v1/shifts', gm, shift('shd-2', 'chef'));
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('not_cover');
    expect(refused.body.message).toMatch(/Kwame Asante has not agreed to cover Marylebone/);

    // Swapping an agreed shift onto someone who has not agreed is the same new pairing.
    const own = await k.call('POST', '/v1/shifts', gm, shift('mar-8', 'server'));
    expect((await k.call('PATCH', `/v1/shifts/${own.body.shift.id}`, gm, { employeeId: 'shd-2', roleId: 'chef' })).status).toBe(403);
    // Changing only the hours of a shift already agreed is never refused.
    expect((await k.call('PATCH', `/v1/shifts/${own.body.shift.id}`, gm, { endMinute: 960 })).status).toBe(200);
  });

  it('lets someone who runs both sites roster across them', async () => {
    const k = await kit({ keys: KEYS as never });
    expect((await k.call('POST', '/v1/shifts', { key: 'area' }, shift('shd-2', 'chef'))).status).toBe(201);
  });

  it('keeps a borrowed shift an area manager made when the site manager re-saves the week', async () => {
    const k = await kit({ keys: KEYS as never });
    const borrowed = (await k.call('POST', '/v1/shifts', { key: 'area' }, shift('shd-2', 'chef'))).body.shift;
    const res = await k.call('PUT', '/v1/rota/week', { key: 'gm-mar' }, {
      siteId: 'mar', weekStart: WEEK,
      shifts: [
        { ...shift('shd-2', 'chef'), id: borrowed.id },
        { ...shift('shd-2', 'chef', { date: '2026-10-20' }), id: 'new-one' },
      ],
    });
    // The agreed shift passes; the new pairing on another day does not.
    expect(res.status).toBe(403);
    const ok = await k.call('PUT', '/v1/rota/week', { key: 'gm-mar' }, { siteId: 'mar', weekStart: WEEK, shifts: [{ ...shift('shd-2', 'chef'), id: borrowed.id }] });
    expect(ok.status).toBe(200);
  });
});
