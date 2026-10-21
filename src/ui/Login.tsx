import { useState, type FormEvent } from 'react';
import { login, requestReset } from './session';

export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [mode, setMode] = useState<'signIn' | 'forgot' | 'sent'>(() =>
    window.location.hash === '#forgot' ? 'forgot' : 'signIn',
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sentMessage, setSentMessage] = useState('');
  const [busy, setBusy] = useState(false);

  function switchTo(next: typeof mode) {
    setMode(next);
    setError(null);
    history.replaceState(null, '', next === 'forgot' ? '#forgot' : window.location.pathname);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'forgot') {
        setSentMessage((await requestReset(email)).message);
        switchTo('sent');
      } else {
        await login(email, password);
        onSignedIn();
        return;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again.');
    }
    setBusy(false);
  }

  const brand = (
    <div className="brand">
      <span className="brand-mark" aria-hidden>P</span>
      <div>
        <div className="brand-name">Preshift</div>
        <div className="brand-sub">Rota by Preshift and Williams, Stanley &amp; Co.</div>
      </div>
    </div>
  );

  if (mode === 'sent') {
    return (
      <div className="login">
        <div className="login-card">
          {brand}
          <h1>Check your email</h1>
          <p className="muted">{sentMessage}</p>
          <p className="muted">Nothing after a few minutes? Check spam, then ask your administrator for a link.</p>
          <button onClick={() => switchTo('signIn')}>Back to sign in</button>
        </div>
      </div>
    );
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        {brand}
        <h1>{mode === 'forgot' ? 'Reset your password' : 'Sign in'}</h1>
        {mode === 'forgot' && <p className="muted">Enter the email you sign in with and we will send a link to choose a new password.</p>}
        <label>
          Email
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {mode === 'signIn' && (
          <label>
            <span className="label-row">
              Password
              <button type="button" className="link" onClick={() => switchTo('forgot')}>Forgot password?</button>
            </span>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        )}
        {error && <p className="login-error" role="alert">{error}</p>}
        <button type="submit" className="primary" disabled={busy}>
          {mode === 'forgot' ? (busy ? 'Sending' : 'Send reset link') : busy ? 'Signing in' : 'Sign in'}
        </button>
        {mode === 'forgot' ? (
          <button type="button" onClick={() => switchTo('signIn')}>Back to sign in</button>
        ) : (
          <p className="login-alt">
            No account yet? <a href="/demo/">Try the demo</a> with sample data, or{' '}
            <a href="mailto:hello@preshift.co.uk?subject=Preshift%20Rota%20access">ask for access</a>.
          </p>
        )}
      </form>
    </div>
  );
}
