import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { syncedAt } from './EposSetup';

interface AtsStatus {
  connection: null | { source: 'talent_funnel' | 'other'; label: string; connectedAt: string; connectedBy: string; lastReceived: { at: string; ok: boolean; message?: string } | null };
  webhookUrl: string | null;
  waiting: number;
}

const problem = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Connects a recruitment system, so each hire arrives on Onboarding ready to check and add. */
export function RecruitmentSetup() {
  const [status, setStatus] = useState<AtsStatus | null>(null);
  const [source, setSource] = useState<'talent_funnel' | 'other'>('talent_funnel');
  const [secret, setSecret] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);
  const load = useCallback(() => api.get<AtsStatus>('/v1/integrations/ats').then(setStatus), []);
  useEffect(() => {
    load().catch((e) => setMessage({ text: problem(e), bad: true }));
  }, [load]);
  const connect = async () => {
    try {
      const r = await api.put<{ secret: string }>('/v1/integrations/ats', { source });
      setSecret(r.secret);
      await load();
      setMessage({ text: 'Connected. Copy the signing secret now: it is shown only once.' });
    } catch (e) {
      setMessage({ text: problem(e), bad: true });
    }
  };
  const disconnect = async () => {
    try {
      await api.del('/v1/integrations/ats');
      setSecret(null);
      await load();
      setMessage({ text: 'Disconnected. Hires already handed over stay on Onboarding.' });
    } catch (e) {
      setMessage({ text: problem(e), bad: true });
    }
  };
  const conn = status?.connection;
  return (
    <section className="settings-card">
      <h2>Recruitment</h2>
      <p className="muted small">
        Each candidate marked hired in your recruitment system arrives on Onboarding with the details they applied with, for a manager
        at the site to check and add as a starter. Point the system's hired webhook at the address below, signed with the secret
        (HMAC-SHA256 of the body, sent as X-Preshift-Signature: sha256=...).
      </p>
      {conn && (
        <p className="small">
          Connected to {conn.label} by {conn.connectedBy}, {syncedAt(conn.connectedAt)}. {status!.waiting} hire{status!.waiting === 1 ? '' : 's'} waiting.
          {conn.lastReceived ? ` Last received ${syncedAt(conn.lastReceived.at)}${conn.lastReceived.ok ? '' : `: ${conn.lastReceived.message}`}.` : ' Nothing received yet.'}
        </p>
      )}
      {status?.webhookUrl && <p className="small">Webhook address: <code>{status.webhookUrl}</code></p>}
      <form className="settings-form" onSubmit={(e) => { e.preventDefault(); void connect(); }}>
        <label>
          System
          <select value={source} onChange={(e) => setSource(e.target.value as 'talent_funnel' | 'other')}>
            <option value="talent_funnel">Talent Funnel</option>
            <option value="other">Another applicant tracking system</option>
          </select>
        </label>
        <button className="primary" type="submit">{conn ? 'New secret' : 'Connect'}</button>
        {conn && <button type="button" className="danger" onClick={() => void disconnect()}>Disconnect</button>}
      </form>
      {secret && (
        <div className="settings-form">
          <label>
            Signing secret (shown once)
            <input readOnly value={secret} onFocus={(e) => e.currentTarget.select()} />
          </label>
        </div>
      )}
      {message && <p className={`small ${message.bad ? 'bad-text' : 'good-text'}`}>{message.text}</p>}
    </section>
  );
}
