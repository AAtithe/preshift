import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEMO_TOTP_SECRET } from './seedUsers';
import { enterCode, kit, TODAY } from './testkit';
import { MemoryStore } from './store';

const WEEK = '2026-10-19';
const SATURDAY = '2026-10-24';
const PASSWORD = 'pint of best bitter';
const APP_SECRET = 'a'.repeat(32);

async function boot() {
  const sent: { url: string; body: any }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), body: JSON.parse(String(init?.body ?? 'null')) });
    return new Response(JSON.stringify({ messages: [{ id: `wamid.${sent.length}` }] }), { status: 200 });
  }) as typeof globalThis.fetch;
  const now = new Date(`${TODAY}T11:00:00Z`);
  const k = await kit({
    store: new MemoryStore(['demo'], TODAY),
    fetch,
    now: () => now,
    keys: [
      { key: 'admin', orgId: 'demo', name: 'Admin', scopes: ['*'] },
      { key: 'priya', orgId: 'demo', name: 'Priya (key)', scopes: ['*'], userId: 'usr_gm_mar' },
      { key: 'grace', orgId: 'demo', name: 'Grace (key)', scopes: ['*'], userId: 'usr_sup' },
    ],
  });
  const priya = { key: 'priya' };
  expect((await k.call('POST', '/v1/rota/build', { key: 'admin' }, { siteId: 'mar', weekStart: WEEK })).status).toBe(200);
  expect((await k.call('POST', '/v1/rota/publish', { key: 'admin' }, { siteId: 'mar', weekStart: WEEK })).status).toBe(200);

  async function staff(employeeId: string) {
    const invite = await k.call('POST', `/v1/staff-logins/${employeeId}/invite`, priya);
    const link = Object.fromEntries(new URLSearchParams(new URL(invite.body.path, 'https://x').hash.slice(1)));
    const joined = await k.call('POST', '/v1/staff/join', null, { ...link, email: `${employeeId}@example.com`, password: PASSWORD });
    expect(joined.status).toBe(200);
    return { cookie: joined.cookie! };
  }

  /** A published Saturday shift at Marylebone with at least two people who could cover it. */
  async function coverable() {
    const shifts = (await k.call('GET', `/v1/shifts?siteId=mar&from=${SATURDAY}&to=${SATURDAY}`, priya)).body as { id: string; employeeId: string; published: boolean }[];
    for (const s of shifts) {
      const preview = await k.call('POST', '/v1/cover/preview', priya, { shiftId: s.id });
      const askable = preview.body.candidates.filter((c: { askable: boolean }) => c.askable);
      if (askable.length >= 2) return { shift: s, preview: preview.body, askable: askable as { employeeId: string; name: string }[] };
    }
    throw new Error('No Saturday shift with two people free to cover it');
  }

  const shiftById = async (id: string) => ((await k.call('GET', `/v1/shifts?siteId=mar&from=${SATURDAY}&to=${SATURDAY}`, priya)).body as { id: string; employeeId: string; published: boolean }[]).find((s) => s.id === id);
  const thread = async (employeeId: string) => (await k.call('GET', `/v1/messages/dm_${employeeId}`, priya)).body.messages as { body: string; from: { name: string } }[];

  return { ...k, sent, priya, staff, coverable, shiftById, thread };
}

describe('cover requests', () => {
  it('asks only those who could legally work it, and gives it to the first who says yes', async () => {
    const t = await boot();
    const { shift, preview, askable } = await t.coverable();
    // The person off is never asked, and nobody blocked is offered it.
    expect(preview.original.employeeId).toBe(shift.employeeId);
    expect(preview.candidates.some((c: { employeeId: string }) => c.employeeId === shift.employeeId)).toBe(false);
    const blocked = preview.candidates.filter((c: { askable: boolean }) => !c.askable);
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked.every((c: { reason: string }) => c.reason)).toBe(true);
    // A GM sees what each would add to labour.
    expect(preview.candidates[0].marginal).toEqual(expect.any(Number));

    const [a, b] = askable;
    const first = await t.staff(a.employeeId);
    const second = await t.staff(b.employeeId);
    const made = await t.call('POST', '/v1/cover', t.priya, { shiftId: shift.id, employeeIds: [a.employeeId, b.employeeId], note: 'Big party in at 7.' });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ status: 'open', firstToAccept: true, publish: true });
    expect(made.body.offers.map((o: { employeeId: string }) => o.employeeId)).toEqual([a.employeeId, b.employeeId]);
    // Asking twice for the same shift is refused.
    expect((await t.call('POST', '/v1/cover', t.priya, { shiftId: shift.id })).body.error).toBe('already_asked');

    // Each sees the offer in the staff app, and in their thread.
    const offers = await t.call('GET', '/v1/staff/cover', first);
    expect(offers.body.offers).toHaveLength(1);
    expect((await t.thread(a.employeeId)).at(-1)!.body).toMatch(/^Cover wanted: Sat 24 Oct, .+\nBig party in at 7\./);

    const yes = await t.call('POST', `/v1/staff/cover/${made.body.id}/accept`, first);
    expect(yes.body.outcome).toBe('filled');
    const after = await t.shiftById(shift.id);
    expect(after).toMatchObject({ employeeId: a.employeeId, published: true });

    // Too late for the second, who hears it has gone; the person off hears they are off.
    expect((await t.call('GET', '/v1/staff/cover', second)).body.offers).toEqual([]);
    expect((await t.call('POST', `/v1/staff/cover/${made.body.id}/accept`, second)).body).toMatchObject({ outcome: 'refused', reason: 'Someone else has already taken it.' });
    expect((await t.thread(shift.employeeId)).at(-1)!.body).toMatch(/is covered\. You are off it\./);
    expect((await t.thread(a.employeeId)).at(-1)!.body).toMatch(/^It's yours/);
    const list = await t.call('GET', '/v1/cover?siteId=mar', t.priya);
    expect(list.body[0]).toMatchObject({ status: 'filled', filledBy: a.name });
  });

  it('refuses a yes that has become illegal since it was offered, and the next person can still take it', async () => {
    const t = await boot();
    const { shift, askable } = await t.coverable();
    const [a, b] = askable;
    const first = await t.staff(a.employeeId);
    const second = await t.staff(b.employeeId);
    const made = await t.call('POST', '/v1/cover', t.priya, { shiftId: shift.id, employeeIds: [a.employeeId, b.employeeId] });
    // Meanwhile the first is booked on leave that day.
    const person = (await t.call('GET', `/v1/employees/${a.employeeId}`, { key: 'admin' })).body;
    expect((await t.call('PATCH', `/v1/employees/${a.employeeId}`, { key: 'admin' }, { leave: [...person.leave, SATURDAY] })).status).toBe(200);
    const yes = await t.call('POST', `/v1/staff/cover/${made.body.id}/accept`, first);
    expect(yes.body.outcome).toBe('refused');
    expect(yes.body.reason).toMatch(/leave/);
    expect((await t.shiftById(shift.id))!.employeeId).toBe(shift.employeeId);
    expect((await t.call('POST', `/v1/staff/cover/${made.body.id}/accept`, second)).body.outcome).toBe('filled');
  });

  it('lets the manager choose among those who say yes', async () => {
    const t = await boot();
    const { shift, askable } = await t.coverable();
    const [a, b] = askable;
    const first = await t.staff(a.employeeId);
    const second = await t.staff(b.employeeId);
    const made = await t.call('POST', '/v1/cover', t.priya, { shiftId: shift.id, employeeIds: [a.employeeId, b.employeeId], firstToAccept: false });
    expect((await t.call('POST', `/v1/staff/cover/${made.body.id}/accept`, first)).body.outcome).toBe('waiting');
    expect((await t.call('POST', `/v1/staff/cover/${made.body.id}/decline`, second)).status).toBe(200);
    expect((await t.shiftById(shift.id))!.employeeId).toBe(shift.employeeId);
    // Only someone who said yes can be chosen.
    expect((await t.call('POST', `/v1/cover/${made.body.id}/assign`, t.priya, { employeeId: b.employeeId })).body.error).toBe('not_accepted');
    const chosen = await t.call('POST', `/v1/cover/${made.body.id}/assign`, t.priya, { employeeId: a.employeeId });
    expect(chosen.status).toBe(200);
    expect(chosen.body.status).toBe('filled');
    expect((await t.shiftById(shift.id))!.employeeId).toBe(a.employeeId);
  });

  it('calls the request off when the shift is changed after cover was asked for', async () => {
    const t = await boot();
    const { shift, askable } = await t.coverable();
    const first = await t.staff(askable[0].employeeId);
    const made = await t.call('POST', '/v1/cover', t.priya, { shiftId: shift.id, employeeIds: [askable[0].employeeId] });
    expect((await t.call('PATCH', `/v1/shifts/${shift.id}`, t.priya, { endMinute: 23 * 60 + 30 })).status).toBe(200);
    const yes = await t.call('POST', `/v1/staff/cover/${made.body.id}/accept`, first);
    expect(yes.body).toMatchObject({ outcome: 'refused' });
    expect((await t.call('GET', '/v1/cover?siteId=mar', t.priya)).body[0].status).toBe('cancelled');
  });

  it('takes YES on WhatsApp when there is one offer it can mean', async () => {
    const t = await boot();
    const owner = await enterCode(t, await t.as('olivia@marylebonegroup.example'), DEMO_TOTP_SECRET);
    await t.call('PUT', '/v1/settings/messaging/whatsapp', owner, { phoneNumberId: '1234567890', accessToken: 'EAAG'.padEnd(40, 'x'), appSecret: APP_SECRET, template: 'work_message', language: 'en_GB' });
    const { shift, askable } = await t.coverable();
    const a = askable[0];
    const phone = await t.staff(a.employeeId);
    await t.call('PUT', '/v1/staff/channels', phone, { channels: ['whatsapp'], phone: '07700 900123', whatsapp: true });
    const made = await t.call('POST', '/v1/cover', t.priya, { shiftId: shift.id, employeeIds: [a.employeeId] });
    const offer = t.sent.filter((s) => s.url.startsWith('https://graph.facebook.com/')).at(-1)!;
    expect(offer.body.template.components[0].parameters[0].text).toMatch(/^Cover wanted: Sat 24 Oct/);

    const raw = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: '447700900123', id: 'wamid.yes', timestamp: String(Math.floor(Date.parse(`${TODAY}T11:00:00Z`) / 1000)), type: 'text', text: { body: 'Yes!' } }] } }] }] });
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/integrations/whatsapp/webhook/demo',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}` },
      payload: raw,
    });
    expect(res.statusCode).toBe(200);
    expect((await t.shiftById(shift.id))!.employeeId).toBe(a.employeeId);
    const list = await t.call('GET', '/v1/cover?siteId=mar', t.priya);
    expect(list.body.find((r: { id: string }) => r.id === made.body.id).offers[0]).toMatchObject({ response: 'accepted', via: 'whatsapp' });
    // Inside WhatsApp's window now, so the confirmation goes as free text.
    expect(t.sent.at(-1)!.body).toMatchObject({ type: 'text' });
  });

  it('is for those who edit the site rota, and offers nobody who cannot be asked', async () => {
    const t = await boot();
    const { shift, preview } = await t.coverable();
    expect((await t.call('POST', '/v1/cover/preview', { key: 'grace' }, { shiftId: shift.id })).status).toBe(403);
    expect((await t.call('POST', '/v1/cover', { key: 'admin' }, { shiftId: shift.id })).status).toBe(403);
    const blocked = preview.candidates.find((c: { askable: boolean }) => !c.askable);
    const refused = await t.call('POST', '/v1/cover', t.priya, { shiftId: shift.id, employeeIds: [blocked.employeeId] });
    expect(refused.body.error).toBe('not_askable');
    // A shift that has started cannot be offered.
    expect((await t.call('POST', '/v1/cover/preview', t.priya, { siteId: 'mar', roleId: 'bar', date: '2026-10-20', startMinute: 600, endMinute: 900 })).body.error).toBe('started');
  });
});
