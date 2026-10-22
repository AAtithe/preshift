import { useEffect, useState, type FormEvent } from 'react';
import { AUDIENCE_LABEL, live, roleOf, ukDate } from '../engine/access';
import type { RotaState } from '../engine/types';
import { EnrolDialog, RecoveryCodes } from './access/Authenticator';
import { lastSeen, reach, today, type Me } from './access/model';
import { api, ApiError } from './api';
import { OwnPassword, type Account } from './SettingsView';

const problem = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

/**
 * The signed-in person's own page: their details, what they can do and where, how they sign in.
 * Name and title are theirs to change. Email is the identity, and roles are granted by someone
 * else on the Access tab, so both are shown here but never edited.
 */
export function ProfileView({ me, account, state, onSaved }: { me: Me | null; account: Account | null; state: RotaState; onSaved: () => void }) {
  if (account?.demo) {
    return (
      <div className="settings">
        <section className="settings-card">
          <h2>Your profile in the demo</h2>
          <p className="small muted">
            In the live product this is where each person keeps their own name and job title, sees the roles they hold and at which
            sites, changes their password and manages their authenticator. The demo has no accounts of its own: switch who you are
            acting as at the top to see what each role can do.
          </p>
        </section>
      </div>
    );
  }
  const user = me?.user;
  return (
    <div className="settings">
      {user ? <Details me={me!} onSaved={onSaved} /> : <NoRecord email={account?.email} />}
      {user && <Access me={me!} state={state} />}
      {user && <Security me={me!} />}
      {account && <OwnPassword />}
      {account && <Organisations account={account} />}
      <section className="settings-card">
        <h2>Sign out</h2>
        <p className="small muted">Ends this session on this device. Changing your password above signs out every other device.</p>
        <p className="small"><a className="link" href="/auth/logout">Sign out</a></p>
      </section>
    </div>
  );
}

function NoRecord({ email }: { email?: string }) {
  return (
    <section className="settings-card">
      <h2>Your details</h2>
      <p className="small">{email ? `Signed in as ${email}.` : 'Signed in with an API key.'}</p>
      <p className="small muted">
        You have no access record in this organisation yet, so there is no name or role to show. Ask whoever manages access to add
        you on the Access tab. Until then you keep the organisation-wide access every account had before roles.
      </p>
    </section>
  );
}

function Details({ me, onSaved }: { me: Me; onSaved: () => void }) {
  const user = me.user!;
  const [form, setForm] = useState({ name: user.name, jobTitle: user.jobTitle ?? '' });
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);
  useEffect(() => setForm({ name: user.name, jobTitle: user.jobTitle ?? '' }), [user.name, user.jobTitle]);
  const changed = form.name.trim() !== user.name || form.jobTitle.trim() !== (user.jobTitle ?? '');

  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      await api.patch('/v1/me', { name: form.name, jobTitle: form.jobTitle });
      setMessage({ text: 'Saved. Your new name shows on rotas, approvals and the access record from now on.' });
      onSaved();
    } catch (err) {
      setMessage({ text: problem(err), bad: true });
    }
  }

  return (
    <section className="settings-card">
      <h2>Your details</h2>
      <p className="small muted">
        Your name and job title are yours to keep right. Your email is how you sign in and how the organisation knows you, so to
        change it ask whoever manages access to invite the new address.
      </p>
      <form className="settings-form" onSubmit={save}>
        <label>Name <input required maxLength={120} autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label>Job title <input maxLength={120} autoComplete="organization-title" value={form.jobTitle} onChange={(e) => setForm({ ...form, jobTitle: e.target.value })} /></label>
        <button className="primary" type="submit" disabled={!changed || !form.name.trim()}>Save details</button>
      </form>
      {message && <p className={`small ${message.bad ? 'bad-text' : 'muted'}`}>{message.text}</p>}
      <table className="table">
        <tbody>
          <tr><th>Email</th><td>{user.email}</td></tr>
          <tr><th>Side</th><td>{AUDIENCE_LABEL[user.audience]}</td></tr>
          {user.activatedAt && <tr><th>Joined</th><td>{ukDate(user.activatedAt)}</td></tr>}
          {user.invitedBy && <tr><th>Invited by</th><td>{user.invitedBy}</td></tr>}
          <tr><th>Last seen</th><td>{lastSeen(user)}</td></tr>
        </tbody>
      </table>
    </section>
  );
}

function Access({ me, state }: { me: Me; state: RotaState }) {
  const user = me.user!;
  const now = today();
  const current = user.memberships.filter((m) => live(m, now));
  const coming = user.memberships.filter((m) => m.active && m.starts > now);
  const employee = user.employeeId ? state.employees.find((e) => e.id === user.employeeId) : undefined;
  return (
    <section className="settings-card">
      <h2>Your roles</h2>
      <p className="small muted">
        What you can do, and where. Roles are granted and ended on the Access tab by someone who manages access, never by the
        person who holds them, so nobody can widen their own reach.
      </p>
      {current.length + coming.length === 0 ? (
        <p className="small">You hold no roles at the moment.</p>
      ) : (
        <table className="table">
          <thead>
            <tr><th>Role</th><th>Where</th><th>From</th><th>Until</th><th>Granted by</th></tr>
          </thead>
          <tbody>
            {[...current, ...coming].map((m) => {
              const role = roleOf(m.roleId);
              return (
                <tr key={m.id}>
                  <td>
                    {role?.name ?? m.roleId}
                    {role?.about && <div className="muted small">{role.about}</div>}
                    {role?.mfa && <div className="muted small">Authenticator required</div>}
                  </td>
                  <td>{reach(state, m.siteIds)}</td>
                  <td>{m.starts > now ? `Starts ${ukDate(m.starts)}` : ukDate(m.starts)}</td>
                  <td>{m.ends ? ukDate(m.ends) : 'No end date'}</td>
                  <td>{m.grantedBy}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="small muted">
        {employee
          ? `You are linked to ${employee.name} on the rota, so you cannot approve your own hours or pay.`
          : 'You are not linked to anyone on the rota.'}
      </p>
    </section>
  );
}

function Security({ me }: { me: Me }) {
  const a = me.authenticator;
  const user = me.user!;
  const [enrolling, setEnrolling] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!a) return null;

  async function replaceCodes() {
    if (!confirm('Make ten new recovery codes? The ones you have now stop working.')) return;
    setError(null);
    try {
      setCodes((await api.post<{ recoveryCodes: string[] }>('/v1/me/authenticator/recovery-codes')).recoveryCodes);
    } catch (e) {
      setError(problem(e));
    }
  }

  let status: string;
  if (a.enrolled) status = a.verified ? 'Set up, and this session has entered a code.' : 'Set up. Enter a code in the bar at the top to switch on your strong rights for this session.';
  else if (a.required) status = 'Not set up, and one of your roles needs it. Your pay, payroll and access rights are off until you set it up.';
  else status = 'Not set up. None of your roles needs one, but it keeps your account safe if your password is ever stolen.';

  return (
    <section className="settings-card">
      <h2>Authenticator</h2>
      <p className="small">{status}</p>
      {a.enrolled && <p className="small muted">{a.recoveryLeft} recovery {a.recoveryLeft === 1 ? 'code' : 'codes'} left. Lost your phone? Sign in with a recovery code, or ask whoever manages access to reset your authenticator once they have confirmed it is you.</p>}
      <div className="settings-form">
        {!a.enrolled && a.configured && <button className="primary" onClick={() => setEnrolling(true)}>Set up authenticator</button>}
        {!a.configured && <p className="small muted">This server is not set up for authenticators yet (PRESHIFT_SECRET_KEY). Ask whoever runs Preshift.</p>}
        {a.enrolled && a.verified && <button onClick={() => void replaceCodes()}>Make new recovery codes</button>}
      </div>
      {error && <p className="small bad-text">{error}</p>}
      {enrolling && <EnrolDialog email={user.email} onClose={() => setEnrolling(false)} />}
      {codes && <RecoveryCodes codes={codes} email={user.email} onDone={() => location.reload()} />}
    </section>
  );
}

function Organisations({ account }: { account: Account }) {
  const orgs = account.organisations ?? [];
  if (orgs.length < 2) return null;
  return (
    <section className="settings-card">
      <h2>Your organisations</h2>
      <p className="small muted">You work in more than one. Switch between them with the Organisation menu at the top. Your password and authenticator are the same in each; your name, title and roles are kept by each organisation.</p>
      <table className="table">
        <tbody>
          {orgs.map((o) => (
            <tr key={o.orgId}>
              <td>{o.name}</td>
              <td className="muted small">{[o.current && 'Here now', o.home && 'Home'].filter(Boolean).join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
