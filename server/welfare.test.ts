import { describe, expect, it } from 'vitest';
import { addDays } from '../src/engine/time';
import { MemoryStore } from './store';
import { enrol, kit, TODAY } from './testkit';

const OWNER = { email: 'owner@ws.example', password: 'correct horse battery' };
const NOW = new Date(`${TODAY}T09:00:00Z`);
const person = (key: string, userId: string) => ({ key, orgId: 'demo', name: `${key} key`, scopes: ['*'] as ['*'], userId, mfa: true });

/** A fake Hospitality Rewards: checks the key, and keeps every request made to it. */
function fakeRewards(opts: { key?: string; failAwards?: boolean } = {}) {
  const calls: { method: string; url: string; headers: Record<string, string>; body?: any }[] = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const headers = init.headers as Record<string, string>;
    calls.push({ method: init.method ?? 'GET', url, headers, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (headers.authorization !== `Bearer ${opts.key ?? 'hr_live_good_key_9876'}`) return json(401, { error: 'unauthorised' });
    if (url.endsWith('/account')) return json(200, { name: 'West End Dining Group' });
    if (url.endsWith('/members') || url.endsWith('/members/remove')) return json(200, {});
    if (url.endsWith('/recognitions')) return opts.failAwards ? json(503, { error: 'down' }) : json(201, { id: `hr-${headers['idempotency-key']}` });
    return json(404, {});
  }) as typeof fetch;
  return { impl, calls };
}

/** The demo group, its owner signed in with an authenticator, and personal keys for a GM and a supervisor. */
async function boot(fetchImpl: typeof fetch = fakeRewards().impl) {
  const store = new MemoryStore(['demo'], TODAY);
  const k = await kit({
    store,
    accounts: false,
    keys: [person('gm', 'usr_gm_mar'), person('sup', 'usr_sup'), person('gmshd', 'usr_gm_shd'), { key: 'system', orgId: 'demo', name: 'System', scopes: ['*'] }],
    fetch: fetchImpl,
    now: () => NOW,
  });
  const setup = await k.form('/auth/setup', { email: OWNER.email, password: OWNER.password, confirm: OWNER.password, next: '/app/' });
  const cookie = (await enrol(k, setup.cookie!)).cookie;
  const as = (who: 'owner' | 'gm' | 'sup' | 'gmshd') => async (method: string, url: string, body?: unknown) => {
    const res = await k.call(method, url, who === 'owner' ? cookie : { key: who }, body);
    return { status: res.status, body: res.body, raw: res.raw };
  };
  /** A member of staff signed in to the staff app on their phone. */
  const phone = async (employeeId: string, email: string) => {
    const link = await k.call('POST', `/v1/staff-logins/${employeeId}/invite`, { key: 'system' });
    const fragment = Object.fromEntries(new URLSearchParams(new URL(link.body.path, 'https://x').hash.slice(1)));
    const joined = await k.call('POST', '/v1/staff/join', null, { ...fragment, email, password: 'a long staff password' });
    return async (method: string, url: string, body?: unknown) => {
      const res = await k.call(method, url, joined.cookie!, body);
      return { status: res.status, body: res.body };
    };
  };
  return { store, owner: as('owner'), gm: as('gm'), sup: as('sup'), gmShd: as('gmshd'), phone, org: () => store.load('demo') };
}

describe('the wellbeing screen', () => {
  it('shows each manager their own sites only, and nothing to someone who neither manages the team nor reads HR', async () => {
    const t = await boot();
    const all = await t.owner('GET', '/v1/welfare');
    expect(all.status).toBe(200);
    expect(all.body.sites.map((s: { siteId: string }) => s.siteId).sort()).toEqual(['fitz', 'mar', 'shd']);
    const mar = await t.gm('GET', '/v1/welfare');
    expect(mar.body.sites.map((s: { siteId: string }) => s.siteId)).toEqual(['mar']);
    const org = await t.org();
    const home = new Map(org.state.employees.map((e) => [e.id, e.siteId]));
    expect(mar.body.people.every((p: { employeeId: string }) => home.get(p.employeeId) === 'mar')).toBe(true);
    expect((await t.sup('GET', '/v1/welfare')).status).toBe(403);
  });

  it('flags someone who asked for a chat, and lets their manager mark it held', async () => {
    const t = await boot();
    const org = await t.org();
    org.welfare = { recognitions: [], pulses: [], pulseAnswered: [], chats: [{ id: 'chat_1', employeeId: 'mar-3', siteId: 'mar', at: NOW.toISOString(), status: 'open' }], rewardsOptOut: [], rewardsEnrolled: [] };
    const list = await t.gm('GET', '/v1/welfare');
    expect(list.body.people[0]).toMatchObject({ employeeId: 'mar-3', level: 'act' });
    expect(list.body.chats).toHaveLength(1);
    // Another site's GM cannot see or close it.
    expect((await t.gmShd('GET', '/v1/welfare')).body.chats).toEqual([]);
    expect((await t.gmShd('POST', '/v1/welfare/chats/chat_1/done')).status).toBe(403);
    expect((await t.gm('POST', '/v1/welfare/chats/chat_1/done')).body).toMatchObject({ status: 'done', doneBy: 'Priya Shah' });
  });

  it('shows a week of the pulse only once five people have answered', async () => {
    const t = await boot();
    const org = await t.org();
    const week = '2026-10-19';
    org.welfare = { recognitions: [], pulses: Array.from({ length: 4 }, () => ({ siteId: 'mar', week, score: 4 as const })), pulseAnswered: [], chats: [], rewardsOptOut: [], rewardsEnrolled: [] };
    const last = (r: { body: { pulse: { average: number | null; responses: number }[] } }) => r.body.pulse[r.body.pulse.length - 1];
    expect(last(await t.gm('GET', '/v1/welfare'))).toEqual({ week, responses: 4, average: null });
    org.welfare.pulses.push({ siteId: 'mar', week, score: 2 });
    expect(last(await t.gm('GET', '/v1/welfare'))).toEqual({ week, responses: 5, average: 3.6 });
  });
});

describe('recognition', () => {
  const thanks = { employeeId: 'mar-3', category: 'guest', message: 'Rescued a birthday table when the cake went missing.', points: 100 };

  it('lets a GM thank their own team, never themselves, and only within the month’s budget', async () => {
    const t = await boot();
    const given = await t.gm('POST', '/v1/welfare/recognitions', thanks);
    expect(given.status).toBe(201);
    expect(given.body).toMatchObject({ by: 'Priya Shah', points: 100, siteId: 'mar', rewards: { status: 'not-connected' } });
    // Priya is mar-1 on the rota.
    expect((await t.gm('POST', '/v1/welfare/recognitions', { ...thanks, employeeId: 'mar-1' })).body.message).toMatch(/themselves/);
    expect((await t.gmShd('POST', '/v1/welfare/recognitions', thanks)).status).toBe(403);
    expect((await t.sup('POST', '/v1/welfare/recognitions', thanks)).status).toBe(403);
    for (let i = 0; i < 4; i++) await t.gm('POST', '/v1/welfare/recognitions', thanks);
    const over = await t.gm('POST', '/v1/welfare/recognitions', thanks);
    expect(over.status).toBe(422);
    expect(over.body.message).toMatch(/500 points this month \(500 given\)/);
    // A thank you on its own is always allowed.
    expect((await t.gm('POST', '/v1/welfare/recognitions', { ...thanks, points: 0 })).body.rewards.status).toBe('none');
  });

  it('keeps the policy to whoever manages settings, and checks it', async () => {
    const t = await boot();
    expect((await t.gm('PUT', '/v1/welfare/policy', { pointsPerSiteMonth: 1000 })).status).toBe(403);
    expect((await t.owner('PUT', '/v1/welfare/policy', { lateFinishMinute: 600 })).status).toBe(422);
    const saved = await t.owner('PUT', '/v1/welfare/policy', { pointsPerSiteMonth: 1000, travelHomeAllowance: 12, supportLine: { name: 'Hospitality Action EAP', url: 'https://www.hospitalityaction.org.uk' } });
    expect(saved.body).toMatchObject({ pointsPerSiteMonth: 1000, travelHomeAllowance: 12, mealFromHours: 6, supportLine: { name: 'Hospitality Action EAP' } });
    expect((await t.owner('PUT', '/v1/welfare/policy', { supportLine: null })).body.supportLine).toBeUndefined();
  });
});

describe('Hospitality Rewards', () => {
  it('checks the key before saving, sends nobody until a sync, and sends no pay, age or health', async () => {
    const fake = fakeRewards();
    const t = await boot(fake.impl);
    expect((await t.gm('PUT', '/v1/integrations/rewards', { baseUrl: 'https://api.example-rewards.test/v1', apiKey: 'hr_live_good_key_9876' })).status).toBe(403);
    const refused = await t.owner('PUT', '/v1/integrations/rewards', { baseUrl: 'https://api.example-rewards.test/v1', apiKey: 'typo' });
    expect(refused.status).toBe(422);
    expect((await t.owner('GET', '/v1/integrations/rewards')).body.connection).toBeNull();
    expect((await t.owner('PUT', '/v1/integrations/rewards', { baseUrl: 'http://insecure.test', apiKey: 'x' })).body.error).toBe('base_url_required');

    const connected = await t.owner('PUT', '/v1/integrations/rewards', { baseUrl: 'https://api.example-rewards.test/v1', apiKey: 'hr_live_good_key_9876' });
    expect(connected.body).toMatchObject({ connection: { accountName: 'West End Dining Group', environment: 'production' }, keyEndsWith: '9876' });
    expect(fake.calls.filter((c) => c.url.includes('/members'))).toEqual([]);

    const sync = await t.owner('POST', '/v1/integrations/rewards/sync');
    expect(sync.body).toMatchObject({ ok: true, removed: 0 });
    const sent = fake.calls.filter((c) => c.url.endsWith('/members')).flatMap((c) => c.body.members);
    expect(sent.length).toBe(sync.body.enrolled);
    expect(sent.length).toBeGreaterThan(5);
    for (const m of sent) expect(Object.keys(m).every((k) => ['ref', 'firstName', 'lastName', 'email', 'site', 'company', 'startDate'].includes(k))).toBe(true);
    // The key is never handed back, only its end.
    expect(JSON.stringify((await t.owner('GET', '/v1/integrations/rewards')).body)).not.toContain('hr_live_good_key_9876');
  });

  it('credits points once, by recognition id, and removes leavers and people who opted out', async () => {
    const fake = fakeRewards();
    const t = await boot(fake.impl);
    await t.owner('PUT', '/v1/integrations/rewards', { baseUrl: 'https://api.example-rewards.test/v1', apiKey: 'hr_live_good_key_9876' });
    await t.owner('POST', '/v1/integrations/rewards/sync');
    const given = await t.gm('POST', '/v1/welfare/recognitions', { employeeId: 'mar-3', category: 'team', message: 'Covered the pass on a night two chefs went home sick.', points: 80 });
    expect(given.body.rewards).toMatchObject({ status: 'sent', ref: `hr-${given.body.id}` });
    const award = fake.calls.find((c) => c.url.endsWith('/recognitions'))!;
    expect(award.headers['idempotency-key']).toBe(given.body.id);
    expect(award.body).toMatchObject({ memberRef: 'mar-3', points: 80, reason: 'Team player' });

    const org = await t.org();
    org.welfare!.rewardsOptOut.push('mar-4');
    const leaver = org.state.employees.find((e) => e.id === 'mar-5')!;
    leaver.leaveDate = addDays(TODAY, -1);
    const again = await t.owner('POST', '/v1/integrations/rewards/sync');
    expect(again.body).toMatchObject({ ok: true, removed: 2, awarded: 0 });
    expect(fake.calls.find((c) => c.url.endsWith('/members/remove'))!.body.refs.sort()).toEqual(['mar-4', 'mar-5']);
  });

  it('keeps points waiting when the platform is down, and sends them on the next sync', async () => {
    const down = fakeRewards({ failAwards: true });
    const t = await boot(down.impl);
    await t.owner('PUT', '/v1/integrations/rewards', { baseUrl: 'https://api.example-rewards.test/v1', apiKey: 'hr_live_good_key_9876' });
    await t.owner('POST', '/v1/integrations/rewards/sync');
    const given = await t.gm('POST', '/v1/welfare/recognitions', { employeeId: 'mar-3', category: 'guest', message: 'Calm and kind with a guest having a panic attack.', points: 50 });
    expect(given.status).toBe(201);
    expect(given.body.rewards.status).toBe('failed');
    expect((await t.owner('GET', '/v1/integrations/rewards')).body.waiting).toBe(1);
  });

  it('gives a settings person the eligibility file, and nobody else', async () => {
    const t = await boot();
    expect((await t.gm('GET', '/v1/integrations/rewards/eligibility.csv')).status).toBe(403);
    const file = await t.owner('GET', '/v1/integrations/rewards/eligibility.csv');
    expect(file.status).toBe(200);
    expect(file.raw.split('\n')[0]).toBe('Employee reference,First name,Last name,Work email,Site,Company,Start date');
    expect((await t.org()).audit.some((a) => a.action === 'rewards.eligibility_exported')).toBe(true);
  });

  it('connects to the simulator where payroll is simulated', async () => {
    const t = await boot();
    const sim = await t.owner('PUT', '/v1/integrations/rewards', { environment: 'simulator' });
    expect(sim.body.connection.accountName).toBe('Simulated Hospitality Rewards account');
    expect((await t.owner('POST', '/v1/integrations/rewards/sync')).body.ok).toBe(true);
  });
});

describe('the staff app', () => {
  it('takes one pulse answer a week, stored without who gave it, and a chat request with their name', async () => {
    const t = await boot();
    const me = await t.phone('mar-3', 'ama@example.com');
    const first = await me('GET', '/v1/staff/me');
    expect(first.body.welfare).toMatchObject({ pulse: { answered: false }, chatOpen: false, supportLine: null });
    const answered = await me('POST', '/v1/staff/pulse', { score: 2, chat: true });
    expect(answered.body.welfare).toMatchObject({ pulse: { answered: true }, chatOpen: true });
    expect((await me('POST', '/v1/staff/pulse', { score: 5 })).status).toBe(409);
    const org = await t.org();
    expect(org.welfare!.pulses).toEqual([{ siteId: 'mar', week: answered.body.welfare.pulse.week, score: 2 }]);
    expect(JSON.stringify(org.welfare!.pulses) + JSON.stringify(org.welfare!.pulseAnswered)).not.toContain('mar-3');
    expect(org.welfare!.chats).toMatchObject([{ employeeId: 'mar-3', siteId: 'mar', status: 'open' }]);
    // Their manager sees the chat, never the score of four people's answers.
    const gm = await t.gm('GET', '/v1/welfare');
    expect(gm.body.chats).toHaveLength(1);
    expect(gm.body.pulse[gm.body.pulse.length - 1].average).toBeNull();
  });

  it('lets a person opt out of Hospitality Rewards, and shows thanks they have been given', async () => {
    const t = await boot();
    const me = await t.phone('mar-3', 'ama@example.com');
    await t.gm('POST', '/v1/welfare/recognitions', { employeeId: 'mar-3', category: 'standards', message: 'Spotted the allergen label error before service.', points: 40 });
    const view = await me('GET', '/v1/staff/me');
    expect(view.body.welfare.recognitions).toMatchObject([{ label: 'Standards and safety', points: 40, by: 'Priya Shah' }]);
    const out = await me('POST', '/v1/staff/rewards', { optOut: true });
    expect(out.body.welfare.rewards.optedOut).toBe(true);
    expect((await t.org()).welfare!.rewardsOptOut).toEqual(['mar-3']);
    expect((await me('POST', '/v1/staff/rewards', { optOut: false })).body.welfare.rewards.optedOut).toBe(false);
  });
});
