import { useEffect, useState, type FormEvent } from 'react';
import { PasswordRules, passwordReady } from './ChangePassword';
import { checkReset, resetPassword } from './session';

export function ResetPassword({ token, onDone }: { token: string; onDone: () => void }) {
  const [email, setEmail] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    checkReset(token).then(
      (r) => setEmail(r.email),
      (err) => setInvalid(err instanceof Error ? err.message : 'This reset link is not valid.'),
    );
  }, [token]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!passwordReady(next, confirm)) return;
    setBusy(true);
    setError(null);
    try {
      await resetPassword(token, next);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reset your password.');
      setBusy(false);
    }
  }

  if (invalid) {
    return (
      <div className="login">
        <div className="login-card">
          <h1>Link no longer works</h1>
          <p className="muted">{invalid}</p>
          <a className="button-link" href="/app/#forgot">Send a new link</a>
        </div>
      </div>
    );
  }
  if (!email) return <div className="login"><p className="muted">Checking your link</p></div>;

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <h1>Choose a new password</h1>
        <p className="muted">For {email}. Saving it signs out every device signed in to this account and signs you in here.</p>
        <input type="email" autoComplete="username" value={email} readOnly hidden />
        <label>
          New password
          <input type={show ? 'text' : 'password'} autoComplete="new-password" required value={next} onChange={(e) => setNext(e.target.value)} />
        </label>
        <label>
          Confirm new password
          <input type={show ? 'text' : 'password'} autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </label>
        <label className="check">
          <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Show passwords
        </label>
        <PasswordRules next={next} confirm={confirm} />
        {error && <p className="login-error" role="alert">{error}</p>}
        <button type="submit" className="primary" disabled={busy || !passwordReady(next, confirm)}>
          {busy ? 'Saving' : 'Save and sign in'}
        </button>
      </form>
    </div>
  );
}
