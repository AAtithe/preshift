import type { FastifyInstance } from 'fastify';
import { usageCostUsd, type TokenUsage } from '../../src/ai/pricing';
import { overLimit, recordSpend } from '../assistantLimits';
import { sessionUser } from '../auth';
import { takeAssistantCall } from '../demo';
import { isSandbox } from '../sandbox';
import type { Store } from '../store';
import { claudeKeySetting } from './access';

// The rota assistant's route to Claude. The organisation's Claude API key is entered by an admin in
// Settings and stays on the server; only signed-in people can use it, and only for the assistant's
// own requests, so this cannot be used as a general-purpose Claude endpoint on the key.
const MODEL = 'claude-opus-5-5';
const MAX_TOKENS = 16000;
const FORWARDED_HEADERS = ['anthropic-version', 'anthropic-beta', 'content-type'];

const error = (type: string, message: string) => ({ type: 'error', error: { type, message } });

/**
 * Demo sandboxes never use a customer's key. They share demoKey (PRESHIFT_DEMO_CLAUDE_KEY), capped per
 * sandbox and per day; without it the assistant says it is not switched on in the demo. Real
 * organisations use their own key from Settings, within the spend limits an admin sets there. Every
 * response is metered.
 */
export function assistantRoutes(app: FastifyInstance, store: Store, options: { demoKey?: string } = {}) {
  app.post('/api/anthropic/v1/messages', { schema: { hide: true } }, async (req, reply) => {
    const user = await sessionUser(req.headers.cookie, store);
    if (!user) return reply.code(401).send(error('session_expired', 'Sign in to use the rota assistant.'));
    const sandbox = isSandbox(user.orgId);
    const apiKey = sandbox ? options.demoKey : await store.getSetting(claudeKeySetting(user.orgId));
    if (!apiKey) {
      return reply.code(403).send(sandbox
        ? error('demo', 'The rota assistant is not switched on in this demo. Book a demo to see it working on your own sites.')
        : error('not_configured', 'An admin needs to add the Claude API key in Settings.'));
    }

    const params = (req.body ?? {}) as { model?: string; max_tokens?: number; stream?: boolean };
    if (params.model !== MODEL || !(Number(params.max_tokens) <= MAX_TOKENS) || params.stream) {
      return reply.code(400).send(error('proxy_error', 'Only rota assistant requests are accepted.'));
    }
    if (sandbox) {
      const limit = await takeAssistantCall(store, user.orgId);
      if (limit) return reply.code(403).send(error('demo', limit));
    } else {
      // 403 rather than 429, so the client does not retry a limit that will not lift for hours.
      const limited = await overLimit(store, user.orgId, user.email);
      if (limited) return reply.code(403).send(error('spend_limit', limited));
    }

    const headers = new Headers({ 'x-api-key': apiKey });
    for (const name of FORWARDED_HEADERS) {
      const value = req.headers[name];
      if (typeof value === 'string') headers.set(name, value);
    }
    const search = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const upstream = await fetch(`https://api.anthropic.com/v1/messages${search}`, {
      method: 'POST',
      headers,
      body: (req as unknown as { rawBody: string }).rawBody,
    });
    const text = await upstream.text();
    if (upstream.ok) {
      try {
        const usage = (JSON.parse(text) as { usage?: TokenUsage }).usage;
        if (usage) await recordSpend(store, user.orgId, user.email, usageCostUsd(usage));
      } catch {
        // An unreadable body still goes back to the client; it just is not metered.
      }
    }
    return reply.code(upstream.status).header('content-type', upstream.headers.get('content-type') ?? 'application/json').send(text);
  });
}
