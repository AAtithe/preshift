import { afterEach, describe, expect, it, vi } from 'vitest';
import { addDays, weekStart } from '../src/engine/time';
import { managerDigests, sendManagerDigests } from './digest';
import { emailSetting } from './mail';
import { kit, type Kit } from './testkit';
import { freezeClock, holdClock } from './testClock';

holdClock();

const PASSWORD = 'pint of best bitter';
const KEY = { key: 'manager' };

async function boot() {
  const k = await kit({ keys: [{ key: 'manager', orgId: 'demo', name: 'GM', scopes: ['*'] }, { key: 'rota-only', orgId: 'demo', name: 'Rota tool', scopes: ['rota:read', 'rota:write'] as never }] });
  const join = async (person: string) => {
    const res = await k.call('POST', `/v1/staff-logins/${person}/invite`, KEY);
    expect(res.status).toBe(201);
    const link = Object.fromEntries(new URLSearchParams(new URL(res.body.path, 'https://x').hash.slice(1)));
    const joined = await k.call('POST', '/v1/staff/join', null, { ...link, email: `${person}@example.com`, password: PASSWORD });
    expect(joined.status).toBe(200);
    return joined.cookie!;
  };
  const me = async (cookie: string) => (await k.call('GET', '/v1/staff/me', cookie)).body;
  return { k, join, me };
}

/**
 * A clear day for the tests' own shifts, ten days out: inside the fortnight the staff app shows
 * (today to today + 13) whatever day of the week the tests run, with the days around it cleared.
 */
async function clearDay(k: Kit, today: string) {
  const day = addDays(today, 10);
  const org = await k.store.load('demo');
  org.state.shifts = org.state.shifts.filter((s) => s.date < addDays(day, -2) || s.date > addDays(day, 9));
  return day;
}

const bar = (employeeId: string, date: string, startMinute = 17 * 60, endMinute = 23 * 60) => ({ employeeId, roleId: 'bar', siteId: 'mar', date, startMinute, endMinute, breakMinutes: 20 });

async function postAndPublish(k: Kit, shift: ReturnType<typeof bar>) {
  const made = await k.call('POST', '/v1/shifts', KEY, shift);
  expect(made.status).toBe(201);
  const pub = await k.call('POST', '/v1/rota/publish', KEY, { siteId: 'mar', weekStart: weekStart(shift.date) });
  expect(pub.status).toBe(200);
  return made.body.shift.id as string;
}

const notes = async (k: Kit, cookie: string) => (await k.call('GET', '/v1/staff/notifications', cookie)).body as { kind: string; title: string; body: string; read: boolean }[];

describe('staff notifications', () => {
  it('tells people when their rota is out, when it changes and when a shift is cancelled', async () => {
    const { k, join, me } = await boot();
    const ben = await join('mar-12');
    const today = (await me(ben)).today;
    const day = await clearDay(k, today);
    const id = await postAndPublish(k, bar('mar-12', day));
    let feed = await notes(k, ben);
    expect(feed[0]).toMatchObject({ kind: 'rota_published', title: 'Your rota at Marylebone is out' });
    expect(feed[0].body).toMatch(/17:00-23:00, Bartender at Marylebone/);
    expect((await me(ben)).unread).toBeGreaterThan(0);

    // Publishing again with nothing changed tells nobody anything new.
    await k.call('POST', '/v1/rota/publish', KEY, { siteId: 'mar', weekStart: weekStart(day) });
    expect((await notes(k, ben)).length).toBe(feed.length);

    // A moved shift is a change.
    await k.call('PATCH', `/v1/shifts/${id}`, KEY, { startMinute: 18 * 60 });
    await k.call('POST', '/v1/rota/publish', KEY, { siteId: 'mar', weekStart: weekStart(day) });
    feed = await notes(k, ben);
    expect(feed[0].kind).toBe('rota_changed');
    expect(feed[0].body).toMatch(/New: .*18:00-23:00/);
    expect(feed[0].body).toMatch(/Taken off: .*17:00-23:00/);

    // A published shift deleted is told straight away, and not again at the next publish.
    expect((await k.call('DELETE', `/v1/shifts/${id}`, KEY)).status).toBe(204);
    feed = await notes(k, ben);
    expect(feed[0]).toMatchObject({ kind: 'shift_cancelled' });
    await k.call('POST', '/v1/rota/publish', KEY, { siteId: 'mar', weekStart: weekStart(day) });
    expect((await notes(k, ben)).length).toBe(feed.length);

    await k.call('POST', '/v1/staff/notifications/read', ben, {});
    expect((await me(ben)).unread).toBe(0);
  });

  it('shows who else is on, by name and time only', async () => {
    const { k, join, me } = await boot();
    const ben = await join('mar-12');
    const day = await clearDay(k, (await me(ben)).today);
    await k.call('POST', '/v1/shifts', KEY, bar('mar-15', day, 18 * 60, 23 * 60));
    await postAndPublish(k, bar('mar-12', day));
    const team = (await k.call('GET', '/v1/staff/team', ben)).body;
    const shift = team.find((t: { date: string }) => t.date === day);
    expect(shift.team).toEqual([{ name: 'Zara Ahmed', role: 'Bartender', startMinute: 1080, endMinute: 1380 }]);
    expect(JSON.stringify(team)).not.toMatch(/hourlyRate|mar-15/);
  });
});

describe('shift swaps', () => {
  it('a colleague agrees, the manager approves, the shift moves and both are told', async () => {
    const { k, join, me } = await boot();
    const ben = await join('mar-12');
    const zara = await join('mar-15');
    const day = await clearDay(k, (await me(ben)).today);
    const id = await postAndPublish(k, bar('mar-12', day));

    const options = (await k.call('GET', `/v1/staff/shifts/${id}/swap-options`, ben)).body;
    const names = options.people.map((p: { name: string }) => p.name);
    expect(names).toContain('Zara Ahmed');
    // Not trained for the bar: never offered.
    expect(names).not.toContain('Marco Bianchi');

    // Asking someone who could not legally take it is refused up front.
    expect((await k.call('POST', '/v1/staff/swaps', ben, { shiftId: id, toEmployeeId: 'mar-2' })).body.error).toBe('not_eligible');

    const asked = await k.call('POST', '/v1/staff/swaps', ben, { shiftId: id, toEmployeeId: 'mar-15', note: 'Family wedding' });
    expect(asked.status).toBe(201);
    expect((await notes(k, zara))[0]).toMatchObject({ kind: 'swap_offered', title: 'Ben Ford asked you to swap' });
    expect((await k.call('POST', '/v1/staff/swaps', ben, { shiftId: id, toEmployeeId: 'mar-16' })).body.error).toBe('already_offered');

    // Not approvable until the colleague agrees.
    expect((await k.call('POST', `/v1/requests/${asked.body.id}/approve`, KEY, {})).body.error).toBe('not_agreed');

    const board = (await k.call('GET', '/v1/staff/board', zara)).body;
    expect(board.offers).toEqual([expect.objectContaining({ id: asked.body.id, from: 'Ben Ford', directed: true })]);
    expect((await k.call('POST', `/v1/staff/swaps/${asked.body.id}/accept`, zara)).status).toBe(200);
    expect((await notes(k, ben))[0]).toMatchObject({ kind: 'swap_accepted' });

    const waiting = (await k.call('GET', '/v1/requests', KEY)).body.find((r: { id: string }) => r.id === asked.body.id);
    expect(waiting).toMatchObject({ kind: 'swap', status: 'accepted', takerName: 'Zara Ahmed', canDecide: true, problem: null });

    const approved = await k.call('POST', `/v1/requests/${asked.body.id}/approve`, KEY, {});
    expect(approved.status).toBe(200);
    const shift = (await k.call('GET', `/v1/shifts?siteId=mar&from=${day}&to=${day}`, KEY)).body.find((s: { id: string }) => s.id === id);
    expect(shift).toMatchObject({ employeeId: 'mar-15', published: true });
    expect((await notes(k, ben))[0]).toMatchObject({ kind: 'request_decided', title: 'Shift swap approved' });
    expect((await notes(k, zara))[0]).toMatchObject({ kind: 'request_decided', title: 'Shift swap approved' });
    // Zara now sees it as her own shift.
    expect((await me(zara)).shifts.some((s: { id: string }) => s.id === id)).toBe(true);
  });

  it('exchanges two shifts, checking both people', async () => {
    const { k, join, me } = await boot();
    const ben = await join('mar-12');
    const zara = await join('mar-15');
    const day = await clearDay(k, (await me(ben)).today);
    const mine = await postAndPublish(k, bar('mar-12', day));
    const theirs = await postAndPublish(k, bar('mar-15', addDays(day, 1)));
    const options = (await k.call('GET', `/v1/staff/shifts/${mine}/swap-options`, ben)).body;
    expect(options.people.find((p: { name: string }) => p.name === 'Zara Ahmed').shifts.map((s: { id: string }) => s.id)).toContain(theirs);
    const asked = await k.call('POST', '/v1/staff/swaps', ben, { shiftId: mine, toEmployeeId: 'mar-15', returnShiftId: theirs });
    expect(asked.status).toBe(201);
    await k.call('POST', `/v1/staff/swaps/${asked.body.id}/accept`, zara);
    expect((await k.call('POST', `/v1/requests/${asked.body.id}/approve`, KEY, {})).status).toBe(200);
    const shifts = (await k.call('GET', `/v1/shifts?siteId=mar&from=${day}&to=${addDays(day, 1)}`, KEY)).body;
    expect(shifts.find((s: { id: string }) => s.id === mine).employeeId).toBe('mar-15');
    expect(shifts.find((s: { id: string }) => s.id === theirs).employeeId).toBe('mar-12');
  });

  it('refuses a taker the swap would put in breach', async () => {
    const { k, join, me } = await boot();
    const ben = await join('mar-12');
    const zara = await join('mar-15');
    const day = await clearDay(k, (await me(ben)).today);
    const id = await postAndPublish(k, bar('mar-12', day));
    // Zara already works that evening: taking Ben's shift would double book her.
    await postAndPublish(k, bar('mar-15', day, 18 * 60, 22 * 60));
    const open = await k.call('POST', '/v1/staff/swaps', ben, { shiftId: id });
    expect(open.status).toBe(201);
    expect((await k.call('GET', '/v1/staff/board', zara)).body.offers).toEqual([]);
    expect((await k.call('POST', `/v1/staff/swaps/${open.body.id}/accept`, zara)).body.error).toBe('compliance_block');
  });
});

describe('open shifts', () => {
  it('posted to those eligible, claimed, approved for one and the rest told', async () => {
    const { k, join, me } = await boot();
    const ben = await join('mar-12');
    const callum = await join('mar-16');
    const marco = await join('mar-2');
    const day = await clearDay(k, (await me(ben)).today);
    const posted = await k.call('POST', '/v1/open-shifts', KEY, { siteId: 'mar', roleId: 'bar', date: day, startMinute: 18 * 60, endMinute: 23 * 60, note: 'Private party', everyone: true });
    expect(posted.status).toBe(201);
    expect(posted.body.eligible).toContain('Ben Ford');
    expect(posted.body.offer.allTold).toBe(true);
    expect(posted.body.eligible).not.toContain('Marco Bianchi');
    expect((await notes(k, ben))[0]).toMatchObject({ kind: 'open_shift' });
    expect(await notes(k, marco)).toEqual([]);
    expect((await k.call('GET', '/v1/staff/board', marco)).body.openShifts).toEqual([]);

    const a = await k.call('POST', `/v1/staff/open-shifts/${posted.body.id}/claim`, callum);
    const b = await k.call('POST', `/v1/staff/open-shifts/${posted.body.id}/claim`, ben);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect((await k.call('POST', `/v1/staff/open-shifts/${posted.body.id}/claim`, ben)).body.error).toBe('already_claimed');
    expect((await k.call('POST', `/v1/staff/open-shifts/${posted.body.id}/claim`, marco)).body.error).toBe('not_eligible');

    expect((await k.call('POST', `/v1/requests/${a.body.id}/approve`, KEY, {})).status).toBe(200);
    const list = (await k.call('GET', '/v1/open-shifts?siteId=mar', KEY)).body;
    expect(list.find((o: { id: string }) => o.id === posted.body.id)).toMatchObject({ status: 'filled', filledByName: 'Callum Fraser' });
    const made = (await k.call('GET', `/v1/shifts?siteId=mar&from=${day}&to=${day}`, KEY)).body.find((s: { employeeId: string }) => s.employeeId === 'mar-16');
    expect(made).toMatchObject({ startMinute: 1080, endMinute: 1380, published: true });
    expect((await notes(k, ben))[0]).toMatchObject({ title: 'Open shift filled' });
    expect((await me(ben)).requests.find((r: { id: string }) => r.id === b.body.id).status).toBe('cancelled');
  });

  it('shows the cancellation on top even when it lands in the same millisecond as the publish', async () => {
    // Freeze the clock so every notification ties: the order written must decide, newest first.
    freezeClock('2026-10-22T12:00:00Z');
    try {
      const { k, join, me } = await boot();
      const ben = await join('mar-12');
      const day = await clearDay(k, (await me(ben)).today);
      const id = await postAndPublish(k, bar('mar-12', day));
      expect((await k.call('POST', '/v1/open-shifts', KEY, { fromShiftId: id })).status).toBe(201);
      const list = await notes(k, ben);
      expect(new Set(list.map((n) => (n as unknown as { at: string }).at)).size).toBe(1);
      expect(list.map((n) => n.kind)).toEqual(['shift_cancelled', 'rota_published']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('puts a shift out for cover from the person who had it', async () => {
    const { k, join, me } = await boot();
    const ben = await join('mar-12');
    const day = await clearDay(k, (await me(ben)).today);
    const id = await postAndPublish(k, bar('mar-12', day));
    const posted = await k.call('POST', '/v1/open-shifts', KEY, { fromShiftId: id });
    expect(posted.status).toBe(201);
    expect(posted.body.releasedFrom).toEqual({ shiftId: id, employeeId: 'mar-12' });
    expect(posted.body.eligible).not.toContain('Ben Ford');
    expect((await notes(k, ben))[0]).toMatchObject({ kind: 'shift_cancelled' });
    expect((await k.call('DELETE', `/v1/open-shifts/${posted.body.id}`, KEY)).status).toBe(204);
  });
});

describe('open shifts offered cheapest first', () => {
  it('tells those short of their contracted hours first, then the cheapest, then everyone', async () => {
    const { k, join, me } = await boot();
    const ben = await join('mar-12');
    const callum = await join('mar-16');
    const day = await clearDay(k, (await me(ben)).today);
    const org = await k.store.load('demo');
    // Only Callum has contracted hours this week that the rota does not yet fill.
    for (const e of org.state.employees) e.contractedHours = 0;
    Object.assign(org.state.employees.find((e) => e.id === 'mar-16')!, { payBasis: 'hourly', contractedHours: 40 });
    const posted = await k.call('POST', '/v1/open-shifts', KEY, { siteId: 'mar', roleId: 'bar', date: day, startMinute: 18 * 60, endMinute: 23 * 60 });
    expect(posted.status).toBe(201);
    expect(posted.body.offer.waves.map((w: { tier: string }) => w.tier)).toEqual(['contracted', 'cheapest', 'everyone']);
    expect(posted.body.told).toBe(1);
    expect(posted.body.offer.nextAt).toEqual(expect.any(String));
    expect((await notes(k, callum))[0]).toMatchObject({ kind: 'open_shift' });
    expect((await k.call('GET', '/v1/staff/board', callum)).body.openShifts).toHaveLength(1);

    // Ben is in a later wave: not told, not shown, and cannot claim ahead of it.
    const o = (await k.store.load('demo')).openShifts!.find((x) => x.id === posted.body.id)!;
    const wave = o.offer!.waves.findIndex((w) => w.employeeIds.includes('mar-12'));
    expect(wave).toBeGreaterThan(0);
    expect(await notes(k, ben)).toEqual([]);
    expect((await k.call('GET', '/v1/staff/board', ben)).body.openShifts).toEqual([]);
    expect((await k.call('POST', `/v1/staff/open-shifts/${posted.body.id}/claim`, ben)).body.error).toBe('not_offered');

    // A claim waiting holds the next wave; once decided, the next goes when its time comes.
    const { releaseDueWaves } = await import('./routes/requests');
    const later = new Date(Date.parse(o.offer!.nextAt!) + 60_000);
    const claim = await k.call('POST', `/v1/staff/open-shifts/${posted.body.id}/claim`, callum);
    expect(claim.status).toBe(201);
    expect(releaseDueWaves(org, later)).toBe(0);
    expect((await k.call('POST', `/v1/requests/${claim.body.id}/decline`, KEY, { note: 'Need you rested for Saturday' })).status).toBe(200);
    expect(releaseDueWaves(org, later)).toBeGreaterThan(0);
    expect(o.offer!.released).toBe(2);

    // The manager sees the tier each claimant came from, and can tell everyone at once.
    const all = await k.call('POST', `/v1/open-shifts/${posted.body.id}/offer-all`, KEY);
    expect(all.status).toBe(200);
    expect(all.body.offer.allTold).toBe(true);
    expect((await k.call('GET', '/v1/staff/board', ben)).body.openShifts).toHaveLength(1);
    const ask = await k.call('POST', `/v1/staff/open-shifts/${posted.body.id}/claim`, ben);
    expect(ask.status).toBe(201);
    const view = (await k.call('GET', '/v1/requests?siteId=mar', KEY)).body.find((r: { id: string }) => r.id === ask.body.id);
    expect(view.offer).toMatchObject({ tier: expect.stringMatching(/cheapest|everyone/), cost: expect.any(Number) });
  });

  it('tells everyone at once inside a day of the start', async () => {
    freezeClock('2026-10-22T09:00:00Z');
    try {
      const { k, join, me } = await boot();
      const ben = await join('mar-12');
      const today = (await me(ben)).today;
      const org = await k.store.load('demo');
      org.state.shifts = org.state.shifts.filter((s) => s.date !== today);
      const posted = await k.call('POST', '/v1/open-shifts', KEY, { siteId: 'mar', roleId: 'bar', date: today, startMinute: 18 * 60, endMinute: 23 * 60 });
      expect(posted.status).toBe(201);
      expect(posted.body.offer.allTold).toBe(true);
      expect(posted.body.told).toBe(posted.body.eligible.length);
    } finally {
      vi.useRealTimers();
    }
  });

  it('approves a claim by itself only when the site turned it on, no rule is touched and labour stays in budget', async () => {
    const { k, join, me } = await boot();
    const ben = await join('mar-12');
    const day = await clearDay(k, (await me(ben)).today);
    const org = await k.store.load('demo');
    const site = org.state.sites.find((x) => x.id === 'mar')!;
    org.state.forecast = org.state.forecast.filter((f) => !(f.siteId === 'mar' && f.date >= weekStart(day) && f.date <= addDays(weekStart(day), 6)));
    org.state.forecast.push({ siteId: 'mar', date: day, hour: 19, sales: 50_000, covers: 900 });
    const post = async () => (await k.call('POST', '/v1/open-shifts', KEY, { siteId: 'mar', roleId: 'bar', date: day, startMinute: 18 * 60, endMinute: 23 * 60, everyone: true })).body.id as string;

    // Off by default: the claim waits for a manager.
    const first = await post();
    const waiting = await k.call('POST', `/v1/staff/open-shifts/${first}/claim`, ben);
    expect(waiting.body.status).toBe('pending');
    expect((await k.call('DELETE', `/v1/open-shifts/${first}`, KEY)).status).toBe(204);

    expect((await k.call('PUT', '/v1/open-shifts/auto-approve', KEY, { siteId: 'mar', on: true })).status).toBe(200);
    expect((await k.call('GET', '/v1/open-shifts/auto-approve', KEY)).body.find((x: { siteId: string }) => x.siteId === 'mar').on).toBe(true);

    // Over budget: still waits.
    site.labourTargetPct = 0.0001;
    const second = await post();
    expect((await k.call('POST', `/v1/staff/open-shifts/${second}/claim`, ben)).body.status).toBe('pending');
    expect((await k.call('DELETE', `/v1/open-shifts/${second}`, KEY)).status).toBe(204);

    // Within budget and clear of every rule: approved and on the rota at once.
    site.labourTargetPct = 0.9;
    const third = await post();
    const done = await k.call('POST', `/v1/staff/open-shifts/${third}/claim`, ben);
    expect(done.status).toBe(201);
    expect(done.body.status).toBe('approved');
    const list = (await k.call('GET', '/v1/open-shifts?siteId=mar', KEY)).body;
    expect(list.find((o: { id: string }) => o.id === third)).toMatchObject({ status: 'filled', autoApproved: true, filledByName: 'Ben Ford' });
    expect((await notes(k, ben))[0].title).toMatch(/approved/i);
  });
});

describe('holiday, time off and availability', () => {
  it('holiday asked, seen against the balance and the floor, approved into leave', async () => {
    const { k, join, me } = await boot();
    const ben = await join('mar-12');
    const before = await me(ben);
    expect(before.holiday.remainingHours).toBeGreaterThan(0);
    const from = addDays(before.today, 20);
    const asked = await k.call('POST', '/v1/staff/requests/holiday', ben, { from, to: addDays(from, 1), note: 'Cousin visiting' });
    expect(asked.status).toBe(201);
    expect(asked.body.hours).toBeGreaterThan(0);
    expect((await k.call('POST', '/v1/staff/requests/holiday', ben, { from, to: from })).body.error).toBe('overlaps');
    expect((await k.call('POST', '/v1/staff/requests/holiday', ben, { from: addDays(before.today, -1), to: before.today })).body.error).toBe('in_the_past');

    const view = (await k.call('GET', '/v1/requests', KEY)).body.find((r: { id: string }) => r.id === asked.body.id);
    expect(view.balance.afterHours).toBeCloseTo(view.balance.remainingHours - asked.body.hours, 2);
    expect(view.note).toBe('Cousin visiting');

    expect((await k.call('POST', `/v1/requests/${asked.body.id}/approve`, KEY, { note: 'Enjoy it' })).status).toBe(200);
    const after = await me(ben);
    expect(after.holiday.upcoming).toEqual([from, addDays(from, 1)]);
    expect((await notes(k, ben))[0].body).toMatch(/approved by GM\. Enjoy it/);
    expect((await k.call('POST', `/v1/requests/${asked.body.id}/decline`, KEY, {})).body.error).toBe('already_decided');
  });

  it('a GM decides for their own site only, and never their own request', async () => {
    const { k, join, me } = await boot();
    const ben = await join('mar-12');
    const hannahStaff = await join('shd-7');
    const today = (await me(ben)).today;
    const mar = await k.call('POST', '/v1/staff/requests/holiday', ben, { from: addDays(today, 30), to: addDays(today, 30) });
    const shd = await k.call('POST', '/v1/staff/requests/holiday', hannahStaff, { from: addDays(today, 30), to: addDays(today, 30) });
    const priya = await k.as('priya@marylebonegroup.example');
    const seen = (await k.call('GET', '/v1/requests', priya)).body.map((r: { id: string }) => r.id);
    expect(seen).toContain(mar.body.id);
    expect(seen).not.toContain(shd.body.id);
    expect((await k.call('POST', `/v1/requests/${shd.body.id}/approve`, priya, {})).status).toBe(404);
    // A floor supervisor runs shifts but does not book leave.
    const grace = await k.as('grace@marylebonegroup.example');
    expect((await k.call('GET', '/v1/requests', grace)).body).toEqual([]);

    const priyaStaff = await join('mar-1');
    const own = await k.call('POST', '/v1/staff/requests/holiday', priyaStaff, { from: addDays(today, 40), to: addDays(today, 40) });
    expect((await k.call('POST', `/v1/requests/${own.body.id}/approve`, priya, {})).status).toBe(403);
  });

  it('time off becomes an absence of its kind once approved', async () => {
    const { k, join, me } = await boot();
    const ben = await join('mar-12');
    const today = (await me(ben)).today;
    const asked = await k.call('POST', '/v1/staff/requests/time-off', ben, { absenceType: 'compassionate', from: today, to: addDays(today, 2), note: 'Funeral' });
    expect(asked.status).toBe(201);
    expect(asked.body.absenceLabel).toBe('Compassionate');
    expect((await k.call('POST', '/v1/staff/requests/time-off', ben, { absenceType: 'sickness', from: today, to: today })).status).toBe(400);
    expect((await k.call('POST', `/v1/requests/${asked.body.id}/approve`, KEY, {})).status).toBe(200);
    const e = (await k.call('GET', '/v1/employees/mar-12', KEY)).body;
    expect(e.absences.at(-1)).toMatchObject({ type: 'compassionate', from: today, to: addDays(today, 2), reason: 'Funeral' });
  });

  it('weekly availability is proposed and approved; one-off days are the person\'s own say', async () => {
    const { k, join, me } = await boot();
    const ben = await join('mar-12');
    const pattern = [0, 1, 2, 3, 4].map((weekday) => ({ weekday, fromMinute: 16 * 60, toMinute: 24 * 60 }));
    const asked = await k.call('POST', '/v1/staff/requests/availability', ben, { availability: pattern, note: 'Back at college in the day' });
    expect(asked.status).toBe(201);
    expect((await k.call('POST', `/v1/requests/${asked.body.id}/approve`, KEY, {})).status).toBe(200);
    expect((await k.call('GET', '/v1/employees/mar-12', KEY)).body.availability).toEqual(pattern);

    const today = (await me(ben)).today;
    const day = await clearDay(k, today);
    const put = await k.call('PUT', '/v1/staff/unavailable', ben, { dates: [{ date: day, note: 'Exam' }] });
    expect(put.body.unavailable).toEqual([{ date: day, note: 'Exam' }]);
    // The rota warns on it.
    const made = await k.call('POST', '/v1/shifts', KEY, bar('mar-12', day));
    expect(made.body.issues.map((i: { code: string }) => i.code)).toContain('availability');
  });
});

describe('sickness', () => {
  it('reported from the phone, blocks their shifts, acknowledged, with a fit note and a return date', async () => {
    const { k, join, me } = await boot();
    const ben = await join('mar-12');
    const today = (await me(ben)).today;
    const tomorrow = addDays(today, 1);
    const org = await k.store.load('demo');
    org.state.shifts = org.state.shifts.filter((s) => !(s.employeeId === 'mar-12' && s.date >= today && s.date <= addDays(today, 6)));
    await postAndPublish(k, bar('mar-12', tomorrow));

    // A fit note needs a sickness to go with.
    const pdf = Buffer.from('%PDF-1.4 fit note');
    const early = await k.app.inject({ method: 'POST', url: '/v1/staff/fit-note?fileName=note.pdf', headers: { cookie: ben, 'content-type': 'application/pdf' }, payload: pdf });
    expect(early.statusCode).toBe(409);

    const sick = await k.call('POST', '/v1/staff/sick', ben, { note: 'Flu' });
    expect(sick.status).toBe(201);
    expect((await me(ben)).sick).toEqual({ from: today });
    expect((await k.call('POST', '/v1/staff/sick', ben, {})).body.error).toBe('already_off');

    const view = (await k.call('GET', '/v1/requests', KEY)).body.find((r: { id: string }) => r.id === sick.body.id);
    expect(view).toMatchObject({ kind: 'sickness', note: 'Flu' });
    expect(view.clashes.map((c: { line: string }) => c.line).join()).toMatch(/Bartender at Marylebone/);
    // The shift now blocks publication until it is re-covered.
    const blocked = await k.call('POST', '/v1/rota/publish', KEY, { siteId: 'mar', weekStart: weekStart(tomorrow) });
    expect(blocked.body.error).toBe('compliance_block');

    // A rota key without HR access never learns that someone is off sick.
    const rotaKey = (await k.call('GET', '/v1/requests', { key: 'rota-only' })).body;
    expect(rotaKey.some((r: { kind: string }) => r.kind === 'sickness')).toBe(false);
    expect((await k.call('POST', `/v1/requests/${sick.body.id}/approve`, { key: 'rota-only' }, {})).status).toBe(404);

    // Staff cannot withdraw a sickness report; a manager acknowledges it.
    expect((await k.call('POST', `/v1/staff/requests/${sick.body.id}/cancel`, ben)).status).toBe(409);
    expect((await k.call('POST', `/v1/requests/${sick.body.id}/approve`, KEY, {})).status).toBe(200);

    const up = await k.app.inject({ method: 'POST', url: '/v1/staff/fit-note?fileName=note.pdf', headers: { cookie: ben, 'content-type': 'application/pdf' }, payload: pdf });
    expect(up.statusCode).toBe(201);
    expect(up.json().fitNoteFor.uploaded).toBe(1);
    const e = (await k.call('GET', '/v1/employees/mar-12', KEY)).body;
    const absence = e.absences.at(-1);
    expect(absence.reportedBy).toBe('staff');
    const file = await k.app.inject({ method: 'GET', url: `/v1/employees/mar-12/absences/${absence.id}/fit-notes/${absence.fitNotes[0].id}`, headers: { authorization: 'Bearer manager' } });
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(pdf)).toBe(true);

    expect((await k.call('POST', '/v1/staff/sick/back', ben, { lastDayOff: addDays(today, -1) })).body.error).toBe('invalid_dates');
    expect((await k.call('POST', '/v1/staff/sick/back', ben, { lastDayOff: tomorrow })).status).toBe(200);
    expect((await me(ben)).sick).toBeNull();
  });
});

describe('managers\' morning email', () => {
  afterEach(() => vi.unstubAllGlobals());

  async function waiting() {
    const { k, join, me } = await boot();
    const ben = await join('mar-12');
    const zara = await join('mar-15');
    const lee = await join('shd-5');
    const today = (await me(ben)).today;
    await k.call('POST', '/v1/staff/requests/holiday', ben, { from: addDays(today, 20), to: addDays(today, 21), note: 'Cousin visiting' });
    await k.call('POST', '/v1/staff/sick', zara, { note: 'Flu' });
    await k.call('POST', '/v1/staff/requests/holiday', lee, { from: addDays(today, 20), to: addDays(today, 20) });
    await k.call('POST', '/v1/open-shifts', KEY, { siteId: 'mar', roleId: 'bar', date: addDays(today, 2), startMinute: 1080, endMinute: 1380 });
    // An open swap nobody has agreed to is not the manager's yet.
    const day = await clearDay(k, today);
    const id = await postAndPublish(k, bar('mar-12', day));
    await k.call('POST', '/v1/staff/swaps', ben, { shiftId: id });
    return { k, today };
  }

  it('tells each manager only what is theirs to decide, with no reasons', async () => {
    const { k, today } = await waiting();
    const org = await k.store.load('demo');
    const digests = managerDigests(org, today);
    const of = (email: string) => digests.find((d) => d.user.email === email);
    const priya = of('priya@marylebonegroup.example')!;
    const text = JSON.stringify(priya.sections);
    expect(text).toMatch(/Ben Ford, Marylebone: holiday/);
    expect(text).toMatch(/Zara Ahmed, Marylebone: off sick since/);
    expect(text).toMatch(/nobody has claimed it yet/);
    expect(text).not.toMatch(/Leo Martins|Cousin visiting|Flu|Bartender at Marylebone to/);
    expect(priya.count).toBe(3);
    // Hannah runs Shoreditch: only Leo's holiday.
    expect(JSON.stringify(of('hannah@marylebonegroup.example')!.sections)).toMatch(/Leo Martins/);
    // A floor supervisor decides none of it, so gets nothing.
    expect(of('grace@marylebonegroup.example')).toBeUndefined();
    // Suspended and invited people get nothing.
    expect(of('chris@marylebonegroup.example')).toBeUndefined();
  });

  it('can be turned off by each person, and shows them what it would say', async () => {
    const { k, today } = await waiting();
    const priya = await k.as('priya@marylebonegroup.example');
    const preview = await k.call('GET', '/v1/requests/digest', priya);
    expect(preview.body).toMatchObject({ on: true, email: 'priya@marylebonegroup.example', count: 3 });
    expect((await k.call('PUT', '/v1/requests/digest', priya, { on: false })).body).toEqual({ on: false });
    const org = await k.store.load('demo');
    expect(managerDigests(org, today).some((d) => d.user.email === 'priya@marylebonegroup.example')).toBe(false);
    expect((await k.call('GET', '/v1/requests/digest', priya)).body.on).toBe(false);
    expect((await k.call('GET', '/v1/requests/digest', KEY)).status).toBe(403);
  });

  it('goes once a day, through the organisation\'s own Resend, and not without it', async () => {
    const { k, today } = await waiting();
    const sent: { to: string[]; subject: string; text: string }[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit = {}) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ id: `m_${sent.length}` }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    expect(await sendManagerDigests(k.store, today)).toEqual({ orgs: 0, sent: 0 });
    await k.store.setSetting(emailSetting('demo'), JSON.stringify({ resendApiKey: 're_test', from: 'Preshift <rota@ws.example>', appUrl: 'https://rota.ws.example' }));
    const first = await sendManagerDigests(k.store, today);
    expect(first.orgs).toBe(1);
    expect(first.sent).toBe(sent.length);
    const priya = sent.find((m) => m.to[0] === 'priya@marylebonegroup.example')!;
    expect(priya.subject).toBe('Staff requests: 3 waiting for you');
    expect(priya.text).toMatch(/https:\/\/rota\.ws\.example\/app\/\?view=requests/);
    expect(priya.text).not.toMatch(/Flu|Cousin/);
    expect(await sendManagerDigests(k.store, today)).toEqual({ orgs: 0, sent: 0 });
  });
});
