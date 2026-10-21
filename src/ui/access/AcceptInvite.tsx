import { useState } from 'react';
import { ApiError } from '../api';

interface Accepted { name: string; email: string; needsAuthenticator: boolean }

/** The page an invitation link opens. It needs no key: the single-use token is the proof. */
export function AcceptInvite() {
  const token = new URLSearchParams(location.search).get('token') ?? '';
  const [done, setDone] = useState<Accepted | null>(null);
  const [error, setError] = useState<string | null>(token ? null : 'This link has no invitation in it. Ask for a new one.');
  const [busy, setBusy] = useState(false);

  async function accept() {
    setBusy(true);
    const res = await fetch('/v1/invites/accept', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
    const body = await res.json().catch(() => ({}));
    if (res.ok) setDone(body as Accepted);
    else setError(new ApiError(res.status, body.error, body.message ?? 'Could not accept the invitation').message);
    setBusy(false);
  }

  return (
    <div className="app accept">
      <div className="brand">
        <span className="brand-mark" aria-hidden>P</span>
        <div className="brand-name">Preshift</div>
      </div>
      <div className="card">
        {done ? (
          <>
            <h2>Welcome, {done.name}</h2>
            <p>Your account for {done.email} is active.</p>
            {done.needsAuthenticator && <p className="warn-text">Your role needs an authenticator app. Until you set one up, payroll, pay and access rights stay switched off.</p>}
            <a className="link" href="/">Open Preshift</a>
          </>
        ) : (
          <>
            <h2>You have been invited to Preshift</h2>
            <p className="muted">Accepting activates your account. The link works once and lasts seven days.</p>
            {error && <div className="notice error">{error}</div>}
            <button className="primary" disabled={!token || busy} onClick={() => void accept()}>Accept invitation</button>
          </>
        )}
      </div>
    </div>
  );
}
