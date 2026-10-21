import Anthropic from '@anthropic-ai/sdk';
import type { LondonNow } from '../engine/rotaWeek';
import type { RotaState } from '../engine/types';
import { formatMinute } from '../engine/time';
import { usageCostUsd } from './pricing';
import { executeRotaTool, ROTA_TOOLS, type RotaDraft } from './rotaTools';

export const ROTA_MODEL = 'claude-opus-5-5';
const MAX_TURNS = 40;


const SYSTEM_PROMPT = `You write weekly rotas for UK hospitality sites on behalf of the general manager.

You work on a draft through tools. The tools cost every shift the way payroll will (holiday accrual, employer NI, pension, guaranteed hours, starters and leavers pro rata) and refuse any change that would break UK employment law or the person's record: approved leave, not employed that day, no right to work check, under 18 limits, double booking. Treat a refusal as final for that person and slot and find another way.

Priorities, in order:
1. Legal. Never try to work around a refusal.
2. The manager's instructions. If one cannot be met, say so plainly rather than quietly ignoring it.
3. Cover the forecast. Hours short of headcount are lost sales and a poor guest experience.
4. Labour % at or under the site target. Use people already paid for through contracted hours first, then the home team, then a sister site in the same company, and only then another company in the group, which costs an intercompany recharge. Within that, the lowest cost legal person. Remove cover in hours that are over the forecast.
5. A fair, workable rota: sensible shift lengths, clear days off, primary roles first, no needless split shifts, and no one borrowed from a site that is short itself.

How to work:
- Start with get_rota_status and list_team. Use build_from_forecast as the starting point for an empty or part-built week unless the manager asks otherwise, then refine with add_shift, update_shift and remove_shift.
- Shifts that have started are history: people have clocked against them. Leave them alone and only plan the hours still ahead.
- Use ids exactly as the tools return them. Never invent people or roles.
- Check get_rota_status again before you finish.

The manager may come back with follow-up changes to the same draft. Make just those changes, keep the rest of the draft as it is, and check the status again.

Finish with a short note to the manager in plain British English, no headings and no markdown tables: what you did, the week's labour % against target, anyone borrowed from another site or company, any gaps you could not fill and what would fix them (hire, cross-train, accept the gap), and any instruction you could not follow and why. Keep it under 150 words.`;

export interface RotaAgentRequest {
  state: RotaState;
  siteId: string;
  weekStart: string;
  instruction: string;
  /** UK wall-clock time now; drafting never touches hours that have already started. */
  now: LondonNow;
  /** Continue an earlier draft with a follow-up instruction, keeping its changes and conversation. */
  previous?: RotaAgentResult;
}

export interface RotaUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Approximate cost at Claude Opus 5.5 list prices, in US dollars. */
  costUsd: number;
}

export interface RotaAgentResult {
  state: RotaState;
  summary: string;
  steps: string[];
  /** The whole conversation, so a follow-up can continue it. Appended to, never edited. */
  messages: Anthropic.Beta.BetaMessageParam[];
  /** Every instruction given for this draft, oldest first, for the audit record. */
  instructions: string[];
  usage: RotaUsage;
}

export class RotaAgentError extends Error {}

const noUsage = (): RotaUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 });

function addUsage(total: RotaUsage, u: Anthropic.Beta.BetaUsage): RotaUsage {
  return {
    inputTokens: total.inputTokens + (u.input_tokens ?? 0),
    outputTokens: total.outputTokens + (u.output_tokens ?? 0),
    cacheReadTokens: total.cacheReadTokens + (u.cache_read_input_tokens ?? 0),
    cacheWriteTokens: total.cacheWriteTokens + (u.cache_creation_input_tokens ?? 0),
    costUsd: total.costUsd + usageCostUsd(u),
  };
}

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
  const base = req.previous?.state ?? req.state;
  const draft: RotaDraft = { state: structuredClone(base), siteId: req.siteId, weekStart: req.weekStart, now: req.now };
  const steps: string[] = [...(req.previous?.steps ?? [])];
  const step = (s: string) => {
    steps.push(s);
    onStep(s);
  };
  const instruction = req.instruction.trim() || (req.previous ? '' : 'Build this week from the forecast.');
  if (!instruction) throw new RotaAgentError('Say what you would like changed in the draft.');
  const instructions = [...(req.previous?.instructions ?? []), instruction];
  let usage = req.previous?.usage ?? noUsage();

  const clock = `${req.now.date} ${formatMinute(req.now.minute)}`;
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...(req.previous?.messages ?? []),
    {
      role: 'user',
      content: req.previous
        ? `It is now ${clock}. Change to the draft:\n${instruction}`
        : `Site: ${site.name} (id ${site.id}). Week commencing ${req.weekStart}. Labour target ${(site.labourTargetPct * 100).toFixed(1)}%. ` +
          `It is now ${clock} UK time.\n\nManager's request:\n${instruction}`,
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
    usage = addUsage(usage, response.usage);

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
        return { state: draft.state, summary, steps, messages, instructions, usage };
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
  if (err instanceof Anthropic.AuthenticationError && JSON.stringify(err.error).includes('session_expired')) {
    return 'Your session has ended. Sign in again, then redraft. Nothing has been applied.';
  }
  if (err instanceof Anthropic.PermissionDeniedError && JSON.stringify(err.error).includes('spend_limit')) {
    const body = err.error as { error?: { message?: string } } | undefined;
    return body?.error?.message ?? 'The rota assistant has reached its spending limit.';
  }
  if (err instanceof Anthropic.PermissionDeniedError && JSON.stringify(err.error).includes('not_configured')) {
    return 'The assistant is not set up yet. An admin needs to add the Claude API key under Settings.';
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return 'Claude did not accept the saved API key. An admin can replace it under Settings.';
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
