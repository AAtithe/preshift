// The web app is a client of the public Preshift API, with no private back door.
// It authenticates with the sign-in session cookie and carries no key, locally as well as live.
// One exception, in development builds only: someone may choose to act as a demo person, and then
// that person's demo key is sent instead, until they go back to their own sign-in.

const env = (import.meta as unknown as { env: Record<string, string | boolean | undefined> }).env;
const DEMO_KEY = 'preshift.demoKey';

function storedKey(): string | null {
  try {
    return localStorage.getItem(DEMO_KEY);
  } catch {
    return null;
  }
}

const DEV_KEY = env.DEV ? storedKey() : null;

/** Only a development build can act as a demo person. */
export const canSwitchDemo = Boolean(env.DEV);
/** Acting as a demo person rather than as the signed-in account. */
export const actingAsDemo = Boolean(DEV_KEY);

export function signInAsDemo(userId: string | null) {
  try {
    if (userId) localStorage.setItem(DEMO_KEY, `dev-${userId}`);
    else localStorage.removeItem(DEMO_KEY);
  } catch {
    // Without storage the demo stays as the signed-in account.
  }
  location.reload();
}

/** The demo people, asked with the development key whoever is signed in. */
export async function demoPeople<T>(): Promise<T> {
  const res = await fetch('/v1/dev/people', { headers: { authorization: 'Bearer dev-key' } });
  if (!res.ok) throw new Error('No demo');
  return res.json();
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    // Session ended: back to sign-in, returning here afterwards.
    window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'http_error', message: res.statusText }));
    throw new ApiError(res.status, err.error, err.message, err.details);
  }
  if (res.status === 204) return undefined as T;
  return (res.headers.get('content-type') ?? '').includes('json') ? res.json() : ((await res.text()) as T);
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  del: <T = void>(path: string) => request<T>('DELETE', path),
};
