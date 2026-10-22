// The staff app's calls to its own API, under the staff session cookie.

export class Problem extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Problem(res.status, data.error ?? 'http_error', data.message ?? 'Something went wrong. Try again.');
  return data as T;
}

export const say = (e: unknown) => (e instanceof Problem ? e.message : 'Could not reach Preshift. Check your signal and try again.');
