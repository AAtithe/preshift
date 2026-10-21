import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from './api';

export interface Me {
  email: string;
  orgId: string;
  role: 'admin' | 'member';
  /** The Williams, Stanley & Co. lead on the labour programme. */
  lead?: boolean;
}

interface Person {
  email: string;
  role: 'admin' | 'member';
  createdAt: string;
  locked: boolean;
}

interface Settings {
  claudeApiKey: { set: boolean; endsWith?: string };
}

const problem = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

export function SettingsView({ me }: { me: Me }) {
  return (
    <div className="settings">
      {me.role === 'admin' && <People me={me} />}
      {me.role === 'admin' && <ClaudeKey />}
      <OwnPassword />
    </div>
  );
}

function People({ me }: { me: Me }) {
  const [people, setPeople] = useState<Person[]>([]);
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);
  const [form, setForm] = useState({ email: '', password: '', role: 'member' as Person['role'] });

  const load = useCallback(async () => {
    try {
      setPeople(await api.get<Person[]>('/v1/users'));
    } catch (e) {
      setMessage({ text: problem(e), bad: true });
    }
  }, []);
  useEffect(() => void load(), [load]);

  async function act(done: string, fn: () => Promise<unknown>) {
    try {
      await fn();
      setMessage({ text: done });
      await load();
    } catch (e) {
      setMessage({ text: problem(e), bad: true });
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    await act(`Added ${form.email}. Give them the password yourself; they can change it under Settings.`, () =>
      api.post('/v1/users', form),
    );
    setForm({ email: '', password: '', role: 'member' });
  }

  function reset(p: Person) {
    const password = prompt(`New password for ${p.email}, at least 12 characters. They will be signed out everywhere.`);
    if (password) void act(`Password reset for ${p.email}.`, () => api.patch(`/v1/users/${encodeURIComponent(p.email)}`, { password }));
  }

  return (
    <section className="settings-card">
      <h2>Who can sign in</h2>
      <p className="muted small">
        Accounts for signing in to Preshift. This is separate from the People tab, which holds your staff records. Admins can
        also add and remove accounts and change these settings.
      </p>
      <table className="table">
        <thead>
          <tr><th>Email</th><th>Role</th><th>Added</th><th /></tr>
        </thead>
        <tbody>
          {people.map((p) => (
            <tr key={p.email}>
              <td>
                {p.email}
                {p.email === me.email && <span className="muted"> (you)</span>}
                {p.locked && <span className="tag">locked</span>}
              </td>
              <td>
                <select
                  value={p.role}
                  disabled={p.email === me.email}
                  aria-label={`Role for ${p.email}`}
                  onChange={(e) => void act(`${p.email} is now ${e.target.value === 'admin' ? 'an admin' : 'a member'}.`, () =>
                    api.patch(`/v1/users/${encodeURIComponent(p.email)}`, { role: e.target.value }))}
                >
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
              </td>
              <td className="muted small">{new Date(p.createdAt).toLocaleDateString('en-GB')}</td>
              <td className="num">
                <button className="link" onClick={() => reset(p)}>Reset password</button>
                {p.email !== me.email && (
                  <button
                    className="link danger"
                    onClick={() => { if (confirm(`Remove ${p.email}? They lose access straight away.`)) void act(`Removed ${p.email}.`, () => api.del(`/v1/users/${encodeURIComponent(p.email)}`)); }}
                  >
                    Remove
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form className="settings-form" onSubmit={add}>
        <label>Email <input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
        <label>
          First password
          <input type="text" required minLength={12} autoComplete="off" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </label>
        <label>
          Role
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Person['role'] })}>
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <button className="primary" type="submit">Add account</button>
      </form>
      {message && <p className={`small ${message.bad ? 'bad-text' : 'muted'}`}>{message.text}</p>}
    </section>
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
