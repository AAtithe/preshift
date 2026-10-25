import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { syncedAt } from './EposSetup';

interface Status {
  connected: boolean;
  connectedAt?: string;
  connectedBy?: string;
  waiting?: number;
  review?: number;
}

/** Connects the organisation's own TrustID account for right to work checks done on the person's phone. */
export function TrustIdSetup() {
  const [status, setStatus] = useState<Status | null>(null);
  const [form, setForm] = useState({ apiKey: '', username: '', password: '', base: '' });
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  const load = useCallback(() => api.get<Status>('/v1/integrations/trustid').then(setStatus), []);
  useEffect(() => void load().catch(() => setStatus({ connected: false })), [load]);
  const connect = async () => {
    try {
      await api.put('/v1/integrations/trustid', { apiKey: form.apiKey, username: form.username, password: form.password, ...(form.base ? { base: form.base } : {}) });
      setForm({ apiKey: '', username: '', password: '', base: '' });
      await load();
      setNote({ text: 'Connected. Send a check from a person\'s right to work section.' });
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : String(e), bad: true });
    }
  };
  const disconnect = async () => {
    await api.del('/v1/integrations/trustid');
    await load();
  };
  return (
    <section className="settings-card">
      <h2>TrustID</h2>
      <p className="muted small">
        Right to work checks done by the person on their own phone through your TrustID account. TrustID emails them a link, checks the
        documents or share code, and the result is written to their record: a time-limited permission sets the follow-up date, a
        rejection clears the check so the rota blocks their shifts, and anything TrustID flags waits for you to look at in TrustID.
        Each client uses its own TrustID account, as the check is the employer's statutory excuse.
      </p>
      {status?.connected ? (
        <p className="small">
          Connected by {status.connectedBy}, {syncedAt(status.connectedAt!)}. {status.waiting} waiting for the person, {status.review} to review in TrustID.{' '}
          <button className="link" onClick={() => void disconnect()}>Disconnect</button>
        </p>
      ) : (
        <form className="settings-form" onSubmit={(e) => { e.preventDefault(); void connect(); }}>
          <label>API key<input type="password" autoComplete="off" required value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} /></label>
          <label>User name<input autoComplete="off" required value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></label>
          <label>Password<input type="password" autoComplete="off" required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
          <label>TrustID address (optional)<input placeholder="https://cloud.trustid.co.uk" value={form.base} onChange={(e) => setForm({ ...form, base: e.target.value })} /></label>
          <button className="primary" type="submit">Connect</button>
        </form>
      )}
      {note && <p className={`small ${note.bad ? 'bad-text' : 'good-text'}`}>{note.text}</p>}
    </section>
  );
}
