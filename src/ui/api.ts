// The web app is a client of the public Preshift API, with no private back door.

const KEY = (import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_PRESHIFT_API_KEY ?? 'dev-key';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${KEY}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
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
  del: (path: string) => request<void>('DELETE', path),
};
