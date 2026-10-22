import { useEffect, useRef, useState } from 'react';
import { ProposalCard, type ProposalDeps } from './proposals';
import { useAppAgent, type AgentView } from './useAppAgent';

const STARTERS = [
  'Are we on target for labour this week?',
  "Who's working on Saturday night?",
  'How much holiday has Grace got left?',
  'Add a new starter',
];

const usd = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

/** Shifty, the chat in the bottom right. Answers questions about the rota and team, and proposes changes to confirm. */
export function Shifty({ view, deps }: { view: () => AgentView; deps: ProposalDeps }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const agent = useAppAgent('chat', view, deps);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [agent.items, agent.steps]);
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  function send(value = text) {
    if (!value.trim()) return;
    void agent.send(value);
    setText('');
  }

  if (!open) {
    return (
      <button className="shifty-launcher" onClick={() => setOpen(true)} aria-label="Chat with Shifty">
        <span className="shifty-mark" aria-hidden>S</span>
        <span>Shifty</span>
      </button>
    );
  }

  return (
    <section className="shifty" role="dialog" aria-label="Shifty">
      <header className="shifty-head">
        <span className="shifty-mark" aria-hidden>S</span>
        <div>
          <div className="shifty-name">Shifty</div>
          <div className="muted small">Ask about your rota and team</div>
        </div>
        <span className="spacer" />
        {agent.items.length > 0 && <button className="link small" onClick={agent.reset}>New chat</button>}
        <button className="link" onClick={() => setOpen(false)} aria-label="Close Shifty">Close</button>
      </header>

      <div className="shifty-list" ref={list}>
        {agent.items.length === 0 && (
          <div className="shifty-empty">
            <p className="small">
              Hello. I can look up shifts, labour, holiday and the team, and set things up for you to confirm, such as a new
              starter, a leaver or a shift. Nothing changes until you press Confirm.
            </p>
            <div className="shifty-starters">
              {STARTERS.map((s) => (
                <button key={s} className="chip-button" onClick={() => send(s)}>{s}</button>
              ))}
            </div>
          </div>
        )}
        {agent.items.map((item) => (
          <div key={item.id} className={`bubble from-${item.from}${item.error ? ' error' : ''}`}>
            {item.text && <p>{item.text}</p>}
            {item.proposals.map((p) => <ProposalCard key={p.id} proposal={p} deps={deps} onSettled={agent.settled} />)}
          </div>
        ))}
        {agent.busy && (
          <div className="bubble from-shifty thinking">
            <p className="muted small">{agent.steps.at(-1) ?? 'Thinking...'}</p>
          </div>
        )}
      </div>

      <form className="shifty-input" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <textarea
          ref={input}
          rows={2}
          value={text}
          placeholder="Ask Shifty..."
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        {agent.busy ? (
          <button type="button" onClick={agent.stop}>Stop</button>
        ) : (
          <button className="primary" type="submit" disabled={!text.trim()}>Send</button>
        )}
      </form>
      {agent.costUsd > 0 && <div className="shifty-cost muted small">Claude usage this chat {usd.format(agent.costUsd)}</div>}
    </section>
  );
}
