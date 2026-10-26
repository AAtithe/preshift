import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { MemoryStore } from './store';
import { aesCmac, readSun, sunMac, sunPicc } from './tagSun';
import { freezeClock } from './testClock';

const PASSWORD = 'pint of best bitter';
const SERIAL = Buffer.from('04A1B2C3D4E5F6', 'hex');

afterEach(() => vi.useRealTimers());

describe('secure tag reads', () => {
  it('match the AES-CMAC test vectors in RFC 4493', () => {
    const key = Buffer.from('2b7e151628aed2a6abf7158809cf4f3c', 'hex');
    expect(aesCmac(key, Buffer.alloc(0)).toString('hex')).toBe('bb1d6929e95937287fa37d129b756746');
    expect(aesCmac(key, Buffer.from('6bc1bee22e409f96e93d7e117393172a', 'hex')).toString('hex')).toBe('070a16b46b4d4144f79bdd9dd04a287c');
    const forty = '6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411';
    expect(aesCmac(key, Buffer.from(forty, 'hex')).toString('hex')).toBe('dfa66747de9ae63030ca32611497c827');
  });

  it("read NXP's own example from AN12196", () => {
    const zero = Buffer.alloc(16);
    expect(readSun(zero, zero, 'EF963FF7828658A599F3041510671E88', '94EED9EE65337086')).toEqual({ uid: '04DE5F1EACC040', counter: 61 });
    // One character changed in the MAC, or the wrong key: not this tag.
    expect(readSun(zero, zero, 'EF963FF7828658A599F3041510671E88', '94EED9EE65337087')).toBeNull();
    expect(readSun(Buffer.alloc(16, 1), zero, 'EF963FF7828658A599F3041510671E88', '94EED9EE65337086')).toBeNull();
    expect(readSun(zero, zero, 'not hex', '94EED9EE65337086')).toBeNull();
  });
});

async function boot() {
  const store = new MemoryStore(['demo'], '2026-10-21');
  const { app } = await buildApp({ apiKeys: [{ key: 'manager', orgId: 'demo', name: 'GM', scopes: ['*'] }], store, provider: new TeamPaySimulator(), autoDispatch: false });
  const send = async (method: string, url: string, headers: Record<string, string>, body?: unknown) => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      payload: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.statusCode, body: res.body ? res.json() : undefined, cookie: String(res.headers['set-cookie'] ?? '').split(';')[0] };
  };
  const manager = (method: string, url: string, body?: unknown) => send(method, url, { authorization: 'Bearer manager' }, body);
  const staff = (cookie: string, method: string, url: string, body?: unknown) => send(method, url, { cookie }, body);

  async function signIn(person: string, email: string) {
    const link = Object.fromEntries(new URLSearchParams(new URL((await manager('POST', `/v1/staff-logins/${person}/invite`)).body.path, 'https://x').hash.slice(1)));
    const joined = await send('POST', '/v1/staff/join', {}, { ...link, email, password: PASSWORD });
    expect(joined.status).toBe(200);
    return joined.cookie;
  }

  /** Adds a tag and stands in for it: each read writes the next counter, as the chip does. */
  async function stick(siteId: string, serial = SERIAL) {
    const added = await manager('POST', '/v1/tap-points', { siteId, name: 'Staff entrance' });
    expect(added.status).toBe(201);
    const meta = Buffer.from(added.body.keys.metaRead, 'hex');
    const file = Buffer.from(added.body.keys.fileRead, 'hex');
    let counter = 0;
    const tag = added.body.tapPoint.id as string;
    const read = (n = ++counter) => ({ tag, picc: sunPicc(meta, serial, n).toString('hex').toUpperCase(), cmac: sunMac(file, serial, n).toString('hex').toUpperCase() });
    return { tag, read, added: added.body };
  }
  return { store, manager, staff, signIn, stick };
}

describe('clocking by touching a phone to the site tag', () => {
  it('adds a tag, gives its keys once, and never shows them again', async () => {
    const t = await boot();
    const { added } = await t.stick('mar');
    expect(added.keys.metaRead).toMatch(/^[0-9A-F]{32}$/);
    expect(added.keys.fileRead).toMatch(/^[0-9A-F]{32}$/);
    expect(added.keys.metaRead).not.toBe(added.keys.fileRead);
    expect(added.tapPoint.path).toBe(`/staff/?tag=${added.tapPoint.id}&picc=${'0'.repeat(32)}&cmac=${'0'.repeat(16)}`);
    const list = await t.manager('GET', '/v1/tap-points');
    expect(list.body).toEqual([expect.objectContaining({ id: added.tapPoint.id, siteId: 'mar', name: 'Staff entrance', lastTapAt: null })]);
    expect(JSON.stringify(list.body)).not.toContain(added.keys.metaRead);
    expect(JSON.stringify(list.body)).not.toContain(added.keys.fileRead);
  });

  it('clocks in and out with no location, at a site with no geofence, and records how', async () => {
    const t = await boot();
    const me = await t.signIn('mar-1', 'priya@example.com');
    const { read } = await t.stick('mar');
    freezeClock('2026-10-21T08:00:00Z');
    const first = await t.staff(me, 'POST', '/v1/staff/tap', read());
    expect(first.status).toBe(200);
    expect(first.body.tap).toEqual({ action: 'clock_in', siteName: 'Marylebone' });
    expect(first.body.overview.open).toMatchObject({ siteId: 'mar', method: 'tag', status: 'open', clockIn: 9 * 60 });
    expect(first.body.overview.sites.find((s: { id: string }) => s.id === 'mar')).toMatchObject({ geofence: null, tag: true });

    // A second touch straight after is the same arrival, not a clock-out.
    expect((await t.staff(me, 'POST', '/v1/staff/tap', read())).body.tap.action).toBe('already_clocked_in');

    freezeClock('2026-10-21T16:30:00Z');
    const out = await t.staff(me, 'POST', '/v1/staff/tap', read());
    expect(out.body.tap.action).toBe('clock_out');
    expect(out.body.overview.recent[0]).toMatchObject({ clockIn: 9 * 60, clockOut: 17 * 60 + 30, method: 'tag', status: 'submitted' });
    expect((await t.manager('GET', '/v1/tap-points')).body[0]).toMatchObject({ tagSerial: '04A1B2C3D4E5F6', lastTapAt: '2026-10-21T16:30:00.000Z' });
  });

  it('ends a break when touched while on one', async () => {
    const t = await boot();
    const me = await t.signIn('mar-1', 'priya@example.com');
    const { read } = await t.stick('mar');
    freezeClock('2026-10-21T08:00:00Z');
    await t.staff(me, 'POST', '/v1/staff/tap', read());
    freezeClock('2026-10-21T11:00:00Z');
    await t.staff(me, 'POST', '/v1/staff/break-start');
    freezeClock('2026-10-21T11:30:00Z');
    const back = await t.staff(me, 'POST', '/v1/staff/tap', read());
    expect(back.body.tap.action).toBe('break_end');
    expect(back.body.overview.open.breaks).toEqual([{ start: 12 * 60, end: 12 * 60 + 30 }]);
  });

  it('refuses a link used already, one read older than the last, and one the tag did not write', async () => {
    const t = await boot();
    const me = await t.signIn('mar-1', 'priya@example.com');
    const { tag, read } = await t.stick('mar');
    const sent = read();
    const older = read();
    const latest = read();
    expect((await t.staff(me, 'POST', '/v1/staff/tap', latest)).status).toBe(200);
    // The same address again, from the history, a screenshot or a message to a friend.
    expect((await t.staff(me, 'POST', '/v1/staff/tap', latest)).body.error).toBe('tap_used');
    // Reads taken earlier and kept back are spent once a later one is seen.
    expect((await t.staff(me, 'POST', '/v1/staff/tap', older)).body.error).toBe('tap_used');
    expect((await t.staff(me, 'POST', '/v1/staff/tap', sent)).body.error).toBe('tap_used');
    // Made up, or the counter edited by hand.
    const forged = await t.staff(me, 'POST', '/v1/staff/tap', { tag, picc: 'F'.repeat(32), cmac: '0'.repeat(16) });
    expect(forged.status).toBe(403);
    expect(forged.body.error).toBe('tag_not_genuine');
    // The address as printed, before the tag fills it in.
    expect((await t.staff(me, 'POST', '/v1/staff/tap', { tag, picc: '0'.repeat(32), cmac: '0'.repeat(16) })).body.error).toBe('tag_not_genuine');
  });

  it('refuses a second chip programmed with the same keys once the first has been read', async () => {
    const t = await boot();
    const me = await t.signIn('mar-1', 'priya@example.com');
    const added = await t.manager('POST', '/v1/tap-points', { siteId: 'mar', name: 'Staff entrance' });
    const meta = Buffer.from(added.body.keys.metaRead, 'hex');
    const file = Buffer.from(added.body.keys.fileRead, 'hex');
    const tag = added.body.tapPoint.id;
    const on = (serial: Buffer, n: number) => ({ tag, picc: sunPicc(meta, serial, n).toString('hex'), cmac: sunMac(file, serial, n).toString('hex') });
    expect((await t.staff(me, 'POST', '/v1/staff/tap', on(SERIAL, 1))).status).toBe(200);
    expect((await t.staff(me, 'POST', '/v1/staff/tap', on(Buffer.from('04000000000001', 'hex'), 50))).body.error).toBe('tag_not_genuine');
  });

  it('needs the staff login, a tag that still exists, and a site the person works at', async () => {
    const t = await boot();
    const me = await t.signIn('mar-1', 'priya@example.com');
    const mar = await t.stick('mar');
    expect((await t.staff('', 'POST', '/v1/staff/tap', mar.read())).status).toBe(401);

    const shd = await t.stick('shd');
    const elsewhere = await t.staff(me, 'POST', '/v1/staff/tap', shd.read());
    expect(elsewhere.status).toBe(403);
    expect(elsewhere.body.error).toBe('not_your_site');

    expect((await t.manager('DELETE', `/v1/tap-points/${mar.tag}`)).status).toBe(204);
    expect((await t.staff(me, 'POST', '/v1/staff/tap', mar.read())).body.error).toBe('unknown_tag');
    expect((await t.manager('GET', '/v1/tap-points')).body.map((p: { siteId: string }) => p.siteId)).toEqual(['shd']);
  });

  it('needs a real site and a name to add a tag', async () => {
    const t = await boot();
    expect((await t.manager('POST', '/v1/tap-points', { siteId: 'nowhere', name: 'Door' })).status).toBe(404);
    expect((await t.manager('POST', '/v1/tap-points', { siteId: 'mar', name: '' })).status).toBe(400);
  });
});
