import { describe, expect, it } from 'vitest';
import { weekFingerprint } from '../src/engine/rotaWeek';
import { addDays, londonParts, weekStart } from '../src/engine/time';
import type { Shift } from '../src/engine/types';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { MemoryStore } from './store';
import { kit } from './testkit';

// Relative to the real clock, because the server decides what has started from the time now.
const today = londonParts(new Date()).date;
const NEXT_WEEK = weekStart(addDays(today, 14));
const LAST_WEEK = weekStart(addDays(today, -14));

async function setup() {
  const store = new MemoryStore(['demo'], today);
  const { app } = await buildApp({
    apiKeys: [{ key: 'admin', orgId: 'demo', name: 'Admin', scopes: ['*'] }],
    store,
    provider: new TeamPaySimulator(),
    autoDispatch: false,
  });
  const put = (body: Record<string, unknown>) =>
    app.inject({ method: 'PUT', url: '/v1/rota/week', headers: { authorization: 'Bearer admin', 'content-type': 'application/json' }, payload: JSON.stringify(body) });
  const org = await store.load('demo');
  const shift = (date: string, id: string): Shift => ({
    id, employeeId: 'mar-8', roleId: 'server', siteId: 'mar', date, startMinute: 12 * 60, endMinute: 16 * 60, breakMinutes: 0,
  });
  return { put, org, shift, store };
}

describe('saving an assistant draft', () => {
  it('replaces the week in one go and records the instruction in the audit log', async () => {
    const { put, org, shift } = await setup();
    const draft = [shift(NEXT_WEEK, 'a1'), shift(addDays(NEXT_WEEK, 1), 'a2')];
    const res = await put({ siteId: 'mar', weekStart: NEXT_WEEK, shifts: draft, baseline: weekFingerprint(org.state.shifts, 'mar', NEXT_WEEK), source: 'assistant', instruction: 'Cover lunches.' });
    expect(res.statusCode).toBe(200);
    expect(org.state.shifts.filter((s) => s.siteId === 'mar').map((s) => s.id)).toEqual(['a1', 'a2']);
    expect(org.audit.at(-1)).toMatchObject({ action: 'rota.assistant_applied', detail: { instruction: 'Cover lunches.', shifts: 2 } });
  });

  it('refuses a draft if someone changed the week since it began', async () => {
    const { put, org, shift } = await setup();
    const baseline = weekFingerprint(org.state.shifts, 'mar', NEXT_WEEK);
    org.state.shifts.push(shift(NEXT_WEEK, 'someone-else')); // a colleague edits the rota meanwhile
    const res = await put({ siteId: 'mar', weekStart: NEXT_WEEK, shifts: [shift(NEXT_WEEK, 'a1')], baseline });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('rota_changed');
    expect(org.state.shifts.some((s) => s.id === 'someone-else')).toBe(true);
  });

  it('will not move or remove a shift that has been clocked or has already started', async () => {
    const { put, org, shift } = await setup();
    const clocked = shift(NEXT_WEEK, 'clocked');
    org.state.shifts.push(clocked);
    org.timeEntries.push({ id: 't1', employeeId: 'mar-8', siteId: 'mar', roleId: 'server', shiftId: 'clocked', date: NEXT_WEEK, clockIn: 715, breakMinutes: 0, status: 'open', source: 'clock' });
    const removed = await put({ siteId: 'mar', weekStart: NEXT_WEEK, shifts: [] });
    expect(removed.statusCode).toBe(409);
    expect(removed.json()).toMatchObject({ error: 'worked_shift', details: ['clocked'] });
    const moved = await put({ siteId: 'mar', weekStart: NEXT_WEEK, shifts: [{ ...clocked, startMinute: 13 * 60 }] });
    expect(moved.statusCode).toBe(409);
    // Keeping it exactly as it was is fine.
    expect((await put({ siteId: 'mar', weekStart: NEXT_WEEK, shifts: [clocked, shift(addDays(NEXT_WEEK, 2), 'new')] })).statusCode).toBe(200);

    org.state.shifts.push(shift(LAST_WEEK, 'worked-last-week'));
    expect((await put({ siteId: 'mar', weekStart: LAST_WEEK, shifts: [] })).json().error).toBe('worked_shift');
  });

  it('keeps unchanged shifts published, so one change does not unpublish the week', async () => {
    const { put, org, shift } = await setup();
    org.state.shifts.push({ ...shift(NEXT_WEEK, 'p1'), published: true }, { ...shift(addDays(NEXT_WEEK, 1), 'p2'), published: true });
    const res = await put({ siteId: 'mar', weekStart: NEXT_WEEK, shifts: [shift(NEXT_WEEK, 'p1'), { ...shift(addDays(NEXT_WEEK, 1), 'p2'), endMinute: 17 * 60 }] });
    expect(res.statusCode).toBe(200);
    const byId = Object.fromEntries(org.state.shifts.map((s) => [s.id, s.published]));
    expect(byId).toMatchObject({ p1: true, p2: false });
  });
});

describe('editing worked shifts by hand', () => {
  async function withWorked() {
    const t = await setup();
    const call = async (method: string, url: string, body?: unknown) => {
      const { app } = await buildApp({ apiKeys: [{ key: 'admin', orgId: 'demo', name: 'Admin', scopes: ['*'] }], store: t.store, provider: new TeamPaySimulator(), autoDispatch: false });
      const res = await app.inject({ method: method as 'GET', url, headers: { authorization: 'Bearer admin', ...(body ? { 'content-type': 'application/json' } : {}) }, payload: body ? JSON.stringify(body) : undefined });
      return { status: res.statusCode, body: res.body ? res.json() : undefined };
    };
    const now = londonParts(new Date());
    // Running now: started an hour ago and finishing in an hour (or the latest the day allows).
    const running: Shift = { ...t.shift(now.date, 'running'), startMinute: Math.max(0, now.minute - 60), endMinute: Math.min(1439, now.minute + 60) };
    const finished = t.shift(LAST_WEEK, 'finished');
    const clockedAhead = t.shift(NEXT_WEEK, 'clocked-ahead');
    t.org.state.shifts.push(running, finished, clockedAhead);
    t.org.timeEntries.push({ id: 'te', employeeId: 'mar-8', siteId: 'mar', roleId: 'server', shiftId: 'clocked-ahead', date: NEXT_WEEK, clockIn: 700, breakMinutes: 0, status: 'open', source: 'clock' });
    return { ...t, call, running, finished };
  }

  it('refuses deleting or reassigning a worked shift, but lets a running shift run late', async () => {
    const t = await withWorked();
    expect((await t.call('DELETE', '/v1/shifts/finished')).body.error).toBe('worked_shift');
    expect((await t.call('DELETE', '/v1/shifts/clocked-ahead')).status).toBe(409);
    expect((await t.call('PATCH', '/v1/shifts/running', { employeeId: 'mar-7' })).body.error).toBe('worked_shift');
    expect((await t.call('PATCH', '/v1/shifts/running', { startMinute: 0 })).status).toBe(409);
    expect((await t.call('PATCH', '/v1/shifts/finished', { endMinute: 17 * 60 })).status).toBe(409);
    if (t.running.endMinute < 1439) {
      expect((await t.call('PATCH', '/v1/shifts/running', { endMinute: t.running.endMinute + 1 })).status).toBe(200);
    }
  });

  it('keeps worked shifts when a week is cleared, and never builds into hours already gone', async () => {
    const t = await withWorked();
    const cleared = await t.call('POST', '/v1/rota/clear', { siteId: 'mar', weekStart: LAST_WEEK });
    expect(cleared.body).toMatchObject({ removed: 0, kept: 1 });
    await t.call('POST', '/v1/rota/build', { siteId: 'mar', weekStart: weekStart(today) });
    const now = londonParts(new Date());
    const built = t.org.state.shifts.filter((s) => s.id.startsWith('auto-'));
    expect(built.every((s) => s.date > now.date || (s.date === now.date && s.startMinute > now.minute))).toBe(true);
  });
});

describe('saving a group draft', () => {
  it('saves every site together, or none of them', async () => {
    const t = await setup();
    const { app } = await buildApp({ apiKeys: [{ key: 'admin', orgId: 'demo', name: 'Admin', scopes: ['*'] }], store: t.store, provider: new TeamPaySimulator(), autoDispatch: false });
    const putWeeks = (body: unknown) =>
      app.inject({ method: 'PUT', url: '/v1/rota/weeks', headers: { authorization: 'Bearer admin', 'content-type': 'application/json' }, payload: JSON.stringify(body) });
    const at = (siteId: string, id: string, employeeId: string): Shift => ({ ...t.shift(NEXT_WEEK, id), siteId, employeeId });
    const base = (siteId: string) => weekFingerprint(t.org.state.shifts, siteId, NEXT_WEEK);

    const marBaseline = base('mar');
    const fitzBaseline = base('fitz');
    t.org.state.shifts.push(at('fitz', 'colleague', 'fitz-2')); // someone edits Fitzrovia meanwhile
    const refused = await putWeeks({
      weekStart: NEXT_WEEK,
      sites: [
        { siteId: 'mar', baseline: marBaseline, shifts: [at('mar', 'm1', 'mar-8')] },
        { siteId: 'fitz', baseline: fitzBaseline, shifts: [at('fitz', 'f1', 'fitz-3')] },
      ],
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'rota_changed', details: { siteId: 'fitz' } });
    expect(t.org.state.shifts.some((s) => s.id === 'm1')).toBe(false); // Marylebone untouched too

    const ok = await putWeeks({
      weekStart: NEXT_WEEK,
      source: 'assistant',
      instruction: 'Share staff across both.',
      sites: [
        { siteId: 'mar', baseline: base('mar'), shifts: [at('mar', 'm1', 'mar-8')] },
        { siteId: 'fitz', baseline: base('fitz'), shifts: [at('fitz', 'f1', 'fitz-3')] },
      ],
    });
    expect(ok.statusCode).toBe(200);
    expect(t.org.state.shifts.filter((s) => s.date === NEXT_WEEK).map((s) => s.id).sort()).toEqual(['f1', 'm1']);
    expect(t.org.audit.at(-1)).toMatchObject({ action: 'rota.assistant_applied', detail: { siteIds: ['mar', 'fitz'], instruction: 'Share staff across both.' } });
    expect((await putWeeks({ weekStart: NEXT_WEEK, sites: [{ siteId: 'mar', shifts: [] }, { siteId: 'mar', shifts: [] }] })).statusCode).toBe(422);
  });
});

describe('saving a group draft under site access', () => {
  it('refuses the whole draft if it touches a site the person may not edit', async () => {
    const k = await kit();
    const priya = await k.as('priya@marylebonegroup.example'); // General Manager at Marylebone only
    const shift = (siteId: string, id: string, employeeId: string): Shift => ({
      id, employeeId, roleId: 'server', siteId, date: NEXT_WEEK, startMinute: 12 * 60, endMinute: 16 * 60, breakMinutes: 0,
    });
    const both = await k.call('PUT', '/v1/rota/weeks', priya, {
      weekStart: NEXT_WEEK,
      sites: [{ siteId: 'mar', shifts: [shift('mar', 'm1', 'mar-8')] }, { siteId: 'fitz', shifts: [shift('fitz', 'f1', 'fitz-3')] }],
    });
    expect(both.status).toBe(403);
    expect(both.body.message).toMatch(/Fitzrovia/);
    const org = await k.store.load('demo');
    expect(org.state.shifts.some((s) => s.id === 'm1')).toBe(false); // nothing saved, not even her own site
    const mine = await k.call('PUT', '/v1/rota/weeks', priya, { weekStart: NEXT_WEEK, sites: [{ siteId: 'mar', shifts: [shift('mar', 'm1', 'mar-8')] }] });
    expect(mine.status).toBe(200);
  });
});
