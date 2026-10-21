import { useState, type FormEvent } from 'react';
import { changePassword, type User } from './session';

const MIN = 12;

interface Props {
  user: User;
  /** True when an admin set the password and the user must replace it before going on. */
  forced?: boolean;
  onDone: () => void;
  onCancel?: () => void;
}

export function ChangePassword({ user, forced, onDone, onCancel }: Props) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const longEnough = next.length >= MIN;
  const matches = next.length > 0 && next === confirm;
  const different = next.length > 0 && next !== current;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!longEnough || !matches || !different) return;
    setBusy(true);
    setError(null);
    try {
      await changePassword(current, next);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change your password.');
    } finally {
      setBusy(false);
    }
  }

  const form = done ? (
    <div className="login-card">
      <h1>Password changed</h1>
      <p className="muted">Any other devices signed in as {user.email} have been signed out. This one stays signed in.</p>
      <button className="primary" onClick={onDone}>Continue</button>
    </div>
  ) : (
    <form className="login-card" onSubmit={submit}>
      <h1>{forced ? 'Choose your own password' : 'Change password'}</h1>
      {forced && (
        <p className="muted">
          Your password was set by an administrator, so it has been shared with at least one other person. Replace it
          with one only you know before you continue.
        </p>
      )}
      {/* Lets password managers file the new password against the right account. */}
      <input type="email" autoComplete="username" value={user.email} readOnly hidden />
      <label>
        {forced ? 'Password you were given' : 'Current password'}
        <input type={show ? 'text' : 'password'} autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
      </label>
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
      <ul className="pw-rules">
        <li className={longEnough ? 'ok' : ''}>At least {MIN} characters. Three or four unrelated words is easiest to remember.</li>
        <li className={matches ? 'ok' : ''}>Both new password boxes match</li>
        <li className={different ? 'ok' : ''}>Different from the current password</li>
      </ul>
      {error && <p className="login-error" role="alert">{error}</p>}
      <div className="row-actions">
        <button type="submit" className="primary" disabled={busy || !longEnough || !matches || !different}>
          {busy ? 'Saving' : 'Change password'}
        </button>
        {onCancel && <button type="button" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );

  if (forced) return <div className="login">{form}</div>;
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>{form}</div>
    </div>
  );
}
