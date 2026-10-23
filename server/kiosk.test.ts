import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { COOKIE, KIOSK_COOKIE } from './session';
import { MemoryStore } from './store';

const OWNER = { email: 'gm@ws.example', password: 'correct horse battery' };
const SITE = { lat: 51.5205, lng: -0.1517 };

async function boot() {
  const store = new MemoryStore(['demo'], '2026-10-21');
  const { app } = await buildApp({ apiKeys: [{ key: 'integration', orgId: 'demo', name: 'Integration', scopes: ['*'] }], store, provider: new TeamPaySimulator(), autoDispatch: false });
  const cookies = (res: { headers: Record<string, unknown> }) => {
    const raw = res.headers['set-cookie'];
    return (Array.isArray(raw) ? raw : raw ? [String(raw)] : []).map((c) => c.split(';')[0]);
  };
  const call = async (method: string, url: string, body?: unknown, cookie?: string, key?: string) => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      payload: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.statusCode, body: res.body ? res.json() : undefined, cookies: cookies(res), raw: res.headers['set-cookie'] };
  };
  const setup = await app.inject({
    method: 'POST',
    url: '/auth/setup',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ email: OWNER.email, password: OWNER.password, confirm: OWNER.password, next: '/app/' }).toString(),
  });
  const manager = cookies(setup)[0];
  // The kiosk works on today in London, as the clock on the wall does.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
  return { app, store, call, manager, today };
}

async function paired() {
  const t = await boot();
  const res = await t.call('POST', '/v1/kiosks', { siteId: 'mar', name: 'Staff entrance iPad' }, t.manager);
  expect(res.status).toBe(201);
  const kiosk = res.cookies.find((c) => c.startsWith(`${KIOSK_COOKIE}=`))!;
  // Put someone on today's rota at Marylebone, and someone at Shoreditch.
  for (const [employeeId, siteId] of [['mar-1', 'mar'], ['shd-1', 'shd']]) {
    await t.call('POST', '/v1/shifts', { employeeId, roleId: 'bar', siteId, date: t.today, startMinute: 0, endMinute: 1439, breakMinutes: 0 }, undefined, 'integration');
  }
  return { ...t, kiosk, kioskId: res.body.kiosk.id as string };
}

describe('pairing a kiosk', () => {
  it('only from a signed-in person on the device, who is signed out of it in the same step', async () => {
    const t = await boot();
    expect((await t.call('POST', '/v1/kiosks', { siteId: 'mar', name: 'iPad' }, undefined, 'integration')).body.error).toBe('session_only');
    const res = await t.call('POST', '/v1/kiosks', { siteId: 'mar', name: 'Staff entrance iPad' }, t.manager);
    expect(res.status).toBe(201);
    expect(res.body.path).toBe('/kiosk/');
    const raw = (res.raw as string[]).join('\n');
    expect(raw).toMatch(new RegExp(`${KIOSK_COOKIE}=[^;]+; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`));
    expect(raw).toMatch(new RegExp(`${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`));
    expect((await t.call('GET', '/v1/kiosks', undefined, t.manager)).body).toEqual([expect.objectContaining({ siteId: 'mar', name: 'Staff entrance iPad', pairedBy: expect.any(String) })]);
  });
});

describe('the kiosk', () => {
  it("shows today's rota at its own site only", async () => {
    const t = await paired();
    const board = await t.call('GET', '/v1/kiosk/board', undefined, t.kiosk);
    expect(board.status).toBe(200);
    expect(board.body.site).toEqual({ id: 'mar', name: 'Marylebone' });
    expect(board.body.people.map((p: { id: string }) => p.id)).toEqual(['mar-1']);
    expect(board.body.people[0]).toMatchObject({ status: 'not_in', shift: { start: 0, end: 1439 } });
  });

  it('clocks in, breaks and out by name with no location, even at a fenced site', async () => {
    const t = await paired();
    await t.call('PUT', '/v1/sites/mar/geofence', { ...SITE, radiusMetres: 100 }, undefined, 'integration');
    const clock = (action: string, employeeId = 'mar-1') => t.call('POST', '/v1/kiosk/clock', { employeeId, action }, t.kiosk);
    const inn = await clock('in');
    expect(inn.status).toBe(200);
    expect(inn.body).toMatchObject({ action: 'in', name: expect.any(String), entry: { method: 'kiosk', status: 'open', siteId: 'mar' } });
    expect((await clock('in')).body.error).toBe('already_clocked_in');
    expect((await clock('break_start')).body.board.people[0].status).toBe('break');
    expect((await clock('break_end')).body.board.people[0].status).toBe('in');
    const out = await clock('out');
    expect(out.body.entry).toMatchObject({ status: 'submitted', breaks: [expect.objectContaining({ end: expect.any(Number) })] });
    expect(out.body.board.people[0].status).toBe('out');
    // Someone on another site's rota cannot be clocked from this kiosk.
    expect((await clock('in', 'shd-1')).body.error).toBe('not_on_rota');
  });

  it('takes card taps as a fixed reader', async () => {
    const t = await paired();
    await t.call('PUT', '/v1/sites/mar/geofence', { ...SITE, radiusMetres: 100 }, undefined, 'integration');
    await t.call('PUT', '/v1/employees/mar-1/badge', { badgeId: 'AB12CD34' }, undefined, 'integration');
    const tap = await t.call('POST', '/v1/kiosk/tap', { badgeId: 'ab:12:cd:34' }, t.kiosk);
    expect(tap.body).toMatchObject({ action: 'clock_in', entry: { method: 'card', siteId: 'mar' } });
    expect((await t.call('POST', '/v1/kiosk/tap', { badgeId: 'AB12CD34' }, t.kiosk)).body.action).toBe('already_clocked_in');
    expect((await t.call('POST', '/v1/kiosk/tap', { badgeId: 'FFFF0000' }, t.kiosk)).body.error).toBe('unknown_card');
  });

  it('reaches nothing in the manager app or API', async () => {
    const t = await paired();
    for (const url of ['/v1/employees', '/v1/time-entries', '/v1/kiosks', '/auth/me']) {
      expect((await t.call('GET', url, undefined, t.kiosk)).status, url).toBe(401);
    }
    expect((await t.app.inject({ method: 'GET', url: '/v1/staff/me', headers: { cookie: t.kiosk } })).statusCode).toBe(401);
  });

  it('stops at once when removed, and refuses forged or tampered credentials', async () => {
    const t = await paired();
    const value = t.kiosk.slice(KIOSK_COOKIE.length + 1);
    const claim = JSON.parse(Buffer.from(value, 'base64url').toString());
    const forge = (v: object) => `${KIOSK_COOKIE}=${Buffer.from(JSON.stringify(v)).toString('base64url')}`;
    expect((await t.call('GET', '/v1/kiosk/board', undefined, forge({ ...claim, s: 'guess' }))).status).toBe(401);
    expect((await t.call('GET', '/v1/kiosk/board', undefined, `${KIOSK_COOKIE}=not-base64-json`)).status).toBe(401);
    // A made-up organisation is refused without being created.
    expect((await t.call('GET', '/v1/kiosk/board', undefined, forge({ ...claim, o: 'acme' }))).status).toBe(401);
    expect(await t.store.has('acme')).toBe(false);

    expect((await t.call('DELETE', `/v1/kiosks/${t.kioskId}`, undefined, undefined, 'integration')).status).toBe(204);
    expect((await t.call('GET', '/v1/kiosk/board', undefined, t.kiosk)).body.error).toBe('not_paired');
    const org = await t.store.load('demo');
    expect(org.audit.map((a) => a.action)).toEqual(expect.arrayContaining(['kiosk.paired', 'kiosk.removed']));
  });
});

describe('kiosk PINs', () => {
  it('refuse PINs that are easy to guess, including the birth date', async () => {
    const { pinProblem, randomPin } = await import('../src/engine/pin');
    const who = { dateOfBirth: '1996-07-14' };
    for (const bad of ['123', '1234567', '12a4', '0000', '1234', '9876', '7890', '1407', '0714', '1996', '140796']) {
      expect(pinProblem(bad, who), bad).not.toBeNull();
    }
    expect(pinProblem('4827', who)).toBeNull();
    for (let i = 0; i < 50; i++) expect(pinProblem(randomPin(who), who)).toBeNull();
  });

  it('once a site asks for them, sign-in by name needs the right PIN, and cards do not', async () => {
    const t = await paired();
    const clock = (action: string, pin?: string) => t.call('POST', '/v1/kiosk/clock', { employeeId: 'mar-1', action, ...(pin ? { pin } : {}) }, t.kiosk);

    expect((await t.call('PUT', '/v1/sites/mar/kiosk-pin', { required: true }, undefined, 'integration')).body.kioskPinRequired).toBe(true);
    expect((await t.call('GET', '/v1/kiosk/board', undefined, t.kiosk)).body).toMatchObject({ pinRequired: true, people: [{ hasPin: false }] });
    expect((await clock('in')).body.error).toBe('no_pin');

    // Never stored in the clear: not on the record, not in organisation data. The demo data already holds
    // four digit values (an intercompany code is 1351), so the check is that issuing the PIN added no copy
    // of it, not that the value appears nowhere, or a random PIN that matches one fails the test.
    const before = JSON.stringify(await t.store.load('demo'));
    const issued = await t.call('POST', '/v1/employees/mar-1/kiosk-pin', undefined, undefined, 'integration');
    expect(issued.status).toBe(201);
    const pin = issued.body.pin as string;
    expect(pin).toMatch(/^\d{4}$/);
    const org = await t.store.load('demo');
    const copies = (json: string) => json.split(`"${pin}"`).length - 1;
    expect(copies(JSON.stringify(org))).toBe(copies(before));
    expect(org.state.employees.find((e) => e.id === 'mar-1')).toMatchObject({ kioskPinSetBy: 'manager', kioskPinSetAt: expect.any(String) });

    expect((await clock('in')).body.error).toBe('pin_required');
    const wrong = pin === '4827' ? '5938' : '4827';
    expect((await clock('in', wrong)).body).toMatchObject({ error: 'wrong_pin', details: { triesLeft: 4 } });
    const inn = await clock('in', pin);
    expect(inn.status).toBe(200);
    expect(inn.body.entry.method).toBe('kiosk');

    // Cards are unaffected by the PIN setting.
    await t.call('PUT', '/v1/employees/mar-1/badge', { badgeId: 'AB12CD34' }, undefined, 'integration');
    expect((await t.call('POST', '/v1/kiosk/tap', { badgeId: 'AB12CD34' }, t.kiosk)).status).toBe(200);
  });

  it('locks a PIN after five wrong tries, for that person only', async () => {
    const t = await paired();
    await t.call('PUT', '/v1/sites/mar/kiosk-pin', { required: true }, undefined, 'integration');
    const pin = (await t.call('POST', '/v1/employees/mar-1/kiosk-pin', undefined, undefined, 'integration')).body.pin as string;
    const wrong = pin === '4827' ? '5938' : '4827';
    const results = [];
    for (let i = 0; i < 5; i++) results.push((await t.call('POST', '/v1/kiosk/clock', { employeeId: 'mar-1', action: 'in', pin: wrong }, t.kiosk)).body.error);
    expect(results).toEqual(['wrong_pin', 'wrong_pin', 'wrong_pin', 'wrong_pin', 'pin_locked']);
    // Even the right PIN is refused while locked.
    expect((await t.call('POST', '/v1/kiosk/clock', { employeeId: 'mar-1', action: 'in', pin }, t.kiosk)).body.error).toBe('pin_locked');
    // Someone else on the rota is not locked out by it.
    await t.call('POST', '/v1/shifts', { employeeId: 'mar-2', roleId: 'bar', siteId: 'mar', date: t.today, startMinute: 0, endMinute: 1439, breakMinutes: 0 }, undefined, 'integration');
    const other = (await t.call('POST', '/v1/employees/mar-2/kiosk-pin', undefined, undefined, 'integration')).body.pin;
    expect((await t.call('POST', '/v1/kiosk/clock', { employeeId: 'mar-2', action: 'in', pin: other }, t.kiosk)).status).toBe(200);
    // A new PIN from a manager clears the lock.
    const fresh = (await t.call('POST', '/v1/employees/mar-1/kiosk-pin', undefined, undefined, 'integration')).body.pin;
    expect((await t.call('POST', '/v1/kiosk/clock', { employeeId: 'mar-1', action: 'in', pin: fresh }, t.kiosk)).status).toBe(200);
  }, 60_000);

  it('lets a person set their own PIN in the staff app, never someone else at the kiosk', async () => {
    const t = await paired();
    await t.call('PUT', '/v1/sites/mar/kiosk-pin', { required: true }, undefined, 'integration');
    const invite = await t.call('POST', '/v1/staff-logins/mar-1/invite', undefined, undefined, 'integration');
    const link = Object.fromEntries(new URLSearchParams(new URL(invite.body.path, 'https://x').hash.slice(1)));
    const joined = await t.call('POST', '/v1/staff/join', { ...link, email: 'priya@example.com', password: 'pint of best bitter' });
    const staff = joined.cookies[0];
    expect(joined.body.kioskPin).toEqual({ set: false, required: true });

    expect((await t.call('PUT', '/v1/staff/kiosk-pin', { pin: '1234' }, staff)).body.error).toBe('weak_pin');
    const set = await t.call('PUT', '/v1/staff/kiosk-pin', { pin: '4827' }, staff);
    expect(set.body.kioskPin).toEqual({ set: true, required: true });
    expect((await t.call('PUT', '/v1/staff/kiosk-pin', { pin: '4827' })).status).toBe(401);
    expect((await t.call('POST', '/v1/kiosk/clock', { employeeId: 'mar-1', action: 'in', pin: '4827' }, t.kiosk)).status).toBe(200);
    expect((await t.call('DELETE', '/v1/employees/mar-1/kiosk-pin', undefined, undefined, 'integration')).status).toBe(204);
    expect((await t.call('POST', '/v1/kiosk/clock', { employeeId: 'mar-1', action: 'out', pin: '4827' }, t.kiosk)).body.error).toBe('no_pin');
  });

});
