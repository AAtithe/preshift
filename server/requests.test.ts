import { describe, expect, it } from 'vitest';
import { addDays, weekStart } from '../src/engine/time';
import { kit, type Kit } from './testkit';

const PASSWORD = 'pint of best bitter';
const KEY = { key: 'manager' };

async function boot() {
  const k = await kit({ keys: [{ key: 'manager', orgId: 'demo', name: 'GM', scopes: ['*'] }] });
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

/** A clear day for the tests' own shifts: next-but-one week, away from the seeded rota. */
async function clearDay(k: Kit, today: string, offset = 9) {
  const day = addDays(weekStart(today), 7 + offset);
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
    const posted = await k.call('POST', '/v1/open-shifts', KEY, { siteId: 'mar', roleId: 'bar', date: day, startMinute: 18 * 60, endMinute: 23 * 60, note: 'Private party' });
    expect(posted.status).toBe(201);
    expect(posted.body.eligible).toContain('Ben Ford');
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
