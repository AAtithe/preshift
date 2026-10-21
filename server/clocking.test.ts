import { describe, expect, it } from 'vitest';
import { checkFence, distanceMetres, normaliseBadge } from '../src/engine/clocking';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { MemoryStore } from './store';

// Marylebone High Street, and points a known distance away.
const SITE = { lat: 51.5205, lng: -0.1517 };
const NORTH_60M = { lat: SITE.lat + 60 / 111_195, lng: SITE.lng };
const NORTH_400M = { lat: SITE.lat + 400 / 111_195, lng: SITE.lng };

async function setup() {
  const { app } = await buildApp({
    apiKeys: [{ key: 'admin', orgId: 'demo', name: 'Admin', scopes: ['*'] }],
    store: new MemoryStore(['demo'], '2026-10-21'),
    provider: new TeamPaySimulator(),
    autoDispatch: false,
  });
  return async (method: string, url: string, body?: unknown) => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: { authorization: 'Bearer admin', ...(body ? { 'content-type': 'application/json' } : {}) },
      payload: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  };
}

const at = (hhmm: string) => `2026-10-21T${hhmm}:00+01:00`;

describe('geofence maths', () => {
  it('measures distance and allows for the fix accuracy, up to the radius again', () => {
    expect(Math.round(distanceMetres(SITE, NORTH_400M))).toBe(400);
    const fence = { ...SITE, radiusMetres: 100 };
    expect(checkFence(fence, { ...NORTH_60M, accuracyMetres: 10 })).toEqual({ ok: true, distanceMetres: 60 });
    expect(checkFence({ ...fence, radiusMetres: 250 }, { ...NORTH_400M, accuracyMetres: 200 }).ok).toBe(true);
    expect(checkFence(fence, { ...NORTH_400M, accuracyMetres: 200 })).toEqual({ ok: false, reason: 'outside_site', distanceMetres: 400 });
    expect(checkFence(fence, { ...SITE, accuracyMetres: 1500 }).ok).toBe(false);
  });

  it('reads one card the same way whichever reader typed it', () => {
    expect(normaliseBadge('04:a2:3f:1b')).toBe('04A23F1B');
    expect(normaliseBadge(' 04-A2-3F-1B\n')).toBe('04A23F1B');
  });
});

describe('clocking in on a device', () => {
  it('needs a location inside the site fence once one is set, and records it', async () => {
    const call = await setup();
    expect((await call('PUT', '/v1/sites/mar/geofence', { ...SITE, radiusMetres: 100 })).body.geofence.radiusMetres).toBe(100);

    const none = await call('POST', '/v1/time-entries/clock-in', { employeeId: 'mar-1', siteId: 'mar', at: at('09:00') });
    expect(none.status).toBe(422);
    expect(none.body.error).toBe('location_required');

    const away = await call('POST', '/v1/time-entries/clock-in', {
      employeeId: 'mar-1', siteId: 'mar', at: at('09:00'), location: { ...NORTH_400M, accuracyMetres: 15 },
    });
    expect(away.status).toBe(422);
    expect(away.body.error).toBe('outside_site');
    expect(away.body.message).toMatch(/400 m from Marylebone/);

    const ok = await call('POST', '/v1/time-entries/clock-in', {
      employeeId: 'mar-1', siteId: 'mar', at: at('09:00'), location: { ...NORTH_60M, accuracyMetres: 15 },
    });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ method: 'device', clockIn: 540, clockInLocation: { distanceMetres: 60 } });

    const out = await call('POST', `/v1/time-entries/${ok.body.id}/clock-out`, { at: at('17:00'), location: { ...SITE, accuracyMetres: 8 } });
    expect(out.body).toMatchObject({ status: 'submitted', clockOut: 1020, clockOutLocation: { distanceMetres: 0 } });
  });

  it('needs no location where the site has no fence', async () => {
    const call = await setup();
    expect((await call('POST', '/v1/time-entries/clock-in', { employeeId: 'mar-1', siteId: 'mar' })).status).toBe(201);
  });
});

describe('RFID cards', () => {
  it('enrol to one person at a time, and a tap clocks in then out', async () => {
    const call = await setup();
    await call('PUT', '/v1/sites/mar/geofence', { ...SITE, radiusMetres: 100 });
    expect((await call('PUT', '/v1/employees/mar-1/badge', { badgeId: '04:a2:3f:1b' })).body.badgeId).toBe('04A23F1B');
    const clash = await call('PUT', '/v1/employees/mar-2/badge', { badgeId: '04A23F1B' });
    expect(clash.status).toBe(409);
    expect(clash.body.error).toBe('badge_in_use');

    expect((await call('POST', '/v1/time-entries/tap', { badgeId: 'FFFF0000', siteId: 'mar' })).body.error).toBe('unknown_card');

    // The reader is on site, so a fenced site still takes a tap with no device location.
    const tapIn = await call('POST', '/v1/time-entries/tap', { badgeId: '04a23f1b', siteId: 'mar', at: at('16:58') });
    expect(tapIn.status).toBe(201);
    expect(tapIn.body).toMatchObject({ action: 'clock_in', employee: { id: 'mar-1' }, entry: { method: 'card', clockIn: 1018 } });

    const bounce = await call('POST', '/v1/time-entries/tap', { badgeId: '04a23f1b', siteId: 'mar', at: at('16:59') });
    expect(bounce.body.action).toBe('already_clocked_in');

    const tapOut = await call('POST', '/v1/time-entries/tap', { badgeId: '04a23f1b', siteId: 'mar', at: at('23:05') });
    expect(tapOut.body).toMatchObject({ action: 'clock_out', entry: { id: tapIn.body.entry.id, clockOut: 1385, status: 'submitted' } });

    expect((await call('DELETE', '/v1/employees/mar-1/badge')).body.badgeId).toBeUndefined();
    expect((await call('POST', '/v1/time-entries/tap', { badgeId: '04a23f1b', siteId: 'mar' })).status).toBe(404);
  });

  it('keeps an enrolled card when the person record is saved', async () => {
    const call = await setup();
    await call('PUT', '/v1/employees/mar-1/badge', { badgeId: 'AB12CD34' });
    const saved = await call('PATCH', '/v1/employees/mar-1', { phone: '07700 900123', badgeId: 'HIJACK' });
    expect(saved.body.badgeId).toBe('AB12CD34');
  });
});
