// The one Claude call the browser makes, without the SDK. The full SDK is several hundred
// kilobytes and the app uses a single method of it, so the browser has this instead: the same
// request the SDK sends, the same retries, and errors that say which status came back. The
// server, the evals and the tests keep the SDK; anything with a beta.messages.create fits.
import type Anthropic from '@anthropic-ai/sdk';

export type MessageParams = Anthropic.Beta.MessageCreateParamsNonStreaming;

/** The part of the Anthropic client the agents use. The SDK client satisfies it as it is. */
export interface MessagesClient {
  beta: { messages: { create(params: MessageParams, options?: { signal?: AbortSignal }): PromiseLike<Anthropic.Beta.BetaMessage> } };
}

/** An error response from the API (or from our proxy in front of it), with its parsed body. */
export class MessagesApiError extends Error {
  override name = 'MessagesApiError';
  constructor(readonly status: number, readonly error: unknown) {
    const body = error as { error?: { message?: string } } | undefined;
    super(body?.error?.message ?? `HTTP ${status}`);
  }
}

/** The request never got an answer: offline, DNS, the connection dropped. */
export class MessagesConnectionError extends Error {
  override name = 'MessagesConnectionError';
}

const API_VERSION = '2023-06-01';
// As the SDK: a no-stream request may take a while to write, and a stuck one gives up eventually.
const TIMEOUT_MS = 10 * 60 * 1000;

/** Statuses worth another go, as the SDK decides them. */
function retryable(res: Response): boolean {
  const hint = res.headers.get('x-should-retry');
  if (hint === 'true') return true;
  if (hint === 'false') return false;
  return res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500;
}

/** How long to wait before attempt n+1: what the server asks for, else a jittered back-off up to 8s. */
function delayMs(res: Response | undefined, attempt: number): number {
  const ms = Number(res?.headers.get('retry-after-ms'));
  if (ms > 0 && ms < 60_000) return ms;
  const s = Number(res?.headers.get('retry-after'));
  if (s > 0 && s < 60) return s * 1000;
  return Math.min(500 * 2 ** attempt, 8000) * (1 - Math.random() * 0.25);
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(signal!.reason); };
    signal?.addEventListener('abort', stop, { once: true });
  });
}

/**
 * A client that posts to baseURL + /v1/messages, as the SDK would: betas go in the anthropic-beta
 * header rather than the body, and failures that may pass are tried again up to maxRetries times.
 */
export function messagesClient(options: { baseURL: string; maxRetries?: number; headers?: Record<string, string>; fetch?: typeof fetch }): MessagesClient {
  const maxRetries = options.maxRetries ?? 2;
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));

  async function create(params: MessageParams, { signal }: { signal?: AbortSignal } = {}): Promise<Anthropic.Beta.BetaMessage> {
    const { betas, ...body } = params as MessageParams & { user_profile_id?: unknown; workspace_id?: unknown };
    delete (body as { user_profile_id?: unknown }).user_profile_id;
    delete (body as { workspace_id?: unknown }).workspace_id;
    const headers: Record<string, string> = { 'content-type': 'application/json', 'anthropic-version': API_VERSION, ...options.headers };
    if (betas?.length) headers['anthropic-beta'] = betas.join(',');
    const payload = JSON.stringify(body);

    for (let attempt = 0; ; attempt++) {
      // One controller for the caller's stop and the time limit together. Built by hand rather
      // than with AbortSignal.any, which the iPads still on iOS 16 and early 17 do not have.
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, TIMEOUT_MS);
      const stop = () => controller.abort(signal!.reason);
      if (signal?.aborted) stop();
      signal?.addEventListener('abort', stop, { once: true });
      let res: Response;
      try {
        res = await doFetch(`${options.baseURL}/v1/messages?beta=true`, { method: 'POST', headers, body: payload, signal: controller.signal });
        if (res.ok) return (await res.json()) as Anthropic.Beta.BetaMessage;
      } catch (err) {
        // Stopped by the caller: say so, and never try again.
        if (signal?.aborted) throw signal.reason ?? err;
        if (attempt < maxRetries) {
          await wait(delayMs(undefined, attempt), signal);
          continue;
        }
        throw new MessagesConnectionError(timedOut ? 'The request timed out.' : (err as Error).message || 'Connection error.', { cause: err });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
      }
      if (attempt < maxRetries && retryable(res)) {
        await res.body?.cancel().catch(() => undefined);
        await wait(delayMs(res, attempt), signal);
        continue;
      }
      const text = await res.text().catch(() => '');
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Not JSON: keep the text as the error body.
      }
      throw new MessagesApiError(res.status, parsed);
    }
  }

  return { beta: { messages: { create } } };
}
