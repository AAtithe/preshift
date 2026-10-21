import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import type { Mail } from './mail';
import { MemoryStore } from './store';

const OWNER = { email: 'owner@ws.example', password: 'correct horse battery' };

async function boot() {
  const store = new MemoryStore(['demo'], '2026-10-21');
  const sent: Mail[] = [];
  const { app } = await buildApp({
    apiKeys: [
      { key: 'integration', orgId: 'demo', name: 'Integration', scopes: ['*'] },
      { key: 'desk', orgId: 'demo', name: 'Preshift support', scopes: ['rota:read', 'support:write'] },
    ],
    store,
    provider: new TeamPaySimulator(),
    autoDispatch: false,
    supportDesk: { to: 'support@preshift.example', send: async (mail) => (sent.push(mail), true) },
  });
  const form = (url: string, fields: Record<string, string>) =>
    app.inject({ method: 'POST', url, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(fields).toString() });
  const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie']).split(';')[0];
  const admin = cookieOf(await form('/auth/setup', { email: OWNER.email, password: OWNER.password, confirm: OWNER.password, next: '/app/' }));
  const call = async (method: string, url: string, body?: unknown, auth: { cookie?: string; key?: string } = { cookie: admin }) => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: {
        ...(auth.cookie ? { cookie: auth.cookie } : {}),
        ...(auth.key ? { authorization: `Bearer ${auth.key}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      payload: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  };
  await call('POST', '/v1/users', { email: 'gm@ws.example', password: 'gm password long', role: 'member' });
  const gm = cookieOf(await form('/auth/login', { email: 'gm@ws.example', password: 'gm password long', next: '/app/' }));
  return { store, call, sent, gm };
}

const bug = {
  kind: 'bug',
  title: 'Hours missing from TeamPay',
  detail: 'Approved Friday hours did not arrive in the pay run.',
  impact: 'payroll',
  steps: '1. Approve Friday\n2. Send hours',
  context: { tab: 'payroll', siteId: 'mar', week: '2026-10-19' },
};

describe('Support', () => {
  it('raises a bug as blocking from what it stops, and sends it to the desk', async () => {
    const t = await boot();
    const res = await t.call('POST', '/v1/support/tickets', bug, { cookie: t.gm });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ severity: 'blocking', status: 'new', raisedBy: 'gm@ws.example', emailed: true, responseTarget: '4 hours, any day' });
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].subject).toMatch(/^\[BLOCKING\] /);
    expect(t.sent[0].text).toContain('Steps to reproduce');
    const org = await t.store.load('demo');
    expect(org.audit.at(-1)).toMatchObject({ action: 'support.ticket_raised' });
  });

  it('refuses a bug that does not say what it stops, and tickets from integration keys', async () => {
    const t = await boot();
    expect((await t.call('POST', '/v1/support/tickets', { ...bug, impact: undefined }, { cookie: t.gm })).status).toBe(400);
    expect((await t.call('POST', '/v1/support/tickets', bug, { key: 'integration' })).status).toBe(403);
  });

  it('takes one vote per person on a feature idea, and none on a bug', async () => {
    const t = await boot();
    const idea = (await t.call('POST', '/v1/support/tickets', { kind: 'feature', title: 'Tips and tronc', detail: 'Share tronc by hours worked', hoursSavedPerWeek: 3 }, { cookie: t.gm })).body;
    expect(idea.votes).toEqual(['gm@ws.example']);
    expect((await t.call('POST', `/v1/support/tickets/${idea.id}/vote`)).body.votes).toHaveLength(2);
    expect((await t.call('POST', `/v1/support/tickets/${idea.id}/vote`)).body.votes).toHaveLength(1);
    const b = (await t.call('POST', '/v1/support/tickets', bug, { cookie: t.gm })).body;
    expect((await t.call('POST', `/v1/support/tickets/${b.id}/vote`)).status).toBe(409);
  });

  it('stops the response clock on the desk’s first reply, not the customer’s', async () => {
    const t = await boot();
    const b = (await t.call('POST', '/v1/support/tickets', bug, { cookie: t.gm })).body;
    const own = await t.call('POST', `/v1/support/tickets/${b.id}/comments`, { body: 'Still happening' }, { cookie: t.gm });
    expect(own.body.firstResponseAt).toBeUndefined();
    const reply = await t.call('POST', `/v1/support/tickets/${b.id}/comments`, { body: 'Looking now' }, { key: 'desk' });
    expect(reply.status).toBe(201);
    expect(reply.body).toMatchObject({ status: 'acknowledged', comments: [{ fromSupport: false }, { fromSupport: true, author: 'Preshift support' }] });
    expect(reply.body.firstResponseAt).toBeTruthy();
    // A customer's own key with every scope is not the desk.
    expect((await t.call('POST', `/v1/support/tickets/${b.id}/comments`, { body: 'x' }, { key: 'integration' })).status).toBe(403);
  });

  it('lets admins and the desk move status on, but not members', async () => {
    const t = await boot();
    const b = (await t.call('POST', '/v1/support/tickets', bug, { cookie: t.gm })).body;
    expect((await t.call('PATCH', `/v1/support/tickets/${b.id}`, { status: 'resolved' }, { cookie: t.gm })).status).toBe(403);
    const done = await t.call('PATCH', `/v1/support/tickets/${b.id}`, { status: 'resolved' }, { key: 'desk' });
    expect(done.body.resolvedAt).toBeTruthy();
    expect((await t.call('PATCH', `/v1/support/tickets/${b.id}`, { status: 'investigating' })).body.resolvedAt).toBeUndefined();
    const list = await t.call('GET', '/v1/support/tickets', undefined, { cookie: t.gm });
    expect(list.body).toMatchObject({ deskConnected: true, answeredByHelp: 0 });
    expect(list.body.tickets).toHaveLength(1);
  });

  it('counts questions the help library answered', async () => {
    const t = await boot();
    await t.call('POST', '/v1/support/answered', {}, { cookie: t.gm });
    expect((await t.call('POST', '/v1/support/answered', {}, { cookie: t.gm })).body.answeredByHelp).toBe(2);
  });
});
