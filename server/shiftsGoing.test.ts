import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEMO_TOTP_SECRET } from './seedUsers';
import { enterCode, kit, TODAY } from './testkit';
import { MemoryStore } from './store';

// Shifts going: one open shift, put out to everyone eligible or to the cheapest first in rounds,
// decided by a manager or by the first legal yes. Main's untargeted flow is in requests.test.ts.

const WEEK = '2026-10-19';
const SATURDAY = '2026-10-24';
const PASSWORD = 'pint of best bitter';
const APP_SECRET = 'a'.repeat(32);

interface Row { employeeId: string; name: string; eligible: boolean; reason: string | null; marginal?: number }

async function boot() {
  const sent: { url: string; body: any }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), body: JSON.parse(String(init?.body ?? 'null')) });
    return new Response(JSON.stringify({ messages: [{ id: `wamid.${sent.length}` }] }), { status: 200 });
  }) as typeof globalThis.fetch;
  const clock = { now: new Date(`${TODAY}T11:00:00Z`) };
  const k = await kit({
    store: new MemoryStore(['demo'], TODAY),
    fetch,
    now: () => clock.now,
    env: { CRON_SECRET: 'tick' },
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

  /** A published Saturday shift at Marylebone with at least `least` people eligible to take it. */
  async function coverable(least = 2) {
    const shifts = (await k.call('GET', `/v1/shifts?siteId=mar&from=${SATURDAY}&to=${SATURDAY}`, priya)).body as { id: string; employeeId: string; startMinute: number; endMinute: number; published: boolean }[];
    for (const s of shifts) {
      const preview = await k.call('POST', '/v1/open-shifts/preview', priya, { fromShiftId: s.id });
      const eligible = (preview.body.candidates as Row[]).filter((c) => c.eligible);
      if (eligible.length >= least) return { shift: s, preview: preview.body, eligible };
    }
    throw new Error(`No Saturday shift with ${least} people eligible`);
  }

  const shiftById = async (id: string) => ((await k.call('GET', `/v1/shifts?siteId=mar&from=${SATURDAY}&to=${SATURDAY}`, priya)).body as { id: string; employeeId: string; published: boolean }[]).find((s) => s.id === id);
  const board = async (who: { cookie: string }) => (await k.call('GET', '/v1/staff/board', who)).body.openShifts as { id: string; fill: string; canDecline: boolean; claimed: boolean }[];
  /** What they have been told about shifts going, newest first: not the rota notices from the publish. */
  const notes = async (who: { cookie: string }) =>
    ((await k.call('GET', '/v1/staff/notifications', who)).body as { kind: string; title: string; body: string }[]).filter((n) => n.kind === 'open_shift' || n.kind === 'request_decided');
  const open = async (id: string) => ((await k.call('GET', '/v1/open-shifts?siteId=mar', priya)).body as any[]).find((o) => o.id === id);
  /** Moves the clock on and runs the quarter-hourly schedule. */
  const later = async (minutes: number) => {
    clock.now = new Date(clock.now.getTime() + minutes * 60_000);
    expect((await k.app.inject({ method: 'GET', url: '/internal/webhooks', headers: { authorization: 'Bearer tick' } })).statusCode).toBe(200);
  };
  const asked = (o: { asked: { employeeId: string; asked: boolean }[] }) => o.asked.filter((x) => x.asked).map((x) => x.employeeId);

  return { ...k, sent, priya, clock, staff, coverable, shiftById, board, notes, open, later, asked };
}

describe('putting a shift out to named people', () => {
  it('previews only those who could legally take it, cheapest first, and gives it to the first legal yes', async () => {
    const t = await boot();
    const { shift, preview, eligible } = await t.coverable();
    expect(preview.holder.employeeId).toBe(shift.employeeId);
    const rows = preview.candidates as Row[];
    expect(rows.some((c) => c.employeeId === shift.employeeId)).toBe(false);
    expect(rows.filter((c) => !c.eligible).every((c) => c.reason)).toBe(true);
    const costs = eligible.map((c) => c.marginal!);
    expect(costs).toEqual([...costs].sort((a, b) => a - b));

    const [a, b] = eligible;
    const first = await t.staff(a.employeeId);
    const second = await t.staff(b.employeeId);
    const put = await t.call('POST', '/v1/open-shifts', t.priya, {
      fromShiftId: shift.id, keepUntilTaken: true, employeeIds: [a.employeeId, b.employeeId], fill: 'first_yes', note: 'Big party in at 7.',
    });
    expect(put.status).toBe(201);
    expect(put.body).toMatchObject({ told: 2, fill: 'first_yes', heldByName: expect.any(String), status: 'open' });
    // Kept by its holder until someone takes it.
    expect((await t.shiftById(shift.id))!.employeeId).toBe(shift.employeeId);
    // Putting the same shift out twice is refused.
    expect((await t.call('POST', '/v1/open-shifts', t.priya, { fromShiftId: shift.id, keepUntilTaken: true })).body.error).toBe('already_out');

    expect(await t.board(first)).toEqual([expect.objectContaining({ id: put.body.id, fill: 'first_yes', canDecline: true })]);
    expect((await t.notes(first))[0]).toMatchObject({ kind: 'open_shift', title: 'Cover wanted', body: expect.stringMatching(/^Sat 24 Oct, .+\. Big party in at 7\. The first to say yes/) });

    const yes = await t.call('POST', `/v1/staff/open-shifts/${put.body.id}/claim`, first);
    expect(yes.status).toBe(200);
    expect(yes.body.outcome).toBe('filled');
    // The same shift, now theirs, still published.
    expect(await t.shiftById(shift.id)).toMatchObject({ employeeId: a.employeeId, published: true });
    expect(await t.open(put.body.id)).toMatchObject({ status: 'filled', filledByName: a.name });

    // Too late for the second, who hears it has gone.
    expect(await t.board(second)).toEqual([]);
    expect((await t.call('POST', `/v1/staff/open-shifts/${put.body.id}/claim`, second)).body.error).toBe('not_open');
    expect((await t.notes(second))[0]).toMatchObject({ title: 'Shift taken' });
    expect((await t.notes(first))[0]).toMatchObject({ title: "It's yours" });
  });

  it('refuses a yes that has become illegal since it was put out, and the next person can still take it', async () => {
    const t = await boot();
    const { shift, eligible } = await t.coverable();
    const [a, b] = eligible;
    const first = await t.staff(a.employeeId);
    const second = await t.staff(b.employeeId);
    const put = await t.call('POST', '/v1/open-shifts', t.priya, { fromShiftId: shift.id, keepUntilTaken: true, employeeIds: [a.employeeId, b.employeeId], fill: 'first_yes' });
    const person = (await t.call('GET', `/v1/employees/${a.employeeId}`, { key: 'admin' })).body;
    expect((await t.call('PATCH', `/v1/employees/${a.employeeId}`, { key: 'admin' }, { leave: [...person.leave, SATURDAY] })).status).toBe(200);
    const yes = await t.call('POST', `/v1/staff/open-shifts/${put.body.id}/claim`, first);
    expect(yes.status).toBe(409);
    expect((await t.shiftById(shift.id))!.employeeId).toBe(shift.employeeId);
    expect((await t.call('POST', `/v1/staff/open-shifts/${put.body.id}/claim`, second)).body.outcome).toBe('filled');
  });

  it('lets the manager approve one claim when they decide who gets it, moving the held shift', async () => {
    const t = await boot();
    const { shift, eligible } = await t.coverable();
    const [a, b] = eligible;
    const first = await t.staff(a.employeeId);
    const second = await t.staff(b.employeeId);
    const put = await t.call('POST', '/v1/open-shifts', t.priya, { fromShiftId: shift.id, keepUntilTaken: true, employeeIds: [a.employeeId, b.employeeId] });
    expect((await t.call('POST', `/v1/staff/open-shifts/${put.body.id}/claim`, first)).body).toMatchObject({ outcome: 'claimed', kind: 'open_shift' });
    expect((await t.call('POST', `/v1/staff/open-shifts/${put.body.id}/claim`, second)).status).toBe(201);
    expect((await t.shiftById(shift.id))!.employeeId).toBe(shift.employeeId);
    const view = await t.open(put.body.id);
    const claim = view.claims.find((c: { employeeId: string }) => c.employeeId === a.employeeId);
    expect((await t.call('POST', `/v1/requests/${claim.id}/approve`, t.priya, {})).status).toBe(200);
    expect((await t.shiftById(shift.id))!.employeeId).toBe(a.employeeId);
    expect((await t.notes(second))[0]).toMatchObject({ title: 'Open shift filled' });
  });

  it('withdraws it when the held shift is changed after it was put out', async () => {
    const t = await boot();
    const { shift, eligible } = await t.coverable();
    const first = await t.staff(eligible[0].employeeId);
    const put = await t.call('POST', '/v1/open-shifts', t.priya, { fromShiftId: shift.id, keepUntilTaken: true, employeeIds: [eligible[0].employeeId], fill: 'first_yes' });
    expect((await t.call('PATCH', `/v1/shifts/${shift.id}`, t.priya, { endMinute: shift.endMinute - 15 })).status).toBe(200);
    expect((await t.call('POST', `/v1/staff/open-shifts/${put.body.id}/claim`, first)).status).toBe(409);
    expect((await t.open(put.body.id)).status).toBe('withdrawn');
  });

  it('takes YES on WhatsApp when there is one shift going it can mean', async () => {
    const t = await boot();
    const owner = await enterCode(t, await t.as('olivia@marylebonegroup.example'), DEMO_TOTP_SECRET);
    await t.call('PUT', '/v1/settings/messaging/whatsapp', owner, { phoneNumberId: '1234567890', accessToken: 'EAAG'.padEnd(40, 'x'), appSecret: APP_SECRET, template: 'work_message', language: 'en_GB' });
    const { shift, eligible } = await t.coverable();
    const a = eligible[0];
    const phone = await t.staff(a.employeeId);
    await t.call('PUT', '/v1/staff/channels', phone, { channels: ['whatsapp'], phone: '07700 900123', whatsapp: true });
    const put = await t.call('POST', '/v1/open-shifts', t.priya, { fromShiftId: shift.id, keepUntilTaken: true, employeeIds: [a.employeeId], fill: 'first_yes' });
    const offer = t.sent.filter((s) => s.url.startsWith('https://graph.facebook.com/')).at(-1)!;
    expect(offer.body.template.components[0].parameters[0].text).toMatch(/^Cover wanted\. Sat 24 Oct/);

    const raw = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: '447700900123', id: 'wamid.yes', timestamp: String(Math.floor(t.clock.now.getTime() / 1000)), type: 'text', text: { body: 'Yes!' } }] } }] }] });
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/integrations/whatsapp/webhook/demo',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}` },
      payload: raw,
    });
    expect(res.statusCode).toBe(200);
    expect((await t.shiftById(shift.id))!.employeeId).toBe(a.employeeId);
    expect((await t.open(put.body.id)).status).toBe('filled');
    // Inside WhatsApp's window now, so the confirmation goes as free text.
    expect(t.sent.at(-1)!.body).toMatchObject({ type: 'text', text: { body: expect.stringMatching(/^It's yours/) } });
  });

  it('is for those who publish the site rota, and asks nobody who is not eligible', async () => {
    const t = await boot();
    const { shift, preview } = await t.coverable();
    expect((await t.call('POST', '/v1/open-shifts/preview', { key: 'grace' }, { fromShiftId: shift.id })).status).toBe(403);
    const blocked = (preview.candidates as Row[]).find((c) => !c.eligible)!;
    expect((await t.call('POST', '/v1/open-shifts', t.priya, { fromShiftId: shift.id, employeeIds: [blocked.employeeId] })).body.error).toBe('not_eligible');
    expect((await t.call('POST', '/v1/open-shifts/preview', t.priya, { siteId: 'mar', roleId: 'bar', date: '2026-10-20', startMinute: 600, endMinute: 900 })).body.error).toBe('in_the_past');
  });
});

describe('putting a shift out in rounds', () => {
  it('asks the cheapest first, then the next round when its time comes', async () => {
    const t = await boot();
    const { shift, eligible } = await t.coverable(4);
    const put = await t.call('POST', '/v1/open-shifts', t.priya, { fromShiftId: shift.id, keepUntilTaken: true, rounds: { size: 2, everyMinutes: 30 }, fill: 'first_yes' });
    expect(put.status).toBe(201);
    expect(put.body).toMatchObject({ rounds: { size: 2, everyMinutes: 30 }, round: 1, waiting: eligible.length - 2, told: 2 });
    expect(t.asked(put.body)).toEqual(eligible.slice(0, 2).map((a) => a.employeeId));
    // Nobody further down hears anything.
    const third = await t.staff(eligible[2].employeeId);
    expect(await t.board(third)).toEqual([]);
    expect(await t.notes(third)).toEqual([]);

    await t.later(29);
    expect((await t.open(put.body.id)).round).toBe(1);
    await t.later(1);
    const o = await t.open(put.body.id);
    expect(o.round).toBe(2);
    expect(t.asked(o)).toEqual(eligible.slice(0, 4).map((a) => a.employeeId));
    expect(await t.board(third)).toHaveLength(1);

    // Once taken, those never asked hear nothing; those asked hear it has gone.
    expect((await t.call('POST', `/v1/staff/open-shifts/${put.body.id}/claim`, third)).body.outcome).toBe('filled');
    for (const u of eligible.slice(4)) {
      const org = await t.store.load('demo');
      expect((org.notifications ?? []).filter((n) => n.employeeId === u.employeeId && n.kind !== 'rota_published')).toEqual([]);
    }
    const round = (await t.open(put.body.id)).round;
    await t.later(60);
    expect((await t.open(put.body.id)).round).toBe(round);
  });

  it('moves on at once when everyone asked says no, and passes over anyone no longer free', async () => {
    const t = await boot();
    const { shift, eligible } = await t.coverable(4);
    const a = await t.staff(eligible[0].employeeId);
    const put = await t.call('POST', '/v1/open-shifts', t.priya, { fromShiftId: shift.id, keepUntilTaken: true, rounds: { size: 1, everyMinutes: 60 } });
    const second = (await t.call('GET', `/v1/employees/${eligible[1].employeeId}`, { key: 'admin' })).body;
    expect((await t.call('PATCH', `/v1/employees/${eligible[1].employeeId}`, { key: 'admin' }, { leave: [...second.leave, SATURDAY] })).status).toBe(200);
    expect((await t.call('POST', `/v1/staff/open-shifts/${put.body.id}/decline`, a)).status).toBe(200);
    const o = await t.open(put.body.id);
    expect(o.asked.find((x: { employeeId: string }) => x.employeeId === eligible[1].employeeId)).toMatchObject({ asked: false, skipped: expect.stringMatching(/leave/) });
    expect(t.asked(o)).toEqual([eligible[0].employeeId, eligible[2].employeeId]);
  });

  it("asks everyone left when there is not time for another round, and on the manager's say", async () => {
    const t = await boot();
    const { shift, eligible } = await t.coverable(4);
    const put = await t.call('POST', '/v1/open-shifts', t.priya, { fromShiftId: shift.id, keepUntilTaken: true, rounds: { size: 1, everyMinutes: 120 } });
    expect(t.asked(await t.open(put.body.id))).toHaveLength(1);
    expect(t.asked((await t.call('POST', `/v1/open-shifts/${put.body.id}/next`, t.priya, {})).body)).toHaveLength(2);
    // Two hours before the shift (London is an hour ahead of UTC in October), everyone left goes.
    t.clock.now = new Date(Date.parse(`${SATURDAY}T00:00:00Z`) + (shift.startMinute - 60 - 119) * 60_000);
    await t.later(0);
    expect(t.asked(await t.open(put.body.id))).toEqual(eligible.map((x) => x.employeeId));
    expect((await t.call('POST', `/v1/open-shifts/${put.body.id}/next`, t.priya, {})).body.error).toBe('nobody_left');
  });

  it('refuses rounds with no time for a second one, and nonsense sizes', async () => {
    const t = await boot();
    const { shift } = await t.coverable(4);
    expect((await t.call('POST', '/v1/open-shifts', t.priya, { fromShiftId: shift.id, keepUntilTaken: true, rounds: { size: 0, everyMinutes: 30 } })).body.error).toBe('invalid_rounds');
    expect((await t.call('POST', '/v1/open-shifts', t.priya, { fromShiftId: shift.id, keepUntilTaken: true, rounds: { size: 2, everyMinutes: 45 } })).body.error).toBe('invalid_rounds');
    t.clock.now = new Date(Date.parse(`${SATURDAY}T00:00:00Z`) + (shift.startMinute - 60 - 90) * 60_000);
    expect((await t.call('POST', '/v1/open-shifts', t.priya, { fromShiftId: shift.id, keepUntilTaken: true, rounds: { size: 1, everyMinutes: 120 } })).body.error).toBe('no_time_for_rounds');
    expect((await t.call('POST', '/v1/open-shifts', t.priya, { fromShiftId: shift.id, keepUntilTaken: true })).status).toBe(201);
  });
});
