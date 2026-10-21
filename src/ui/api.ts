// The web app is a client of the public Preshift API, with no private back door.
// In production it authenticates with the sign-in session cookie and carries no key. The local
// API accepts a development key, which is only ever added to development builds.

const env = (import.meta as unknown as { env: Record<string, string | boolean | undefined> }).env;
const DEMO_KEY = 'preshift.demoKey';

function storedKey(): string | null {
  try {
    return localStorage.getItem(DEMO_KEY);
  } catch {
    return null;
  }
}

// In development the demo can sign in as any seeded person; the choice is this browser's own.
const DEV_KEY = env.DEV ? storedKey() ?? String(env.VITE_PRESHIFT_API_KEY ?? 'dev-key') : null;

/** Only a development build signs in with a key, so only it can switch demo person. */
export const canSwitchDemo = Boolean(DEV_KEY);

export function signInAsDemo(userId: string | null) {
  try {
    if (userId) localStorage.setItem(DEMO_KEY, `dev-${userId}`);
    else localStorage.removeItem(DEMO_KEY);
  } catch {
    // Without storage the demo stays as the owner.
  }
  location.reload();
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      ...(DEV_KEY ? { authorization: `Bearer ${DEV_KEY}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !DEV_KEY) {
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
