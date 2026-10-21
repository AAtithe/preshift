// Signed session cookies and the guard that protects the app. Web Crypto only, so the same
// code runs in Vercel Routing Middleware (edge), Vercel functions (Node) and the Vite dev server.

export const COOKIE = 'ps_session';
export const SESSION_SECONDS = 12 * 60 * 60; // one working day; GMs sign in once per shift

const encoder = new TextEncoder();

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export function sessionSecret() {
  const secret = process.env.SESSION_SECRET;
  return secret && secret.length >= 32 ? secret : null;
}

export async function createSession(email, secret, now = Date.now()) {
  const payload = b64url(encoder.encode(JSON.stringify({ sub: email, exp: Math.floor(now / 1000) + SESSION_SECONDS })));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(payload));
  return `${payload}.${b64url(sig)}`;
}

/** Returns the signed-in email, or null for a missing, forged or expired token. */
export async function readSession(token, secret, now = Date.now()) {
  if (!token || !secret) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64url(sig), encoder.encode(payload));
    if (!ok) return null;
    const { sub, exp } = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    return typeof sub === 'string' && typeof exp === 'number' && exp * 1000 > now ? sub : null;
  } catch {
    return null;
  }
}

export function cookieValue(request, name = COOKIE) {
  const header = request.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

export function sessionCookie(request, token, maxAge = SESSION_SECONDS) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export async function currentUser(request) {
  return readSession(cookieValue(request), sessionSecret());
}

/** Only same-site paths, so the login form cannot be used to bounce people to another site. */
export function safeNext(value, fallback) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\')
    ? value
    : fallback;
}

/**
 * Null when the request may continue. Otherwise the response to send instead:
 * a JSON 401 for API calls, a redirect to the sign-in page for pages.
 */
export async function requireSession(request) {
  if (await currentUser(request)) return null;
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) {
    return Response.json(
      { type: 'error', error: { type: 'session_expired', message: 'Sign in to use the rota assistant.' } },
      { status: 401 },
    );
  }
  const login = new URL('/login', url);
  login.searchParams.set('next', url.pathname + url.search);
  return Response.redirect(login, 303);
}
