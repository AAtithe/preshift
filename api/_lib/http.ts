export function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

// Requiring a JSON body means a cross-site form post cannot reach a state-changing endpoint:
// browsers will not send application/json cross-origin without a CORS preflight we never approve.
export async function readJson<T>(request: Request): Promise<T | null> {
  if (!request.headers.get('content-type')?.includes('application/json')) return null;
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}
