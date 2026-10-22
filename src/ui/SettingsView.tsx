import { EposSetup } from './EposSetup';
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from './api';
import { ApiKeys, Webhooks } from './DeveloperSettings';

/** The signed-in account, from /auth/me. What it may do is its access record, on the Access tab. */
export interface Account {
  email: string;
  /** The organisation this session works in. */
  orgId: string;
  /** Every organisation the person may switch to, this one included. */
  organisations?: { orgId: string; name: string; current: boolean; home: boolean }[];
  /** Set in the public demo, where each visitor has a sandbox of their own. */
  demo?: boolean;
}

interface EmailStatus {
  set: boolean;
  from?: string;
  appUrl?: string;
  keyEndsWith?: string;
  webhook?: { url: string; set: boolean };
}

interface Settings {
  claudeApiKey: { set: boolean; endsWith?: string };
  claudeLimits: { monthlyUsd: number; dailyPerPersonUsd: number };
  claudeSpend: { monthUsd: number; todayUsd: number };
  email: EmailStatus;
}

const usd = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

const problem = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

export function SettingsView({ account, canSettings, onSalesChanged }: { account: Account | null; canSettings: boolean; onSalesChanged?: () => void }) {
  if (account?.demo) {
    return (
      <div className="settings">
        <section className="settings-card">
          <h2>Settings in the demo</h2>
          <p className="small muted">
            In the live product this is where the Claude API key and email are set up, where API keys and webhooks are made for other systems to plug in, and where each person changes their own
            password. People and their roles are on the Access tab. The demo has no accounts to manage: you hold full access to
            your own copy of the demo group, and it is deleted after a day.
          </p>
          <p className="small"><a className="link" href="/demo?fresh=1">Start again with a fresh copy</a></p>
        </section>
        <EposSetup onSynced={onSalesChanged} />
      </div>
    );
  }
  return (
    <div className="settings">
      <section className="settings-card">
        <h2>People and sign-in</h2>
        <p className="muted small">
          Inviting people, their roles, password resets (emailed once email is set up below) and suspending access are on the Access tab, where each change is
          checked against the access rules and recorded. A person sets their own password from their invitation link, so
          nobody else ever knows it.
        </p>
      </section>
      {canSettings && <EposSetup onSynced={onSalesChanged} />}
      {canSettings && <ClaudeKey />}
      {canSettings && <EmailSetup />}
      {canSettings && <ApiKeys />}
      {canSettings && <Webhooks />}
      {account && <OwnPassword />}
    </div>
  );
}

function ClaudeKey() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [key, setKey] = useState('');
  const [limits, setLimitsForm] = useState({ monthlyUsd: '', dailyPerPersonUsd: '' });
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);

  useEffect(() => {
    api
      .get<Settings>('/v1/settings')
      .then((s) => {
        setSettings(s);
        setLimitsForm({ monthlyUsd: String(s.claudeLimits.monthlyUsd), dailyPerPersonUsd: String(s.claudeLimits.dailyPerPersonUsd) });
      })
      .catch((e) => setMessage({ text: problem(e), bad: true }));
  }, []);

  async function saveLimits(e: FormEvent) {
    e.preventDefault();
    try {
      const res = await api.put<Pick<Settings, 'claudeLimits'>>('/v1/settings/claude-limits', {
        monthlyUsd: Number(limits.monthlyUsd),
        dailyPerPersonUsd: Number(limits.dailyPerPersonUsd),
      });
      setSettings((s) => s && { ...s, ...res });
      setMessage({ text: 'Limits saved.' });
    } catch (err) {
      setMessage({ text: problem(err), bad: true });
    }
  }

  async function save(value: string | null) {
    try {
      // The response carries only the key, so keep the rest of what is shown.
      const res = await api.put<Pick<Settings, 'claudeApiKey'>>('/v1/settings/claude-api-key', { claudeApiKey: value });
      setSettings((s) => s && { ...s, ...res });
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
        never shown again after you save it. Preshift stops the assistant at the limits below; a limit on the key in the
        Claude Console is a sensible second line.
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
      {settings && (
        <>
          <h3 className="settings-sub">Spending</h3>
          <p className="small">
            {usd.format(settings.claudeSpend.monthUsd)} spent this month of {usd.format(settings.claudeLimits.monthlyUsd)}
            {' '}({usd.format(settings.claudeSpend.todayUsd)} by you today). Each draft is typically a few tens of cents.
          </p>
          <form className="settings-form" onSubmit={saveLimits}>
            <label>
              Monthly limit for the organisation ($)
              <input type="number" min={0} step={1} required value={limits.monthlyUsd} onChange={(e) => setLimitsForm({ ...limits, monthlyUsd: e.target.value })} />
            </label>
            <label>
              Daily limit per person ($)
              <input type="number" min={0} step={1} required value={limits.dailyPerPersonUsd} onChange={(e) => setLimitsForm({ ...limits, dailyPerPersonUsd: e.target.value })} />
            </label>
            <button type="submit">Save limits</button>
          </form>
        </>
      )}
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

function EmailSetup() {
  const [email, setEmail] = useState<EmailStatus | null>(null);
  const [form, setForm] = useState({ resendApiKey: '', from: '', appUrl: location.origin, webhookSecret: '' });
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);

  useEffect(() => {
    api
      .get<Settings>('/v1/settings')
      .then(({ email }) => {
        setEmail(email);
        if (email.set) setForm({ resendApiKey: '', from: email.from ?? '', appUrl: email.appUrl ?? location.origin, webhookSecret: '' });
      })
      .catch((e) => setMessage({ text: problem(e), bad: true }));
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      setEmail((await api.put<{ email: EmailStatus }>('/v1/settings/email', form)).email);
      setForm({ ...form, resendApiKey: '', webhookSecret: '' });
      setMessage({ text: 'Saved. Invitations and password resets now go by email, and "Forgot your password?" works on the sign-in page.' });
    } catch (err) {
      setMessage({ text: problem(err), bad: true });
    }
  }

  async function remove() {
    if (!confirm('Turn off email? Invitation and reset links will come back to whoever sends them, to hand over themselves.')) return;
    try {
      setEmail((await api.del<{ email: EmailStatus }>('/v1/settings/email')).email);
      setMessage({ text: 'Removed. Email is off.' });
    } catch (err) {
      setMessage({ text: problem(err), bad: true });
    }
  }

  return (
    <section className="settings-card">
      <h2>Email</h2>
      <p className="muted small">
        Sends invitations and password reset links straight to the person, and lets people reset a forgotten password
        themselves from the sign-in page. Emails go through Resend from an address on a domain you have verified there.
        Until this is set, the Access tab shows each link once to whoever sends it, to hand over in person.
      </p>
      <p className="small">
        {email ? (email.set ? `On. Sent from ${email.from}, key ending ${email.keyEndsWith}.` : 'Off.') : '...'}
      </p>
      <form className="settings-form" onSubmit={save}>
        <label>
          {email?.set ? 'Replace Resend key (leave blank to keep)' : 'Resend API key'}
          <input type="password" autoComplete="off" placeholder="re_..." required={!email?.set} value={form.resendApiKey} onChange={(e) => setForm({ ...form, resendApiKey: e.target.value })} />
        </label>
        <label>
          Send from
          <input required placeholder="Preshift <rota@yourdomain.co.uk>" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} />
        </label>
        <label>
          App address used in links
          <input type="url" required value={form.appUrl} onChange={(e) => setForm({ ...form, appUrl: e.target.value })} />
        </label>
        {email?.set && email.webhook && (
          <>
            <p className="muted small">
              Delivery reports: in Resend, add a webhook to <code>{email.webhook.url}</code> for the events email.sent,
              email.delivered, email.delivery_delayed, email.bounced, email.complained and email.failed, then paste its signing
              secret here. Bounces then show on the Access tab against the person. Leave opens and clicks off: Preshift does not
              track them. Without the webhook, "Check now" on a person asks Resend instead.
            </p>
            <label>
              {email.webhook.set ? 'Webhook signing secret saved. Replace it (leave blank to keep)' : 'Webhook signing secret'}
              <input type="password" autoComplete="off" placeholder="whsec_..." value={form.webhookSecret} onChange={(e) => setForm({ ...form, webhookSecret: e.target.value })} />
            </label>
          </>
        )}
        <button className="primary" type="submit">Save</button>
        {email?.set && <button type="button" className="danger" onClick={() => void remove()}>Turn off</button>}
      </form>
      {message && <p className={`small ${message.bad ? 'bad-text' : 'muted'}`}>{message.text}</p>}
    </section>
  );
}
