import type Anthropic from '@anthropic-ai/sdk';
import { useCallback, useRef, useState } from 'react';
import { runAppAgent } from '../ai/appAgent';
import type { AppToolContext, Proposal } from '../ai/appTools';
import { createBrowserClient, describeAgentError } from '../ai/rotaAgent';
import type { TimeEntry } from '../engine/types';
import { api } from './api';
import { carryOut, needsConfirmation, type ProposalDeps } from './proposals';

export interface ChatItem {
  id: number;
  from: 'you' | 'shifty';
  text: string;
  proposals: Proposal[];
  error?: boolean;
}

export interface AgentView {
  ctx: Omit<AppToolContext, 'loadEntries'>;
  where: { screen: string; scope: string; user: string };
}

let nextId = 0;

/**
 * One conversation with Shifty. The conversation is only ever appended to, and what the manager
 * confirmed or cancelled is told to the model on the next message, so it never assumes a proposal
 * went through.
 */
export function useAppAgent(view: () => AgentView, deps: ProposalDeps) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<string[]>([]);
  const [costUsd, setCost] = useState(0);
  const messages = useRef<Anthropic.Beta.BetaMessageParam[]>([]);
  const outcomes = useRef<string[]>([]);
  const entries = useRef<Promise<TimeEntry[]> | null>(null);
  const abort = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    abort.current?.abort();
    messages.current = [];
    outcomes.current = [];
    setItems([]);
    setSteps([]);
    setCost(0);
  }, []);

  const settled = useCallback((outcome: string) => {
    outcomes.current.push(outcome);
  }, []);

  const send = useCallback(
    async (text: string) => {
      if (!text.trim() || busy) return;
      setItems((list) => [...list, { id: nextId++, from: 'you', text, proposals: [] }]);
      setBusy(true);
      setSteps([]);
      abort.current = new AbortController();
      const { ctx, where } = view();
      try {
        const res = await runAppAgent(
          createBrowserClient(),
          {
            messages: messages.current,
            text,
            where,
            outcomes: outcomes.current.splice(0),
            ctx: { ...ctx, loadEntries: () => (entries.current ??= api.get<TimeEntry[]>('/v1/time-entries')) },
          },
          abort.current.signal,
          (s) => setSteps((list) => [...list, s]),
        );
        messages.current = res.messages;
        setCost((c) => c + res.costUsd);
        // Opening a screen changes nothing, so it happens straight away; the rest wait for a click.
        for (const p of res.proposals.filter((x) => !needsConfirmation(x))) void carryOut(p, deps);
        setItems((list) => [...list, { id: nextId++, from: 'shifty', text: res.reply, proposals: res.proposals.filter(needsConfirmation) }]);
      } catch (err) {
        setItems((list) => [...list, { id: nextId++, from: 'shifty', text: describeAgentError(err), proposals: [], error: true }]);
      } finally {
        setBusy(false);
        setSteps([]);
      }
    },
    [busy, view, deps],
  );

  const stop = useCallback(() => abort.current?.abort(), []);

  return { items, busy, steps, costUsd, send, reset, stop, settled };
}
