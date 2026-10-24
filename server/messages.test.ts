import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEMO_TOTP_SECRET } from './seedUsers';
import { enterCode, kit, TODAY } from './testkit';
import { MemoryStore } from './store';
import { releaseHeld } from './messaging';
import { holdClock } from './testClock';

holdClock();

const WEEK = '2026-10-19';
const PASSWORD = 'pint of best bitter';
const APP_SECRET = 'a'.repeat(32);
const WHATSAPP = { phoneNumberId: '1234567890', accessToken: 'EAAG'.padEnd(40, 'x'), appSecret: APP_SECRET, template: 'work_message', language: 'en_GB' };
const SLACK = 'https://hooks.slack.com/services/T000/B000/XXXX';

/** Midday in London unless a test moves the clock. */
const clock = { now: new Date(`${TODAY}T11:00:00Z`) };

interface Sent {
  url: string;
  body: any;
}

async function boot() {
  const sent: Sent[] = [];
  let waId = 0;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const raw = typeof init?.body === 'string' ? init.body : '';
    let body: unknown = raw;
    try {
      body = JSON.parse(raw);
    } catch {
      body = Object.fromEntries(new URLSearchParams(raw));
    }
    sent.push({ url, body });
    if (url.startsWith('https://graph.facebook.com/')) return new Response(JSON.stringify({ messages: [{ id: `wamid.${++waId}` }] }), { status: 200 });
    if (url.startsWith('https://api.twilio.com/')) return new Response(JSON.stringify({ sid: 'SM1' }), { status: 201 });
    return new Response('ok', { status: 200 });
  }) as typeof globalThis.fetch;
  clock.now = new Date(`${TODAY}T11:00:00Z`);
  const k = await kit({
    store: new MemoryStore(['demo'], TODAY),
    fetch,
    now: () => clock.now,
    keys: [
      { key: 'admin', orgId: 'demo', name: 'Admin', scopes: ['*'] },
      { key: 'priya', orgId: 'demo', name: 'Priya (key)', scopes: ['*'], userId: 'usr_gm_mar' },
      { key: 'grace', orgId: 'demo', name: 'Grace (key)', scopes: ['*'], userId: 'usr_sup' },
      { key: 'hannah', orgId: 'demo', name: 'Hannah (key)', scopes: ['*'], userId: 'usr_gm_shd' },
    ],
  });
  const owner = await enterCode(k, await k.as('olivia@marylebonegroup.example'), DEMO_TOTP_SECRET);

  /** A member of staff with a staff app login, signed in. */
  async function staff(employeeId: string, email: string) {
    const invite = await k.call('POST', `/v1/staff-logins/${employeeId}/invite`, { key: 'priya' });
    expect(invite.status).toBe(201);
    const link = Object.fromEntries(new URLSearchParams(new URL(invite.body.path, 'https://x').hash.slice(1)));
    const joined = await k.call('POST', '/v1/staff/join', null, { ...link, email, password: PASSWORD });
    expect(joined.status).toBe(200);
    return { cookie: joined.cookie! };
  }

  const inbound = (payload: unknown, secret = APP_SECRET) => {
    const raw = JSON.stringify(payload);
    return k.app.inject({
      method: 'POST',
      url: '/v1/integrations/whatsapp/webhook/demo',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` },
      payload: raw,
    });
  };

  return { ...k, sent, owner, staff, inbound };
}

const reply = (from: string, id: string, text: string) => ({
  entry: [{ changes: [{ value: { messages: [{ from, id, timestamp: String(Math.floor(clock.now.getTime() / 1000)), type: 'text', text: { body: text } }] } }] }],
});

describe('messages between managers and staff', () => {
  it('keeps one thread per person, with read receipts both ways', async () => {
    const t = await boot();
    const ben = await t.staff('mar-3', 'ben@example.com');

    const sent = await t.call('POST', '/v1/messages/direct', { key: 'priya' }, { employeeId: 'mar-3', body: 'Can you start at 4 on Friday instead of 5?' });
    expect(sent.status).toBe(201);
    // Nobody chose a channel and none is connected: the staff app only.
    expect(sent.body.message.reached).toBe('In the app');

    const inbox = await t.call('GET', '/v1/staff/messages', ben);
    expect(inbox.body.threads).toHaveLength(1);
    const thread = inbox.body.threads[0];
    expect(thread.unread).toBe(1);
    expect(thread.messages[0]).toMatchObject({ from: 'Priya Shah', mine: false, body: 'Can you start at 4 on Friday instead of 5?' });

    clock.now = new Date(clock.now.getTime() + 60_000);
    expect((await t.call('POST', '/v1/staff/messages/read', ben, { conversationId: thread.id })).status).toBe(200);
    clock.now = new Date(clock.now.getTime() + 60_000);
    expect((await t.call('POST', '/v1/staff/messages', ben, { body: 'Yes, no problem.' })).status).toBe(201);

    const list = await t.call('GET', '/v1/messages?siteId=mar', { key: 'priya' });
    expect(list.body[0]).toMatchObject({ id: thread.id, unread: 1, last: { body: 'Yes, no problem.' } });
    const open = await t.call('GET', `/v1/messages/${thread.id}`, { key: 'priya' });
    expect(open.body.readers[0].readAt).toBeTruthy();
    expect(open.body.messages.map((m: { body: string }) => m.body)).toEqual(['Can you start at 4 on Friday instead of 5?', 'Yes, no problem.']);
    clock.now = new Date(clock.now.getTime() + 60_000);
    await t.call('POST', `/v1/messages/${thread.id}/read`, { key: 'priya' });
    expect((await t.call('GET', '/v1/messages?siteId=mar', { key: 'priya' })).body[0].unread).toBe(0);
  });

  it('is for the managers who run the site, never a system key or another site', async () => {
    const t = await boot();
    await t.call('POST', '/v1/messages/direct', { key: 'priya' }, { employeeId: 'mar-3', body: 'Hello' });
    // A supervisor sees the rota, not the team's messages.
    expect((await t.call('GET', '/v1/messages', { key: 'grace' })).body).toEqual([]);
    expect((await t.call('GET', '/v1/messages/dm_mar-3', { key: 'grace' })).status).toBe(404);
    expect((await t.call('POST', '/v1/messages/direct', { key: 'grace' }, { employeeId: 'mar-3', body: 'Hi' })).status).toBe(403);
    // Another site's GM.
    expect((await t.call('GET', '/v1/messages/dm_mar-3', { key: 'hannah' })).status).toBe(404);
    // A key with no person behind it.
    expect((await t.call('GET', '/v1/messages', { key: 'admin' })).status).toBe(403);
    expect((await t.call('POST', '/v1/messages/direct', { key: 'admin' }, { employeeId: 'mar-3', body: 'Hi' })).status).toBe(403);
  });

  it('sends an announcement to the whole team and shows who has read it', async () => {
    const t = await boot();
    const ben = await t.staff('mar-3', 'ben@example.com');
    const res = await t.call('POST', '/v1/messages/announcements', { key: 'priya' }, { siteId: 'mar', title: 'New menu', body: 'Tasting at 3pm Thursday. Please come in 15 minutes early.' });
    expect(res.status).toBe(201);
    const thread = (await t.call('GET', '/v1/staff/messages', ben)).body.threads.find((x: { kind: string }) => x.kind === 'announcement');
    expect(thread.title).toBe('New menu');
    await t.call('POST', '/v1/staff/messages/read', ben, { conversationId: thread.id });
    const open = await t.call('GET', `/v1/messages/${thread.id}`, { key: 'priya' });
    const readers = open.body.readers as { employeeId: string; readAt: string | null }[];
    expect(readers.length).toBeGreaterThan(5);
    expect(readers.filter((r) => r.readAt).map((r) => r.employeeId)).toEqual(['mar-3']);
    // Announcements are for those who publish the rota.
    expect((await t.call('POST', '/v1/messages/announcements', { key: 'grace' }, { siteId: 'mar', body: 'x' })).status).toBe(403);
  });
});

describe('rota notices', () => {
  it('carries the rota notice by WhatsApp to someone who chose it, instead of email', async () => {
    const t = await boot();
    const ben = await t.staff('mar-3', 'ben@example.com');
    await t.call('PUT', '/v1/settings/messaging/whatsapp', t.owner, WHATSAPP);
    expect((await t.call('PUT', '/v1/staff/channels', ben, { channels: ['whatsapp'], phone: '07700 900123', whatsapp: true })).status).toBe(200);
    await t.call('POST', '/v1/rota/build', { key: 'admin' }, { siteId: 'mar', weekStart: WEEK });
    expect((await t.call('POST', '/v1/rota/publish', { key: 'admin' }, { siteId: 'mar', weekStart: WEEK })).status).toBe(200);

    // One WhatsApp to Ben with his week; nobody else chose WhatsApp, so nobody else gets one.
    const whatsapps = t.sent.filter((s) => s.url.startsWith('https://graph.facebook.com/'));
    expect(whatsapps).toHaveLength(1);
    expect(whatsapps[0].body.to).toBe('447700900123');
    expect(whatsapps[0].body.template.components[0].parameters[0].text).toMatch(/^Your rota at Marylebone is out/);
    // It is still in his staff app inbox, marked as carried by WhatsApp rather than emailed.
    const feed = (await t.call('GET', '/v1/staff/notifications', ben)).body as { kind: string }[];
    expect(feed.some((n) => n.kind === 'rota_published')).toBe(true);
    const org = await t.store.load('demo');
    const his = org.notifications!.filter((n) => n.employeeId === 'mar-3');
    expect(his.every((n) => n.email === 'none' && n.via === 'whatsapp')).toBe(true);

    // Republishing an unchanged week tells nobody.
    const before = t.sent.length;
    await t.call('POST', '/v1/rota/publish', { key: 'admin' }, { siteId: 'mar', weekStart: WEEK });
    expect(t.sent.length).toBe(before);
    // Managers do not count rota notices as unread: they are not something staff wrote.
    expect((await t.call('GET', '/v1/messages?siteId=mar', { key: 'priya' })).body.every((c: { unread: number }) => c.unread === 0)).toBe(true);
  });
});

describe('channels', () => {
  it('lets a person choose WhatsApp with their own consent, and carries replies back into their thread', async () => {
    const t = await boot();
    const ben = await t.staff('mar-3', 'ben@example.com');
    // Not offered until the organisation connects it.
    expect((await t.call('PUT', '/v1/staff/channels', ben, { channels: ['whatsapp'], phone: '07700 900123', whatsapp: true })).body.error).toBe('not_offered');

    // Only a person with settings, never a key.
    expect((await t.call('PUT', '/v1/settings/messaging/whatsapp', { key: 'admin' }, WHATSAPP)).status).toBe(403);
    const set = await t.call('PUT', '/v1/settings/messaging/whatsapp', t.owner, WHATSAPP);
    expect(set.status).toBe(200);
    expect(set.body.whatsapp).toMatchObject({ set: true, tokenEndsWith: 'xxxx', template: 'work_message' });
    expect(JSON.stringify(set.body)).not.toContain(APP_SECRET);
    const verifyToken = set.body.whatsapp.webhook.verifyToken as string;

    // Meta checks the address with the verify token.
    const check = await t.app.inject({ method: 'GET', url: `/v1/integrations/whatsapp/webhook/demo?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=42` });
    expect(check.body).toBe('42');
    expect((await t.app.inject({ method: 'GET', url: '/v1/integrations/whatsapp/webhook/demo?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42' })).statusCode).toBe(403);

    // Consent is a tick by the person, for the number they typed.
    expect((await t.call('PUT', '/v1/staff/channels', ben, { channels: ['whatsapp'], phone: '07700 900123' })).body.error).toBe('consent_required');
    expect((await t.call('PUT', '/v1/staff/channels', ben, { channels: ['whatsapp'], phone: '01632 960001', whatsapp: true })).body.error).toBe('invalid_phone');
    const prefs = await t.call('PUT', '/v1/staff/channels', ben, { channels: ['whatsapp'], phone: '07700 900123', whatsapp: true });
    expect(prefs.body).toMatchObject({ channels: ['whatsapp'], phone: '+447700900123', whatsapp: true });

    // Outside WhatsApp's 24 hour window a message must go as the approved template.
    const first = await t.call('POST', '/v1/messages/direct', { key: 'priya' }, { employeeId: 'mar-3', body: 'Are you OK to close tonight?' });
    expect(first.body.message.reached).toBe('WhatsApp: sent');
    const graph = t.sent.filter((s) => s.url.startsWith('https://graph.facebook.com/'));
    expect(graph).toHaveLength(1);
    expect(graph[0].body).toMatchObject({ to: '447700900123', type: 'template', template: { name: 'work_message' } });
    expect(graph[0].body.template.components[0].parameters[0].text).toBe('Priya Shah: Are you OK to close tonight?');

    // Meta reports it read.
    await t.inbound({ entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.1', status: 'read', recipient_id: '447700900123' }] } }] }] });
    expect((await t.call('GET', '/v1/messages/dm_mar-3', { key: 'priya' })).body.messages[0].reached).toBe('WhatsApp: read');

    // A forged reply is refused; a signed one lands in the thread, once.
    expect((await t.inbound(reply('447700900123', 'wamid.in1', 'Forged'), 'b'.repeat(32))).statusCode).toBe(401);
    expect((await t.inbound(reply('447700900123', 'wamid.in1', 'Yes, I can close'))).statusCode).toBe(200);
    expect((await t.inbound(reply('447700900123', 'wamid.in1', 'Yes, I can close'))).statusCode).toBe(200);
    // A number nobody agreed from is ignored.
    await t.inbound(reply('447700900999', 'wamid.in2', 'Who is this?'));
    const thread = await t.call('GET', '/v1/messages/dm_mar-3', { key: 'priya' });
    expect(thread.body.messages.map((m: { body: string; via: string }) => [m.body, m.via])).toEqual([
      ['Are you OK to close tonight?', 'app'],
      ['Yes, I can close', 'whatsapp'],
    ]);

    // Inside the window, free text.
    await t.call('POST', '/v1/messages/direct', { key: 'priya' }, { employeeId: 'mar-3', body: 'Thanks Ben' });
    expect(t.sent.filter((s) => s.url.startsWith('https://graph.facebook.com/')).at(-1)!.body).toMatchObject({ type: 'text', text: { body: 'Priya Shah: Thanks Ben' } });

    // STOP withdraws consent at once.
    await t.inbound(reply('447700900123', 'wamid.in3', 'STOP'));
    expect((await t.call('GET', '/v1/staff/channels', ben)).body).toMatchObject({ channels: [], whatsapp: false });
    const before = t.sent.length;
    await t.call('POST', '/v1/messages/direct', { key: 'priya' }, { employeeId: 'mar-3', body: 'Still there?' });
    expect(t.sent.slice(before).filter((s) => s.url.startsWith('https://graph.facebook.com/'))).toEqual([]);
  });

  it('holds a message for quiet hours unless urgent, and sends it when they end', async () => {
    const t = await boot();
    const ben = await t.staff('mar-3', 'ben@example.com');
    await t.call('PUT', '/v1/settings/messaging/sms', t.owner, { accountSid: `AC${'0'.repeat(32)}`, authToken: 'f'.repeat(32), from: '+447700900000' });
    await t.call('PUT', '/v1/staff/channels', ben, { channels: ['sms'], phone: '+447700900123', sms: true });

    clock.now = new Date(`${TODAY}T22:30:00Z`); // 23:30 in London
    const held = await t.call('POST', '/v1/messages/direct', { key: 'priya' }, { employeeId: 'mar-3', body: 'Rota for next week is up' });
    expect(held.body.message.reached).toBe('Text message: held for quiet hours');
    expect(t.sent.filter((s) => s.url.includes('twilio'))).toEqual([]);
    const urgent = await t.call('POST', '/v1/messages/direct', { key: 'priya' }, { employeeId: 'mar-3', body: 'Fire alarm test at 7, use the back door', urgent: true });
    expect(urgent.body.message.reached).toBe('Text message: sent');

    // Still quiet: nothing released.
    const org = await t.store.load('demo');
    expect(await releaseHeld({ store: t.store, fetch: globalThis.fetch, now: () => clock.now }, org)).toBe(0);

    // 07:00 in London: it goes, through the same provider.
    clock.now = new Date('2026-10-22T06:05:00Z');
    const texts = t.sent.filter((s) => s.url.includes('twilio')).length;
    const released = await t.store.load('demo');
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      t.sent.push({ url: String(input), body: Object.fromEntries(new URLSearchParams(String(init?.body ?? ''))) });
      return new Response(JSON.stringify({ sid: 'SM2' }), { status: 201 });
    }) as typeof fetch;
    expect(await releaseHeld({ store: t.store, fetch: fetcher, now: () => clock.now }, released)).toBe(1);
    const text = t.sent.filter((s) => s.url.includes('twilio'))[texts];
    expect(text.body).toMatchObject({ To: '+447700900123', Body: 'Rota for next week is up' });
  });

  it('tells Slack there is a message, never what it says', async () => {
    const t = await boot();
    const ben = await t.staff('mar-3', 'ben@example.com');
    expect((await t.call('PUT', '/v1/settings/messaging/team', t.owner, { channel: 'slack', siteId: 'mar', url: 'https://example.com/hook' })).body.error).toBe('invalid_url');
    expect((await t.call('PUT', '/v1/settings/messaging/team', t.owner, { channel: 'teams', siteId: 'mar', url: 'https://10.0.0.1/hook' })).body.error).toBe('invalid_url');
    expect((await t.call('PUT', '/v1/settings/messaging/team', t.owner, { channel: 'slack', siteId: 'mar', url: SLACK })).status).toBe(200);

    await t.call('POST', '/v1/staff/messages', ben, { body: 'I have a migraine and cannot come in tonight' });
    const slack = t.sent.filter((s) => s.url === SLACK);
    expect(slack).toHaveLength(1);
    expect(slack[0].body.text).toMatch(/^New message from .+ at Marylebone\./);
    expect(JSON.stringify(slack[0].body)).not.toContain('migraine');
  });

  it('includes messages and choices in a subject access export, and erasure removes the number', async () => {
    const t = await boot();
    const ben = await t.staff('mar-3', 'ben@example.com');
    await t.call('PUT', '/v1/settings/messaging/sms', t.owner, { accountSid: `AC${'0'.repeat(32)}`, authToken: 'f'.repeat(32), from: 'Marylebone' });
    await t.call('PUT', '/v1/staff/channels', ben, { channels: ['sms'], phone: '07700 900123', sms: true });
    await t.call('POST', '/v1/staff/messages', ben, { body: 'Can I swap Saturday?' });
    const exported = await t.call('POST', '/v1/privacy/subjects/mar-3/export', t.owner);
    expect(exported.status).toBe(200);
    expect(exported.body.messages.threads[0].messages[0].body).toBe('Can I swap Saturday?');
    expect(exported.body.messages.preferences).toMatchObject({ phone: '+447700900123', channels: ['sms'] });
    const register = await t.call('GET', '/v1/privacy/register', t.owner);
    expect(register.body.processors.find((p: { name: string }) => p.name === 'Twilio').active).toBe(true);
  });
});
