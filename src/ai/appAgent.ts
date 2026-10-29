import type Anthropic from '@anthropic-ai/sdk';
import { formatMinute } from '../engine/time';
import type { MessagesClient } from './messagesClient';
import { usageCostUsd } from './pricing';
import { APP_TOOLS, executeAppTool, type AppToolContext, type Proposal } from './appTools';
import { ROTA_MODEL, RotaAgentError } from './rotaAgent';

const MAX_TURNS = 12;

const SHARED = `You are Shifty, the assistant inside Preshift, the rota, people and payroll app for UK hospitality groups, run with their accountants. You talk to general managers, owners and finance people.

What you can do: look things up (people, shifts, labour % and cost, compliance issues, holiday balances) and propose changes (a new starter, changes to someone's record, a leaver, holiday, an absence, a shift, removing a shift, publishing a week, asking for cover). For building or reshaping a whole rota, hand over to the rota assistant with open_rota_assistant.

Cover: when someone cannot work a shift ("Ben is ill tonight, find cover"), find their shift with list_shifts and propose_ask_cover. If they are off sick or otherwise absent, also propose the absence. Preshift asks only people who could legally work the shift, so never suggest names yourself or promise anyone will say yes. Keep who is off and why out of the note. Leave the rounds to the default unless the manager asks: it asks the cheapest few first when there is time, and everyone at once when there is not.

How changes work: you only ever propose. The manager sees each proposal as a card and confirms or cancels it. Never say something is done until you are told it was confirmed. If a proposal tool refuses, explain the reason in plain words and suggest what would work.

Ground rules:
- Use ids exactly as the tools return them; look people up with find_people rather than guessing.
- Ask for missing details rather than inventing them: a starter needs a name, site, role, start date, date of birth and pay.
- UK employment law is enforced by the app: minimum wage for age, young worker limits, breaks, rest, leave and right to work. Do not try to work around it.
- Personal data: do not ask for or repeat National Insurance numbers, addresses, bank details or medical information. For sickness, the type and dates are enough.
- Dates: "this week" means the week on screen; work out real dates from today's date given with each message. Times are UK time.
- Money is in pounds. Write in plain British English. No markdown headings or tables.

The app's screens, for go_to and for explaining where things are: sites (all sites overview), rota, clock (clock in), demand, team, people (staff records), holiday, hr (HR overview), absence, training, reviews (probation and reviews), cases (HR cases, restricted), payroll, pay (pay approvals: proposed pay rate changes waiting for the finance director), close (month-end journal), reports, setup (companies, sites, opening hours, labour targets, roles, the typical trading week and staffing rules, and pasting in a team), integrations, privacy (GDPR), access (who can do what, invitations, authenticators), settings (Claude key, spending limits, email), profile (your own name, job title, roles, password and authenticator), howto (guides and quick answers), support (questions, bug reports and feature ideas for the client's client partner, with response times), messages (each person's thread with their managers, announcements, and cover requests and their answers). What each person may do depends on their role and sites; if the app refuses something for want of permission or an authenticator, say so plainly.`;

const MODES = {
  chat: `${SHARED}

You are in the chat window. Be warm, brief and practical, like a capable deputy manager: answer the question, give the number or the name, and offer the next step only when it is useful. Two or three short paragraphs at most.`,
  command: `${SHARED}

You are in the command bar. The manager has typed an instruction to carry out. Do it with as few steps as possible: look up what you need, then make the proposal. If a required detail is missing, ask one short question for it. Reply in one or two sentences; the proposal card shows the details, so do not repeat them.`,
};

export type AppAgentMode = keyof typeof MODES;

export interface AppAgentTurn {
  /** The conversation so far, appended to and never edited. Empty for a new one. */
  messages: Anthropic.Beta.BetaMessageParam[];
  text: string;
  mode: AppAgentMode;
  ctx: AppToolContext;
  /** What the manager is looking at, so "here" and "this week" resolve correctly. */
  where: { screen: string; scope: string; user: string };
  /** Proposals confirmed or cancelled since the last message, so the model never assumes. */
  outcomes?: string[];
}

export interface AppAgentReply {
  messages: Anthropic.Beta.BetaMessageParam[];
  reply: string;
  proposals: Proposal[];
  steps: string[];
  costUsd: number;
  servedModels: string[];
}

export async function runAppAgent(client: MessagesClient, turn: AppAgentTurn, signal?: AbortSignal, onStep: (s: string) => void = () => {}): Promise<AppAgentReply> {
  const { ctx, where } = turn;
  const header =
    `[Today ${ctx.now.date} ${formatMinute(ctx.now.minute)} UK time. ${where.user} is on the ${where.screen} screen, ` +
    `viewing ${where.scope}, week commencing ${ctx.week}.` +
    (turn.outcomes?.length ? ` Since your last reply: ${turn.outcomes.join('; ')}.` : '') +
    ']';
  const messages: Anthropic.Beta.BetaMessageParam[] = [...turn.messages, { role: 'user', content: `${header}\n\n${turn.text.trim()}` }];
  const proposals: Proposal[] = [];
  const steps: string[] = [];
  const served = new Set<string>();
  let costUsd = 0;

  for (let i = 0; i < MAX_TURNS; i++) {
    const response = await client.beta.messages.create(
      {
        model: ROTA_MODEL,
        max_tokens: 8000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium' },
        cache_control: { type: 'ephemeral' },
        system: MODES[turn.mode],
        tools: APP_TOOLS,
        messages,
      },
      { signal },
    );
    costUsd += usageCostUsd(response.usage);
    served.add(response.model);
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'tool_use') {
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        const outcome = await executeAppTool(ctx, block.name, block.input);
        steps.push(outcome.label);
        onStep(outcome.label);
        if (outcome.proposal) proposals.push(outcome.proposal);
        results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(outcome.result), is_error: outcome.isError });
      }
      messages.push({ role: 'user', content: results });
      continue;
    }
    if (response.stop_reason === 'pause_turn') continue;
    if (response.stop_reason === 'refusal') throw new RotaAgentError("Shifty can't help with that one. Try putting it as a question about the rota or your team.", 'refusal');
    if (response.stop_reason === 'max_tokens') throw new RotaAgentError('That needed a longer answer than Shifty can give. Try asking for one part at a time.', 'truncated');
    const reply = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    return { messages, reply, proposals, steps, costUsd, servedModels: [...served] };
  }
  throw new RotaAgentError('Shifty took too many steps on that. Try a simpler request.', 'turn_limit');
}
