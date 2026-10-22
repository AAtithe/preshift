import { useEffect, useRef, useState } from 'react';
import { ProposalCard, type ProposalDeps } from './proposals';
import { useAppAgent, type AgentView } from './useAppAgent';

/**
 * The command bar along the bottom: plain language instructions such as "add a new starter, Sam Lee,
 * bartender at Marylebone from Monday on £12.71". It replies in a line and shows a card to confirm.
 * Ctrl+K (Cmd+K on a Mac) jumps to it from anywhere.
 */
export function CommandBar({ view, deps }: { view: () => AgentView; deps: ProposalDeps }) {
  const [text, setText] = useState('');
  const agent = useAppAgent('command', view, deps);
  const input = useRef<HTMLInputElement>(null);
  const last = agent.items.at(-1);
  const lastReply = last?.from === 'shifty' ? last : null;
  const settledCount = useRef(0);

  // Once every card from the last reply is confirmed or cancelled, tidy the tray away after a moment.
  function settled(outcome: string) {
    agent.settled(outcome);
    settledCount.current += 1;
    if (lastReply && settledCount.current >= lastReply.proposals.length) setTimeout(() => agent.reset(), 4000);
  }
  useEffect(() => {
    settledCount.current = 0;
  }, [lastReply?.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        input.current?.focus();
      }
      if (e.key === 'Escape' && document.activeElement === input.current) agent.reset();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [agent]);

  function run() {
    if (!text.trim()) return;
    // A new instruction starts afresh unless the last reply asked a question that this answers.
    if (lastReply && !/\?\s*$/.test(lastReply.text)) agent.reset();
    void agent.send(text);
    setText('');
  }

  return (
    <div className="command-bar">
      {(agent.busy || lastReply) && (
        <div className="command-tray" role="status">
          {agent.busy ? (
            <p className="muted small">{agent.steps.at(-1) ?? 'Working on it...'}</p>
          ) : (
            lastReply && (
              <>
                <div className="command-tray-head">
                  {lastReply.text && <p className={lastReply.error ? 'bad-text' : ''}>{lastReply.text}</p>}
                  <button className="link small" onClick={agent.reset} aria-label="Dismiss">Dismiss</button>
                </div>
                {lastReply.proposals.map((p) => <ProposalCard key={p.id} proposal={p} deps={deps} onSettled={settled} />)}
              </>
            )
          )}
        </div>
      )}
      <form className="command-form" onSubmit={(e) => { e.preventDefault(); run(); }}>
        <span className="command-prompt" aria-hidden>Tell Preshift</span>
        <input
          ref={input}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder='For example: "Please add a new starter, Sam Lee, bartender at Marylebone from Monday on £12.71"'
          aria-label="Command"
          disabled={agent.busy}
        />
        <kbd className="command-hint">Ctrl K</kbd>
        {agent.busy ? (
          <button type="button" onClick={agent.stop}>Stop</button>
        ) : (
          <button className="primary" type="submit" disabled={!text.trim()}>Go</button>
        )}
      </form>
    </div>
  );
}
