import { describe, expect, it } from 'vitest';
import { addDays, londonParts, weekStart } from '../src/engine/time';
import { buildApp } from './app';
import { MemoryStore } from './store';
import { holdClock } from './testClock';

holdClock();

async function setup() {
  const { app, ctx } = await buildApp({
    apiKeys: [{ key: 'admin', orgId: 'demo', name: 'Admin', scopes: ['*' as const] }],
    store: new MemoryStore(['demo'], '2026-10-21'),
    autoDispatch: false,
  });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: { authorization: 'Bearer admin', ...(body ? { 'content-type': 'application/json' } : {}) },
      payload: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.statusCode, body: res.json() };
  };
  const org = await ctx.store.load('demo');
  org.state.sites = org.state.sites.map((s) =>
    s.id === 'mar'
      ? { ...s, areas: [{ id: 'foh', name: 'Front of house', roleIds: ['server'] }, { id: 'bakery', name: 'Bakery', roleIds: [] }] }
      : s,
  );
  return { call, org };
}

describe('shift areas', () => {
  const ahead = weekStart(addDays(londonParts(new Date()).date, 14));
  const shift = { employeeId: 'mar-2', roleId: 'chef', siteId: 'mar', date: ahead, startMinute: 600, endMinute: 960, breakMinutes: 0 };

  it('keeps an area of the shift’s own site, and refuses one that is not', async () => {
    const { call } = await setup();
    const placed = await call('POST', '/v1/shifts', { ...shift, areaId: 'bakery' });
    expect(placed.status).toBe(201);
    expect(placed.body.shift.areaId).toBe('bakery');
    const wrong = await call('POST', '/v1/shifts', { ...shift, date: addDays(ahead, 1), areaId: 'terrace' });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error).toBe('invalid_area');
    // An empty area is the role's own, kept as none.
    const plain = await call('POST', '/v1/shifts', { ...shift, date: addDays(ahead, 2), areaId: '' });
    expect(plain.status).toBe(201);
    expect(plain.body.shift.areaId).toBeUndefined();
  });

  it('clears an area on request, and drops it when the shift moves to another site', async () => {
    const { call } = await setup();
    const { body } = await call('POST', '/v1/shifts', { ...shift, areaId: 'bakery' });
    const id = body.shift.id;
    expect((await call('PATCH', `/v1/shifts/${id}`, { startMinute: 660 })).body.shift.areaId).toBe('bakery');
    expect((await call('PATCH', `/v1/shifts/${id}`, { areaId: '' })).body.shift.areaId).toBeUndefined();
    await call('PATCH', `/v1/shifts/${id}`, { areaId: 'bakery' });
    const moved = await call('PATCH', `/v1/shifts/${id}`, { siteId: 'fitz' });
    expect(moved.status).toBe(200);
    expect(moved.body.shift.areaId).toBeUndefined();
  });

  it('carries areas through a whole week saved in one go', async () => {
    const { call, org } = await setup();
    const res = await call('PUT', '/v1/rota/week', { siteId: 'mar', weekStart: ahead, shifts: [{ ...shift, id: 'w1', areaId: 'bakery' }] });
    expect(res.status).toBe(200);
    expect(org.state.shifts.find((s) => s.id === 'w1')?.areaId).toBe('bakery');
  });
});
