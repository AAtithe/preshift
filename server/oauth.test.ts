import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from './store';
import { account, kit, TODAY, type Kit } from './testkit';

// Sign in with Preshift for claude.ai: discovery, registration, consent, tokens, and every way a
// connection ends. A token acts as its person, so their sites and roles decide what it can do.

const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const PRIYA = 'priya@marylebonegroup.example';
const WEEK = '2026-10-19';

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

async function register(k: Kit, uris: string[] = [CALLBACK]) {
  return k.app.inject({ method: 'POST', url: '/oauth/register', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ client_name: 'Claude', redirect_uris: uris }) });
}

const form = (k: Kit, url: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  k.app.inject({ method: 'POST', url, headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, payload: new URLSearchParams(fields).toString() });

/** Registers, approves as the person with the boxes given, and swaps the code for tokens. */
async function connect(k: Kit, email = PRIYA, ticks: string[] = ['rota:read', 'rota:write'], orgs: string[] = ['demo']) {
  const clientId = (await register(k)).json().client_id as string;
  const { verifier, challenge } = pkce();
  const cookie = await k.as(email);
  const params = { response_type: 'code', client_id: clientId, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz' };
  const approved = await form(k, '/oauth/authorize', { ...params, decision: 'allow', ...Object.fromEntries(ticks.map((t) => [`tick:${t}`, '1'])), ...Object.fromEntries(orgs.map((o) => [`org:${o}`, '1'])) }, { cookie });
  const back = new URL(approved.headers.location as string);
  const code = back.searchParams.get('code')!;
  const exchange = await form(k, '/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: CALLBACK, client_id: clientId, code_verifier: verifier });
  return { clientId, verifier, challenge, cookie, params, back, code, exchange, tokens: exchange.json() };
}

const mcp = (k: Kit, bearer: string, method: string, params?: unknown) =>
  k.app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
  });

describe('Sign in with Preshift', () => {
  it('is found from the connector address alone', async () => {
    const k = await kit();
    const nobody = await k.app.inject({ method: 'POST', url: '/mcp', headers: { host: 'rota.example', 'content-type': 'application/json' }, payload: '{}' });
    expect(nobody.statusCode).toBe(401);
    expect(nobody.headers['www-authenticate']).toBe('Bearer resource_metadata="http://rota.example/.well-known/oauth-protected-resource/mcp"');
    const resource = (await k.app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource/mcp', headers: { host: 'rota.example' } })).json();
    expect(resource).toMatchObject({ resource: 'http://rota.example/mcp', authorization_servers: ['http://rota.example'] });
    const server = (await k.app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server', headers: { host: 'rota.example' } })).json();
    expect(server).toMatchObject({ issuer: 'http://rota.example', registration_endpoint: 'http://rota.example/oauth/register', code_challenge_methods_supported: ['S256'] });
  });

  it('registers https and loopback clients only', async () => {
    const k = await kit();
    expect((await register(k)).statusCode).toBe(201);
    expect((await register(k, ['http://localhost:33418/callback'])).statusCode).toBe(201);
    expect((await register(k, ['http://evil.example/cb'])).statusCode).toBe(400);
    expect((await register(k, [])).statusCode).toBe(400);
  });

  it('sends a signed-out person to sign in, then shows what the app will be able to do', async () => {
    const k = await kit();
    const clientId = (await register(k)).json().client_id;
    const { challenge } = pkce();
    const url = `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: 'S256', state: 's1' })}`;
    const out = await k.app.inject({ method: 'GET', url });
    expect(out.statusCode).toBe(302);
    expect(out.headers.location).toBe(`/login?next=${encodeURIComponent(url)}`);
    const page = await k.app.inject({ method: 'GET', url, headers: { cookie: await k.as(PRIYA) } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Connect Claude to Preshift');
    expect(page.body).toContain('name="tick:rota:read" value="1" checked');
    expect(page.body).not.toContain('name="tick:rota:write" value="1" checked');
  });

  it('never redirects to an address the app did not register', async () => {
    const k = await kit();
    const clientId = (await register(k)).json().client_id;
    const { challenge } = pkce();
    const res = await k.app.inject({
      method: 'GET',
      url: `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'https://evil.example/cb', code_challenge: challenge, code_challenge_method: 'S256' })}`,
      headers: { cookie: await k.as(PRIYA) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers.location).toBeUndefined();
  });

  it('issues tokens that act as the person: their sites, the boxes they ticked', async () => {
    const k = await kit();
    const c = await connect(k);
    expect(c.back.origin + c.back.pathname).toBe(CALLBACK);
    expect(c.back.searchParams.get('state')).toBe('xyz');
    expect(c.exchange.statusCode).toBe(200);
    expect(c.tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'rota:read rota:write' });
    expect(c.tokens.access_token).toMatch(/^pso_/);

    const tools = (await mcp(k, c.tokens.access_token, 'tools/list')).json().result.tools.map((t: { name: string }) => t.name);
    expect(tools).toContain('build_rota');
    expect(tools).not.toContain('list_employees');
    const sites = (await mcp(k, c.tokens.access_token, 'tools/call', { name: 'list_sites', arguments: {} })).json().result;
    expect(JSON.parse(sites.content[0].text).map((s: { id: string }) => s.id)).toEqual(['mar']);
    const elsewhere = (await mcp(k, c.tokens.access_token, 'tools/call', { name: 'publish_rota', arguments: { siteId: 'shd', weekStart: WEEK } })).json().result;
    expect(elsewhere.isError).toBe(true);
    expect(elsewhere.content[0].text).toContain('403');
  });

  it('uses a code once, with its own verifier, from its own app', async () => {
    const k = await kit();
    const c = await connect(k);
    const again = await form(k, '/oauth/token', { grant_type: 'authorization_code', code: c.code, redirect_uri: CALLBACK, client_id: c.clientId, code_verifier: c.verifier });
    expect(again.json().error).toBe('invalid_grant');

    const clientId = (await register(k)).json().client_id;
    const { challenge } = pkce();
    const approved = await form(k, '/oauth/authorize', { response_type: 'code', client_id: clientId, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: 'S256', decision: 'allow', 'tick:rota:read': '1', 'org:demo': '1' }, { cookie: c.cookie });
    const code = new URL(approved.headers.location as string).searchParams.get('code')!;
    const wrong = await form(k, '/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: CALLBACK, client_id: clientId, code_verifier: pkce().verifier });
    expect(wrong.json().error).toBe('invalid_grant');
  });

  it('refuses an approval posted from another site, or with nothing ticked', async () => {
    const k = await kit();
    const clientId = (await register(k)).json().client_id;
    const { challenge } = pkce();
    const fields = { response_type: 'code', client_id: clientId, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: 'S256', decision: 'allow', 'tick:rota:read': '1', 'org:demo': '1' };
    const cookie = await k.as(PRIYA);
    expect((await form(k, '/oauth/authorize', fields, { cookie, origin: 'https://evil.example', host: 'rota.example' })).statusCode).toBe(403);
    const { 'tick:rota:read': _, ...none } = fields;
    expect((await form(k, '/oauth/authorize', none, { cookie })).statusCode).toBe(400);
    const denied = await form(k, '/oauth/authorize', { ...fields, decision: 'deny' }, { cookie });
    expect(new URL(denied.headers.location as string).searchParams.get('error')).toBe('access_denied');
  });

  it('refuses a signed-in person with no access record in the organisation', async () => {
    const k = await kit();
    await k.store.createUser(account('founder@example.com'));
    const clientId = (await register(k)).json().client_id;
    const { challenge } = pkce();
    const res = await k.app.inject({
      method: 'GET',
      url: `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: 'S256' })}`,
      headers: { cookie: await k.as('founder@example.com') },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('access record');
  });

  it('rotates on refresh, and ends the whole connection when an old refresh token comes back', async () => {
    const k = await kit();
    const c = await connect(k);
    const refreshed = (await form(k, '/oauth/token', { grant_type: 'refresh_token', refresh_token: c.tokens.refresh_token, client_id: c.clientId })).json();
    expect(refreshed.access_token).toMatch(/^pso_/);
    expect((await mcp(k, c.tokens.access_token, 'ping')).statusCode).toBe(401);
    expect((await mcp(k, refreshed.access_token, 'ping')).statusCode).toBe(200);
    // The first refresh token, replayed: someone has a copy, so nothing from this grant works any more.
    const replay = await form(k, '/oauth/token', { grant_type: 'refresh_token', refresh_token: c.tokens.refresh_token, client_id: c.clientId });
    expect(replay.json().error).toBe('invalid_grant');
    expect((await mcp(k, refreshed.access_token, 'ping')).statusCode).toBe(401);
    expect((await form(k, '/oauth/token', { grant_type: 'refresh_token', refresh_token: refreshed.refresh_token })).json().error).toBe('invalid_grant');
  });

  it('ends on a password reset, on revocation, and on disconnect, and records each in the audit trail', async () => {
    const k = await kit();
    const reset = await connect(k);
    await k.store.updateUser(PRIYA, { sessionsValidFrom: Date.now() + 1 });
    expect((await mcp(k, reset.tokens.access_token, 'ping')).statusCode).toBe(401);

    const k2 = await kit();
    const revoked = await connect(k2);
    expect((await form(k2, '/oauth/revoke', { token: revoked.tokens.refresh_token })).statusCode).toBe(200);
    expect((await mcp(k2, revoked.tokens.access_token, 'ping')).statusCode).toBe(401);

    const kept = await connect(k2);
    const list = await k2.app.inject({ method: 'GET', url: '/oauth/connections', headers: { cookie: kept.cookie } });
    expect(list.body).toContain('Claude');
    expect(list.body).toContain('href="/app/"');
    const id = list.body.match(/\/oauth\/connections\/(grant_[^/]+)\/revoke/)![1];
    const gone = await k2.app.inject({ method: 'POST', url: `/oauth/connections/${id}/revoke`, headers: { cookie: kept.cookie } });
    expect(gone.statusCode).toBe(303);
    expect((await mcp(k2, kept.tokens.access_token, 'ping')).statusCode).toBe(401);
    const actions = (await k2.store.load('demo')).audit.map((a) => a.action);
    expect(actions.filter((a) => a === 'oauth.connected')).toHaveLength(2);
    expect(actions.filter((a) => a === 'oauth.revoked')).toHaveLength(2);
  });

  it('never counts as having passed the authenticator, so strong rights stay in the app', async () => {
    const k = await kit();
    // The owner holds settings.manage, a right that needs an authenticator code in each session.
    const c = await connect(k, 'olivia@marylebonegroup.example', ['rota:read']);
    const me = (await k.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${c.tokens.access_token}` } })).json();
    expect(me.user.id).toBe('usr_owner');
    expect(me.permissions).toContain('rota.view');
    expect(me.permissions).not.toContain('settings.manage');
    expect(me.permissions).not.toContain('pay.approve');
  });

  describe('across several organisations', () => {
    /** Priya works for two clients, and has an account but no access record at a third. */
    async function twoClients() {
      const k = await kit({ store: new MemoryStore(['demo', 'acme'], TODAY) });
      const acme = await k.store.load('acme');
      acme.state.entities = acme.state.entities.map((e, i) => ({ ...e, name: i === 0 ? 'Acme Hospitality Ltd' : e.name }));
      await k.store.save(acme);
      await k.store.save(await k.store.load('ghost'));
      await k.store.updateUser(PRIYA, { orgs: ['demo', 'acme', 'ghost'] });
      return k;
    }
    const call = (k: Kit, bearer: string, name: string, args: Record<string, unknown> = {}) =>
      mcp(k, bearer, 'tools/call', { name, arguments: args }).then((r) => r.json().result);

    it('offers every organisation the person works in, ticked, and says which are left out and why', async () => {
      const k = await twoClients();
      const clientId = (await register(k)).json().client_id;
      const page = await k.app.inject({
        method: 'GET',
        url: `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: CALLBACK, code_challenge: pkce().challenge, code_challenge_method: 'S256' })}`,
        headers: { cookie: await k.as(PRIYA) },
      });
      expect(page.body).toContain('name="org:demo" value="1" checked');
      expect(page.body).toContain('name="org:acme" value="1" checked');
      expect(page.body).not.toContain('name="org:ghost"');
      expect(page.body).toContain('ghost (no access record)');
    });

    it('reaches each ticked organisation by name, and never guesses between them', async () => {
      const k = await twoClients();
      const { tokens } = await connect(k, PRIYA, ['rota:read'], ['demo', 'acme']);
      const listed = await call(k, tokens.access_token, 'list_organisations');
      expect(listed.structuredContent.organisations.map((o: { id: string }) => o.id)).toEqual(['demo', 'acme']);
      expect(listed.structuredContent.organisations[1].name).toContain('Acme Hospitality Ltd');

      const unnamed = await call(k, tokens.access_token, 'list_sites');
      expect(unnamed.isError).toBe(true);
      expect(unnamed.content[0].text).toContain('reaches 2 organisations');

      const atAcme = await call(k, tokens.access_token, 'list_sites', { organisation: 'acme' });
      expect(atAcme.isError).toBe(false);
      // Her own sites at that client, as her access record there says.
      expect(JSON.parse(atAcme.content[0].text).map((s: { id: string }) => s.id)).toEqual(['mar']);
      expect((await call(k, tokens.access_token, 'list_sites', { organisation: 'ghost' })).content[0].text).toContain('does not reach');

      // Each organisation's own audit trail records the connection.
      for (const orgId of ['demo', 'acme']) expect((await k.store.load(orgId)).audit.some((a) => a.action === 'oauth.connected')).toBe(true);
    });

    it('acts in the one organisation ticked without being told', async () => {
      const k = await twoClients();
      const { tokens } = await connect(k, PRIYA, ['rota:read'], ['acme']);
      expect((await call(k, tokens.access_token, 'list_organisations')).structuredContent.organisations.map((o: { id: string }) => o.id)).toEqual(['acme']);
      expect((await call(k, tokens.access_token, 'list_sites')).isError).toBe(false);
      expect((await call(k, tokens.access_token, 'list_sites', { organisation: 'demo' })).content[0].text).toContain('does not reach');
    });

    it('drops an organisation the person leaves, at once, and keeps the rest', async () => {
      const k = await twoClients();
      const { tokens } = await connect(k, PRIYA, ['rota:read'], ['demo', 'acme']);
      await k.store.updateUser(PRIYA, { orgs: ['demo'] });
      expect((await call(k, tokens.access_token, 'list_organisations')).structuredContent.organisations.map((o: { id: string }) => o.id)).toEqual(['demo']);
      expect((await call(k, tokens.access_token, 'list_sites', { organisation: 'acme' })).content[0].text).toContain('does not reach');
      expect((await call(k, tokens.access_token, 'list_sites')).isError).toBe(false);
    });

    it('keeps connections made before they reached several organisations working', async () => {
      const k = await twoClients();
      const c = await connect(k, PRIYA, ['rota:read'], ['acme']);
      const page = await k.app.inject({ method: 'GET', url: '/oauth/connections', headers: { cookie: c.cookie } });
      const id = page.body.match(/\/oauth\/connections\/(grant_[^/]+)\/revoke/)![1];
      const stored = JSON.parse((await k.store.getSetting(`oauth:grant:${id}`))!);
      const { orgs, ...legacy } = stored;
      await k.store.setSetting(`oauth:grant:${id}`, JSON.stringify({ ...legacy, orgId: orgs[0].orgId, userId: orgs[0].userId }));
      expect((await call(k, c.tokens.access_token, 'list_organisations')).structuredContent.organisations.map((o: { id: string }) => o.id)).toEqual(['acme']);
      expect((await call(k, c.tokens.access_token, 'list_sites')).isError).toBe(false);
    });

    it('makes a direct API call name its organisation', async () => {
      const k = await twoClients();
      const { tokens } = await connect(k, PRIYA, ['rota:read'], ['demo', 'acme']);
      const auth = { authorization: `Bearer ${tokens.access_token}` };
      const unnamed = await k.app.inject({ method: 'GET', url: '/v1/sites', headers: auth });
      expect(unnamed.statusCode).toBe(400);
      expect(unnamed.json().error).toBe('organisation_required');
      expect((await k.app.inject({ method: 'GET', url: '/v1/sites', headers: { ...auth, 'x-preshift-organisation': 'acme' } })).statusCode).toBe(200);
      expect((await k.app.inject({ method: 'GET', url: '/v1/sites', headers: { ...auth, 'x-preshift-organisation': 'ghost' } })).statusCode).toBe(403);
    });

    it('lists every connection with its organisations, and one disconnect ends it everywhere', async () => {
      const k = await twoClients();
      const c = await connect(k, PRIYA, ['rota:read'], ['demo', 'acme']);
      const page = await k.app.inject({ method: 'GET', url: '/oauth/connections', headers: { cookie: c.cookie } });
      expect(page.body).toContain('Acme Hospitality Ltd');
      const id = page.body.match(/\/oauth\/connections\/(grant_[^/]+)\/revoke/)![1];
      await k.app.inject({ method: 'POST', url: `/oauth/connections/${id}/revoke`, headers: { cookie: c.cookie } });
      expect((await mcp(k, c.tokens.access_token, 'ping')).statusCode).toBe(401);
      for (const orgId of ['demo', 'acme']) expect((await k.store.load(orgId)).audit.some((a) => a.action === 'oauth.revoked')).toBe(true);
    });
  });
});
