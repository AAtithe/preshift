import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { MemoryStore } from './store';
import { holdClock } from './testClock';

holdClock();

const TODAY = '2026-10-21';
const NEXT = '2026-10-26';
const KEYS = [
  { key: 'admin', orgId: 'demo', name: 'Admin', scopes: ['*' as const] },
  { key: 'gm', orgId: 'demo', name: 'GM', scopes: ['rota:read' as const, 'rota:write' as const] },
  { key: 'ws', orgId: 'demo', name: 'WS lead', scopes: ['rota:read' as const, 'rota:write' as const, 'programme:lead' as const] },
];

async function setup(store = new MemoryStore(['demo'], TODAY)) {
  const { app } = await buildApp({ apiKeys: KEYS, store, provider: new TeamPaySimulator(), autoDispatch: false, now: () => new Date(`${TODAY}T10:00:00Z`) });
  const call = async (method: string, url: string, body?: unknown, key = 'admin') => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      payload: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  };
  return { app, call, store };
}

describe('forecast model and accuracy', () => {
  it('models next week from till history, keeps overrides, and scores last week', async () => {
    const { call } = await setup();
    const run = await call('POST', '/v1/forecast/model', { siteId: 'mar', weekStart: NEXT });
    expect(run.status).toBe(200);
    expect(run.body.rows).toBeGreaterThan(50);
    expect(run.body.skipped).toEqual([]);

    const over = await call('PATCH', '/v1/forecast/hour', { siteId: 'mar', date: NEXT, hour: 19, sales: 2000, covers: 48, reason: 'Private party' }, 'gm');
    expect(over.body).toMatchObject({ sales: 2000, overriddenBy: 'GM', overrideReason: 'Private party' });
    expect(over.body.modelSales).toBeLessThan(2000);
    // Running the model again keeps the GM's figure.
    await call('POST', '/v1/forecast/model', { siteId: 'mar', weekStart: NEXT });
    const rows = (await call('GET', `/v1/forecast?siteId=mar&from=${NEXT}&to=${NEXT}`)).body;
    expect(rows.find((r: { hour: number }) => r.hour === 19).sales).toBe(2000);

    const acc = await call('GET', `/v1/forecast/accuracy?siteId=mar&from=2026-10-12&to=2026-10-18`);
    expect(acc.body.measuredDays).toBe(7);
    expect(acc.body.wape).toBeGreaterThan(0);
    expect(acc.body.wape).toBeLessThan(0.3);
    expect(acc.body.dayparts.length).toBeGreaterThan(2);
  });

  it('applies a closure to the model and the floor', async () => {
    const { call } = await setup();
    const adj = await call('POST', '/v1/forecast/adjustments', { siteId: 'mar', date: NEXT, factor: 0, reason: 'closure', note: 'Kitchen refit' });
    expect(adj.status).toBe(201);
    await call('POST', '/v1/forecast/model', { siteId: 'mar', weekStart: NEXT });
    const monday = (await call('GET', `/v1/forecast?siteId=mar&from=${NEXT}&to=${NEXT}`)).body;
    expect(monday.every((r: { sales: number }) => r.sales === 0)).toBe(true);
    await call('POST', '/v1/rota/build', { siteId: 'mar', weekStart: NEXT });
    const shifts = (await call('GET', `/v1/shifts?siteId=mar&from=${NEXT}&to=${NEXT}`)).body;
    expect(shifts).toEqual([]);
    expect((await call('DELETE', `/v1/forecast/adjustments/${adj.body.id}`)).status).toBe(204);
  });

  it('refuses a zero factor that is not a closure, so a blank field never closes the floor', async () => {
    const { call } = await setup();
    const res = await call('POST', '/v1/forecast/adjustments', { siteId: 'mar', date: NEXT, factor: 0, reason: 'event' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('invalid_factor');
  });

  it('keeps the model under a feed and marks a changed hour as an override', async () => {
    const { call } = await setup();
    await call('POST', '/v1/forecast/model', { siteId: 'mar', weekStart: NEXT });
    const [row] = (await call('GET', `/v1/forecast?siteId=mar&from=${NEXT}&to=${NEXT}`)).body.filter((r: { hour: number }) => r.hour === 19);
    await call('PUT', '/v1/forecast', { rows: [{ siteId: 'mar', date: NEXT, hour: 19, sales: row.sales + 300, covers: row.covers + 7 }] }, 'gm');
    const [after] = (await call('GET', `/v1/forecast?siteId=mar&from=${NEXT}&to=${NEXT}`)).body.filter((r: { hour: number }) => r.hour === 19);
    expect(after).toMatchObject({ sales: row.sales + 300, modelSales: row.modelSales, overriddenBy: 'GM' });
  });

  it('takes till actuals in', async () => {
    const { call } = await setup();
    const put = await call('PUT', '/v1/actuals', { rows: [{ siteId: 'mar', date: TODAY, hour: 12, sales: 321, covers: 8 }] });
    expect(put.body.upserted).toBe(1);
    const got = await call('GET', `/v1/actuals?siteId=mar&from=${TODAY}&to=${TODAY}`);
    expect(got.body).toEqual([{ siteId: 'mar', date: TODAY, hour: 12, sales: 321, covers: 8 }]);
  });
});

describe('weekly moves', () => {
  it('offers priced moves, applies one exactly, refuses a stale one, and records a dismissal', async () => {
    const { call } = await setup();
    await call('POST', '/v1/rota/build', { siteId: 'mar', weekStart: NEXT });
    // Pad a shift so there is something to trim.
    const shifts = (await call('GET', `/v1/shifts?siteId=mar&from=${NEXT}&to=${NEXT}`)).body;
    const target = shifts.find((s: { roleId: string }) => s.roleId === 'server');
    await call('PATCH', `/v1/shifts/${target.id}`, { startMinute: 11 * 60, endMinute: 23 * 60, breakMinutes: 30 });

    const offered = await call('POST', '/v1/coach/moves', { siteId: 'mar', weekStart: NEXT }, 'gm');
    expect(offered.status).toBe(200);
    expect(offered.body.moves.length).toBeGreaterThan(0);
    expect(offered.body.moves.length).toBeLessThanOrEqual(3);
    const [first, second] = offered.body.moves;
    expect(first.saving).toBeGreaterThan(0);
    expect(first.title).toMatch(/save £\d+, labour \d+\.\d%\.$/);

    const applied = await call('POST', '/v1/coach/apply', { moveId: first.id }, 'gm');
    expect(applied.body).toMatchObject({ status: 'taken', decidedBy: 'GM' });
    const after = (await call('GET', `/v1/shifts?siteId=mar&from=${NEXT}&to=2026-11-01`)).body;
    const changed = after.find((s: { id: string }) => s.id === first.shiftId);
    if (first.after) expect(changed).toMatchObject({ startMinute: first.after.startMinute, endMinute: first.after.endMinute, employeeId: first.after.employeeId });
    else expect(changed).toBeUndefined();
    expect((await call('POST', '/v1/coach/apply', { moveId: first.id })).status).toBe(404);

    if (second) {
      // Change the shift underneath the second move: applying it now would be stale.
      const s = after.find((x: { id: string }) => x.id === second.shiftId);
      if (s) {
        await call('PATCH', `/v1/shifts/${s.id}`, { breakMinutes: s.breakMinutes + 5 });
        expect((await call('POST', '/v1/coach/apply', { moveId: second.id })).body.error).toBe('stale_move');
      }
      const dismissed = await call('POST', '/v1/coach/dismiss', { moveId: second.id, reason: 'Function booked' });
      expect(dismissed.body).toMatchObject({ status: 'dismissed', reason: 'Function booked' });
    }
    const history = await call('GET', `/v1/coach/history?siteId=mar&from=${NEXT}&to=${NEXT}`);
    expect(history.body.find((m: { id: string }) => m.id === first.id)).toMatchObject({ status: 'taken', realisedSaving: null });

    // Offering again keeps the decided moves and only replaces what is still on offer.
    const again = await call('POST', '/v1/coach/moves', { siteId: 'mar', weekStart: NEXT });
    expect(again.body.records.filter((m: { status: string }) => m.status === 'taken')).toHaveLength(1);
  });
});

describe('taking a move safely', () => {
  it('refuses a swap when the person taking it has been given another shift that day since', async () => {
    const { call } = await setup();
    // Ann (£16) on a long Tuesday; two cheaper servers are free.
    await call('POST', '/v1/rota/build', { siteId: 'mar', weekStart: NEXT });
    const offered = await call('POST', '/v1/coach/moves', { siteId: 'mar', weekStart: NEXT });
    const swap = offered.body.moves.find((m: { kind: string }) => m.kind === 'swap');
    expect(swap).toBeDefined();
    const taker = swap.after.employeeId;
    const made = await call('POST', '/v1/shifts', { employeeId: taker, roleId: swap.after.roleId, siteId: 'mar', date: swap.date, startMinute: swap.after.startMinute, endMinute: swap.after.startMinute + 120, breakMinutes: 0 });
    expect(made.status).toBe(201);
    const res = await call('POST', '/v1/coach/apply', { moveId: swap.id });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('compliance_block');
  });
});

describe('scorecard and programme', () => {
  it('records the publish time and scores finished weeks', async () => {
    const { call } = await setup();
    await call('POST', '/v1/rota/build', { siteId: 'mar', weekStart: NEXT });
    await call('POST', '/v1/rota/publish', { siteId: 'mar', weekStart: NEXT });
    const card = await call('GET', '/v1/scorecard?siteId=mar&weeks=4');
    expect(card.status).toBe(200);
    expect(card.body.weeks).toHaveLength(4);
    expect(card.body.maturity.level).toBe(0);
    expect(card.body.maturity.next).toMatch(/^Publish each week/);
    expect(card.body.weeks.at(-1).forecastWape).toBeGreaterThan(0);
  });

  it('scores every site the caller can see, ranked, and never a week still being worked', async () => {
    const { call } = await setup();
    const all = await call('GET', '/v1/scorecards?weeks=3');
    expect(all.status).toBe(200);
    expect(all.body.cards.length).toBeGreaterThan(1);
    expect(all.body.league.map((r: { rank: number }) => r.rank)).toEqual(all.body.cards.map((_: unknown, i: number) => i + 1));
    expect(all.body.cards[0].weeks.map((w: { weekStart: string }) => w.weekStart)).toEqual(['2026-09-28', '2026-10-05', '2026-10-12']);
    // Asking to end on this week or later still stops at last week.
    const ahead = await call('GET', `/v1/scorecards?weeks=1&endWeek=${NEXT}`);
    expect(ahead.body.cards[0].weeks.map((w: { weekStart: string }) => w.weekStart)).toEqual(['2026-10-12']);
    const earlier = await call('GET', '/v1/scorecards?weeks=1&endWeek=2026-10-01');
    expect(earlier.body.cards[0].weeks.map((w: { weekStart: string }) => w.weekStart)).toEqual(['2026-09-28']);
  });

  it('runs a site through the programme with sign-offs for the WS lead only', async () => {
    const { call } = await setup();
    // Neither the GM nor the operator's own full-access key can set the terms of the fee.
    expect((await call('PUT', '/v1/programmes/mar', { startWeek: '2026-10-05' }, 'gm')).status).toBe(403);
    expect((await call('PUT', '/v1/programmes/mar', { startWeek: '2026-10-05' }, 'admin')).status).toBe(403);
    const set = await call('PUT', '/v1/programmes/mar', { startWeek: '2026-10-07', gainSharePct: 0.2 }, 'ws');
    expect(set.body.startWeek).toBe('2026-10-05');

    // No verification before a baseline: it would lock the programme with nothing to measure against.
    expect((await call('POST', '/v1/programmes/mar/verifications', { from: '2026-10-05', to: '2026-10-18', sales: 75_000, labourCost: 21_000 }, 'ws')).body.error).toBe('no_baseline');
    expect((await call('PUT', '/v1/programmes/mar/baseline', { from: '2026-08-01', to: '2026-08-31', source: 'till_and_payroll' }, 'ws')).body.error).toBe('whole_weeks');
    const base = await call('PUT', '/v1/programmes/mar/baseline', { from: '2025-10-01', to: '2026-09-30', source: 'management_accounts', sales: 1_900_000, labourCost: 589_000 }, 'ws');
    expect(base.body.baseline).toMatchObject({ sales: 1_900_000, source: 'management_accounts', recordedBy: 'WS lead' });

    expect((await call('POST', '/v1/programmes/mar/signoffs', { milestoneId: 'on-time' }, 'ws')).body.error).toBe('not_signable');
    await call('POST', '/v1/programmes/mar/signoffs', { milestoneId: 'kickoff', note: 'Targets agreed with owner' }, 'ws');

    const list = await call('GET', '/v1/programmes');
    const [entry] = list.body;
    expect(entry.status.week).toBe(3);
    expect(entry.status.phase.id).toBe('control');
    expect(entry.status.milestones.find((m: { id: string }) => m.id === 'kickoff').done).toBe(true);
    expect(entry.status.saving.verified).toBe(false);
    expect(entry.status.saving.gainShareFee).toBeNull();

    expect((await call('POST', '/v1/programmes/mar/verifications', { from: '2026-10-05', to: '2026-10-18', sales: 75_000, labourCost: 21_000 }, 'admin')).status).toBe(403);
    // A period overlapping the baseline would never count, so it is refused rather than looking accepted.
    expect((await call('POST', '/v1/programmes/mar/verifications', { from: '2026-09-01', to: '2026-10-18', sales: 75_000, labourCost: 21_000 }, 'ws')).body.error).toBe('outside_programme');
    await call('POST', '/v1/programmes/mar/verifications', { from: '2026-10-05', to: '2026-10-18', sales: 75_000, labourCost: 21_000 }, 'ws');
    const verified = (await call('GET', '/v1/programmes')).body[0].status.saving;
    expect(verified.verified).toBe(true);
    expect(verified.points).toBeCloseTo(589_000 / 1_900_000 - 0.28, 4);
    expect(verified.gainShareFee).toBeGreaterThan(0);

    // Once a saving is signed off, the baseline, start and gain share it was measured on are fixed.
    expect((await call('PUT', '/v1/programmes/mar/baseline', { from: '2025-10-01', to: '2026-09-30', source: 'management_accounts', sales: 1_900_000, labourCost: 700_000 }, 'ws')).body.error).toBe('locked');
    expect((await call('PUT', '/v1/programmes/mar', { startWeek: '2026-10-05', gainSharePct: 0.4 }, 'ws')).body.error).toBe('locked');
  });

  it('only counts a publish that published shifts', async () => {
    const { call, store } = await setup();
    await call('POST', '/v1/rota/publish', { siteId: 'mar', weekStart: NEXT });
    expect((await store.load('demo')).publications).toEqual([]);
    await call('POST', '/v1/rota/build', { siteId: 'mar', weekStart: NEXT });
    await call('POST', '/v1/rota/publish', { siteIds: ['mar', 'fitz'], weekStart: NEXT });
    await call('POST', '/v1/rota/publish', { siteId: 'mar', weekStart: NEXT });
    await call('POST', '/v1/rota/publish', { siteId: 'mar', weekStart: NEXT });
    // First and latest only, and nothing for Fitzrovia, which had no shifts.
    expect((await store.load('demo')).publications.map((p) => p.siteId)).toEqual(['mar', 'mar']);
  });
});

describe('benchmarks', () => {
  it('shows nothing until the organisation shares, then only an anonymous cohort', async () => {
    const store = new MemoryStore(['demo', 'b', 'c', 'd'], TODAY);
    const { call } = await setup(store);
    expect((await call('GET', '/v1/benchmarks')).body).toEqual({ optedIn: false, benchmark: null, sites: [] });
    await call('PUT', '/v1/settings/benchmarking', { benchmarking: true });
    // Three other operators with three sites each share their figures.
    for (const id of ['b', 'c', 'd']) (await store.load(id)).settings.benchmarking = true;
    const res = await call('GET', '/v1/benchmarks');
    expect(res.body.optedIn).toBe(true);
    // Nine sites from three operators is under the ten-site floor.
    expect(res.body.benchmark).toMatchObject({ available: false, sites: 9, operators: 3, metrics: {} });
    expect(JSON.stringify(res.body)).not.toMatch(/"(b|c|d)"/);
    expect(res.body.sites.map((s: { siteId: string }) => s.siteId)).toEqual(['mar', 'fitz', 'shd']);
  });
});
