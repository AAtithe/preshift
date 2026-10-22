import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from './api';

interface ApiKeyView {
  id: string;
  name: string;
  scopes: string[];
  endsWith: string;
  createdAt: string;
  createdBy: string;
  lastUsedAt: string | null;
}

interface Endpoint {
  id: string;
  url: string;
  events: string[];
  description: string;
  active: boolean;
  createdAt: string;
}

interface Delivery {
  id: string;
  endpointId: string;
  type: string;
  createdAt: string;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  lastError: string | null;
}

type Message = { text: string; bad?: boolean } | null;

const problem = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : 'Never');

/** Shown once, straight after it is made: the key or secret is never returned again. */
function Reveal({ label, value, onDone }: { label: string; value: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="small">
      <p>{label} Copy it now and keep it in the other system's secret store. It is not shown again.</p>
      <input readOnly aria-label={label} value={value} onFocus={(e) => e.target.select()} style={{ width: '100%', fontFamily: 'var(--mono, monospace)' }} />
      <p>
        <button className="link" onClick={() => void navigator.clipboard?.writeText(value).then(() => setCopied(true))}>{copied ? 'Copied' : 'Copy'}</button>
        <button className="link" onClick={onDone}>Done</button>
      </p>
    </div>
  );
}

export function ApiKeys() {
  const [keys, setKeys] = useState<ApiKeyView[]>([]);
  const [scopes, setScopes] = useState<Record<string, string>>({});
  const [form, setForm] = useState<{ name: string; scopes: string[] }>({ name: '', scopes: ['rota:read'] });
  const [made, setMade] = useState<{ name: string; key: string } | null>(null);
  const [message, setMessage] = useState<Message>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ scopes: Record<string, string>; keys: ApiKeyView[] }>('/v1/api-keys');
      setKeys(res.keys);
      setScopes(res.scopes);
    } catch (e) {
      setMessage({ text: problem(e), bad: true });
    }
  }, []);
  useEffect(() => void load(), [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    try {
      const res = await api.post<ApiKeyView & { key: string }>('/v1/api-keys', form);
      setMade({ name: res.name, key: res.key });
      setForm({ name: '', scopes: ['rota:read'] });
      setMessage(null);
      await load();
    } catch (err) {
      setMessage({ text: problem(err), bad: true });
    }
  }

  async function revoke(k: ApiKeyView) {
    if (!confirm(`Revoke "${k.name}"? Anything using it stops working straight away.`)) return;
    try {
      await api.del(`/v1/api-keys/${k.id}`);
      setMessage({ text: `Revoked ${k.name}.` });
      await load();
    } catch (err) {
      setMessage({ text: problem(err), bad: true });
    }
  }

  const toggle = (scope: string) =>
    setForm((f) => ({ ...f, scopes: f.scopes.includes(scope) ? f.scopes.filter((s) => s !== scope) : [...f.scopes, scope] }));

  return (
    <section className="settings-card">
      <h2>API keys</h2>
      <p className="muted small">
        For other systems to plug into Preshift: an EPOS pushing sales, a BI tool reading labour, an in-house app. Make one key per
        system, give it only what it needs, and revoke it when the system is retired. Each key reaches this organisation only.
        The full reference is in the <a className="link" href="/docs" target="_blank" rel="noopener">API docs</a>.
      </p>
      {keys.length > 0 && (
        <table className="table">
          <thead>
            <tr><th>Name</th><th>Can</th><th>Key</th><th>Last used</th><th /></tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id}>
                <td>{k.name}<div className="muted small">Made by {k.createdBy}, {when(k.createdAt)}</div></td>
                <td className="small">{k.scopes.includes('*') ? 'Everything' : k.scopes.join(', ')}</td>
                <td className="num small">...{k.endsWith}</td>
                <td className="small">{when(k.lastUsedAt)}</td>
                <td className="num"><button className="link danger" onClick={() => void revoke(k)}>Revoke</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {made ? (
        <Reveal label={`The key for ${made.name}.`} value={made.key} onDone={() => setMade(null)} />
      ) : (
        <form className="settings-form" onSubmit={create}>
          <label>
            System it is for
            <input required maxLength={80} placeholder="Tevalis EPOS" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <fieldset className="small" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend>What it may do</legend>
            {Object.entries(scopes).map(([scope, description]) => (
              <label key={scope} style={{ display: 'block' }}>
                <input type="checkbox" checked={form.scopes.includes(scope)} onChange={() => toggle(scope)} /> {description} <span className="muted">({scope})</span>
              </label>
            ))}
          </fieldset>
          <button className="primary" type="submit" disabled={form.scopes.length === 0}>Make key</button>
        </form>
      )}
      {message && <p className={`small ${message.bad ? 'bad-text' : 'muted'}`}>{message.text}</p>}
    </section>
  );
}

export function Webhooks() {
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [events, setEvents] = useState<{ type: string; description: string; hr: boolean }[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [form, setForm] = useState<{ url: string; events: string[]; description: string }>({ url: '', events: ['*'], description: '' });
  const [secret, setSecret] = useState<{ url: string; secret: string } | null>(null);
  const [message, setMessage] = useState<Message>(null);

  const load = useCallback(async () => {
    try {
      const [e, ev, d] = await Promise.all([
        api.get<Endpoint[]>('/v1/webhooks'),
        api.get<{ type: string; description: string; hr: boolean }[]>('/v1/webhooks/events'),
        api.get<Delivery[]>('/v1/webhooks/deliveries'),
      ]);
      setEndpoints(e);
      setEvents(ev);
      setDeliveries(d);
    } catch (err) {
      setMessage({ text: problem(err), bad: true });
    }
  }, []);
  useEffect(() => void load(), [load]);

  async function act(done: string, fn: () => Promise<unknown>) {
    try {
      await fn();
      setMessage({ text: done });
      await load();
    } catch (err) {
      setMessage({ text: problem(err), bad: true });
    }
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    try {
      const res = await api.post<Endpoint & { secret: string }>('/v1/webhooks', form);
      setSecret({ url: res.url, secret: res.secret });
      setForm({ url: '', events: ['*'], description: '' });
      setMessage(null);
      await load();
    } catch (err) {
      setMessage({ text: problem(err), bad: true });
    }
  }

  async function test(ep: Endpoint) {
    try {
      const res = await api.post<{ delivered: boolean; status: number | null; error: string | null }>(`/v1/webhooks/${ep.id}/test`);
      setMessage(res.delivered ? { text: `Test event delivered to ${ep.url} (answered ${res.status}).` } : { text: `Test not delivered: ${res.error}`, bad: true });
    } catch (err) {
      setMessage({ text: problem(err), bad: true });
    }
  }

  async function rotate(ep: Endpoint) {
    if (!confirm('Make a new signing secret? The old one stops working at once, so update the receiving system straight after.')) return;
    try {
      const res = await api.post<Endpoint & { secret: string }>(`/v1/webhooks/${ep.id}/rotate-secret`);
      setSecret({ url: res.url, secret: res.secret });
    } catch (err) {
      setMessage({ text: problem(err), bad: true });
    }
  }

  const all = form.events.includes('*');
  const isHr = (type: string) => events.some((e) => e.type === type && e.hr);
  // HR events sit beside 'Everything' rather than under it: choosing one never clears it.
  const toggle = (type: string) =>
    setForm((f) => ({
      ...f,
      events: f.events.includes(type) ? f.events.filter((t) => t !== type) : [...f.events.filter((t) => t !== '*' || isHr(type)), type],
    }));
  const shown = (list: string[]) => {
    const hr = list.filter(isHr);
    const rest = list.includes('*') ? ['All except HR'] : list.filter((t) => !isHr(t));
    return [...rest, ...hr].join(', ');
  };
  const failing = deliveries.filter((d) => d.status !== 'delivered');

  return (
    <section className="settings-card">
      <h2>Webhooks</h2>
      <p className="muted small">
        Tell another system the moment something changes here: a rota published, a starter added, hours approved. Preshift posts
        each event to your https address, signed with the endpoint's secret, and retries for several hours if it is down. Events
        carry ids only, never pay or personal details; the other system reads the detail back with its API key.
      </p>
      <p className="muted small">
        HR events (absence, personnel details, training and reviews, right to work copies) are never part of Everything: tick each one
        wanted. Only someone who can read personnel files across the organisation can send them anywhere. They never say the type
        or reason for an absence, and disciplinary, grievance and capability cases are never sent at all.
      </p>
      {endpoints.length > 0 && (
        <table className="table">
          <thead>
            <tr><th>Address</th><th>Events</th><th>State</th><th /></tr>
          </thead>
          <tbody>
            {endpoints.map((ep) => (
              <tr key={ep.id}>
                <td className="small">{ep.url}{ep.description && <div className="muted">{ep.description}</div>}</td>
                <td className="small">{shown(ep.events)}</td>
                <td className="small">{ep.active ? 'On' : 'Off'}</td>
                <td className="num">
                  <button className="link" onClick={() => void test(ep)}>Send test</button>
                  <button className="link" onClick={() => void act(ep.active ? 'Turned off.' : 'Turned on.', () => api.patch(`/v1/webhooks/${ep.id}`, { active: !ep.active }))}>
                    {ep.active ? 'Turn off' : 'Turn on'}
                  </button>
                  <button className="link" onClick={() => void rotate(ep)}>New secret</button>
                  <button className="link danger" onClick={() => { if (confirm(`Remove ${ep.url}? Events stop going there.`)) void act('Removed.', () => api.del(`/v1/webhooks/${ep.id}`)); }}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {failing.length > 0 && (
        <>
          <h3 className="small">Not yet delivered</h3>
          <table className="table">
            <tbody>
              {failing.slice(0, 10).map((d) => (
                <tr key={d.id}>
                  <td className="small">{d.type}<div className="muted">{when(d.createdAt)}</div></td>
                  <td className="small">{d.status === 'failed' ? 'Gave up' : `Retrying, ${d.attempts} tries`}</td>
                  <td className="small bad-text">{d.lastError}</td>
                  <td className="num"><button className="link" onClick={() => void act('Sent again.', () => api.post(`/v1/webhooks/deliveries/${d.id}/retry`))}>Retry now</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {secret ? (
        <Reveal label={`Signing secret for ${secret.url}.`} value={secret.secret} onDone={() => setSecret(null)} />
      ) : (
        <form className="settings-form" onSubmit={create}>
          <label>
            Send events to
            <input type="url" required placeholder="https://your-system.example/preshift" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
          </label>
          <label>
            What it is
            <input maxLength={200} placeholder="Group BI warehouse" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </label>
          <fieldset className="small" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend>Events</legend>
            <label style={{ display: 'block' }}>
              <input type="checkbox" checked={all} onChange={() => setForm({ ...form, events: all ? form.events.filter((t) => t !== '*') : ['*', ...form.events.filter(isHr)] })} />{' '}
              Everything except HR, including events added later
            </label>
            {!all && events.filter((ev) => !ev.hr).map((ev) => (
              <label key={ev.type} style={{ display: 'block' }} title={ev.description}>
                <input type="checkbox" checked={form.events.includes(ev.type)} onChange={() => toggle(ev.type)} /> {ev.type}
              </label>
            ))}
          </fieldset>
          <fieldset className="small" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend>HR events, only when ticked</legend>
            {events.filter((ev) => ev.hr).map((ev) => (
              <label key={ev.type} style={{ display: 'block' }} title={ev.description}>
                <input type="checkbox" checked={form.events.includes(ev.type)} onChange={() => toggle(ev.type)} /> {ev.type}
              </label>
            ))}
          </fieldset>
          <button className="primary" type="submit" disabled={form.events.length === 0}>Add endpoint</button>
        </form>
      )}
      {message && <p className={`small ${message.bad ? 'bad-text' : 'muted'}`}>{message.text}</p>}
    </section>
  );
}
