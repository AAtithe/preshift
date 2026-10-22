// Claude Opus 5.5 list prices per million tokens. Used for the running cost a manager sees on a
// draft and for the spend limits the server enforces. Approximate: a request a fallback model
// finishes is billed at that model's rates. Check against Anthropic's pricing page when it changes.
export const PRICE_PER_MTOK = { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 };

export interface TokenUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** US dollars for one response's usage. */
export function usageCostUsd(u: TokenUsage): number {
  return (
    ((u.input_tokens ?? 0) * PRICE_PER_MTOK.input +
      (u.output_tokens ?? 0) * PRICE_PER_MTOK.output +
      (u.cache_creation_input_tokens ?? 0) * PRICE_PER_MTOK.cacheWrite +
      (u.cache_read_input_tokens ?? 0) * PRICE_PER_MTOK.cacheRead) /
    1_000_000
  );
}
