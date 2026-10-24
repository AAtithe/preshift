import { describe, expect, it } from 'vitest';
import { CORE_TABS, FEATURES, hiddenTabs, normaliseOff } from '../src/engine/features';
import { NAV_ITEMS } from '../src/ui/nav';
import { MemoryStore } from './store';
import { enrol, kit, TODAY, tokenOf } from './testkit';

async function boot() {
  const k = await kit({ store: new MemoryStore([], TODAY), accounts: false });
  const setup = await k.form('/auth/setup', { email: 'owner@ws.example', password: 'correct horse battery', confirm: 'correct horse battery', next: '/app/' });
  const owner = (await enrol(k, setup.cookie!)).cookie;
  const sent = await k.call('POST', '/v1/users', owner, { email: 'viewer@ws.example', name: 'viewer', audience: 'operator', roleId: 'viewer' });
  if (sent.status !== 201) throw new Error(`invite: ${sent.status} ${sent.raw}`);
  const viewer = (await k.form('/auth/accept', { token: tokenOf(sent.body.inviteUrl), password: 'viewer password long', confirm: 'viewer password long' })).cookie!;
  return { k, owner, viewer };
}

describe('the feature catalogue', () => {
  it('names only sections that exist, never a core one, and each section once', () => {
    const tabs = new Set<string>(NAV_ITEMS.map((t) => t.id));
    const switched = FEATURES.flatMap((f) => f.tabs);
    for (const t of switched) expect(tabs.has(t), t).toBe(true);
    for (const t of CORE_TABS) expect(tabs.has(t), t).toBe(true);
    expect(switched.filter((t) => CORE_TABS.includes(t))).toEqual([]);
    expect(new Set(switched).size).toBe(switched.length);
  });

  it('accounts for every section in the bar: switchable or always on', () => {
    const covered = new Set([...FEATURES.flatMap((f) => f.tabs), ...CORE_TABS]);
    expect(NAV_ITEMS.map((t) => t.id).filter((t) => !covered.has(t))).toEqual([]);
  });

  it('keeps known features once, in catalogue order, and reports the rest', () => {
    expect(normaliseOff(['close', 'tronc', 'close', 'rota', 'nope'])).toEqual({ off: ['tronc', 'close'], unknown: ['rota', 'nope'] });
    expect([...hiddenTabs(['hr'])].sort()).toEqual(['absence', 'cases', 'hr', 'reviews', 'training']);
  });
});

describe('switching features', () => {
  it('saves what an owner switches off, tells everyone through /v1/me, and keeps the change on record', async () => {
    const { k, owner, viewer } = await boot();
    expect((await k.call('GET', '/v1/me', viewer)).body.featuresOff).toEqual([]);

    const saved = await k.call('PUT', '/v1/settings/features', owner, { featuresOff: ['tronc', 'hr'] });
    expect(saved.status).toBe(200);
    expect(saved.body.featuresOff).toEqual(['tronc', 'hr']);
    expect((await k.call('GET', '/v1/me', viewer)).body.featuresOff).toEqual(['tronc', 'hr']);

    await k.call('PUT', '/v1/settings/features', owner, { featuresOff: ['hr', 'close'] });
    const read = (await k.call('GET', '/v1/settings/features', owner)).body;
    expect(read.featuresOff).toEqual(['hr', 'close']);
    expect(read.changes).toHaveLength(2);
    expect(read.changes[0]).toMatchObject({ on: ['tronc'], off: ['close'] });
    expect(read.changes[1]).toMatchObject({ on: [], off: ['tronc', 'hr'] });
  });

  it('records nothing when nothing changed', async () => {
    const { k, owner } = await boot();
    await k.call('PUT', '/v1/settings/features', owner, { featuresOff: ['coach'] });
    await k.call('PUT', '/v1/settings/features', owner, { featuresOff: ['coach'] });
    expect((await k.call('GET', '/v1/settings/features', owner)).body.changes).toHaveLength(1);
  });

  it('refuses a core section or an unknown feature, and anyone who does not manage settings', async () => {
    const { k, owner, viewer } = await boot();
    const core = await k.call('PUT', '/v1/settings/features', owner, { featuresOff: ['rota'] });
    expect(core.status).toBe(422);
    expect(core.body.error).toBe('unknown_feature');
    expect((await k.call('PUT', '/v1/settings/features', owner, { featuresOff: 'tronc' })).status).toBe(400);
    expect((await k.call('PUT', '/v1/settings/features', viewer, { featuresOff: [] })).status).toBe(403);
    expect((await k.call('GET', '/v1/settings/features', viewer)).status).toBe(403);
    expect((await k.call('GET', '/v1/me', viewer)).body.featuresOff).toEqual([]);
  });
});
