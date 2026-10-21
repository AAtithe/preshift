import Anthropic from '@anthropic-ai/sdk';
import type { RotaState } from '../engine/types';
import { executeRotaTool, ROTA_TOOLS, type RotaDraft } from './rotaTools';

export const ROTA_MODEL = 'claude-opus-5-5';
const MAX_TURNS = 30;

const SYSTEM_PROMPT = `You write weekly rotas for UK hospitality sites on behalf of the general manager.

You work on a draft through tools. The tools cost every shift the way payroll will (holiday accrual, employer NI, pension, guaranteed hours) and refuse any change that would break UK employment law. Treat a refusal as final for that person and slot and find another way.

Priorities, in order:
1. Legal. Never try to work around a refusal.
2. The manager's instructions in this request. If one cannot be met, say so plainly rather than quietly ignoring it.
3. Cover the forecast. Hours short of headcount are lost sales and a poor guest experience.
4. Labour % at or under the site target. Prefer people already paid for through contracted hours, then the lowest cost legal person. Remove cover in hours that are over the forecast.
5. A fair, workable rota: sensible shift lengths, clear days off, primary roles first, no needless split shifts.

How to work:
- Start with get_rota_status and list_team. Use build_from_forecast as the starting point for an empty or part-built week unless the manager asks otherwise, then refine with add_shift, update_shift and remove_shift.
- Use ids exactly as the tools return them. Never invent people or roles.
- Check get_rota_status again before you finish.

Finish with a short note to the manager in plain British English, no headings and no markdown tables: what you did, the week's labour % against target, any gaps you could not fill and what would fix them (hire, cross-train, accept the gap), and any instruction you could not follow and why. Keep it under 150 words.`;

export interface RotaAgentRequest {
  state: RotaState;
  siteId: string;
  weekStart: string;
  instruction: string;
  today: string;
}

export interface RotaAgentResult {
  state: RotaState;
  summary: string;
  steps: string[];
}

export class RotaAgentError extends Error {}

/**
 * Lets Claude write the rota through the engine's tools, on a copy of the
 * state. Nothing reaches the live rota until the manager accepts the result.
 */
export async function runRotaAgent(
  client: Anthropic,
  req: RotaAgentRequest,
  onStep: (step: string) => void = () => {},
  signal?: AbortSignal,
): Promise<RotaAgentResult> {
  const site = req.state.sites.find((s) => s.id === req.siteId);
  if (!site) throw new RotaAgentError(`Unknown site ${req.siteId}.`);
  const draft: RotaDraft = { state: structuredClone(req.state), siteId: req.siteId, weekStart: req.weekStart };
  const steps: string[] = [];
  const step = (s: string) => {
    steps.push(s);
    onStep(s);
  };

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: 'user',
      content:
        `Site: ${site.name} (id ${site.id}). Week commencing ${req.weekStart}. Labour target ${(site.labourTargetPct * 100).toFixed(1)}%. ` +
        `Today is ${req.today}.\n\nManager's request:\n${req.instruction.trim() || 'Build this week from the forecast.'}`,
    },
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await client.beta.messages.create(
      {
        model: ROTA_MODEL,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'high' },
        cache_control: { type: 'ephemeral' },
        system: SYSTEM_PROMPT,
        tools: ROTA_TOOLS,
        messages,
      },
      { signal },
    );

    // Thinking and fallback blocks must go back unchanged, so keep the whole turn.
    messages.push({ role: 'assistant', content: response.content });

    switch (response.stop_reason) {
      case 'end_turn':
      case 'stop_sequence': {
        const summary = response.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();
        return { state: draft.state, summary, steps };
      }
      case 'pause_turn':
        continue;
      case 'tool_use': {
        const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
        for (const block of response.content) {
          if (block.type !== 'tool_use') continue;
          const outcome = executeRotaTool(draft, block.name, block.input);
          step(outcome.label);
          results.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(outcome.result),
            is_error: outcome.isError,
          });
        }
        messages.push({ role: 'user', content: results });
        continue;
      }
      case 'refusal':
        throw new RotaAgentError('The assistant declined this request. Rephrase it as a rota instruction and try again.');
      case 'max_tokens':
        throw new RotaAgentError('The assistant ran out of room before finishing. Try a narrower request, for example one day at a time.');
      default:
        throw new RotaAgentError(`The assistant stopped unexpectedly (${response.stop_reason ?? 'no reason given'}).`);
    }
  }
  throw new RotaAgentError(`The assistant did not finish within ${MAX_TURNS} steps. The draft so far has not been applied.`);
}

/** Turns SDK failures into something a GM can act on. */
export function describeAgentError(err: unknown): string {
  if (err instanceof RotaAgentError) return err.message;
  if (err instanceof Anthropic.APIUserAbortError) return 'Stopped.';
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return 'The assistant is not connected. Set ANTHROPIC_API_KEY in .env.local for local use, or in the Vercel project settings for the live site.';
  }
  if (err instanceof Anthropic.RateLimitError) return 'The assistant is busy. Wait a minute and try again.';
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the assistant. Check the connection and that the dev server is running.';
  if (err instanceof Anthropic.APIError) return `The assistant returned an error (${err.status ?? 'unknown'}). Try again.`;
  return err instanceof Error ? err.message : String(err);
}

/** Browser client. Requests go to our own server, which adds the API key; the key never reaches the browser. */
export function createBrowserClient(): Anthropic {
  return new Anthropic({
    apiKey: 'set-by-proxy',
    baseURL: `${window.location.origin}/api/anthropic`,
    dangerouslyAllowBrowser: true,
    maxRetries: 2,
  });
}
