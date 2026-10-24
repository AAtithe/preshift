import { useEffect, useState } from 'react';
import type { LedgerProblem } from '../engine/ledger';
import { api, ApiError } from './api';
import { money2 } from './format';

// Posting the labour accrual straight into each company's Xero, on the Close screen. Settings people
// connect Xero and choose which organisation each company posts to; whoever runs the close posts.
// The rules live on the server (server/routes/accounting.ts): checked against Xero's own chart and
// tracking first, never the same week twice unless replaced, and reversed on the Monday after.

export interface XeroStatus {
  configured: boolean;
  simulatorAllowed: boolean;
  connection: { environment: 'production' | 'simulator'; connectedAt: string; connectedBy: string } | null;
  tenants: { tenantId: string; name: string }[];
  ledgers: { entityId: string; name: string; tenantId: string | null; tenantName?: string | null; status?: 'DRAFT' | 'POSTED'; reverse?: boolean }[];
}

export interface XeroPosting {
  id: string;
  journalId: string;
  status: 'DRAFT' | 'POSTED';
  date: string;
  reversalDate?: string;
  debits: number;
  basis: 'rota' | 'actual';
  postedAt: string;
  postedBy: string;
}

export interface XeroCheck {
  basis: 'rota' | 'actual';
  ledger: { tenantName: string; status: 'DRAFT' | 'POSTED'; reverse: boolean } | null;
  debits: number;
  problems: LedgerProblem[];
  posting: XeroPosting | null;
  changed: boolean;
}

const day = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const failure = (e: unknown) => (e instanceof ApiError && Array.isArray(e.details) ? (e.details as string[]).join(' ') : e instanceof Error ? e.message : String(e));

const RETURNED: Record<string, { text: string; bad?: boolean }> = {
  connected: { text: 'Xero is connected. Check which organisation each company posts to below.' },
  expired: { text: 'That Xero sign-in had run out or was started by someone else. Connect again.', bad: true },
  cancelled: { text: 'Xero was not connected: the sign-in was cancelled in Xero.', bad: true },
  error: { text: 'Xero did not complete the connection. Try again in a minute.', bad: true },
};

/** Connecting Xero and choosing where each company posts. For people who manage settings. */
export function XeroSettings({ status, onChange }: { status: XeroStatus; onChange: (s: XeroStatus) => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(() => {
    const returned = new URLSearchParams(window.location.search).get('xero');
    return returned ? RETURNED[returned] ?? null : null;
  });

  // The note from Xero's sign-in is said once, then taken out of the address so a refresh does not repeat it.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (!q.has('xero')) return;
    q.delete('xero');
    window.history.replaceState(null, '', `${window.location.pathname}?${q}`);
  }, []);

  async function run(work: () => Promise<XeroStatus | void>, done?: string) {
    setBusy(true);
    setMessage(null);
    try {
      const next = await work();
      if (next) onChange(next);
      if (done) setMessage({ text: done });
    } catch (e) {
      setMessage({ text: failure(e), bad: true });
    } finally {
      setBusy(false);
    }
  }

  async function connect(environment: 'production' | 'simulator') {
    await run(async () => {
      const res = await api.post<XeroStatus & { authorizeUrl?: string }>('/v1/integrations/xero/connect', { environment });
      // Off to Xero to choose the organisations; Xero sends the person back to Close.
      if (res.authorizeUrl) window.location.assign(res.authorizeUrl);
      else return res;
    });
  }

  const conn = status.connection;
  return (
    <section className="settings-card xero-settings">
      <h2>Xero</h2>
      {!conn ? (
        <>
          <p className="muted small">
            Connect Xero and each company's labour accrual posts straight into its own books from this screen, checked against its chart of
            accounts and site tracking first. Nobody downloads or imports a file. You choose which Xero organisations Preshift may reach.
          </p>
          <div className="row-actions">
            {status.configured && <button className="primary" disabled={busy} onClick={() => void connect('production')}>Connect Xero</button>}
            {status.simulatorAllowed && <button disabled={busy} onClick={() => void connect('simulator')}>Use the simulated Xero</button>}
          </div>
          {!status.configured && !status.simulatorAllowed && <p className="muted small">Xero is not set up on this server yet. Its app credentials are added by whoever runs Preshift.</p>}
        </>
      ) : (
        <>
          <p className="muted small">
            {conn.environment === 'simulator' ? 'The simulated Xero: journals post into books held in Preshift, never a real ledger. ' : ''}
            Connected by {conn.connectedBy} on {day(conn.connectedAt)}. Each company posts into its own Xero organisation. A draft waits for someone
            to approve it in Xero; posted goes straight into the books. The reversal goes in on the Monday after, so payroll's own journal carries the
            real cost.
          </p>
          <table className="table">
            <thead>
              <tr><th>Company</th><th>Xero organisation</th><th>Journals</th><th>Reverse on the Monday after</th></tr>
            </thead>
            <tbody>
              {status.ledgers.map((l) => (
                <tr key={l.entityId}>
                  <td className="strong">{l.name}</td>
                  <td>
                    <select
                      aria-label={`Xero organisation for ${l.name}`}
                      disabled={busy}
                      value={l.tenantId ?? ''}
                      onChange={(e) => void run(() => api.put<XeroStatus>(`/v1/integrations/xero/ledgers/${l.entityId}`, { tenantId: e.target.value || null }), 'Saved.')}
                    >
                      <option value="">Not posting</option>
                      {status.tenants.map((t) => <option key={t.tenantId} value={t.tenantId}>{t.name}</option>)}
                    </select>
                  </td>
                  <td>
                    <select
                      aria-label={`How ${l.name} posts`}
                      disabled={busy || !l.tenantId}
                      value={l.status ?? 'DRAFT'}
                      onChange={(e) => void run(() => api.put<XeroStatus>(`/v1/integrations/xero/ledgers/${l.entityId}`, { tenantId: l.tenantId, status: e.target.value }), 'Saved.')}
                    >
                      <option value="DRAFT">Draft, approved in Xero</option>
                      <option value="POSTED">Posted</option>
                    </select>
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Reverse ${l.name}'s accrual`}
                      disabled={busy || !l.tenantId}
                      checked={l.reverse ?? true}
                      onChange={(e) => void run(() => api.put<XeroStatus>(`/v1/integrations/xero/ledgers/${l.entityId}`, { tenantId: l.tenantId, reverse: e.target.checked }), 'Saved.')}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row-actions">
            <button className="link" disabled={busy} onClick={() => void run(() => api.del<XeroStatus>('/v1/integrations/xero'), 'Xero is disconnected. What was posted stays in Xero.')}>Disconnect Xero</button>
          </div>
        </>
      )}
      {message && <p className={`small ${message.bad ? 'bad-text' : 'good-text'}`}>{message.text}</p>}
    </section>
  );
}

/** One company's week in Xero: what the check found, what was posted, and the button to post it. */
export function XeroPost({ entityId, week, basis }: { entityId: string; week: string; basis: 'auto' | 'rota' | 'actual' }) {
  const [check, setCheck] = useState<XeroCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api.get<XeroCheck>(`/v1/journal/xero/check?weekStart=${week}&entityId=${encodeURIComponent(entityId)}&basis=${basis}`).then(setCheck).catch((e) => setError(failure(e)));
  useEffect(() => {
    setCheck(null);
    setError(null);
    void load();
  }, [entityId, week, basis]);

  async function post(replace: boolean) {
    setBusy(true);
    setError(null);
    try {
      await api.post('/v1/journal/xero', { weekStart: week, entityId, basis, ...(replace ? { replace: true } : {}) });
      await load();
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/v1/journal/xero/postings/${encodeURIComponent(id)}/remove`);
      await load();
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  }

  if (!check) return error ? <p className="bad-text small xero-post">{error}</p> : null;
  const blocks = check.problems.filter((p) => p.severity === 'block');
  const posted = check.posting;
  const kind = (s: 'DRAFT' | 'POSTED') => (s === 'DRAFT' ? 'a draft' : 'posted');
  return (
    <div className="xero-post">
      {posted ? (
        <p className={`small ${check.changed ? 'warn-text' : 'good-text'}`}>
          In Xero as {kind(posted.status)}, {money2(posted.debits)} on {day(posted.date)}{posted.reversalDate ? `, reversed ${day(posted.reversalDate)}` : ''}. Sent by{' '}
          {posted.postedBy} on {day(posted.postedAt)} from the {posted.basis === 'actual' ? 'approved actuals' : 'rota'}.
          {check.changed ? ' The journal has changed since: post again to void that one and send this.' : ''}
        </p>
      ) : (
        check.ledger && <p className="muted small">Goes to {check.ledger.tenantName} as {kind(check.ledger.status)}{check.ledger.reverse ? ', with its reversal on the Monday after' : ''}.</p>
      )}
      {check.problems.length > 0 && (
        <ul className="issues compact">
          {check.problems.map((p) => <li key={p.message} className={p.severity}>{p.message}</li>)}
        </ul>
      )}
      <div className="row-actions">
        {!posted && <button className="primary" disabled={busy || blocks.length > 0} onClick={() => void post(false)}>{busy ? 'Posting' : 'Post to Xero'}</button>}
        {posted && check.changed && <button className="primary" disabled={busy || blocks.length > 0} onClick={() => void post(true)}>{busy ? 'Posting' : 'Post again, replacing it'}</button>}
        {posted && <button className="link" disabled={busy} onClick={() => void remove(posted.id)}>Take it out of Xero</button>}
      </div>
      {error && <p className="bad-text small">{error}</p>}
    </div>
  );
}
