import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { emailSetting } from './mail';
import { MemoryStore } from './store';

const EMAIL = { resendApiKey: 're_test_abcd', from: 'WS <support@ws.example>', appUrl: 'https://rota.ws.example' };
const person = (key: string, userId: string) => ({ key, orgId: 'demo', name: `${key} key`, scopes: ['*' as const], userId, mfa: true });

let sent: { to: string[]; subject: string; text: string }[] = [];
beforeEach(() => {
  sent = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    if (url !== 'https://api.resend.com/emails') throw new Error(`unexpected fetch ${url}`);
    sent.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ id: `mail-${sent.length}` }), { status: 200 });
  });
});
afterEach(() => vi.unstubAllGlobals());

async function boot({ partnerEmail = true } = {}) {
  const store = new MemoryStore(['demo'], '2026-10-21');
  // The client partner signs in from Williams, Stanley & Co.'s own organisation, whose email tells them.
  if (partnerEmail) {
    await store.createUser({ email: 'sam.okoro@williamsstanley.example', orgId: 'ws-home', orgs: ['ws-home', 'demo'], role: 'member', salt: 's', hash: 'h', createdAt: '2026-10-01T00:00:00Z', sessionsValidFrom: 0, failedAttempts: 0, lockedUntil: 0 });
    await store.setSetting(emailSetting('ws-home'), JSON.stringify(EMAIL));
  }
  const { app } = await buildApp({
    apiKeys: [{ key: 'system', orgId: 'demo', name: 'System', scopes: ['*'] }, person('gm', 'usr_gm_mar'), person('partner', 'usr_ws_partner'), person('owner', 'usr_owner'), person('ma', 'usr_ws_ma')],
    store,
    provider: new TeamPaySimulator(),
    autoDispatch: false,
  });
  const as = (key: string) => (method: string, url: string, body?: unknown) =>
    app
      .inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${key}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, payload: body !== undefined ? JSON.stringify(body) : undefined })
      .then((r) => ({ status: r.statusCode, body: r.body ? r.json() : undefined }));
  return { store, gm: as('gm'), partner: as('partner'), owner: as('owner'), ma: as('ma'), system: as('system') };
}

const BUG = { kind: 'bug', title: 'Clock-in fails at Marylebone', detail: 'Staff get an error when they tap in on the tablet.', impact: 'clocking', steps: 'Tap a card on the entrance tablet' };

describe('support, answered by the client partner', () => {
  it('raises a blocking bug, tells the WS client partner by email, and lets only them answer and move it on', async () => {
    const t = await boot();
    const raised = await t.gm('POST', '/v1/support/tickets', BUG);
    expect(raised.status).toBe(201);
    expect(raised.body).toMatchObject({ severity: 'blocking', raisedBy: 'Priya Shah', notified: 'emailed', status: 'new' });
    expect(raised.body.responseTarget).toMatch(/4 working hours/);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(['sam.okoro@williamsstanley.example']);
    expect(sent[0].subject).toMatch(/^\[BLOCKING\] /);
    expect(sent[0].text).toContain('https://rota.ws.example/?view=support');

    // Anyone here sees the list and who answers it; a comment from the client is not the desk's reply.
    const list = await t.owner('GET', '/v1/support/tickets');
    expect(list.body).toMatchObject({ desk: ['Sam Okoro'], youAreDesk: false });
    const id = raised.body.id;
    const own = await t.owner('POST', `/v1/support/tickets/${id}/comments`, { body: 'Same at Fitzrovia.' });
    expect(own.body).toMatchObject({ status: 'new' });
    expect(own.body.firstResponseAt).toBeUndefined();

    // Only the partner moves it on. Another WS role is not the desk.
    expect((await t.owner('PATCH', `/v1/support/tickets/${id}`, { status: 'resolved' })).status).toBe(403);
    expect((await t.ma('PATCH', `/v1/support/tickets/${id}`, { status: 'resolved' })).status).toBe(403);
    expect((await t.partner('GET', '/v1/support/tickets')).body.youAreDesk).toBe(true);
    const reply = await t.partner('POST', `/v1/support/tickets/${id}/comments`, { body: 'Looking now: the reader lost its network.' });
    expect(reply.body).toMatchObject({ status: 'acknowledged', comments: [{ fromSupport: false }, { fromSupport: true, author: 'Sam Okoro' }] });
    expect(reply.body.firstResponseAt).toBeTruthy();
    const closed = await t.partner('PATCH', `/v1/support/tickets/${id}`, { status: 'resolved' });
    expect(closed.body.resolvedAt).toBeTruthy();
  });

  it('never lets a key raise, read or answer: support is people', async () => {
    const t = await boot();
    expect((await t.system('GET', '/v1/support/tickets')).status).toBe(403);
    expect((await t.system('POST', '/v1/support/tickets', BUG)).status).toBe(403);
  });

  it('saves the ticket and says so when the partner cannot be emailed', async () => {
    const t = await boot({ partnerEmail: false });
    const raised = await t.gm('POST', '/v1/support/tickets', BUG);
    expect(raised.status).toBe(201);
    expect(raised.body.notified).toBe('not_set_up');
    expect(sent).toEqual([]);
    expect((await t.gm('GET', '/v1/support/tickets')).body.tickets).toHaveLength(1);
  });

  it('asks for enough to act on, takes one vote per person on an idea, and caps a day at 30', async () => {
    const t = await boot();
    expect((await t.gm('POST', '/v1/support/tickets', { ...BUG, impact: undefined })).body.error).toBe('incomplete');
    const idea = (await t.gm('POST', '/v1/support/tickets', { kind: 'feature', title: 'Swap shifts', detail: 'Let staff swap shifts with a manager approving.', hoursSavedPerWeek: 3 })).body;
    expect(idea.votes).toEqual(['Priya Shah']);
    expect((await t.owner('POST', `/v1/support/tickets/${idea.id}/vote`)).body.votes).toEqual(['Priya Shah', 'Olivia Grant']);
    expect((await t.owner('POST', `/v1/support/tickets/${idea.id}/vote`)).body.votes).toEqual(['Priya Shah']);
    for (let i = 0; i < 29; i++) await t.gm('POST', '/v1/support/tickets', { kind: 'question', title: `Question ${i}`, detail: 'How does this part work?' });
    expect((await t.gm('POST', '/v1/support/tickets', { kind: 'question', title: 'One more', detail: 'How does this part work?' })).status).toBe(429);
  });

  it('lists tickets in the record of processing, and drops closed ones two years on', async () => {
    const t = await boot();
    await t.gm('POST', '/v1/support/tickets', BUG);
    const register = (await t.owner('GET', '/v1/privacy/register')).body;
    expect(register.activities.find((a: { activity: string }) => a.activity === 'Support tickets')).toMatchObject({ held: 1 });
    const org = await t.store.load('demo');
    org.support!.tickets[0] = { ...org.support!.tickets[0], status: 'resolved', resolvedAt: '2024-01-01T00:00:00Z' };
    expect((await t.gm('GET', '/v1/support/tickets')).body.tickets).toEqual([]);
  });
});
