import { createDecipheriv, createECDH, createHmac, createPublicKey, verify } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addDays, weekStart } from '../src/engine/time';
import { encryptPayload, validEndpoint, vapidAuthorisation, vapidKeys } from './push';
import { MemoryStore } from './store';
import { kit } from './testkit';

const b = (s: string) => Buffer.from(s, 'base64url');

describe('web push encryption', () => {
  it('matches the worked example in RFC 8291 byte for byte', () => {
    const body = encryptPayload(
      { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
      Buffer.from('When I grow up, I want to be a watermelon'),
      b('DGv6ra1nlYgDCS1FRnbzlw'),
      b('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
    );
    expect(body.toString('base64url')).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });

  it('signs a VAPID token the push service can check against the public key', async () => {
    const keys = await vapidKeys(new MemoryStore([], '2026-10-23'));
    const header = vapidAuthorisation(keys, 'https://fcm.googleapis.com/fcm/send/abc', 'mailto:support@preshift.co.uk', 1_000);
    const [, token, k] = header.match(/^vapid t=([^,]+), k=(.+)$/)!;
    expect(k).toBe(keys.publicKey);
    const [h, c, sig] = token.split('.');
    expect(JSON.parse(b(c).toString())).toEqual({ aud: 'https://fcm.googleapis.com', exp: 1_000 + 12 * 3600, sub: 'mailto:support@preshift.co.uk' });
    const pub = b(keys.publicKey);
    const jwk = { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') };
    expect(verify('sha256', Buffer.from(`${h}.${c}`), { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, b(sig))).toBe(true);
  });

  it('keeps one key pair per deployment', async () => {
    const store = new MemoryStore([], '2026-10-23');
    expect((await vapidKeys(store)).publicKey).toBe((await vapidKeys(store)).publicKey);
  });

  it('sends only to the real push services, over https', () => {
    expect(validEndpoint('https://fcm.googleapis.com/fcm/send/x')).toBe(true);
    expect(validEndpoint('https://web.push.apple.com/QK2x')).toBe(true);
    expect(validEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe(true);
    expect(validEndpoint('https://wns2-par02p.notify.windows.com/w/?token=x')).toBe(true);
    expect(validEndpoint('http://fcm.googleapis.com/fcm/send/x')).toBe(false);
    expect(validEndpoint('https://fcm.googleapis.com:8443/x')).toBe(false);
    expect(validEndpoint('https://169.254.169.254/latest/meta-data')).toBe(false);
    expect(validEndpoint('https://push.apple.com.evil.example/x')).toBe(false);
    expect(validEndpoint('not a url')).toBe(false);
  });
});

/** A phone: its own key pair and auth secret, and a way to read what was pushed to it. */
function phone() {
  const ecdh = createECDH('prime256v1');
  const p256dh = ecdh.generateKeys().toString('base64url');
  const auth = Buffer.from('0123456789abcdef').toString('base64url');
  const hmac = (k: Buffer, d: Buffer) => createHmac('sha256', k).update(d).digest();
  const read = (body: Buffer) => {
    const salt = body.subarray(0, 16);
    const idlen = body[20];
    const asPublic = body.subarray(21, 21 + idlen);
    const shared = ecdh.computeSecret(asPublic);
    const ikm = hmac(hmac(b(auth), shared), Buffer.concat([Buffer.from('WebPush: info\0'), b(p256dh), asPublic, Buffer.from([1])]));
    const prk = hmac(salt, ikm);
    const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
    const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
    const data = body.subarray(21 + idlen);
    const d = createDecipheriv('aes-128-gcm', cek, nonce);
    d.setAuthTag(data.subarray(data.length - 16));
    const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
    return JSON.parse(plain.subarray(0, plain.lastIndexOf(2)).toString());
  };
  return { p256dh, auth, read };
}

describe('push from the staff app', () => {
  afterEach(() => vi.unstubAllGlobals());

  async function boot() {
    const k = await kit({ keys: [{ key: 'manager', orgId: 'demo', name: 'GM', scopes: ['*'] }] });
    const res = await k.call('POST', '/v1/staff-logins/mar-12/invite', { key: 'manager' });
    const link = Object.fromEntries(new URLSearchParams(new URL(res.body.path, 'https://x').hash.slice(1)));
    const ben = (await k.call('POST', '/v1/staff/join', null, { ...link, email: 'ben@example.com', password: 'pint of best bitter' })).cookie!;
    const pushed: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
    let status = 201;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      pushed.push({ url, headers: init.headers as Record<string, string>, body: init.body as Buffer });
      return new Response(null, { status });
    });
    return { k, ben, pushed, setStatus: (s: number) => { status = s; } };
  }

  it('turns on for a phone, pushes the rota when published, and forgets a phone that has gone', async () => {
    const { k, ben, pushed, setStatus } = await boot();
    const p = phone();
    const endpoint = 'https://fcm.googleapis.com/fcm/send/ben-phone';
    // The server's public key, for the phone to subscribe with.
    expect((await k.call('GET', '/v1/staff/push', ben)).body.publicKey).toMatch(/^B[A-Za-z0-9_-]{86}$/);
    // Only a real push service.
    expect((await k.call('POST', '/v1/staff/push/subscribe', ben, { endpoint: 'https://10.0.0.5/hook', keys: { p256dh: p.p256dh, auth: p.auth } })).status).toBe(422);
    expect((await k.call('POST', '/v1/staff/push/subscribe', ben, { endpoint, keys: { p256dh: p.p256dh, auth: p.auth }, label: 'Android, Chrome' })).body).toEqual({ ok: true, devices: 1 });
    expect((await k.call('GET', '/v1/staff/me', ben)).body.pushDevices).toBe(1);
    expect((await k.call('GET', '/v1/staff-logins', { key: 'manager' })).body.find((l: { employeeId: string }) => l.employeeId === 'mar-12').pushDevices).toBe(1);

    const test = await k.call('POST', '/v1/staff/push/test', ben);
    expect(test.body).toEqual({ sent: 1, failed: 0, gone: 0 });
    expect(p.read(pushed[0].body)).toMatchObject({ title: 'Notifications are on' });
    expect(pushed[0].headers['content-encoding']).toBe('aes128gcm');
    expect(pushed[0].headers.authorization).toMatch(/^vapid t=.+, k=B/);

    // Publishing Ben's week pushes it to his phone, encrypted for that phone alone.
    const today = (await k.call('GET', '/v1/staff/me', ben)).body.today;
    const day = addDays(weekStart(today), 16);
    await k.call('POST', '/v1/shifts', { key: 'manager' }, { employeeId: 'mar-12', roleId: 'bar', siteId: 'mar', date: day, startMinute: 1020, endMinute: 1380, breakMinutes: 20 });
    await k.call('POST', '/v1/rota/publish', { key: 'manager' }, { siteId: 'mar', weekStart: weekStart(day) });
    const rota = pushed.filter((x) => x.url === endpoint).at(-1)!;
    expect(p.read(rota.body)).toMatchObject({ title: 'Your rota at Marylebone is out', url: '/staff/#inbox' });
    expect(JSON.stringify(p.read(rota.body))).not.toMatch(/13\.75|hourly/);
    const org = await k.store.load('demo');
    expect(org.notifications!.filter((n) => n.employeeId === 'mar-12').at(-1)!.push).toBe('sent');

    // The phone unsubscribed in the meantime: the push service says so, and it is forgotten.
    setStatus(410);
    await k.call('POST', '/v1/shifts', { key: 'manager' }, { employeeId: 'mar-12', roleId: 'bar', siteId: 'mar', date: addDays(day, 1), startMinute: 1020, endMinute: 1380, breakMinutes: 20 });
    await k.call('POST', '/v1/rota/publish', { key: 'manager' }, { siteId: 'mar', weekStart: weekStart(day) });
    expect((await k.call('GET', '/v1/staff/me', ben)).body.pushDevices).toBe(0);
  });

  it('turns off for one phone, and closing the login forgets every phone', async () => {
    const { k, ben } = await boot();
    const a = phone();
    const c = phone();
    await k.call('POST', '/v1/staff/push/subscribe', ben, { endpoint: 'https://fcm.googleapis.com/fcm/send/a', keys: { p256dh: a.p256dh, auth: a.auth } });
    await k.call('POST', '/v1/staff/push/subscribe', ben, { endpoint: 'https://web.push.apple.com/c', keys: { p256dh: c.p256dh, auth: c.auth } });
    expect((await k.call('POST', '/v1/staff/push/unsubscribe', ben, { endpoint: 'https://fcm.googleapis.com/fcm/send/a' })).body).toEqual({ ok: true, devices: 1 });
    expect((await k.store.getStaffLogin('demo', 'mar-12'))!.push!.map((d) => d.endpoint)).toEqual(['https://web.push.apple.com/c']);
    expect((await k.call('DELETE', '/v1/staff-logins/mar-12', { key: 'manager' })).status).toBe(204);
    expect(await k.store.getStaffLogin('demo', 'mar-12')).toBeNull();
    expect((await k.call('POST', '/v1/staff/push/test', ben)).status).toBe(401);
  });
});
