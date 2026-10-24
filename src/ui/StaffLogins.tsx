import { useCallback, useEffect, useState } from 'react';
import type { Employee } from '../engine/types';
import { emailState, type MailState } from './access/model';
import { api, ApiError } from './api';

interface StaffLoginRow {
  employeeId: string;
  email: string | null;
  status: 'active' | 'invited' | 'expired';
  inviteWaiting: boolean;
  lastSignInAt: string | null;
  locked: boolean;
  /** Phones the person turned notifications on for. */
  pushDevices?: number;
  /** The last staff app invitation emailed, and what Resend reported. */
  lastEmail: MailState | null;
}

type InviteResult =
  | { emailed: true; to: string; expiresAt: string }
  | { emailed: false; reason: 'handed_over' | 'email_not_set_up' | 'no_address' | 'send_failed'; path?: string; expiresAt: string; emailProblem?: string };

/** Why a link came back to hand over rather than going by email. */
const WHY: Record<Exclude<InviteResult, { emailed: true }>['reason'], string | null> = {
  handed_over: null,
  email_not_set_up: 'Email is not set up under Settings, so this link is yours to pass on.',
  no_address: 'There is no email on their record. Add one to their details to email invites from now on, or pass this link on.',
  send_failed: 'The email did not go. Check the email settings, or pass this link on yourself.',
};

const when = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/**
 * Staff logins for clocking on their own phones. A manager sends a one-time invite link; the
 * person opens it on their phone and chooses a password. A new invite is also the password reset.
 */
export function StaffLogins({ team, siteFenced }: { team: Employee[]; siteFenced: boolean }) {
  const [rows, setRows] = useState<StaffLoginRow[]>([]);
  const [link, setLink] = useState<{ name: string; url: string; expiresAt: string; why: string | null } | null>(null);
  const [emailed, setEmailed] = useState<{ person: Employee; to: string; expiresAt: string; joined: boolean } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => setRows(await api.get<StaffLoginRow[]>('/v1/staff-logins')), []);
  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : 'Could not reach Preshift. Try again.');
    } finally {
      setBusy(false);
    }
  }

  /** Emails the invite to the person where Preshift can; otherwise, or when asked, hands the link back. */
  const invite = (person: Employee, handOver = false) =>
    run(async () => {
      const res = await api.post<InviteResult>(`/v1/staff-logins/${person.id}/invite`, handOver ? { handOver: true } : undefined);
      if (res.emailed) {
        setLink(null);
        setEmailed({ person, to: res.to, expiresAt: res.expiresAt, joined: rows.some((r) => r.employeeId === person.id && r.status === 'active') });
      } else if (!res.path) {
        // A login they have set up: the link only ever goes to their own email, even when that fails.
        setLink(null);
        setEmailed(null);
        setMessage(res.emailProblem ?? 'The email did not go.');
      } else {
        setEmailed(null);
        setLink({ name: person.name, url: `${window.location.origin}${res.path}`, expiresAt: res.expiresAt, why: WHY[res.reason] });
      }
    });

  const share = async () => {
    if (!link) return;
    const text = `Your Preshift login for clocking in on your phone. Open this link on your phone to set it up: ${link.url}`;
    try {
      if (navigator.share) await navigator.share({ title: 'Preshift login', text });
      else {
        await navigator.clipboard.writeText(link.url);
        setMessage('Link copied. Send it to them privately, by text or WhatsApp.');
      }
    } catch {
      // Closing the share sheet is not an error.
    }
  };

  return (
    <>
      <h3>Phone logins</h3>
      <p className="muted small">
        Staff with a login can clock in and out on their own phone, but only when the phone is inside this site's clocking area,
        and they see their own published shifts and hours. Send the invite privately: whoever opens it can set up the login.
        Forgotten password? Send a reset link: once someone has set up their login it only ever goes to the email they signed up with,
        never to a manager, because whoever opened it could clock in as them. If they no longer use that address, close their login and invite them again.
      </p>
      {!siteFenced && <p className="small warn-text">Set the site location above first. Phones cannot clock in at a site without one.</p>}
      {message && <p className="small bad-text" role="alert">{message}</p>}
      {emailed && (
        <div className="notice" role="status">
          <div className="strong">Invite emailed to {emailed.person.name} at {emailed.to}, valid until {when(emailed.expiresAt)}</div>
          <p className="small muted">Only they see the link. If it does not arrive, this list will say so once Resend reports it.</p>
          {!emailed.joined && <button disabled={busy} onClick={() => void invite(emailed.person, true)}>Hand over a link instead</button>}{' '}
          <button className="link" onClick={() => setEmailed(null)}>Done</button>
        </div>
      )}
      {link && (
        <div className="notice">
          <div className="strong">Invite for {link.name}, valid until {when(link.expiresAt)}</div>
          {link.why && <p className="small">{link.why}</p>}
          <input readOnly value={link.url} onFocus={(e) => e.currentTarget.select()} style={{ width: '100%', margin: '6px 0' }} aria-label="Invite link" />
          <button className="primary" onClick={() => void share()}>Share link</button>{' '}
          <button onClick={() => void navigator.clipboard.writeText(link.url).then(() => setMessage('Link copied.'))}>Copy</button>{' '}
          <button className="link" onClick={() => setLink(null)}>Done</button>
        </div>
      )}
      <div className="grid-wrap">
        <table className="table">
          <thead><tr><th>Name</th><th>Phone login</th><th className="num" /></tr></thead>
          <tbody>
            {team.map((person) => {
              const row = rows.find((r) => r.employeeId === person.id);
              return (
                <tr key={person.id}>
                  <td>{person.name}</td>
                  <td>
                    {!row ? (
                      <span className="muted">None</span>
                    ) : row.status === 'active' ? (
                      <>
                        <span className="good-text">Active</span>
                        <span className="muted small"> {row.email}{row.lastSignInAt ? `, last signed in ${when(row.lastSignInAt)}` : ''}</span>
                        {/* Without notifications, a moved shift reaches them only when they next look. */}
                        <span className="muted small">{row.pushDevices ? `. Notifications on ${row.pushDevices} phone${row.pushDevices === 1 ? '' : 's'}` : '. Notifications off'}</span>
                        {row.locked && <span className="tag">Locked</span>}
                        {row.inviteWaiting && <span className="tag">New invite sent</span>}
                      </>
                    ) : row.status === 'invited' ? (
                      <span className="warn-text">Invite sent, not set up yet</span>
                    ) : (
                      <span className="muted">Invite expired</span>
                    )}
                    {row?.lastEmail && <MailLine mail={row.lastEmail} />}
                  </td>
                  <td className="num">
                    <button disabled={busy} onClick={() => void invite(person)}>{row?.status === 'active' ? 'Email a reset link' : row ? 'New invite' : 'Invite'}</button>{' '}
                    {row && (
                      <button
                        className="danger"
                        disabled={busy}
                        onClick={() => {
                          if (window.confirm(`Close ${person.name}'s phone login? They are signed out on every phone.`)) {
                            void run(async () => { await api.del(`/v1/staff-logins/${person.id}`); });
                          }
                        }}
                      >
                        Close
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function MailLine({ mail }: { mail: MailState }) {
  const { text, tone } = emailState(mail);
  return <div className={`small ${tone === 'bad' ? 'bad-text' : 'muted'}`}>{text}</div>;
}
