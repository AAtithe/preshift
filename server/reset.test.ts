import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { MemoryStore, PgStore, type Query, type Store } from './store';
import { verifyWebhook } from './maillog';
import { tokenOf } from './testkit';
import { createHmac } from 'node:crypto';
import { codeAt, stepAt } from './totp';

const OWNER = { email: 'owner@ws.example', password: 'correct horse battery' };
const MEMBER = { email: 'gm@ws.example', password: 'members own password' };
const EMAIL = { resendApiKey: 're_test_1234567890abcd', from: 'Preshift <rota@ws.example>', appUrl: 'https://rota.ws.example' };

function pglite(): Query {
  const db = new PGlite();
  return async (text, params) => (await db.query(text, params)).rows as Record<string, unknown>[];
}

let sent: { to: string[]; text: string; auth: string; id: string }[] = [];
/** What Resend says when asked about an email. */
let lastEvent = 'delivered';
let asked = 0;

beforeEach(() => {
  sent = [];
  lastEvent = 'delivered';
  asked = 0;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    if (url.startsWith('https://api.resend.com/emails/') && (init.method ?? 'GET') === 'GET') {
      asked++;
      return new Response(JSON.stringify({ object: 'email', id: url.split('/').pop(), last_event: lastEvent }), { status: 200 });
    }
    if (url !== 'https://api.resend.com/emails') throw new Error(`unexpected fetch ${url}`);
    const id = `4ef9a417-02e9-4d39-ad75-9611e0fcc33${sent.length}`;
    sent.push({ ...JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>).authorization, id });
    return new Response(JSON.stringify({ id }), { status: 200 });
  });
});
afterEach(() => vi.unstubAllGlobals());

async function boot(store: Store = new MemoryStore(['demo'], '2026-10-21'), { email = true } = {}) {
  const { app } = await buildApp({ apiKeys: [], store, provider: new TeamPaySimulator(), autoDispatch: false });
  const form = (url: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, payload: new URLSearchParams(fields).toString() });
  const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie'] ?? '').split(';')[0];
  const call = (method: string, url: string, cookie?: string, body?: unknown) =>
    app.inject({
      method: method as 'GET',
      url,
      headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      payload: body !== undefined ? JSON.stringify(body) : undefined,
    });
  const signIn = (email: string, password: string) => form('/auth/login', { email, password, next: '/app/' });

  // The owner sets up, then proves an authenticator: settings and access both need one.
  const first = cookieOf(await form('/auth/setup', { email: OWNER.email, password: OWNER.password, confirm: OWNER.password }));
  const start = (await call('POST', '/v1/me/authenticator/start', first)).json();
  const owner = cookieOf(await call('POST', '/v1/me/authenticator/confirm', first, { code: codeAt(start.secret, stepAt(Date.now())) }));
  if (email) expect((await call('PUT', '/v1/settings/email', owner, EMAIL)).statusCode).toBe(200);
  const invite = (who: { email: string; name: string }, cookie = owner) =>
    call('POST', '/v1/users', cookie, { ...who, audience: 'operator', roleId: 'general_manager', siteIds: ['mar'] });
  const invited = (await invite({ email: MEMBER.email, name: 'Grace Mensah' })).json();
  // The member takes the link from their inbox, or from whoever was handed it, and sets their own password.
  const token = email ? decodeURIComponent(/#invite=([^\s"<]+)/.exec(sent[0].text)![1]) : tokenOf(invited.inviteUrl);
  expect((await form('/auth/accept', { token, password: MEMBER.password, confirm: MEMBER.password })).headers.location).toBe('/app/');
  sent = [];
  const forgot = (address: string, headers?: Record<string, string>) => form('/auth/forgot', { email: address }, headers);
  const tokenFrom = (text: string) => /#reset=([A-Za-z0-9_-]+)/.exec(text)![1];
  return { app, owner, memberId: invited.user.id as string, invite, form, call, cookieOf, signIn, forgot, tokenFrom };
}

describe('forgot password', () => {
  it('answers the same whether or not the email has an account, and emails only a real one', async () => {
    const t = await boot();
    const unknown = await t.forgot('nobody@ws.example');
    const known = await t.forgot(' GM@ws.example ');
    expect(unknown.statusCode).toBe(303);
    expect(known.statusCode).toBe(303);
    expect(unknown.headers.location).toBe('/login?sent=1');
    expect(known.headers.location).toBe(unknown.headers.location);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual([MEMBER.email]);
    expect(sent[0].auth).toBe(`Bearer ${EMAIL.resendApiKey}`);
  });

  it('builds the link from the saved app address, never the request, with the token after #', async () => {
    const t = await boot();
    await t.forgot(MEMBER.email, { host: 'evil.example', 'x-forwarded-host': 'evil.example' });
    expect(sent[0].text).toContain('https://rota.ws.example/login#reset=');
    expect(sent[0].text).not.toContain('evil.example');
  });

  it('sends one account at most three emails an hour', async () => {
    const t = await boot();
    for (let i = 0; i < 5; i++) expect((await t.forgot(MEMBER.email)).headers.location).toBe('/login?sent=1');
    expect(sent).toHaveLength(3);
  });

  it('sends nothing until email is set up, and says the same', async () => {
    const t = await boot(undefined, { email: false });
    expect((await t.forgot(MEMBER.email)).headers.location).toBe('/login?sent=1');
    expect(sent).toHaveLength(0);
  });
});

describe('choosing a new password from a link', () => {
  it('checks the link, sets the password, signs out other devices and signs this one in', async () => {
    const t = await boot();
    const before = t.cookieOf(await t.signIn(MEMBER.email, MEMBER.password));
    await t.forgot(MEMBER.email);
    const token = t.tokenFrom(sent[0].text);

    expect((await t.call('POST', '/auth/reset', undefined, { token })).json()).toEqual({ ok: true, email: MEMBER.email });
    expect((await t.call('POST', '/auth/reset', undefined, { token, password: 'short' })).statusCode).toBe(400);

    const done = await t.call('POST', '/auth/reset', undefined, { token, password: 'a brand new passphrase' });
    expect(done.statusCode).toBe(200);
    expect(String(done.headers['set-cookie'])).toMatch(/HttpOnly/);
    expect((await t.call('GET', '/auth/me', t.cookieOf(done))).statusCode).toBe(200);
    expect((await t.call('GET', '/auth/me', before)).statusCode).toBe(401);
    expect((await t.signIn(MEMBER.email, MEMBER.password)).headers.location).toMatch(/error=invalid/);
    expect((await t.signIn(MEMBER.email, 'a brand new passphrase')).headers.location).toBe('/app/');
  });

  it('works once, and an earlier link stops working when a new one is sent', async () => {
    const t = await boot();
    await t.forgot(MEMBER.email);
    await t.forgot(MEMBER.email);
    const [first, second] = sent.map((m) => t.tokenFrom(m.text));
    expect((await t.call('POST', '/auth/reset', undefined, { token: first })).statusCode).toBe(410);
    expect((await t.call('POST', '/auth/reset', undefined, { token: second, password: 'a brand new passphrase' })).statusCode).toBe(200);
    expect((await t.call('POST', '/auth/reset', undefined, { token: second, password: 'and another passphrase' })).statusCode).toBe(410);
  });

  it('refuses a link after 30 minutes, or an invented one', async () => {
    const t = await boot();
    await t.forgot(MEMBER.email);
    const token = t.tokenFrom(sent[0].text);
    vi.useFakeTimers({ now: Date.now() + 31 * 60 * 1000, toFake: ['Date'] });
    try {
      expect((await t.call('POST', '/auth/reset', undefined, { token })).statusCode).toBe(410);
    } finally {
      vi.useRealTimers();
    }
    expect((await t.call('POST', '/auth/reset', undefined, { token: 'made-up' })).statusCode).toBe(410);
  });

  it('clears a lockout, since the person has proved they hold the inbox', async () => {
    const t = await boot();
    for (let i = 0; i < 5; i++) await t.signIn(MEMBER.email, 'wrong password here');
    expect((await t.signIn(MEMBER.email, MEMBER.password)).headers.location).toMatch(/error=locked/);
    await t.forgot(MEMBER.email);
    await t.call('POST', '/auth/reset', undefined, { token: t.tokenFrom(sent[0].text), password: 'a brand new passphrase' });
    expect((await t.signIn(MEMBER.email, 'a brand new passphrase')).headers.location).toBe('/app/');
  });

  it('lets only one of two simultaneous uses of a link change the password, in Postgres', async () => {
    const t = await boot(new PgStore(pglite(), ['demo'], '2026-10-21'));
    await t.forgot(MEMBER.email);
    const token = t.tokenFrom(sent[0].text);
    const results = await Promise.all([
      t.call('POST', '/auth/reset', undefined, { token, password: 'first new passphrase' }),
      t.call('POST', '/auth/reset', undefined, { token, password: 'second new passphrase' }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 410]);
  });
});

describe('resets from the Access tab and email settings', () => {
  it('lets only someone who manages access reset a password, and hands over a 24 hour link until email is set up', async () => {
    const t = await boot(undefined, { email: false });
    const member = t.cookieOf(await t.signIn(MEMBER.email, MEMBER.password));
    expect((await t.call('POST', `/v1/users/usr_owner/reset-password`, member)).statusCode).toBe(403);

    const res = (await t.call('POST', `/v1/users/${t.memberId}/reset-password`, t.owner)).json();
    expect(res).toMatchObject({ emailed: false, expiresInHours: 24 });
    expect(res.inviteUrl).toMatch(/^\/login#reset=/);
    // The old password stops at once, before the link is used.
    expect((await t.signIn(MEMBER.email, MEMBER.password)).headers.location).toMatch(/error=invalid/);
    vi.useFakeTimers({ now: Date.now() + 23 * 3600 * 1000, toFake: ['Date'] });
    try {
      expect((await t.call('POST', '/auth/reset', undefined, { token: tokenOf(res.inviteUrl), password: 'set from a handed link' })).statusCode).toBe(200);
    } finally {
      vi.useRealTimers();
    }
    expect(sent).toHaveLength(0);
  });

  it('emails the reset link once email is set up, and never shows it to whoever reset it', async () => {
    const t = await boot();
    const res = await t.call('POST', `/v1/users/${t.memberId}/reset-password`, t.owner);
    expect(res.json()).toMatchObject({ emailed: true });
    expect(res.body).not.toMatch(/#reset=/);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual([MEMBER.email]);
    expect(sent[0].text).toContain(`https://rota.ws.example/login#reset=`);
    expect(sent[0].text).toContain('expires in 24 hours');
    const token = t.tokenFrom(sent[0].text);
    expect((await t.call('POST', '/auth/reset', undefined, { token, password: 'chosen from the email' })).statusCode).toBe(200);
    expect((await t.signIn(MEMBER.email, 'chosen from the email')).headers.location).toBe('/app/');
  });

  it('never returns the Resend key, keeps it when only the address changes, and refuses bad values', async () => {
    const t = await boot();
    const view = (await t.call('GET', '/v1/settings', t.owner)).json().email;
    expect(view).toEqual({ set: true, from: EMAIL.from, appUrl: EMAIL.appUrl, keyEndsWith: 'abcd', webhook: { url: 'https://rota.ws.example/v1/integrations/resend/webhook/demo', set: false } });
    expect(JSON.stringify(view)).not.toContain(EMAIL.resendApiKey);

    const moved = await t.call('PUT', '/v1/settings/email', t.owner, { from: EMAIL.from, appUrl: 'https://new.ws.example/app/' });
    expect(moved.json().email).toMatchObject({ appUrl: 'https://new.ws.example', keyEndsWith: 'abcd' });

    expect((await t.call('PUT', '/v1/settings/email', t.owner, { ...EMAIL, appUrl: 'http://rota.ws.example' })).statusCode).toBe(400);
    expect((await t.call('PUT', '/v1/settings/email', t.owner, { ...EMAIL, resendApiKey: 'sk-nope' })).statusCode).toBe(400);
    expect((await t.call('PUT', '/v1/settings/email', t.owner, { ...EMAIL, from: 'not an address' })).statusCode).toBe(400);

    expect((await t.call('DELETE', '/v1/settings/email', t.owner)).json()).toEqual({ email: { set: false } });
    await t.forgot(MEMBER.email);
    expect(sent).toHaveLength(0);
  });
});

describe('invitation emails', () => {
  it('emails the invitation from the saved address, naming who sent it and the role, and keeps the link from the inviter', async () => {
    const t = await boot();
    const res = await t.invite({ email: 'ama@ws.example', name: 'Ama Boateng' }, t.owner);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ emailed: true });
    expect(res.body).not.toMatch(/#invite=/);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(['ama@ws.example']);
    expect(sent[0].auth).toBe(`Bearer ${EMAIL.resendApiKey}`);
    expect(sent[0].text).toContain('https://rota.ws.example/login#invite=');
    expect(sent[0].text).toContain('as General manager');
    expect(sent[0].text).toContain('expires in 7 days');
    const audit = (await t.call('GET', '/v1/access/audit', t.owner)).json();
    expect(audit.find((e: { action: string }) => e.action === 'user.invited').detail).toMatchObject({ emailed: true });
  });

  it('greets the person from the link in the request body, never the address', async () => {
    const t = await boot();
    await t.invite({ email: 'ama@ws.example', name: 'Ama Boateng' }, t.owner);
    const token = decodeURIComponent(/#invite=([^\s"<]+)/.exec(sent[0].text)![1]);
    expect((await t.call('POST', '/auth/link', undefined, { token })).json()).toEqual({ name: 'Ama Boateng', email: 'ama@ws.example', kind: 'invite' });
    expect((await t.call('GET', `/auth/link?token=${encodeURIComponent(token)}`)).statusCode).toBe(404);
    // A mistake on the form goes back to the page with the token after #, out of the address the server sees.
    const weak = await t.form('/auth/accept', { token, password: 'short', confirm: 'short' });
    expect(weak.headers.location).toBe(`/login?error=weak#invite=${encodeURIComponent(token)}`);
  });

  it('sends a resent invitation by email too, with a fresh link that ends the old one', async () => {
    const t = await boot();
    const ama = (await t.invite({ email: 'ama@ws.example', name: 'Ama Boateng' }, t.owner)).json().user;
    const resent = await t.call('POST', `/v1/users/${ama.id}/resend-invite`, t.owner);
    expect(resent.json()).toMatchObject({ emailed: true });
    expect(sent).toHaveLength(2);
    const [first, second] = sent.map((m) => decodeURIComponent(/#invite=([^\s"<]+)/.exec(m.text)![1]));
    expect((await t.call('POST', '/auth/link', undefined, { token: first })).statusCode).toBe(404);
    expect((await t.call('POST', '/auth/link', undefined, { token: second })).statusCode).toBe(200);
  });

  it('hands the link back, saying why, when Resend refuses the email', async () => {
    const t = await boot();
    vi.stubGlobal('fetch', async () => new Response('{"message":"domain not verified"}', { status: 403 }));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = (await t.invite({ email: 'ama@ws.example', name: 'Ama Boateng' }, t.owner)).json();
      expect(res.emailed).toBe(false);
      expect(res.emailProblem).toMatch(/did not go/);
      expect(res.inviteUrl).toMatch(/^https:\/\/rota\.ws\.example\/login#invite=/);
    } finally {
      errors.mockRestore();
    }
  });

  it('shows the link once to the inviter while email is not set up', async () => {
    const t = await boot(undefined, { email: false });
    const res = (await t.invite({ email: 'ama@ws.example', name: 'Ama Boateng' }, t.owner)).json();
    expect(res.emailed).toBe(false);
    expect(res.emailProblem).toBeUndefined();
    expect(res.inviteUrl).toMatch(/^\/login#invite=/);
    expect(sent).toHaveLength(0);
  });
});

describe('the sign-in page', () => {
  it('has scripts that parse, and names every message it can show', () => {
    const page = readFileSync(new URL('../site/login.html', import.meta.url), 'utf8');
    const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    // A syntax error stops every link on the page from working, and nothing else would notice.
    for (const code of scripts) expect(() => new Function(code)).not.toThrow();
    for (const id of ['badlink', 'expired', 'weak', 'mismatch', 'suspended', 'elsewhere', 'sent', 'setpassword', 'reset', 'forgot']) {
      expect(page).toContain(`id="${id}"`);
    }
  });
});


const SECRET = `whsec_${Buffer.from('a webhook signing secret for tests').toString('base64')}`;
let delivery = 0;

/** A report signed the way Resend signs them. */
function signed(type: string, emailId: string, data: Record<string, unknown> = {}, opts: { secret?: string; at?: number; id?: string } = {}) {
  const body = JSON.stringify({ type, created_at: '2026-10-21T10:00:00.000Z', data: { email_id: emailId, ...data } });
  const id = opts.id ?? `msg_${++delivery}`;
  const at = String(opts.at ?? Math.floor(Date.now() / 1000));
  const key = Buffer.from((opts.secret ?? SECRET).replace(/^whsec_/, ''), 'base64');
  const signature = createHmac('sha256', key).update(`${id}.${at}.${body}`).digest('base64');
  return { body, headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': at, 'svix-signature': `v1,${signature}` } };
}

async function withWebhook() {
  const t = await boot();
  expect((await t.call('PUT', '/v1/settings/email', t.owner, { from: EMAIL.from, appUrl: EMAIL.appUrl, webhookSecret: SECRET })).statusCode).toBe(200);
  const report = (r: ReturnType<typeof signed>, orgId = 'demo') => t.app.inject({ method: 'POST', url: `/v1/integrations/resend/webhook/${orgId}`, headers: r.headers, payload: r.body });
  const invited = async () => {
    const ama = (await t.invite({ email: 'ama@ws.example', name: 'Ama Boateng' }, t.owner)).json().user;
    return { ama, emailId: sent[sent.length - 1].id };
  };
  const person = async (id: string) => (await t.call('GET', `/v1/users/${id}`, t.owner)).json();
  const attention = async () => (await t.call('GET', '/v1/access/health', t.owner)).json().attention as { kind: string; userId?: string; message: string; severity: string }[];
  return { ...t, report, invited, person, attention };
}

describe('what became of each email', () => {
  it('checks signatures exactly as Resend makes them, by the published Svix test vector', () => {
    const headers = { 'svix-id': 'msg_p5jXN8AQM9LWM0D4loKWxJek', 'svix-timestamp': '1614265330', 'svix-signature': 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=' };
    expect(verifyWebhook('whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', headers, '{"test": 2432232314}', 1614265330)).toBe(true);
    expect(verifyWebhook('whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', headers, '{"test": 2432232315}', 1614265330)).toBe(false);
  });

  it('shows an invitation as sent, then delivered once Resend reports it', async () => {
    const t = await withWebhook();
    const { ama, emailId } = await t.invited();
    expect((await t.person(ama.id)).lastEmail).toMatchObject({ id: emailId, kind: 'invite', status: 'sent', to: 'ama@ws.example', by: 'owner' });
    const res = await t.report(signed('email.delivered', emailId));
    expect(res.json()).toEqual({ ok: true, recorded: true });
    expect((await t.person(ama.id)).lastEmail).toMatchObject({ status: 'delivered', at: '2026-10-21T10:00:00.000Z' });
    const listed = (await t.call('GET', `/v1/access/emails?userId=${ama.id}`, t.owner)).json();
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toMatch(/#invite=|login/);
  });

  it('puts a bounce in front of whoever manages access, with the reason, until it stops mattering', async () => {
    const t = await withWebhook();
    const { ama, emailId } = await t.invited();
    await t.report(signed('email.bounced', emailId, { bounce: { type: 'Permanent', subType: 'General', message: 'The recipient mailbox does not exist.' } }));
    expect((await t.person(ama.id)).lastEmail).toMatchObject({ status: 'bounced', detail: 'permanent: The recipient mailbox does not exist.' });
    const flag = (await t.attention()).find((a) => a.kind === 'email_bounced');
    expect(flag).toMatchObject({ userId: ama.id, severity: 'warn' });
    expect(flag!.message).toMatch(/invitation to ama@ws\.example bounced.*mailbox does not exist.*Withdraw the invitation/);
    const audit = (await t.call('GET', '/v1/access/audit', t.owner)).json();
    expect(audit.find((e: { action: string }) => e.action === 'email.bounced')).toMatchObject({ actor: 'Resend' });
    // A later delivery report cannot undo a bounce.
    await t.report(signed('email.delivered', emailId));
    expect((await t.person(ama.id)).lastEmail.status).toBe('bounced');
    // Withdrawn, the invitation no longer needs anyone's attention.
    await t.call('DELETE', `/v1/users/${ama.id}/invite`, t.owner);
    expect((await t.attention()).some((a) => a.kind === 'email_bounced')).toBe(false);
  });

  it('hands a link over instead of emailing it when asked, for an address that bounced', async () => {
    const t = await withWebhook();
    const { ama } = await t.invited();
    const res = (await t.call('POST', `/v1/users/${ama.id}/resend-invite`, t.owner, { handOver: true })).json();
    expect(res).toMatchObject({ emailed: false });
    expect(res.inviteUrl).toMatch(/^https:\/\/rota\.ws\.example\/login#invite=/);
    expect(sent).toHaveLength(1);
    const reset = (await t.call('POST', `/v1/users/${t.memberId}/reset-password`, t.owner, { handOver: true })).json();
    expect(reset.inviteUrl).toMatch(/#reset=/);
    expect(sent).toHaveLength(1);
  });

  it('believes a report only with a valid, recent signature, and records each one once', async () => {
    const t = await withWebhook();
    const { ama, emailId } = await t.invited();
    expect((await t.report(signed('email.bounced', emailId, {}, { secret: `whsec_${Buffer.from('someone else').toString('base64')}` }))).statusCode).toBe(401);
    expect((await t.report(signed('email.bounced', emailId, {}, { at: Math.floor(Date.now() / 1000) - 600 }))).statusCode).toBe(401);
    const tampered = signed('email.delivered', emailId);
    expect((await t.report({ ...tampered, body: tampered.body.replace('delivered', 'bounced') })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'POST', url: '/v1/integrations/resend/webhook/demo', headers: { 'content-type': 'application/json' }, payload: tampered.body })).statusCode).toBe(401);
    // An organisation without a saved secret believes nothing, and an invented one learns nothing.
    expect((await t.report(signed('email.bounced', emailId), 'nowhere')).statusCode).toBe(401);
    expect((await t.person(ama.id)).lastEmail.status).toBe('sent');

    const once = signed('email.delivery_delayed', emailId, {}, { id: 'msg_retried' });
    expect((await t.report(once)).json().recorded).toBe(true);
    expect((await t.report(once)).json().recorded).toBe(false);
    expect((await t.call('GET', `/v1/access/emails?userId=${ama.id}`, t.owner)).json()[0].status).toBe('delayed');
    // Emails Preshift never sent, and events it does not track, are acknowledged and ignored.
    expect((await t.report(signed('email.delivered', 'not-ours'))).json()).toEqual({ ok: true, recorded: false });
    expect((await t.report(signed('email.opened', emailId))).json()).toEqual({ ok: true, recorded: false });
  });

  it('logs "Forgot your password?" emails against the person, and drops a bounce once they sign in', async () => {
    const t = await withWebhook();
    await t.forgot(MEMBER.email);
    const emailId = sent[0].id;
    expect((await t.person(t.memberId)).lastEmail).toMatchObject({ kind: 'forgot', by: 'Forgot your password?' });
    await t.report(signed('email.bounced', emailId, { bounce: { type: 'Transient', message: 'Mailbox full' } }));
    expect((await t.attention()).find((a) => a.kind === 'email_bounced')!.message).toMatch(/password reset email.*temporary: Mailbox full.*hand the link over in person/);
    await new Promise((r) => setTimeout(r, 5));
    const member = t.cookieOf(await t.signIn(MEMBER.email, MEMBER.password));
    await t.call('GET', '/v1/me', member);
    expect((await t.attention()).some((a) => a.kind === 'email_bounced')).toBe(false);
  });

  it('asks Resend where an email stands when there is no webhook, and records each state once', async () => {
    const t = await boot();
    const ama = (await t.invite({ email: 'ama@ws.example', name: 'Ama Boateng' }, t.owner)).json().user;
    const emailId = sent[0].id;
    lastEvent = 'bounced';
    expect((await t.call('POST', `/v1/access/emails/${emailId}/check`, t.owner)).json()).toMatchObject({ status: 'bounced' });
    await t.call('POST', `/v1/access/emails/${emailId}/check`, t.owner);
    expect(asked).toBe(2);
    expect((await t.call('GET', `/v1/access/emails?userId=${ama.id}`, t.owner)).json()[0]).toMatchObject({ status: 'bounced' });
    expect((await t.call('POST', '/v1/access/emails/not-ours/check', t.owner)).statusCode).toBe(404);
    // Nobody learns about emails to people they cannot read: the general manager at Marylebone, of a Shoreditch invitation.
    await t.call('POST', '/v1/users', t.owner, { email: 'ben@ws.example', name: 'Ben Ross', audience: 'operator', roleId: 'general_manager', siteIds: ['shd'] });
    const member = t.cookieOf(await t.signIn(MEMBER.email, MEMBER.password));
    expect((await t.call('POST', `/v1/access/emails/${sent[1].id}/check`, member)).statusCode).toBe(404);
    expect((await t.call('GET', '/v1/access/emails', member)).json().map((m: { to: string }) => m.to)).not.toContain('ben@ws.example');
  });

  it('shows where to send reports and whether the secret is saved, never the secret itself', async () => {
    const t = await withWebhook();
    const email = (await t.call('GET', '/v1/settings', t.owner)).json().email;
    expect(email.webhook).toEqual({ url: 'https://rota.ws.example/v1/integrations/resend/webhook/demo', set: true });
    expect(JSON.stringify(email)).not.toContain(SECRET);
    // Saving without the secret keeps it; a bad one is refused; null removes it.
    expect((await t.call('PUT', '/v1/settings/email', t.owner, { from: EMAIL.from, appUrl: EMAIL.appUrl })).json().email.webhook.set).toBe(true);
    expect((await t.call('PUT', '/v1/settings/email', t.owner, { from: EMAIL.from, appUrl: EMAIL.appUrl, webhookSecret: 'secret' })).statusCode).toBe(400);
    expect((await t.call('PUT', '/v1/settings/email', t.owner, { from: EMAIL.from, appUrl: EMAIL.appUrl, webhookSecret: null })).json().email.webhook.set).toBe(false);
  });
});
