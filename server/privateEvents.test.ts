import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { MemoryStore } from './store';

const TODAY = '2026-10-21';
const KEYS = [{ key: 'admin', orgId: 'demo', name: 'Admin', scopes: ['*' as const] }];

async function setup() {
  const store = new MemoryStore(['demo'], TODAY);
  const { app } = await buildApp({ apiKeys: KEYS, store, provider: new TeamPaySimulator(), autoDispatch: false, now: () => new Date(`${TODAY}T07:00:00Z`) });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.inject({ method: method as 'GET', url, headers: { authorization: 'Bearer admin', ...(body ? { 'content-type': 'application/json' } : {}) }, payload: body ? JSON.stringify(body) : undefined });
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  };
  return { call, store };
}

const pushed = { id: '991', siteId: 'mar', source: 'tripleseat', date: '2026-11-11', startMinute: 1080, endMinute: 1440, guests: 80, kind: 'wedding', style: 'seated', status: 'confirmed', spend: 7000 };

describe('private events in', () => {
  it('drops the client\'s details from a push, and takes a change by reference', async () => {
    const { call, store } = await setup();
    const res = await call('PUT', '/v1/private-events', { rows: [{ ...pushed, clientName: 'Jane Smith', email: 'jane@example.com', title: 'Smith wedding' }] });
    expect(res.body).toEqual({ received: 1 });
    const org = await store.load('demo');
    expect(org.state.privateEvents!.find((e) => e.id === 'tripleseat:991')).toEqual({ ...pushed, id: 'tripleseat:991', exclusive: false });
    expect(JSON.stringify(org)).not.toMatch(/Jane|jane@|Smith wedding/);
    // Final numbers sent again replace the first.
    await call('PUT', '/v1/private-events', { rows: [{ ...pushed, guests: 95 }] });
    const list = (await call('GET', '/v1/private-events?siteId=mar&from=2026-11-11&to=2026-11-11')).body;
    expect(list).toHaveLength(1);
    expect(list[0].guests).toBe(95);
    expect(list[0].team.length).toBeGreaterThan(0);
    expect((await call('PUT', '/v1/private-events', { rows: [{ ...pushed, endMinute: 1000 }] })).body.error).toBe('invalid_time');
    expect((await call('PUT', '/v1/private-events', { rows: [{ ...pushed, siteId: 'nowhere' }] })).status).toBe(404);
  });

  it('imports an export, confirms a held event, and only deletes one entered by hand', async () => {
    const { call } = await setup();
    const csv = ['Event ID,Event Name,Event Date,Start Time,End Time,Guest Count,Status,Event Type', 'TS1,Lee 40th,12/11/2026,19:00,23:00,50,Tentative,Birthday party'].join('\n');
    const imp = await call('POST', '/v1/private-events/import', { siteId: 'mar', source: 'tripleseat', csv });
    expect(imp.body).toMatchObject({ imported: 1, ahead: 1, confirmed: 0, notRead: ['Event Name'] });
    const confirmed = await call('PATCH', '/v1/private-events/tripleseat%3ATS1', { status: 'confirmed', guests: 55 });
    expect(confirmed.body).toMatchObject({ status: 'confirmed', guests: 55 });
    expect((await call('DELETE', '/v1/private-events/tripleseat%3ATS1')).status).toBe(409);

    const made = await call('POST', '/v1/private-events', { siteId: 'mar', date: '2026-11-13', startMinute: 720, endMinute: 960, guests: 30, kind: 'party', style: 'buffet', status: 'confirmed' });
    expect(made.status).toBe(201);
    expect((await call('DELETE', `/v1/private-events/${encodeURIComponent(made.body.id)}`)).status).toBe(204);

    // A confirmed event shows on the calendar and leaves a reminder to roster it.
    const cal = (await call('GET', '/v1/calendar?siteId=mar&from=2026-10-21&to=2026-11-15')).body;
    expect(cal.days.find((d: { date: string }) => d.date === '2026-11-12').privateEvents).toHaveLength(1);
    expect(cal.reminders.some((r: { key: string }) => r.key === 'private:tripleseat:TS1')).toBe(true);
  });
});
