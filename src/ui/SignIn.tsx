import { useState, type FormEvent } from 'react';
import { api } from './api';

type Mode = 'signin' | 'invite' | 'signup';

/** Sign in, accept an invite (the link carries #invite=token), or set up a new organisation where the server allows it. */
export function SignIn({ onDone }: { onDone: () => void }) {
  const invite = new URLSearchParams(location.hash.slice(1)).get('invite');
  const [mode, setMode] = useState<Mode>(invite ? 'invite' : 'signin');
  const [form, setForm] = useState({ organisationName: '', name: '', email: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'signin') await api.login(form.email, form.password);
      else if (mode === 'invite') await api.acceptInvite(invite!, form.name, form.password);
      else await api.signup(form.organisationName, form.name, form.email, form.password);
      history.replaceState(null, '', location.pathname);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="signin">
      <form className="panel signin-card" onSubmit={submit}>
        <div className="brand">
          <span className="brand-mark" aria-hidden>P</span>
          <div>
            <div className="brand-name">Preshift</div>
            <div className="brand-sub">Rota by Preshift and Williams, Stanley &amp; Co.</div>
          </div>
        </div>
        <h2>{mode === 'signin' ? 'Sign in' : mode === 'invite' ? 'Accept your invite' : 'Set up your organisation'}</h2>
        {mode === 'invite' && <p className="small muted">Already have an account? Use your existing password to add this organisation to it.</p>}
        <div className="form one">
          {mode === 'signup' && (
            <label>
              Organisation
              <input required value={form.organisationName} onChange={set('organisationName')} autoComplete="organization" />
            </label>
          )}
          {mode !== 'signin' && (
            <label>
              Your name
              <input required value={form.name} onChange={set('name')} autoComplete="name" />
            </label>
          )}
          {mode !== 'invite' && (
            <label>
              Email
              <input required type="email" value={form.email} onChange={set('email')} autoComplete="email" />
            </label>
          )}
          <label>
            Password
            <input
              required
              type="password"
              minLength={mode === 'signin' ? undefined : 12}
              value={form.password}
              onChange={set('password')}
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            />
          </label>
        </div>
        {error && <div className="notice bad small">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="link" onClick={() => setMode(mode === 'signup' ? 'signin' : 'signup')}>
            {mode === 'signup' ? 'I already have an account' : 'New organisation'}
          </button>
          <span className="spacer" />
          <button className="primary" disabled={busy}>
            {mode === 'signin' ? 'Sign in' : mode === 'invite' ? 'Join' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}
