// Sign in with Preshift for Claude and other MCP clients: OAuth 2.1 with PKCE, dynamic client
// registration, and the discovery documents the MCP authorisation spec asks for. claude.ai finds
// all of it from the connector's address alone, so nobody copies a key anywhere.
//
// A token acts as the person who approved it, exactly as a personal API key does: their roles
// decide site by site, it never counts as having passed the authenticator (so pay approval and
// other strong rights stay in the app), and it carries only the scopes they ticked. Removing the
// person, suspending them or resetting their password ends every token they gave. Everything is
// kept in the settings store, hashed, so it works on Vercel with no new tables.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiKey, Scope } from './auth';
import { SCOPES } from './auth';
import { isSandbox } from './sandbox';
import { cookieFrom, readSession } from './session';
import { audit, orgsOfAccount, type Store, type UserStore } from './store';

export const ACCESS_PREFIX = 'pso_';
const REFRESH_PREFIX = 'psr_';
const ACCESS_SECONDS = 60 * 60;
const REFRESH_SECONDS = 30 * 24 * 60 * 60;
const CODE_SECONDS = 5 * 60;

/** What a person may hand Claude. Pay changes, payroll, HR files, webhooks and keys stay in the app. */
export const OAUTH_SCOPES = ['rota:read', 'employees:read', 'rota:write', 'time:approve'] as const;
const DEFAULT_SCOPES: Scope[] = ['rota:read'];

interface OAuthClient {
  id: string;
  name: string;
  redirectUris: string[];
  createdAt: string;
}

interface OAuthCode {
  clientId: string;
  redirectUri: string;
  challenge: string;
  scopes: Scope[];
  orgId: string;
  userId: string;
  email: string;
  expiresAt: number;
}

/** One person's approval of one client in one organisation. Its tokens rotate; the grant stays. */
export interface OAuthGrant {
  id: string;
  clientId: string;
  clientName: string;
  orgId: string;
  userId: string;
  email: string;
  scopes: Scope[];
  createdAt: string;
  /** Epoch milliseconds of the approval, compared with the account's sessionsValidFrom. */
  issuedAt: number;
  accessHash: string;
  accessExpiresAt: number;
  refreshHash: string;
  refreshExpiresAt: number;
  lastUsedAt?: string;
  revokedAt?: string;
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const token = (prefix: string) => `${prefix}${randomBytes(32).toString('base64url')}`;
const nowSeconds = () => Math.floor(Date.now() / 1000);

const key = {
  client: (id: string) => `oauth:client:${id}`,
  code: (h: string) => `oauth:code:${h}`,
  codeUsed: (h: string) => `oauth:code-used:${h}`,
  grant: (id: string) => `oauth:grant:${id}`,
  access: (h: string) => `oauth:access:${h}`,
  refresh: (h: string) => `oauth:refresh:${h}`,
  refreshUsed: (h: string) => `oauth:refresh-used:${h}`,
  person: (email: string, orgId: string) => `oauth:person:${email.toLowerCase()}:${orgId}`,
};

async function readJson<T>(store: UserStore, k: string): Promise<T | null> {
  const raw = await store.getSetting(k);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
const writeJson = (store: UserStore, k: string, v: unknown) => store.setSetting(k, JSON.stringify(v));

/** Whoever marks the key first wins: two requests racing with one code or refresh token, only one succeeds. */
async function claimOnce(store: UserStore, k: string, value: string) {
  const nonce = `${value}:${randomUUID()}`;
  return (await store.settingOnce(k, () => nonce)) === nonce;
}

async function saveGrant(store: UserStore, g: OAuthGrant) {
  await writeJson(store, key.grant(g.id), g);
}

/** Fresh tokens for a grant. The previous access and refresh tokens stop working at once. */
async function issueTokens(store: UserStore, g: OAuthGrant) {
  if (g.accessHash) await store.setSetting(key.access(g.accessHash), null);
  if (g.refreshHash) await store.setSetting(key.refresh(g.refreshHash), null);
  const access = token(ACCESS_PREFIX);
  const refresh = token(REFRESH_PREFIX);
  g.accessHash = hash(access);
  g.accessExpiresAt = nowSeconds() + ACCESS_SECONDS;
  g.refreshHash = hash(refresh);
  g.refreshExpiresAt = nowSeconds() + REFRESH_SECONDS;
  await store.setSetting(key.access(g.accessHash), g.id);
  await store.setSetting(key.refresh(g.refreshHash), g.id);
  await saveGrant(store, g);
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_SECONDS, refresh_token: refresh, scope: g.scopes.join(' ') };
}

async function revokeGrant(store: Store, g: OAuthGrant, by: string) {
  if (g.revokedAt) return;
  g.revokedAt = new Date().toISOString();
  await store.setSetting(key.access(g.accessHash), null);
  await store.setSetting(key.refresh(g.refreshHash), null);
  await saveGrant(store, g);
  const org = await store.load(g.orgId);
  audit(org, by, 'oauth.revoked', { id: g.id, client: g.clientName, email: g.email });
  await store.save(org);
}

/** The account still exists, still belongs to the organisation, and has not reset its password since. */
async function accountStands(store: UserStore, g: OAuthGrant) {
  const account = await store.getUser(g.email);
  return !!account && orgsOfAccount(account).includes(g.orgId) && g.issuedAt >= account.sessionsValidFrom;
}

/**
 * The principal for a bearer token from this server, or null. Acts as its person, like a personal
 * key: their roles decide, the authenticator is never counted as passed.
 */
export async function oauthPrincipal(bearer: string, store: UserStore): Promise<ApiKey | null> {
  const grantId = await store.getSetting(key.access(hash(bearer)));
  if (!grantId) return null;
  const g = await readJson<OAuthGrant>(store, key.grant(grantId));
  if (!g || g.revokedAt || g.accessHash !== hash(bearer) || g.accessExpiresAt <= nowSeconds()) return null;
  if (!(await accountStands(store, g))) return null;
  if (!g.lastUsedAt || Date.now() - Date.parse(g.lastUsedAt) > 5 * 60_000) await saveGrant(store, { ...g, lastUsedAt: new Date().toISOString() });
  return { key: `oauth:${g.id}`, keyId: `oauth:${g.id}`, orgId: g.orgId, name: `${g.clientName} for ${g.email}`, scopes: g.scopes, userId: g.userId, mfa: false };
}

/** The address people reach Preshift on, for the discovery documents and the issuer. */
export function baseUrl(req: FastifyRequest, env: NodeJS.ProcessEnv = process.env) {
  if (env.PRESHIFT_PUBLIC_URL) return env.PRESHIFT_PUBLIC_URL.replace(/\/+$/, '');
  const proto = req.headers['x-forwarded-proto'] === 'https' || req.protocol === 'https' ? 'https' : 'http';
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost');
  return `${proto}://${host.split(',')[0].trim()}`;
}

export const resourceMetadataUrl = (req: FastifyRequest) => `${baseUrl(req)}/.well-known/oauth-protected-resource/mcp`;

/** https anywhere, or http on this machine for desktop and command line clients. No fragments, no credentials. */
function redirectAllowed(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > 2000) return false;
  try {
    const u = new URL(raw);
    if (u.hash || u.username || u.password) return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

const S256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
const PKCE = /^[A-Za-z0-9._~-]{43,128}$/;

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>
<style>:root{color-scheme:light dark;--bg:#f7f6f3;--card:#fff;--ink:#1d1d1b;--quiet:#5f5e5a;--line:#dcdad3;--accent:#1f4e79}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#20201e;--ink:#eeede9;--quiet:#a8a6a0;--line:#3a3935;--accent:#7fb0dd}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,sans-serif}main{max-width:520px;margin:48px auto;padding:0 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:24px}h1{font-size:20px;margin:0 0 12px}p{margin:0 0 12px}.quiet{color:var(--quiet);font-size:13px}
label{display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-top:1px solid var(--line)}label span b{display:block;font-weight:600}
.row{display:flex;gap:12px;margin-top:20px}button{font:inherit;padding:10px 18px;border-radius:8px;border:1px solid var(--line);background:none;color:var(--ink);cursor:pointer}
button.go{background:var(--accent);border-color:var(--accent);color:#fff}table{width:100%;border-collapse:collapse}td{padding:8px 0;border-top:1px solid var(--line);vertical-align:top}</style></head>
<body><main><div class="card">${body}</div></main></body></html>`;
}

const html = (reply: FastifyReply, code: number, title: string, body: string) =>
  reply.code(code).type('text/html; charset=utf-8').header('cache-control', 'no-store').header('x-frame-options', 'DENY').send(page(title, body));

/** A form post from this site only: a page elsewhere cannot approve on someone's behalf. */
function sameSite(req: FastifyRequest) {
  const origin = req.headers.origin;
  if (!origin) return req.headers['sec-fetch-site'] === undefined || req.headers['sec-fetch-site'] === 'same-origin';
  try {
    return new URL(origin).host === (req.headers['x-forwarded-host'] ?? req.headers.host);
  } catch {
    return false;
  }
}

const cors = (reply: FastifyReply) => reply.header('access-control-allow-origin', '*').header('access-control-allow-headers', 'authorization, content-type, mcp-protocol-version');

function chosenScopes(raw: unknown): Scope[] {
  const asked = (Array.isArray(raw) ? raw.join(' ') : String(raw ?? '')).split(/[\s,]+/).filter(Boolean);
  return OAUTH_SCOPES.filter((s) => asked.includes(s));
}

interface AuthorizeParams {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  state?: string;
  scope?: string | string[];
  resource?: string;
}

export function oauthRoutes(app: FastifyInstance, store: Store) {
  const hidden = { schema: { hide: true } };

  const resourceDoc = async (req: FastifyRequest, reply: FastifyReply) =>
    cors(reply).send({
      resource: `${baseUrl(req)}/mcp`,
      authorization_servers: [baseUrl(req)],
      scopes_supported: OAUTH_SCOPES,
      bearer_methods_supported: ['header'],
      resource_name: 'Preshift',
    });
  app.get('/.well-known/oauth-protected-resource', hidden, resourceDoc);
  app.get('/.well-known/oauth-protected-resource/mcp', hidden, resourceDoc);

  app.get('/.well-known/oauth-authorization-server', hidden, async (req, reply) => {
    const base = baseUrl(req);
    return cors(reply).send({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: OAUTH_SCOPES,
      authorization_response_iss_parameter_supported: true,
    });
  });

  const preflight = async (_req: FastifyRequest, reply: FastifyReply) => cors(reply).code(204).send();
  app.options('/oauth/register', hidden, preflight);
  app.options('/oauth/token', hidden, preflight);
  app.options('/oauth/revoke', hidden, preflight);

  // Dynamic client registration (RFC 7591): claude.ai registers itself the first time it connects.
  app.post<{ Body: { redirect_uris?: unknown; client_name?: unknown } }>('/oauth/register', hidden, async (req, reply) => {
    cors(reply);
    const uris = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris : [];
    if (uris.length === 0 || uris.length > 10 || !uris.every(redirectAllowed)) {
      return reply.code(400).send({ error: 'invalid_redirect_uri', error_description: 'Give one to ten redirect addresses, each https, or http on localhost.' });
    }
    const name = typeof req.body?.client_name === 'string' && req.body.client_name.trim() ? req.body.client_name.trim().slice(0, 100) : 'An MCP client';
    const client: OAuthClient = { id: `psc_${randomUUID()}`, name, redirectUris: uris as string[], createdAt: new Date().toISOString() };
    await writeJson(store, key.client(client.id), client);
    return reply.code(201).send({
      client_id: client.id,
      client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1000),
      client_name: client.name,
      redirect_uris: client.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  });

  /**
   * Checks the request before anyone sees a page. A bad client or redirect is shown here and never
   * redirected, so this endpoint cannot be used to send people to an address nobody registered.
   */
  async function check(p: AuthorizeParams): Promise<{ client: OAuthClient; scopes: Scope[] } | { problem: string } | { redirectError: string; client: OAuthClient }> {
    const client = p.client_id ? await readJson<OAuthClient>(store, key.client(p.client_id)) : null;
    if (!client) return { problem: 'This app is not registered with Preshift. Remove the connector and add it again.' };
    if (!p.redirect_uri || !client.redirectUris.includes(p.redirect_uri)) return { problem: 'This app asked to return to an address it did not register.' };
    if (p.response_type !== 'code') return { redirectError: 'unsupported_response_type', client };
    if (p.code_challenge_method !== 'S256' || !p.code_challenge || !PKCE.test(p.code_challenge)) return { redirectError: 'invalid_request', client };
    const scopes = p.scope === undefined || p.scope === '' ? DEFAULT_SCOPES : chosenScopes(p.scope);
    if (scopes.length === 0) return { redirectError: 'invalid_scope', client };
    return { client, scopes };
  }

  const back = (reply: FastifyReply, req: FastifyRequest, redirectUri: string, params: Record<string, string | undefined>) => {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries({ ...params, iss: baseUrl(req) })) if (v !== undefined) u.searchParams.set(k, v);
    return reply.code(302).header('location', u.toString()).send();
  };

  /** The signed-in person and their access record in the session's organisation, or why not. */
  async function who(req: FastifyRequest) {
    const claims = await readSession(cookieFrom(req.headers.cookie), await store.sessionSecret());
    if (!claims) return null;
    const account = await store.getUser(claims.email);
    if (!account || !orgsOfAccount(account).includes(claims.orgId) || claims.issuedAt < account.sessionsValidFrom) return null;
    const org = await store.load(claims.orgId);
    const record = org.users.find((u) => u.email === account.email.toLowerCase());
    return { account, org, record };
  }

  const orgLabel = (org: { orgId: string; state: { entities: { name: string }[] } }) => org.state.entities.map((e) => e.name).join(', ') || org.orgId;

  const refusal = (org: { orgId: string }, record: { status: string } | undefined) => {
    if (isSandbox(org.orgId)) return 'This is the public demo, so connecting other apps is switched off here.';
    if (!record) return 'You need an access record in this organisation before you can connect an app. Ask whoever manages access.';
    if (record.status === 'invited') return 'Open Preshift once to accept your invitation, then connect again.';
    if (record.status !== 'active') return 'Your access to this organisation is not active.';
    return null;
  };

  app.get<{ Querystring: AuthorizeParams }>('/oauth/authorize', hidden, async (req, reply) => {
    const p = req.query;
    const checked = await check(p);
    if ('problem' in checked) return html(reply, 400, 'Cannot connect', `<h1>Cannot connect</h1><p>${escape(checked.problem)}</p>`);
    if ('redirectError' in checked) return back(reply, req, p.redirect_uri!, { error: checked.redirectError, state: p.state });
    const me = await who(req);
    if (!me) return reply.code(302).header('location', `/login?next=${encodeURIComponent(req.url)}`).send();
    const no = refusal(me.org, me.record);
    if (no) return html(reply, 403, 'Cannot connect', `<h1>Cannot connect</h1><p>${escape(no)}</p>`);
    const host = new URL(p.redirect_uri!).host;
    const hiddenFields = (['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'response_type'] as const)
      .filter((k) => p[k] !== undefined)
      .map((k) => `<input type="hidden" name="${k}" value="${escape(String(p[k]))}">`)
      .join('');
    const boxes = OAUTH_SCOPES.map(
      (s) => `<label><input type="checkbox" name="tick:${s}" value="1"${checked.scopes.includes(s) ? ' checked' : ''}><span><b>${escape(s)}</b>${escape(SCOPES[s])}</span></label>`,
    ).join('');
    return html(
      reply,
      200,
      'Connect to Preshift',
      `<h1>Connect ${escape(checked.client.name)} to Preshift</h1>
<p>${escape(checked.client.name)} will act as you, ${escape(me.record!.name)}, in ${escape(orgLabel(me.org))}. It can only do what you can do, at the sites you can do it, and only what you tick below.</p>
<p class="quiet">It will return to ${escape(host)}. Approving pay, payroll, personnel files and settings stay in Preshift itself. You can disconnect at any time at /oauth/connections.</p>
<form method="post" action="/oauth/authorize">${hiddenFields}${boxes}
<div class="row"><button class="go" name="decision" value="allow">Allow</button><button name="decision" value="deny">Cancel</button></div></form>`,
    );
  });

  app.post<{ Body: AuthorizeParams & Record<string, string> }>('/oauth/authorize', hidden, async (req, reply) => {
    if (!sameSite(req)) return html(reply, 403, 'Cannot connect', '<h1>Cannot connect</h1><p>Approve from the Preshift page itself.</p>');
    const p = req.body ?? {};
    // The scopes come from the boxes ticked, never from the original request.
    const ticked = OAUTH_SCOPES.filter((s) => p[`tick:${s}`] === '1');
    const checked = await check({ ...p, scope: ticked.join(' ') || 'none' });
    if ('problem' in checked) return html(reply, 400, 'Cannot connect', `<h1>Cannot connect</h1><p>${escape(checked.problem)}</p>`);
    if (p.decision !== 'allow') return back(reply, req, p.redirect_uri!, { error: 'access_denied', state: p.state });
    if ('redirectError' in checked) {
      if (checked.redirectError === 'invalid_scope') return html(reply, 400, 'Cannot connect', '<h1>Tick at least one box</h1><p>Go back and choose what the app may do.</p>');
      return back(reply, req, p.redirect_uri!, { error: checked.redirectError, state: p.state });
    }
    const me = await who(req);
    if (!me) return reply.code(302).header('location', '/login').send();
    const no = refusal(me.org, me.record);
    if (no) return html(reply, 403, 'Cannot connect', `<h1>Cannot connect</h1><p>${escape(no)}</p>`);
    const code = randomBytes(32).toString('base64url');
    const record: OAuthCode = {
      clientId: checked.client.id,
      redirectUri: p.redirect_uri!,
      challenge: p.code_challenge!,
      scopes: checked.scopes,
      orgId: me.org.orgId,
      userId: me.record!.id,
      email: me.account.email,
      expiresAt: nowSeconds() + CODE_SECONDS,
    };
    await writeJson(store, key.code(hash(code)), record);
    return back(reply, req, p.redirect_uri!, { code, state: p.state });
  });

  const tokenError = (reply: FastifyReply, error: string, description: string, status = 400) =>
    reply.code(status).header('cache-control', 'no-store').send({ error, error_description: description });

  app.post<{ Body: Record<string, string> }>('/oauth/token', hidden, async (req, reply) => {
    cors(reply);
    const b = req.body ?? {};
    if (b.grant_type === 'authorization_code') {
      const h = hash(String(b.code ?? ''));
      const c = await readJson<OAuthCode>(store, key.code(h));
      if (!c || c.expiresAt <= nowSeconds()) return tokenError(reply, 'invalid_grant', 'That code is unknown, used or expired.');
      if (c.clientId !== b.client_id || c.redirectUri !== b.redirect_uri) return tokenError(reply, 'invalid_grant', 'That code was issued to another app or address.');
      if (typeof b.code_verifier !== 'string' || !PKCE.test(b.code_verifier) || S256(b.code_verifier) !== c.challenge) return tokenError(reply, 'invalid_grant', 'The code verifier does not match.');
      if (!(await claimOnce(store, key.codeUsed(h), c.clientId))) return tokenError(reply, 'invalid_grant', 'That code is unknown, used or expired.');
      await store.setSetting(key.code(h), null);
      const client = await readJson<OAuthClient>(store, key.client(c.clientId));
      const g: OAuthGrant = {
        id: `grant_${randomUUID()}`,
        clientId: c.clientId,
        clientName: client?.name ?? 'An MCP client',
        orgId: c.orgId,
        userId: c.userId,
        email: c.email,
        scopes: c.scopes,
        createdAt: new Date().toISOString(),
        issuedAt: Date.now(),
        accessHash: '',
        accessExpiresAt: 0,
        refreshHash: '',
        refreshExpiresAt: 0,
      };
      const issued = await issueTokens(store, g);
      const index = (await readJson<string[]>(store, key.person(g.email, g.orgId))) ?? [];
      await writeJson(store, key.person(g.email, g.orgId), [...index, g.id].slice(-50));
      const org = await store.load(g.orgId);
      audit(org, g.email, 'oauth.connected', { id: g.id, client: g.clientName, scopes: g.scopes });
      await store.save(org);
      return reply.header('cache-control', 'no-store').send(issued);
    }
    if (b.grant_type === 'refresh_token') {
      const h = hash(String(b.refresh_token ?? ''));
      const grantId = await store.getSetting(key.refresh(h));
      if (!grantId) {
        // A refresh token used twice means it was copied: end the whole grant, as OAuth 2.1 advises.
        const used = await store.getSetting(key.refreshUsed(h));
        const reused = used ? await readJson<OAuthGrant>(store, key.grant(used.split(':')[0])) : null;
        if (reused) await revokeGrant(store, reused, 'Preshift (refresh token reused)');
        return tokenError(reply, 'invalid_grant', 'That refresh token is unknown, used or expired.');
      }
      const g = await readJson<OAuthGrant>(store, key.grant(grantId));
      if (!g || g.revokedAt || g.refreshHash !== h || g.refreshExpiresAt <= nowSeconds()) return tokenError(reply, 'invalid_grant', 'That refresh token is unknown, used or expired.');
      if (b.client_id && b.client_id !== g.clientId) return tokenError(reply, 'invalid_grant', 'That refresh token belongs to another app.');
      if (!(await accountStands(store, g))) return tokenError(reply, 'invalid_grant', 'Sign in to Preshift again.');
      if (!(await claimOnce(store, key.refreshUsed(h), g.id))) return tokenError(reply, 'invalid_grant', 'That refresh token is unknown, used or expired.');
      // A narrower set may be asked for on refresh, never a wider one.
      if (b.scope) {
        const narrower = chosenScopes(b.scope).filter((s) => g.scopes.includes(s));
        if (narrower.length === 0) return tokenError(reply, 'invalid_scope', 'Ask for scopes this connection already has.');
        g.scopes = narrower;
      }
      return reply.header('cache-control', 'no-store').send(await issueTokens(store, g));
    }
    return tokenError(reply, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
  });

  // Token revocation (RFC 7009): always 200, so it says nothing about which tokens exist.
  app.post<{ Body: Record<string, string> }>('/oauth/revoke', hidden, async (req, reply) => {
    cors(reply);
    const t = String(req.body?.token ?? '');
    const h = hash(t);
    const grantId = (await store.getSetting(key.access(h))) ?? (await store.getSetting(key.refresh(h)));
    const g = grantId ? await readJson<OAuthGrant>(store, key.grant(grantId)) : null;
    if (g) await revokeGrant(store, g, `${g.clientName} for ${g.email}`);
    return reply.code(200).send({});
  });

  // A person's own connections in the organisation they are signed in to, with a disconnect button.
  app.get('/oauth/connections', hidden, async (req, reply) => {
    const me = await who(req);
    if (!me) return reply.code(302).header('location', `/login?next=${encodeURIComponent('/oauth/connections')}`).send();
    const ids = (await readJson<string[]>(store, key.person(me.account.email, me.org.orgId))) ?? [];
    const grants = (await Promise.all(ids.map((id) => readJson<OAuthGrant>(store, key.grant(id))))).filter((g): g is OAuthGrant => !!g && !g.revokedAt);
    const rows = grants
      .map(
        (g) => `<tr><td><b>${escape(g.clientName)}</b><br><span class="quiet">${escape(g.scopes.join(', '))}<br>Connected ${escape(g.createdAt.slice(0, 10))}${g.lastUsedAt ? `, last used ${escape(g.lastUsedAt.slice(0, 10))}` : ''}</span></td>
<td style="text-align:right"><form method="post" action="/oauth/connections/${escape(g.id)}/revoke"><button>Disconnect</button></form></td></tr>`,
      )
      .join('');
    return html(
      reply,
      200,
      'Connected apps',
      `<h1>Connected apps</h1><p>Apps you have let act as you in ${escape(orgLabel(me.org))}. Disconnecting stops them at once.</p>${rows ? `<table>${rows}</table>` : '<p class="quiet">None yet. To connect Claude, add this Preshift address followed by /mcp as a custom connector in Claude.</p>'}<p class="quiet" style="margin-top:20px"><a href="/app/" style="color:inherit">Back to Preshift</a></p>`,
    );
  });

  app.post<{ Params: { id: string } }>('/oauth/connections/:id/revoke', hidden, async (req, reply) => {
    if (!sameSite(req)) return html(reply, 403, 'Refused', '<h1>Refused</h1><p>Disconnect from the Preshift page itself.</p>');
    const me = await who(req);
    if (!me) return reply.code(302).header('location', '/login').send();
    const g = await readJson<OAuthGrant>(store, key.grant(req.params.id));
    // Only your own, in the organisation you are signed in to.
    if (!g || g.email !== me.account.email || g.orgId !== me.org.orgId) return html(reply, 404, 'Not found', '<h1>Not found</h1>');
    await revokeGrant(store, g, me.record?.name ?? me.account.email);
    return reply.code(303).header('location', '/oauth/connections').send();
  });
}
