import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from './api';

/** The signed-in account, from /auth/me. What it may do is its access record, on the Access tab. */
export interface Account {
  email: string;
  orgId: string;
}

interface Settings {
  claudeApiKey: { set: boolean; endsWith?: string };
}

const problem = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

export function SettingsView({ account, canSettings }: { account: Account | null; canSettings: boolean }) {
  return (
    <div className="settings">
      <section className="settings-card">
        <h2>People and sign-in</h2>
        <p className="muted small">
          Inviting people, their roles, password resets and suspending access are on the Access tab, where each change is
          checked against the access rules and recorded. A person sets their own password from their invitation link, so
          nobody else ever knows it.
        </p>
      </section>
      {canSettings && <ClaudeKey />}
      {account && <OwnPassword />}
    </div>
  );
}

function ClaudeKey() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [key, setKey] = useState('');
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);

  useEffect(() => {
    api.get<Settings>('/v1/settings').then(setSettings).catch((e) => setMessage({ text: problem(e), bad: true }));
  }, []);

  async function save(value: string | null) {
    try {
      setSettings(await api.put<Settings>('/v1/settings/claude-api-key', { claudeApiKey: value }));
      setKey('');
      setMessage({ text: value ? 'Saved. The rota assistant is ready.' : 'Removed. The rota assistant is off.' });
    } catch (e) {
      setMessage({ text: problem(e), bad: true });
    }
  }

  const current = settings?.claudeApiKey;
  return (
    <section className="settings-card">
      <h2>Rota assistant</h2>
      <p className="muted small">
        The assistant uses your organisation's Claude API key. It is kept on the server, used only for the assistant, and
        never shown again after you save it. Set a monthly spend limit on it in the Claude Console.
      </p>
      <p className="small">
        {current ? (current.set ? `A key is saved, ending ${current.endsWith}.` : 'No key saved, so the assistant is off.') : '...'}
      </p>
      <form className="settings-form" onSubmit={(e) => { e.preventDefault(); void save(key); }}>
        <label>
          {current?.set ? 'Replace key' : 'Claude API key'}
          <input type="password" autoComplete="off" placeholder="sk-ant-..." required value={key} onChange={(e) => setKey(e.target.value)} />
        </label>
        <button className="primary" type="submit">Save key</button>
        {current?.set && (
          <button type="button" className="danger" onClick={() => { if (confirm('Remove the key? The assistant stops working until a new one is saved.')) void save(null); }}>
            Remove key
          </button>
        )}
      </form>
      {message && <p className={`small ${message.bad ? 'bad-text' : 'muted'}`}>{message.text}</p>}
    </section>
  );
}

function OwnPassword() {
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);

  async function change(e: FormEvent) {
    e.preventDefault();
    if (form.newPassword !== form.confirm) return setMessage({ text: 'The two new passwords do not match.', bad: true });
    try {
      await api.post('/auth/password', { currentPassword: form.currentPassword, newPassword: form.newPassword });
      setForm({ currentPassword: '', newPassword: '', confirm: '' });
      setMessage({ text: 'Password changed. Any other device you were signed in on has been signed out.' });
    } catch (err) {
      setMessage({ text: problem(err), bad: true });
    }
  }

  return (
    <section className="settings-card">
      <h2>Your password</h2>
      <form className="settings-form" onSubmit={change}>
        <label>Current password <input type="password" autoComplete="current-password" required value={form.currentPassword} onChange={(e) => setForm({ ...form, currentPassword: e.target.value })} /></label>
        <label>New password <input type="password" autoComplete="new-password" minLength={12} required value={form.newPassword} onChange={(e) => setForm({ ...form, newPassword: e.target.value })} /></label>
        <label>New password again <input type="password" autoComplete="new-password" minLength={12} required value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} /></label>
        <button className="primary" type="submit">Change password</button>
      </form>
      {message && <p className={`small ${message.bad ? 'bad-text' : 'muted'}`}>{message.text}</p>}
    </section>
  );
}
