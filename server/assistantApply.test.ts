import { describe, expect, it } from 'vitest';
import { weekFingerprint } from '../src/engine/rotaWeek';
import { addDays, londonParts, weekStart } from '../src/engine/time';
import type { Shift } from '../src/engine/types';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { MemoryStore } from './store';

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
  return { put, org, shift };
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
