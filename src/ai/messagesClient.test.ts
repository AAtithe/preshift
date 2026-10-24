import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { messagesClient, MessagesApiError, MessagesConnectionError, type MessageParams } from './messagesClient';
import { describeAgentError } from './rotaAgent';

const params: MessageParams = {
  model: 'claude-test',
  max_tokens: 100,
  betas: ['server-side-fallback-2026-07-01', 'another-beta'],
  messages: [{ role: 'user', content: 'Hello' }],
};
const reply = { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Hi' }], stop_reason: 'end_turn' };
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A fetch that answers from a list in turn and keeps every request it was given. */
function fakeFetch(...answers: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    const next = answers.shift();
    if (!next) throw new Error('no more answers');
    if (next instanceof Error) throw next;
    return next;
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

describe('the browser messages client', () => {
  it('sends what the SDK sends: the beta endpoint, betas as a header, the rest as the body', async () => {
    const f = fakeFetch(json(200, reply));
    const client = messagesClient({ baseURL: 'https://app.example/api/anthropic', fetch: f.fetch });
    expect(await client.beta.messages.create(params)).toEqual(reply);
    const [{ url, init }] = f.calls;
    expect(url).toBe('https://app.example/api/anthropic/v1/messages?beta=true');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    // Exactly the headers our proxy passes on to Claude.
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['anthropic-beta']).toBe('server-side-fallback-2026-07-01,another-beta');
    expect(headers['content-type']).toBe('application/json');
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({ model: 'claude-test', max_tokens: 100, messages: [{ role: 'user', content: 'Hello' }] });
  });

  it('tries again after an overload or a dropped connection, then succeeds', async () => {
    const f = fakeFetch(json(529, { error: { type: 'overloaded_error' } }, { 'retry-after-ms': '1' }), new TypeError('Failed to fetch'), json(200, reply));
    vi.spyOn(Math, 'random').mockReturnValue(1); // the shortest back-off, so the test is quick
    const client = messagesClient({ baseURL: '', fetch: f.fetch, maxRetries: 2 });
    expect(await client.beta.messages.create(params)).toEqual(reply);
    expect(f.calls).toHaveLength(3);
    vi.restoreAllMocks();
  });

  it('gives up after its retries, keeping the last status and body', async () => {
    const busy = () => json(429, { type: 'error', error: { type: 'rate_limit_error', message: 'Slow down' } }, { 'retry-after-ms': '1' });
    const f = fakeFetch(busy(), busy(), busy());
    const client = messagesClient({ baseURL: '', fetch: f.fetch, maxRetries: 2 });
    const err = await client.beta.messages.create(params).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(MessagesApiError);
    expect((err as MessagesApiError).status).toBe(429);
    expect((err as MessagesApiError).message).toBe('Slow down');
    expect(f.calls).toHaveLength(3);
  });

  it('never retries a refusal it will get again, such as a spend limit', async () => {
    const f = fakeFetch(json(403, { type: 'error', error: { type: 'spend_limit', message: 'This month is spent.' } }));
    const client = messagesClient({ baseURL: '', fetch: f.fetch });
    await expect(client.beta.messages.create(params)).rejects.toBeInstanceOf(MessagesApiError);
    expect(f.calls).toHaveLength(1);
  });

  it('reports a connection that never answers as such once the retries are spent', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    vi.useFakeTimers();
    const f = fakeFetch(new TypeError('Failed to fetch'), new TypeError('Failed to fetch'));
    const client = messagesClient({ baseURL: '', fetch: f.fetch, maxRetries: 1 });
    const pending = client.beta.messages.create(params).then(() => null, (e: unknown) => e);
    await vi.runAllTimersAsync();
    expect(await pending).toBeInstanceOf(MessagesConnectionError);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('stops at once when the manager stops it, and does not try again', async () => {
    const controller = new AbortController();
    const f = fakeFetch();
    const hanging = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
    }));
    const client = messagesClient({ baseURL: '', fetch: hanging as unknown as typeof fetch });
    const pending = client.beta.messages.create(params, { signal: controller.signal }).then(() => null, (e: unknown) => e);
    controller.abort();
    const err = await pending;
    expect(describeAgentError(err)).toBe('Stopped.');
    expect(hanging).toHaveBeenCalledTimes(1);
    expect(f.calls).toHaveLength(0);
  });
});

describe('what the manager is told when the assistant fails', () => {
  const api = (status: number, type: string, message: string) => new MessagesApiError(status, { type: 'error', error: { type, message } });

  it('reads our proxy refusals from the browser client', () => {
    expect(describeAgentError(api(401, 'session_expired', 'Sign in'))).toMatch(/session has ended/);
    expect(describeAgentError(api(403, 'demo', 'Not in this demo.'))).toBe('Not in this demo.');
    expect(describeAgentError(api(403, 'spend_limit', 'This month is spent.'))).toBe('This month is spent.');
    expect(describeAgentError(api(403, 'not_configured', 'x'))).toMatch(/not set up yet/);
    expect(describeAgentError(api(401, 'authentication_error', 'bad key'))).toMatch(/did not accept the saved API key/);
    expect(describeAgentError(api(429, 'rate_limit_error', 'x'))).toMatch(/busy/);
    expect(describeAgentError(api(500, 'api_error', 'x'))).toBe('The assistant returned an error (500). Try again.');
    expect(describeAgentError(new MessagesConnectionError('Failed to fetch'))).toMatch(/Could not reach/);
  });

  it('reads the same refusals off the SDK errors the evals and server see', () => {
    const sdk = (status: number, type: string) => Anthropic.APIError.generate(status, { type: 'error', error: { type, message: 'm' } }, 'm', new Headers());
    expect(describeAgentError(sdk(401, 'session_expired'))).toMatch(/session has ended/);
    expect(describeAgentError(sdk(403, 'spend_limit'))).toBe('m');
    expect(describeAgentError(sdk(429, 'rate_limit_error'))).toMatch(/busy/);
    expect(describeAgentError(new Anthropic.APIUserAbortError())).toBe('Stopped.');
    expect(describeAgentError(new Anthropic.APIConnectionError({ message: 'down' }))).toMatch(/Could not reach/);
  });
});
