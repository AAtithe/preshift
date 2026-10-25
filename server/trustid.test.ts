import { describe, expect, it } from 'vitest';
import { trustIdDate, trustIdResult } from './integrations/trustid';
import { MemoryStore } from './store';
import { enrol, kit, TODAY } from './testkit';

const OWNER = { email: 'owner@ws.example', password: 'correct horse battery' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const field = (Name: string, value: { FieldValueString?: string; FieldValueDate?: string }) => ({ m_Item1: { Name }, m_Item2: value });

/** A fake TrustID Cloud: sign-in, guest links, and one finished application to read back. */
function fakeTrustId(container: Record<string, unknown>) {
  const calls: { path: string; body: Record<string, unknown>; key: string }[] = [];
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init.body ?? '{}'));
    calls.push({ path: url.pathname, body, key: (init.headers as Record<string, string>)['tid-api-key'] });
    if (url.pathname === '/VPE/session/login/') return body.Password === 'right' ? json(200, { Success: true, SessionId: 'sess-1' }) : json(200, { Success: false, AccessDenied: true });
    if (body.SessionId !== 'sess-1') return json(200, { Success: false, SessionExpired: true, Message: 'Session expired' });
    if (url.pathname === '/VPE/guestLink/createGuestLink/') return json(200, { Success: true, Message: 'Operation executed successfully.' });
    if (url.pathname === '/VPE/dataAccess/retrieveDocumentContainer/') return json(200, { Success: true, Container: container });
    return json(404, {});
  }) as typeof fetch;
  return { impl, calls };
}

const resultCallback = (reference: string) => ({
  Callback: {
    WorkflowName: 'AutoReferral',
    WorkflowState: 'Stop',
    WorkflowStorage: [{ Key: 'ContainerId', Value: 'c-1' }, { Key: 'DocumentId', Value: null }, { Key: 'ClientApplicationReference', Value: reference }],
  },
  Response: { Success: true, ContainerId: 'c-1' },
});

async function boot(container: Record<string, unknown>) {
  const fake = fakeTrustId(container);
  const k = await kit({ store: new MemoryStore(['demo'], TODAY), accounts: false, fetch: fake.impl, env: { PRESHIFT_APP_URL: 'https://app.preshift.example' } });
  const setup = await k.form('/auth/setup', { email: OWNER.email, password: OWNER.password, confirm: OWNER.password, next: '/app/' });
  const cookie = (await enrol(k, setup.cookie!)).cookie;
  const call = (method: string, url: string, body?: unknown) => k.call(method, url, cookie, body);
  const callback = (token: string, body: unknown) =>
    k.app.inject({ method: 'POST', url: '/v1/integrations/trustid/webhook/demo', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, payload: JSON.stringify(body) });
  return { k, call, callback, fake };
}

const timeLimited = {
  Id: 'c-1',
  OverallStatus: 'NoAlert',
  ApplicationFlexibleFieldList: [field('__RTW_RightToWorkStatus', { FieldValueString: 'Time Limited' }), field('__RTW_FollowUpDate', { FieldValueDate: '/Date(1798761600000+0000)/' }), field('__RTW_WorkRestrictions', { FieldValueString: '20 hours a week in term time' })],
  Documents: [{ DocumentName: 'Biometric Residence Permit' }],
};

describe('TrustID right to work checks', () => {
  it('reads the right to work outcome, follow-up date and any alert from a finished application', () => {
    expect(trustIdDate('/Date(1798761600000+0000)/')).toBe('2027-01-01');
    expect(trustIdResult(timeLimited)).toEqual({ status: 'Time Limited', followUpDate: '2027-01-01', restrictions: '20 hours a week in term time', document: 'Biometric Residence Permit', alert: false });
    expect(trustIdResult({ OverallStatus: 'Alert', ApplicationFlexibleFieldList: [field('__RTW_RightToWorkStatus', { FieldValueString: 'Continuous' })] })).toMatchObject({ status: 'Continuous', alert: true });
    expect(trustIdResult({}).status).toBe('Unknown');
  });

  it('connects only with credentials TrustID accepts, sends the invitation, and writes the result back from TrustID', async () => {
    const { k, call, callback, fake } = await boot(timeLimited);
    expect((await call('PUT', '/v1/integrations/trustid', { apiKey: 'key-1', username: 'ws', password: 'wrong' })).status).toBe(422);
    expect((await call('PUT', '/v1/integrations/trustid', { apiKey: 'key-1', username: 'ws', password: 'right' })).status).toBe(200);
    expect(fake.calls.every((c) => c.key === 'key-1')).toBe(true);

    const sent = await call('POST', '/v1/employees/mar-12/right-to-work/trustid', { email: 'ben@example.com' });
    expect(sent.status).toBe(200);
    const link = fake.calls.find((c) => c.path === '/VPE/guestLink/createGuestLink/')!.body;
    expect(link).toMatchObject({ Email: 'ben@example.com', Name: 'Ben Ford', SendEmail: true, ClientApplicationReference: sent.body.id, ContainerEventCallbackUrl: 'https://app.preshift.example/v1/integrations/trustid/webhook/demo' });
    const token = (link.ContainerEventCallbackHeaders as { Header: string; Value: string }[])[0].Value.replace('Bearer ', '');

    // Only TrustID, with the token it was given, can post a result.
    expect((await callback('forged', resultCallback(sent.body.id))).statusCode).toBe(401);
    // A container first submitted is not the result.
    expect((await callback(token, { Callback: { WorkflowName: 'ContainerSubmitted', WorkflowState: 'Start' } })).json()).toMatchObject({ ignored: true });
    const done = await callback(token, resultCallback(sent.body.id));
    expect(done.json()).toMatchObject({ status: 'done' });
    expect(fake.calls.at(-1)).toMatchObject({ path: '/VPE/dataAccess/retrieveDocumentContainer/', body: { ContainerId: 'c-1' } });

    const ben = (await k.store.load('demo')).state.employees.find((e) => e.id === 'mar-12')!;
    expect(ben.rightToWork).toMatchObject({ checked: true, evidence: 'TrustID digital check: Biometric Residence Permit', expiry: '2027-01-01' });
  });

  it('clears the check on a rejection, and leaves a flagged result for a person to decide', async () => {
    const rejected = { OverallStatus: 'NoAlert', ApplicationFlexibleFieldList: [field('__RTW_RightToWorkStatus', { FieldValueString: 'Rejected' })] };
    const { k, call, callback, fake } = await boot(rejected);
    await call('PUT', '/v1/integrations/trustid', { apiKey: 'key-1', username: 'ws', password: 'right' });
    const sent = await call('POST', '/v1/employees/mar-12/right-to-work/trustid', { email: 'ben@example.com' });
    const token = ((fake.calls.find((c) => c.path === '/VPE/guestLink/createGuestLink/')!.body.ContainerEventCallbackHeaders as { Value: string }[])[0].Value).replace('Bearer ', '');
    await callback(token, resultCallback(sent.body.id));
    const ben = (await k.store.load('demo')).state.employees.find((e) => e.id === 'mar-12')!;
    expect(ben.rightToWork).toMatchObject({ checked: false, evidence: expect.stringContaining('no right to work shown') });
  });

  it('does not change the record on a result TrustID itself flagged', async () => {
    const flagged = { OverallStatus: 'Alert', ApplicationFlexibleFieldList: [field('__RTW_RightToWorkStatus', { FieldValueString: 'Continuous' })] };
    const { k, call, callback, fake } = await boot(flagged);
    await call('PUT', '/v1/integrations/trustid', { apiKey: 'key-1', username: 'ws', password: 'right' });
    const before = (await k.store.load('demo')).state.employees.find((e) => e.id === 'mar-12')!.rightToWork;
    const sent = await call('POST', '/v1/employees/mar-12/right-to-work/trustid', { email: 'ben@example.com' });
    const token = ((fake.calls.find((c) => c.path === '/VPE/guestLink/createGuestLink/')!.body.ContainerEventCallbackHeaders as { Value: string }[])[0].Value).replace('Bearer ', '');
    expect((await callback(token, resultCallback(sent.body.id))).json()).toMatchObject({ status: 'review' });
    expect((await k.store.load('demo')).state.employees.find((e) => e.id === 'mar-12')!.rightToWork).toEqual(before);
    expect((await call('GET', '/v1/integrations/trustid')).body).toMatchObject({ review: 1 });
  });

  it('refuses to send a check until TrustID is connected', async () => {
    const { call } = await boot(timeLimited);
    expect((await call('POST', '/v1/employees/mar-12/right-to-work/trustid', { email: 'ben@example.com' })).status).toBe(409);
  });
});
