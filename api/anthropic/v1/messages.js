// Production counterpart of the /api/anthropic proxy in vite.config.ts, run as a Vercel function.
// It adds the API key on the server and only forwards the rota assistant's own requests, so a
// public deployment cannot be used as a general-purpose Claude endpoint on our key. The session
// check repeats the middleware's, so the key stays protected even if the middleware is bypassed.

import { requireSession } from '../../../server/session.js';

const MODEL = 'claude-opus-5-5';
const MAX_TOKENS = 16000;
const FORWARDED_HEADERS = ['anthropic-version', 'anthropic-beta', 'content-type'];

const error = (status, message) =>
  Response.json({ type: 'error', error: { type: 'proxy_error', message } }, { status });

export async function POST(request) {
  const denied = await requireSession(request);
  if (denied) return denied;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return error(403, 'The rota assistant is not configured on this deployment.');

  const body = await request.text();
  let params;
  try {
    params = JSON.parse(body);
  } catch {
    return error(400, 'Body must be JSON.');
  }
  if (params.model !== MODEL || !(params.max_tokens <= MAX_TOKENS) || params.stream) {
    return error(400, 'Only rota assistant requests are accepted.');
  }

  const headers = new Headers({ 'x-api-key': apiKey });
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const { search } = new URL(request.url);
  const upstream = await fetch(`https://api.anthropic.com/v1/messages${search}`, { method: 'POST', headers, body });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  });
}
