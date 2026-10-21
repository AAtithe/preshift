// Signed session cookies for people signing in to the web app. The signing key lives in the
// database (UserStore.sessionSecret), so there is nothing to configure outside the app.

export const COOKIE = 'ps_session';
export const SESSION_SECONDS = 12 * 60 * 60; // one working day; GMs sign in once per shift

export interface SessionClaims {
  email: string;
  orgId: string;
  /** Issued at, epoch milliseconds: compared with the user's sessionsValidFrom. */
  issuedAt: number;
}

const encoder = new TextEncoder();

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function hmacKey(secret: string) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function createSession(user: { email: string; orgId: string }, secret: string, now = Date.now()): Promise<string> {
  // Milliseconds, so a reset refuses every session issued before it, even within the same second.
  const payload = b64url(encoder.encode(JSON.stringify({ sub: user.email, org: user.orgId, iat: now, exp: Math.floor(now / 1000) + SESSION_SECONDS })));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(payload));
  return `${payload}.${b64url(sig)}`;
}

/** The session's claims, or null for a missing, forged or expired token. */
export async function readSession(token: string | null | undefined, secret: string, now = Date.now()): Promise<SessionClaims | null> {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64url(sig), encoder.encode(payload));
    if (!ok) return null;
    const { sub, org, iat, exp } = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    if (typeof sub !== 'string' || typeof org !== 'string' || typeof iat !== 'number' || typeof exp !== 'number') return null;
    if (exp * 1000 <= now) return null;
    return { email: sub, orgId: org, issuedAt: iat };
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

export function sessionCookie(token: string, secure: boolean, maxAge = SESSION_SECONDS): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

/** Only same-site paths, so the sign-in form cannot be used to bounce people to another site. */
export function safeNext(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\')
    ? value
    : fallback;
}
