import type { FastifyInstance } from 'fastify';

// Server side of the rota assistant: adds the Claude API key and forwards only
// the assistant's own requests, so a public deployment cannot be used as a
// general-purpose Claude endpoint on our key.
const MODEL = 'claude-opus-5-5';
const MAX_TOKENS = 16000;
const FORWARDED_HEADERS = ['anthropic-version', 'anthropic-beta', 'content-type'];

export function anthropicRoutes(app: FastifyInstance, env: NodeJS.ProcessEnv) {
  app.post('/api/anthropic/v1/messages', { schema: { hide: true } }, async (req, reply) => {
    const fail = (status: number, message: string) =>
      reply.code(status).send({ type: 'error', error: { type: 'proxy_error', message } });

    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) return fail(403, 'The rota assistant is not configured on this deployment.');
    const raw = (req as unknown as { rawBody?: string }).rawBody ?? '';
    const params = req.body as { model?: string; max_tokens?: number; stream?: boolean } | undefined;
    if (!params || params.model !== MODEL || !((params.max_tokens ?? Infinity) <= MAX_TOKENS) || params.stream) {
      return fail(400, 'Only rota assistant requests are accepted.');
    }

    const headers: Record<string, string> = { 'x-api-key': apiKey };
    for (const name of FORWARDED_HEADERS) {
      const value = req.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    const search = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const upstream = await fetch(`https://api.anthropic.com/v1/messages${search}`, { method: 'POST', headers, body: raw });
    return reply
      .code(upstream.status)
      .header('content-type', upstream.headers.get('content-type') ?? 'application/json')
      .send(Buffer.from(await upstream.arrayBuffer()));
  });
}
