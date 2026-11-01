import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  featureOrder,
  HELP_ARTICLES,
  IMPACTS,
  isOpen,
  KIND_LABEL,
  responseOverdue,
  STATUS_LABEL,
  suggestArticles,
  ticketProblem,
  type BugImpact,
  type HelpArticle,
  type SupportTicket,
  type TicketContext,
  type TicketKind,
  type TicketStatus,
} from '../engine/support';
import { api, ApiError } from './api';

type Ticket = SupportTicket & { responseDueAt: string; responseTarget: string };
/** The client's WS client partners answer its tickets; `youAreDesk` is whether the person looking is one. */
type Listing = { tickets: Ticket[]; answeredByHelp: number; desk: string[]; youAreDesk: boolean };

interface Props {
  /** The person's own name: votes are counted by name. */
  me: string | null;
  /** Where the person was before opening Support, attached to a bug report. */
  context: TicketContext;
  /** Opens the tab a help article points to. */
  onOpen: (tab: string) => void;
}

/** Why the client partner was not emailed about a ticket: it is still here for them to see. */
const NOT_TOLD: Record<'failed' | 'not_set_up' | 'no_desk', string> = {
  failed: 'The email to your client partner did not go',
  not_set_up: 'Your client partner was not emailed: their email is not set up',
  no_desk: 'No client partner to tell yet',
};
const problem = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));
const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const TAB_LABEL: Record<string, string> = {
  rota: 'Rota', demand: 'Demand', clock: 'Clock in', payroll: 'Payroll', close: 'Close', holiday: 'Holiday', people: 'People', settings: 'Settings', privacy: 'GDPR',
};

/**
 * Front line support in the app: answers first, then a ticket that tells the client's WS client partner what they
 * need to know, and a board where the organisation's feature ideas are ranked by votes and worth.
 */
export function SupportView({ me, context, onOpen }: Props) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      setListing(await api.get<Listing>('/v1/support/tickets'));
    } catch (e) {
      setMessage({ text: problem(e), bad: true });
    }
  }, []);
  useEffect(() => void load(), [load]);

  async function act(done: string, fn: () => Promise<unknown>) {
    try {
      await fn();
      setMessage({ text: done });
      await load();
    } catch (e) {
      setMessage({ text: problem(e), bad: true });
    }
  }

  const tickets = listing?.tickets ?? [];
  const now = new Date();
  const open = tickets.filter(isOpen);
  const blocking = open.filter((t) => t.severity === 'blocking');
  const overdue = open.filter((t) => responseOverdue(t, now));
  const ideas = tickets.filter((t) => t.kind === 'feature');
  // Only the client partner moves a ticket on; the server refuses anyone else.
  const isAdmin = listing?.youAreDesk ?? false;

  return (
    <div className="settings support">
      <div className="kpis people-kpis">
        <div className={`kpi ${blocking.length ? 'bad' : open.some((t) => t.kind === 'bug') ? 'warn' : 'good'}`}>
          <div className="kpi-label">Open bugs</div>
          <div className="kpi-value">{open.filter((t) => t.kind === 'bug').length}</div>
          <div className="kpi-hint">{blocking.length} blocking</div>
        </div>
        <div className={`kpi ${overdue.length ? 'bad' : 'good'}`}>
          <div className="kpi-label">Awaiting first reply</div>
          <div className="kpi-value">{open.filter((t) => !t.firstResponseAt).length}</div>
          <div className="kpi-hint">{overdue.length} past the response target</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Feature ideas</div>
          <div className="kpi-value">{ideas.filter(isOpen).length}</div>
          <div className="kpi-hint">{ideas.filter((t) => t.status === 'planned').length} planned</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Answered by help</div>
          <div className="kpi-value">{listing?.answeredByHelp ?? '-'}</div>
          <div className="kpi-hint">Questions closed with no ticket</div>
        </div>
      </div>
      {message && <div className={`notice ${message.bad ? 'error' : ''}`}>{message.text}</div>}
      <Raise context={context} onOpen={onOpen} act={act} desk={listing?.desk ?? []} />
      <Ideas ideas={ideas} me={me} isAdmin={isAdmin} act={act} />
      <Tickets tickets={tickets.filter((t) => t.kind !== 'feature')} isAdmin={isAdmin} now={now} act={act} />
      <Library onOpen={onOpen} />
    </div>
  );
}

type Act = (done: string, fn: () => Promise<unknown>) => Promise<void>;

function Raise({ context, onOpen, act, desk }: { context: TicketContext; onOpen: (tab: string) => void; act: Act; desk: string[] }) {
  const blank = { kind: 'question' as TicketKind, title: '', detail: '', impact: '' as BugImpact | '', steps: '', hours: '' };
  const [form, setForm] = useState(blank);
  const [dismissed, setDismissed] = useState(false);
  const suggestions = useMemo(() => suggestArticles(`${form.title} ${form.detail}`), [form.title, form.detail]);
  const incomplete = ticketProblem({ kind: form.kind, title: form.title, detail: form.detail, impact: form.impact || undefined });
  const fullContext: TicketContext = { ...context, userAgent: navigator.userAgent.slice(0, 300) };

  async function submit(e: FormEvent) {
    e.preventDefault();
    const sent = form.kind === 'bug' ? 'Reported.' : form.kind === 'feature' ? 'Idea added, with your vote.' : 'Sent.';
    await act(`${sent} The response target is shown against it below.`, () =>
      api.post('/v1/support/tickets', {
        kind: form.kind,
        title: form.title.trim(),
        detail: form.detail.trim(),
        ...(form.kind === 'bug' ? { impact: form.impact, context: fullContext, ...(form.steps.trim() ? { steps: form.steps.trim() } : {}) } : {}),
        ...(form.kind === 'feature' && Number(form.hours) > 0 ? { hoursSavedPerWeek: Number(form.hours) } : {}),
      }),
    );
    setForm({ ...blank, kind: form.kind });
    setDismissed(false);
  }

  function answered(a: HelpArticle) {
    void act(`Good. "${a.title}" is counted as answered, so nobody needs to pick it up.`, () => api.post('/v1/support/answered'));
    setForm({ ...blank, kind: form.kind });
  }

  return (
    <section className="settings-card">
      <h2>Ask, report or suggest</h2>
      <p className="muted small">
        Start typing and the answers that fit appear first; most questions are settled there. Do not paste staff personal details such as
        addresses, pay or right to work documents: name the person and the site, and your client partner will look them up with you.
      </p>
      {/* A how-do-I is often answered faster by seeing it done; in its own tab so a half-written ticket is kept. */}
      <p className="small support-watch">
        Asking how to do something? It may be quicker to watch it.{' '}
        <a href="/walkthrough" target="_blank" rel="noreferrer">Watch the walkthrough</a>, in chapters to jump between.
      </p>
      <div className="toggle" role="radiogroup" aria-label="What is it">
        {(Object.keys(KIND_LABEL) as TicketKind[]).map((k) => (
          <button key={k} type="button" role="radio" aria-checked={form.kind === k} className={form.kind === k ? 'active' : ''} onClick={() => setForm({ ...form, kind: k })}>
            {KIND_LABEL[k]}
          </button>
        ))}
      </div>
      <form className="support-form" onSubmit={submit}>
        <label>
          {form.kind === 'feature' ? 'The idea in a line' : form.kind === 'bug' ? 'What went wrong, in a line' : 'Your question'}
          <input value={form.title} maxLength={140} onChange={(e) => { setForm({ ...form, title: e.target.value }); setDismissed(false); }} />
        </label>
        <label>
          {form.kind === 'feature' ? 'What problem it solves, and for whom' : form.kind === 'bug' ? 'What you expected, and what happened instead' : 'More detail'}
          <textarea rows={4} value={form.detail} maxLength={5000} onChange={(e) => setForm({ ...form, detail: e.target.value })} />
        </label>
        {suggestions.length > 0 && !dismissed && (
          <div className="help-suggest" aria-live="polite">
            <div className="kpi-label">These may answer it</div>
            {suggestions.map((a) => (
              <article key={a.id} className="help-article">
                <h3>{a.title}</h3>
                <p className="small">{a.body}</p>
                <div className="help-actions">
                  {a.tab && <button type="button" className="link" onClick={() => onOpen(a.tab!)}>Open {TAB_LABEL[a.tab] ?? a.tab}</button>}
                  <button type="button" className="link" onClick={() => answered(a)}>This answered it</button>
                </div>
              </article>
            ))}
            <button type="button" className="link muted small" onClick={() => setDismissed(true)}>None of these, carry on</button>
          </div>
        )}
        {form.kind === 'bug' && (
          <>
            <label>
              What does it stop you doing?
              <select value={form.impact} onChange={(e) => setForm({ ...form, impact: e.target.value as BugImpact })} required>
                <option value="">Choose one</option>
                {(Object.keys(IMPACTS) as BugImpact[]).map((k) => <option key={k} value={k}>{IMPACTS[k].label}</option>)}
              </select>
            </label>
            <label>
              Steps to make it happen again
              <textarea rows={3} value={form.steps} maxLength={3000} placeholder={'1. Open Rota for Marylebone, week 43\n2. Drag Ben’s Friday shift to Saturday\n3. Labour % does not change'} onChange={(e) => setForm({ ...form, steps: e.target.value })} />
            </label>
            <p className="muted small">
              Sent with it: the screen you were on ({TAB_LABEL[context.tab ?? ''] ?? context.tab ?? 'none'}){context.siteId ? `, site ${context.siteId}` : ''}
              {context.week ? `, week of ${context.week}` : ''}, and your browser.
            </p>
          </>
        )}
        {form.kind === 'feature' && (
          <label>
            Hours a week it would save across your sites (your estimate)
            <input type="number" min={0} max={1000} step={0.5} value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value })} />
          </label>
        )}
        <div className="settings-form">
          <button className="primary" type="submit" disabled={Boolean(incomplete)} title={incomplete ?? undefined}>
            {form.kind === 'bug' ? 'Report it' : form.kind === 'feature' ? 'Propose it' : 'Ask your client partner'}
          </button>
          <span className="muted small">
            {desk.length
              ? `Goes to ${desk.join(' and ')}, your Williams, Stanley & Co. client partner.`
              : 'No Williams, Stanley & Co. client partner is set for you yet, so it is logged here until one is.'}
          </span>
        </div>
      </form>
    </section>
  );
}

function Ideas({ ideas, me, isAdmin, act }: { ideas: Ticket[]; me: string | null; isAdmin: boolean; act: Act }) {
  const [showClosed, setShowClosed] = useState(false);
  const shown = ideas.filter((t) => showClosed || isOpen(t)).sort(featureOrder);
  return (
    <section className="settings-card">
      <h2>Feature ideas</h2>
      <p className="muted small">
        Vote for what would make the biggest difference to your week. Ideas are weighed by votes and by the hours they would save, so say
        what it is worth when you propose one. One vote each; press again to take it back.
      </p>
      <label className="muted small check-inline">
        <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> Show shipped and declined
      </label>
      <table className="table">
        <thead>
          <tr><th className="num">Votes</th><th>Idea</th><th className="num">Hours a week</th><th>Status</th></tr>
        </thead>
        <tbody>
          {shown.length === 0 && <tr><td colSpan={4} className="muted">No ideas yet. Propose one above.</td></tr>}
          {shown.map((t) => {
            const mine = Boolean(me && t.votes?.includes(me));
            return (
              <tr key={t.id}>
                <td className="num">
                  <button className={`vote ${mine ? 'on' : ''}`} aria-pressed={mine} onClick={() => void act(mine ? 'Vote taken back.' : 'Voted.', () => api.post(`/v1/support/tickets/${t.id}/vote`))}>
                    {t.votes?.length ?? 0}
                  </button>
                </td>
                <td>
                  {t.title}
                  <div className="muted small">{t.detail}</div>
                  <Thread ticket={t} act={act} />
                </td>
                <td className="num">{t.hoursSavedPerWeek ?? '-'}</td>
                <td>{isAdmin ? <StatusPicker ticket={t} act={act} /> : STATUS_LABEL[t.status]}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function Tickets({ tickets, isAdmin, now, act }: { tickets: Ticket[]; isAdmin: boolean; now: Date; act: Act }) {
  const [showClosed, setShowClosed] = useState(false);
  const shown = tickets.filter((t) => showClosed || isOpen(t));
  return (
    <section className="settings-card">
      <h2>Questions and bugs</h2>
      <p className="muted small">
        Everyone in your organisation sees these, so check here before reporting something twice and add to the open one instead.
        Blocking bugs are answered within 4 hours, any day. Everything else within the working days shown.
      </p>
      <label className="muted small check-inline">
        <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> Show resolved
      </label>
      <table className="table">
        <thead>
          <tr><th>Raised</th><th>What</th><th>Reply due</th><th>Status</th></tr>
        </thead>
        <tbody>
          {shown.length === 0 && <tr><td colSpan={4} className="muted">Nothing {showClosed ? '' : 'open '}here.</td></tr>}
          {shown.map((t) => (
            <tr key={t.id}>
              <td>
                {when(t.raisedAt)}
                <div className="muted small">{t.raisedBy}</div>
              </td>
              <td>
                {t.title}
                {t.severity && <span className={`tag ${t.severity === 'blocking' ? 'bad' : ''}`}>{t.severity}</span>}
                <div className="muted small">{KIND_LABEL[t.kind]}{t.impact ? `. Affects: ${IMPACTS[t.impact].label.toLowerCase()}` : ''}</div>
                <Thread ticket={t} act={act} />
              </td>
              <td>
                {t.firstResponseAt ? <span className="muted small">Replied {when(t.firstResponseAt)}</span> : when(t.responseDueAt)}
                {responseOverdue(t, now) && <span className="tag bad">overdue</span>}
                <div className="muted small">{t.responseTarget}</div>
                {t.notified && t.notified !== 'emailed' && t.notified !== 'demo' && <div className="small warn-text">{NOT_TOLD[t.notified]}</div>}
              </td>
              <td>{isAdmin ? <StatusPicker ticket={t} act={act} /> : STATUS_LABEL[t.status]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function StatusPicker({ ticket, act }: { ticket: Ticket; act: Act }) {
  return (
    <select
      aria-label="Status"
      value={ticket.status}
      onChange={(e) => void act('Status changed.', () => api.patch(`/v1/support/tickets/${ticket.id}`, { status: e.target.value as TicketStatus }))}
    >
      {(Object.keys(STATUS_LABEL) as TicketStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
    </select>
  );
}

function Thread({ ticket, act }: { ticket: Ticket; act: Act }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  const count = ticket.comments.length;
  if (!open) {
    return (
      <button className="link small" onClick={() => setOpen(true)}>
        {count ? `${count} repl${count === 1 ? 'y' : 'ies'}` : 'Add detail'}
        {ticket.comments.some((c) => c.fromSupport) ? ', your client partner has replied' : ''}
      </button>
    );
  }
  return (
    <div className="thread">
      {ticket.comments.map((c, i) => (
        <div key={i} className={`thread-item ${c.fromSupport ? 'from-support' : ''}`}>
          <div className="muted small">{c.fromSupport ? `${c.author}, WS client partner` : c.author}, {when(c.at)}</div>
          <div className="small">{c.body}</div>
        </div>
      ))}
      <form
        className="settings-form"
        onSubmit={(e) => {
          e.preventDefault();
          void act('Added.', () => api.post(`/v1/support/tickets/${ticket.id}/comments`, { body: body.trim() })).then(() => setBody(''));
        }}
      >
        <input value={body} maxLength={5000} placeholder="Add more, or reply" onChange={(e) => setBody(e.target.value)} />
        <button type="submit" disabled={!body.trim()}>Add</button>
        <button type="button" className="link" onClick={() => setOpen(false)}>Hide</button>
      </form>
    </div>
  );
}

function Library({ onOpen }: { onOpen: (tab: string) => void }) {
  const [query, setQuery] = useState('');
  const shown = query.trim() ? suggestArticles(query, HELP_ARTICLES, HELP_ARTICLES.length) : HELP_ARTICLES;
  return (
    <section className="settings-card">
      <h2>Help library</h2>
      <p className="muted small">The questions operators ask most, and where in Preshift each one is fixed.</p>
      <div className="settings-form">
        <label>
          Search
          <input value={query} placeholder="publish, clock in, holiday balance" onChange={(e) => setQuery(e.target.value)} />
        </label>
      </div>
      {shown.length === 0 && <p className="muted small">Nothing matches. Ask your client partner above.</p>}
      {shown.map((a) => (
        <details key={a.id} className="help-article">
          <summary>{a.title}</summary>
          <p className="small">{a.body}</p>
          {a.tab && <button className="link" onClick={() => onOpen(a.tab!)}>Open {TAB_LABEL[a.tab] ?? a.tab}</button>}
        </details>
      ))}
    </section>
  );
}
