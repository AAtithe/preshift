// Signed session cookies for people signing in to the web app. Web Crypto only, so the same
// code runs in the Preshift API, the Vercel functions and the Vite dev server.

export const COOKIE = 'ps_session';
export const SESSION_SECONDS = 12 * 60 * 60; // one working day; GMs sign in once per shift

export interface SessionUser {
  email: string;
  orgId: string;
}

const encoder = new TextEncoder();

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function hmacKey(secret: string) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export function sessionSecret(env: Record<string, string | undefined> = process.env): string | null {
  const secret = env.SESSION_SECRET;
  return secret && secret.length >= 32 ? secret : null;
}

export async function createSession(user: SessionUser, secret: string, now = Date.now()): Promise<string> {
  const claims = { sub: user.email, org: user.orgId, exp: Math.floor(now / 1000) + SESSION_SECONDS };
  const payload = b64url(encoder.encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(payload));
  return `${payload}.${b64url(sig)}`;
}

/** The signed-in user, or null for a missing, forged or expired token. */
export async function readSession(token: string | null | undefined, secret: string | null, now = Date.now()): Promise<SessionUser | null> {
  if (!token || !secret) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64url(sig), encoder.encode(payload));
    if (!ok) return null;
    const { sub, org, exp } = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    if (typeof sub !== 'string' || typeof org !== 'string' || typeof exp !== 'number' || exp * 1000 <= now) return null;
    return { email: sub, orgId: org };
  } catch {
    return null;
  }
}

export function cookieFrom(header: string | null | undefined, name = COOKIE): string | null {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

export function sessionCookie(request: Request, token: string, maxAge = SESSION_SECONDS): string {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export async function currentUser(request: Request): Promise<SessionUser | null> {
  return readSession(cookieFrom(request.headers.get('cookie')), sessionSecret());
}

/** Only same-site paths, so the sign-in form cannot be used to bounce people to another site. */
export function safeNext(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\')
    ? value
    : fallback;
}

/**
 * Null when the request may continue. Otherwise the response to send instead:
 * a JSON 401 for API calls, a redirect to the sign-in page for pages.
 */
export async function requireSession(request: Request): Promise<Response | null> {
  if (await currentUser(request)) return null;
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/')) {
    return Response.json(
      { type: 'error', error: { type: 'session_expired', message: 'Sign in to continue.' } },
      { status: 401 },
    );
  }
  // Relative, so it stays on whatever host the person used, however the request was proxied.
  const next = new URLSearchParams({ next: url.pathname + url.search });
  return new Response(null, { status: 303, headers: { location: `/login?${next}` } });
}
