import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usageCostUsd } from '../src/ai/pricing';
import { MemoryStore, PgStore, type Query } from './store';
import { enrol, kit, TODAY, tokenOf } from './testkit';

const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234';
const REQUEST = { model: 'claude-opus-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] };
// One response worth exactly $1: 50,000 output tokens at $20 per million.
const DOLLAR = { input_tokens: 0, output_tokens: 50_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

afterEach(() => vi.unstubAllGlobals());

async function boot() {
  // A fresh system as main's access tests build it: the owner sets up an authenticator, then invites a GM.
  const k = await kit({ store: new MemoryStore([], TODAY), accounts: false });
  const setup = await k.form('/auth/setup', { email: 'owner@ws.example', password: 'correct horse battery', confirm: 'correct horse battery', next: '/app/' });
  const owner = (await enrol(k, setup.cookie!)).cookie;
  await k.call('PUT', '/v1/settings/claude-api-key', owner, { claudeApiKey: KEY });
  const sent = await k.call('POST', '/v1/users', owner, { email: 'gm@ws.example', name: 'gm', audience: 'operator', roleId: 'viewer' });
  if (sent.status !== 201) throw new Error(`invite: ${sent.status} ${sent.raw}`);
  const gm = (await k.form('/auth/accept', { token: tokenOf(sent.body.inviteUrl), password: 'gm password long', confirm: 'gm password long' })).cookie!;

  // Claude itself is stubbed; every call reports usage worth $1.
  const upstream = vi.fn(async () => Response.json({ id: 'm', type: 'message', content: [], stop_reason: 'end_turn', usage: DOLLAR }));
  vi.stubGlobal('fetch', upstream);
  const call = async (method: string, url: string, cookie: string, body?: unknown) => {
    const res = await k.call(method, url, cookie, body);
    return { statusCode: res.status, json: () => res.body };
  };
  const ask = (cookie: string) => call('POST', '/api/anthropic/v1/messages', cookie, REQUEST);
  return { owner, gm, call, ask, upstream };
}

describe('assistant spending', () => {
  it('prices usage at Claude Opus 5.5 list rates', () => {
    expect(usageCostUsd(DOLLAR)).toBeCloseTo(1);
    expect(usageCostUsd({ input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 })).toBeCloseTo(4 + 0.2 + 5);
  });

  it('meters every response and stops at the monthly limit for the organisation', async () => {
    const t = await boot();
    await t.call('PUT', '/v1/settings/claude-limits', t.owner, { monthlyUsd: 2, dailyPerPersonUsd: 100 });
    expect((await t.ask(t.gm)).statusCode).toBe(200);
    expect((await t.ask(t.owner)).statusCode).toBe(200);
    const blocked = await t.ask(t.gm);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toMatchObject({ type: 'spend_limit' });
    expect(blocked.json().error.message).toMatch(/this month's limit of \$2/);
    expect(t.upstream).toHaveBeenCalledTimes(2); // the blocked request never reached Claude
    const settings = (await t.call('GET', '/v1/settings', t.owner)).json();
    expect(settings.claudeSpend.monthUsd).toBeCloseTo(2);
    expect(settings.claudeSpend.todayUsd).toBeCloseTo(1);
  });

  it('stops one person at their daily limit without stopping everyone else', async () => {
    const t = await boot();
    await t.call('PUT', '/v1/settings/claude-limits', t.owner, { monthlyUsd: 100, dailyPerPersonUsd: 1 });
    expect((await t.ask(t.gm)).statusCode).toBe(200);
    const blocked = await t.ask(t.gm);
    expect(blocked.json().error.message).toMatch(/today's limit of \$1/);
    expect((await t.ask(t.owner)).statusCode).toBe(200);
  });

  it('lets only people who manage settings set the limits, and refuses nonsense', async () => {
    const t = await boot();
    expect((await t.call('PUT', '/v1/settings/claude-limits', t.gm, { monthlyUsd: 1_000 })).statusCode).toBe(403);
    expect((await t.call('PUT', '/v1/settings/claude-limits', t.owner, { monthlyUsd: -5 })).statusCode).toBe(400);
    expect((await t.call('PUT', '/v1/settings/claude-limits', t.owner, { dailyPerPersonUsd: 'lots' })).statusCode).toBe(400);
    const saved = await t.call('PUT', '/v1/settings/claude-limits', t.owner, { monthlyUsd: 75 });
    expect(saved.json().claudeLimits).toEqual({ monthlyUsd: 75, dailyPerPersonUsd: 10 });
  });
});

describe('running totals in Postgres', () => {
  it('counts every concurrent addition', async () => {
    const db = new PGlite();
    const query: Query = async (text, params) => (await db.query(text, params)).rows as Record<string, unknown>[];
    const store = new PgStore(query, ['demo'], '2026-10-21');
    await Promise.all(Array.from({ length: 20 }, () => store.addToSetting('total', 0.25)));
    expect(Number(await store.getSetting('total'))).toBeCloseTo(5);
  });
});
