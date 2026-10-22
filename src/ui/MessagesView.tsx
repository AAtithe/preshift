import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { CHANNEL_NAMES, MAX_BODY, type Channel, type Delivery } from '../engine/messaging';
import type { RotaState } from '../engine/types';
import { api, ApiError } from './api';
import { CoverPanel } from './CoverPanel';
import { londonParts } from '../engine/time';

interface Row {
  id: string;
  kind: 'direct' | 'announcement';
  siteId: string;
  siteName: string;
  employeeId: string | null;
  name: string;
  urgent: boolean;
  lastAt: string;
  last: { from: string; body: string; at: string } | null;
  unread: number;
  recipients?: number;
  read?: number;
}

interface Thread {
  id: string;
  kind: 'direct' | 'announcement';
  siteId: string;
  siteName: string;
  employeeId: string | null;
  name: string;
  messages: { id: string; at: string; from: { kind: string; name: string }; body: string; via: string; urgent: boolean; deliveries: Delivery[]; reached: string }[];
  readers: { employeeId: string; name: string; readAt: string | null }[];
}

interface Reach {
  employeeId: string;
  name: string;
  app: boolean;
  channel: Exclude<Channel, 'slack' | 'teams' | 'app'> | null;
  problems: string[];
}

interface Props {
  state: RotaState;
  /** The sites in scope where the person may message the team. */
  siteIds: string[];
  /** May send announcements at the site: those who publish its rota. */
  canAnnounce: (siteId: string) => boolean;
  /** A thread to open first, from a link in a notice. */
  openThread?: string;
  /** May ask for cover at the site: those who edit its rota. */
  canCover: (siteId: string) => boolean;
  /** A shift to ask cover for, from the shift editor on the rota. */
  coverShiftId?: string;
}

const problem = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));
const when = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * The team's messages: one thread per person with their managers, and announcements to a whole
 * site with who has read them. Everything here is the record of what each person was told and
 * when; WhatsApp, text and email only carry it to their phone.
 */
export function MessagesView({ state, siteIds, canAnnounce, openThread, canCover, coverShiftId }: Props) {
  const single = siteIds.length === 1 ? siteIds[0] : '';
  const [rows, setRows] = useState<Row[]>([]);
  const [selected, setSelected] = useState<string | null>(openThread ?? null);
  const [thread, setThread] = useState<Thread | null>(null);
  const [mode, setMode] = useState<'thread' | 'new' | 'announce' | 'reach' | 'cover'>(coverShiftId ? 'cover' : 'thread');
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      const all = await api.get<Row[]>(`/v1/messages${single ? `?siteId=${encodeURIComponent(single)}` : ''}`);
      setRows(all.filter((r) => siteIds.includes(r.siteId)));
    } catch (e) {
      setMessage({ text: problem(e), bad: true });
    }
  }, [single, siteIds]);
  useEffect(() => void load(), [load]);

  const open = useCallback(async (id: string) => {
    setSelected(id);
    setMode('thread');
    try {
      setThread(await api.get<Thread>(`/v1/messages/${encodeURIComponent(id)}`));
      await api.post(`/v1/messages/${encodeURIComponent(id)}/read`);
      setRows((r) => r.map((x) => (x.id === id ? { ...x, unread: 0 } : x)));
    } catch (e) {
      setMessage({ text: problem(e), bad: true });
    }
  }, []);
  useEffect(() => {
    if (openThread) void open(openThread);
  }, [openThread, open]);

  const unread = rows.reduce((n, r) => n + r.unread, 0);

  return (
    <div className="messages">
      <div className="messages-list panel">
        <div className="panel-head">
          <span className="panel-title">Messages{unread ? ` (${unread} unread)` : ''}</span>
          <span className="panel-actions">
            <button className="primary" onClick={() => setMode('new')}>Message someone</button>
            {single && canAnnounce(single) && <button onClick={() => setMode('announce')}>Announce</button>}
            {single && canCover(single) && <button onClick={() => setMode('cover')}>Cover</button>}
            {single && <button className="ghost" onClick={() => setMode('reach')}>Who we can reach</button>}
          </span>
        </div>
        {rows.length === 0 ? (
          <div className="empty">
            <b>No messages yet</b>
            Rota notices, messages and announcements appear here, one thread per person.
          </div>
        ) : (
          <ul className="thread-list">
            {rows.map((r) => (
              <li key={r.id}>
                <button className={`thread-row ${selected === r.id && mode === 'thread' ? 'on' : ''}`} onClick={() => void open(r.id)}>
                  <span className="thread-name">
                    {r.name}
                    {r.kind === 'announcement' && <span className="tag borrowed">Announcement</span>}
                    {r.urgent && <span className="tag bad">Urgent</span>}
                  </span>
                  <span className="thread-when muted small">{when(r.lastAt)}</span>
                  <span className="thread-last muted small">
                    {r.kind === 'announcement' ? `Read by ${r.read} of ${r.recipients}` : r.last ? `${r.last.from}: ${r.last.body}` : ''}
                  </span>
                  {r.unread > 0 && <span className="pill tone-warn">{r.unread} new</span>}
                  {!single && <span className="muted small">{r.siteName}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="messages-main">
        {message && <p className={`small ${message.bad ? 'bad-text' : 'muted'}`}>{message.text}</p>}
        {mode === 'thread' && thread && <ThreadPane thread={thread} onSent={async () => { await open(thread.id); await load(); }} />}
        {mode === 'thread' && !thread && <div className="empty panel"><b>Choose a conversation</b>Or start one with Message someone.</div>}
        {mode === 'new' && (
          <NewMessage
            state={state}
            siteIds={siteIds}
            onSent={async (id) => { await load(); await open(id); }}
          />
        )}
        {mode === 'announce' && single && (
          <Announce
            siteName={state.sites.find((s) => s.id === single)?.name ?? single}
            siteId={single}
            onSent={async (id) => { await load(); await open(id); }}
          />
        )}
        {mode === 'reach' && single && <ReachPane siteId={single} />}
        {mode === 'cover' && single && (() => {
          const now = londonParts(new Date());
          return <CoverPanel state={state} siteId={single} today={now.date} nowMinute={now.minute} shiftId={coverShiftId} />;
        })()}
        {mode === 'cover' && !single && <div className="empty panel"><b>Choose a site</b>Cover is asked for one site's shift at a time.</div>}
      </div>
    </div>
  );
}

function ThreadPane({ thread, onSent }: { thread: Thread; onSent: () => Promise<void> }) {
  const [body, setBody] = useState('');
  const [urgent, setUrgent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!thread.employeeId) return;
    setBusy(true);
    try {
      await api.post('/v1/messages/direct', { employeeId: thread.employeeId, body, urgent });
      setBody('');
      setUrgent(false);
      setError(null);
      await onSent();
    } catch (err) {
      setError(problem(err));
    } finally {
      setBusy(false);
    }
  }

  const read = thread.readers.filter((r) => r.readAt);
  return (
    <section className="panel thread">
      <div className="panel-head">
        <span className="panel-title">{thread.name}</span>
        <span className="panel-sub">
          {thread.kind === 'announcement'
            ? `${thread.siteName}: read by ${read.length} of ${thread.readers.length}`
            : thread.readers[0]?.readAt
              ? `Last read ${when(thread.readers[0].readAt)}`
              : 'Not opened in the staff app yet'}
        </span>
      </div>
      <div className="panel-body">
        <ol className="bubbles">
          {thread.messages.map((m) => (
            <li key={m.id} className={`bubble ${m.from.kind}`}>
              <div className="bubble-head small">
                <span className="strong">{m.from.name}</span>
                <span className="muted"> {when(m.at)}{m.via !== 'app' ? `, by ${CHANNEL_NAMES[m.via as Channel]}` : ''}</span>
                {m.urgent && <span className="tag bad">Urgent</span>}
              </div>
              <div className="bubble-body">{m.body}</div>
              {m.from.kind !== 'staff' && thread.kind === 'direct' && <div className="bubble-foot muted small" title={m.deliveries.map((d) => `${CHANNEL_NAMES[d.channel]} ${d.to}: ${d.status}${d.detail ? ` (${d.detail})` : ''}`).join('\n')}>{m.reached}</div>}
            </li>
          ))}
        </ol>
        {thread.kind === 'announcement' && (
          <details className="small">
            <summary>Who has read it</summary>
            <ul className="plain">
              {thread.readers.map((r) => (
                <li key={r.employeeId}>{r.name}: {r.readAt ? `read ${when(r.readAt)}` : <span className="warn-text">not yet</span>}</li>
              ))}
            </ul>
          </details>
        )}
        {thread.kind === 'direct' && (
          <form className="compose" onSubmit={(e) => void send(e)}>
            <textarea required maxLength={MAX_BODY} rows={3} placeholder={`Message ${thread.name.split(' ')[0]}`} value={body} onChange={(e) => setBody(e.target.value)} />
            <div className="compose-actions">
              <label className="small"><input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} /> Urgent: send through their quiet hours</label>
              <button className="primary" type="submit" disabled={busy}>{busy ? 'Sending' : 'Send'}</button>
            </div>
            {error && <p className="small bad-text">{error}</p>}
          </form>
        )}
      </div>
    </section>
  );
}

function NewMessage({ state, siteIds, onSent }: { state: RotaState; siteIds: string[]; onSent: (id: string) => Promise<void> }) {
  const people = state.employees.filter((e) => e.status !== 'leaver' && siteIds.includes(e.siteId)).sort((a, b) => a.name.localeCompare(b.name));
  const [employeeId, setEmployeeId] = useState(people[0]?.id ?? '');
  const [body, setBody] = useState('');
  const [urgent, setUrgent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(e: FormEvent) {
    e.preventDefault();
    try {
      const res = await api.post<{ conversationId: string }>('/v1/messages/direct', { employeeId, body, urgent });
      await onSent(res.conversationId);
    } catch (err) {
      setError(problem(err));
    }
  }

  return (
    <section className="panel">
      <div className="panel-head"><span className="panel-title">Message someone</span></div>
      <form className="panel-body compose" onSubmit={(e) => void send(e)}>
        <label className="small muted">To
          <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <textarea required maxLength={MAX_BODY} rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
        <div className="compose-actions">
          <label className="small"><input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} /> Urgent</label>
          <button className="primary" type="submit">Send</button>
        </div>
        <p className="muted small">It goes into their thread in the staff app, and to WhatsApp, text or email if they chose one. Their reply comes back here.</p>
        {error && <p className="small bad-text">{error}</p>}
      </form>
    </section>
  );
}

function Announce({ siteId, siteName, onSent }: { siteId: string; siteName: string; onSent: (id: string) => Promise<void> }) {
  const [form, setForm] = useState({ title: '', body: '', urgent: false });
  const [error, setError] = useState<string | null>(null);

  async function send(e: FormEvent) {
    e.preventDefault();
    try {
      const res = await api.post<{ conversationId: string }>('/v1/messages/announcements', { siteId, ...form });
      await onSent(res.conversationId);
    } catch (err) {
      setError(problem(err));
    }
  }

  return (
    <section className="panel">
      <div className="panel-head"><span className="panel-title">Announcement to the {siteName} team</span></div>
      <form className="panel-body compose" onSubmit={(e) => void send(e)}>
        <label className="small muted">Title <input maxLength={120} placeholder="New menu tasting" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
        <textarea required maxLength={MAX_BODY} rows={5} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
        <div className="compose-actions">
          <label className="small"><input type="checkbox" checked={form.urgent} onChange={(e) => setForm({ ...form, urgent: e.target.checked })} /> Urgent</label>
          <button className="primary" type="submit">Send to everyone</button>
        </div>
        <p className="muted small">
          Everyone who works at {siteName}, including those who cover it, gets it once. You see who has read it. Replies go to each person's own thread,
          never to the whole team, so nobody's sick note or complaint is read by everyone.
        </p>
        {error && <p className="small bad-text">{error}</p>}
      </form>
    </section>
  );
}

function ReachPane({ siteId }: { siteId: string }) {
  const [rows, setRows] = useState<Reach[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.get<Reach[]>(`/v1/messages/reach?siteId=${encodeURIComponent(siteId)}`).then(setRows).catch((e) => setError(problem(e)));
  }, [siteId]);
  if (error) return <p className="small bad-text">{error}</p>;
  if (!rows) return <p className="muted small">Loading</p>;
  const onApp = rows.filter((r) => r.app).length;
  const outside = rows.filter((r) => r.channel).length;
  const nowhere = rows.filter((r) => !r.app && !r.channel);
  return (
    <section className="panel">
      <div className="panel-head">
        <span className="panel-title">Who we can reach</span>
        <span className="panel-sub">{onApp} of {rows.length} on the staff app; {outside} reached on their phone</span>
      </div>
      <div className="panel-body">
        {nowhere.length > 0 && (
          <p className="small warn-text">
            {nowhere.length} {nowhere.length === 1 ? 'person has' : 'people have'} no staff app login and no channel: a rota notice to them reaches nobody. Invite them to the staff app from Clock in.
          </p>
        )}
        <table className="table">
          <thead><tr><th>Name</th><th>Staff app</th><th>On their phone</th><th>Why not</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.employeeId}>
                <td>{r.name}</td>
                <td>{r.app ? 'Yes' : <span className="warn-text">No login</span>}</td>
                <td>{r.channel ? CHANNEL_NAMES[r.channel] : <span className="muted">App only</span>}</td>
                <td className="muted small">{r.problems.join('; ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">Each person chooses WhatsApp, text or email in the staff app and agrees to it there. A manager cannot choose for them.</p>
      </div>
    </section>
  );
}
