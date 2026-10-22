import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { CHANNEL_NAMES, MAX_BODY, type PersonChannel } from '../engine/messaging';
import { formatMinute, parseClock } from '../engine/time';
import { call, Problem, say } from './http';

interface Thread {
  id: string;
  kind: 'direct' | 'announcement';
  title: string;
  urgent: boolean;
  lastAt: string;
  unread: number;
  messages: { id: string; at: string; from: string; mine: boolean; body: string; urgent: boolean }[];
}

type Outside = Exclude<PersonChannel, 'app'>;

interface Prefs {
  offered: Outside[];
  channels: Outside[];
  phone: string | null;
  whatsapp: boolean;
  sms: boolean;
  quiet: { start: number; end: number } | null;
  email: string | null;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Messages from work: the person's own thread with their managers, and announcements to their team. */
export function StaffMessages({ onSignedOut }: { onSignedOut: () => void }) {
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setThreads((await call<{ threads: Thread[] }>('GET', '/v1/staff/messages')).threads);
    } catch (e) {
      if (e instanceof Problem && e.status === 401) onSignedOut();
    }
  }, [onSignedOut]);
  useEffect(() => {
    void load();
    const onVisible = () => document.visibilityState === 'visible' && void load();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  async function read(id: string) {
    setOpen(open === id ? null : id);
    const t = threads?.find((x) => x.id === id);
    if (!t?.unread) return;
    await call('POST', '/v1/staff/messages/read', { conversationId: id }).catch(() => undefined);
    setThreads((all) => all?.map((x) => (x.id === id ? { ...x, unread: 0 } : x)) ?? null);
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setThreads((await call<{ threads: Thread[] }>('POST', '/v1/staff/messages', { body })).threads);
      setBody('');
    } catch (err) {
      if (err instanceof Problem && err.status === 401) return onSignedOut();
      setError(say(err));
    } finally {
      setBusy(false);
    }
  }

  if (!threads) return null;
  const unread = threads.reduce((n, t) => n + t.unread, 0);
  const direct = threads.find((t) => t.kind === 'direct');

  return (
    <section className="staff-card">
      <h2>Messages{unread ? ` (${unread} new)` : ''}</h2>
      {threads.length === 0 && <p className="muted">No messages yet. Your rota and messages from your managers appear here.</p>}
      <ul className="staff-threads">
        {threads.map((t) => (
          <li key={t.id}>
            <button className={`staff-thread ${t.unread ? 'new' : ''}`} onClick={() => void read(t.id)} aria-expanded={open === t.id}>
              <span className="strong">{t.title}</span>
              {t.urgent && <span className="bad-text small"> Urgent</span>}
              <span className="muted small"> {when(t.lastAt)}{t.unread ? `, ${t.unread} new` : ''}</span>
            </button>
            {open === t.id && (
              <ol className="staff-bubbles">
                {t.messages.slice(-30).map((m) => (
                  <li key={m.id} className={m.mine ? 'mine' : ''}>
                    <div className="muted small">{m.from}, {when(m.at)}{m.urgent ? ', urgent' : ''}</div>
                    <div className="staff-bubble-body">{m.body}</div>
                  </li>
                ))}
              </ol>
            )}
          </li>
        ))}
      </ul>
      <form className="staff-form" onSubmit={(e) => void send(e)}>
        <label>
          {direct ? 'Message your managers' : 'Message your managers (sickness, swaps, anything about work)'}
          <textarea required maxLength={MAX_BODY} rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
        <button className="staff-big" disabled={busy || !body.trim()}>{busy ? 'Sending' : 'Send'}</button>
        <p className="muted small">Only your managers read this, never the rest of the team.</p>
        {error && <p className="staff-msg bad" role="alert">{error}</p>}
      </form>
    </section>
  );
}

/** How work reaches this person beyond the app. Their choice and their consent, nobody else's. */
export function StaffReach({ onSignedOut }: { onSignedOut: () => void }) {
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [form, setForm] = useState({ channel: '' as Outside | '', phone: '', agree: false, quiet: true, start: '22:00', end: '07:00' });
  const [message, setMessage] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  useEffect(() => {
    call<Prefs>('GET', '/v1/staff/notifications')
      .then((p) => {
        setPrefs(p);
        setForm({
          channel: p.channels[0] ?? '',
          phone: p.phone ?? '',
          agree: p.whatsapp || p.sms,
          quiet: p.quiet !== null,
          start: formatMinute(p.quiet?.start ?? 22 * 60),
          end: formatMinute(p.quiet?.end ?? 7 * 60),
        });
      })
      .catch((e) => (e instanceof Problem && e.status === 401 ? onSignedOut() : undefined));
  }, [onSignedOut]);

  if (!prefs) return null;
  if (prefs.offered.length === 0) return null;

  const phoneChannel = form.channel === 'whatsapp' || form.channel === 'sms';

  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      const next = await call<Prefs>('PUT', '/v1/staff/notifications', {
        channels: form.channel ? [form.channel] : [],
        phone: phoneChannel ? form.phone : null,
        whatsapp: form.channel === 'whatsapp' && form.agree,
        sms: form.channel === 'sms' && form.agree,
        quiet: form.quiet ? { start: parseClock(form.start), end: parseClock(form.end) } : null,
      });
      setPrefs(next);
      setMessage({ tone: 'good', text: next.channels.length ? `Saved. Work messages now come to you by ${CHANNEL_NAMES[next.channels[0]]} as well as here.` : 'Saved. Work messages come to you here only.' });
    } catch (err) {
      if (err instanceof Problem && err.status === 401) return onSignedOut();
      setMessage({ tone: 'bad', text: say(err) });
    }
  }

  return (
    <section className="staff-card">
      <h2>How work reaches you</h2>
      <p className="muted small">Your rota and messages always come here. You can also have them on your phone. Change or stop this at any time.</p>
      <form className="staff-form" onSubmit={(e) => void save(e)}>
        <label>
          Also send them by
          <select value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value as Outside | '', agree: false })}>
            <option value="">Nothing else, just this app</option>
            {prefs.offered.map((c) => <option key={c} value={c}>{CHANNEL_NAMES[c]}{c === 'email' && prefs.email ? ` (${prefs.email})` : ''}</option>)}
          </select>
        </label>
        {phoneChannel && (
          <>
            <label>
              Your mobile number
              <input type="tel" inputMode="tel" autoComplete="tel" required value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="07700 900123" />
            </label>
            <label className="staff-check">
              <input type="checkbox" required checked={form.agree} onChange={(e) => setForm({ ...form, agree: e.target.checked })} />
              <span>
                {form.channel === 'whatsapp'
                  ? 'I agree to get my rota and messages from work on WhatsApp at this number. WhatsApp is run by Meta, which handles the messages. I can stop at any time here, or by replying STOP.'
                  : 'I agree to get my rota and messages from work by text at this number. I can stop at any time here.'}
              </span>
            </label>
          </>
        )}
        <label className="staff-check">
          <input type="checkbox" checked={form.quiet} onChange={(e) => setForm({ ...form, quiet: e.target.checked })} />
          <span>Quiet hours: hold messages until the morning unless they are urgent</span>
        </label>
        {form.quiet && (
          <div className="staff-row">
            <label>From <input type="time" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} /></label>
            <label>Until <input type="time" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} /></label>
          </div>
        )}
        <button className="staff-big">Save</button>
        {message && <p className={`staff-msg ${message.tone}`} role="status">{message.text}</p>}
      </form>
    </section>
  );
}
