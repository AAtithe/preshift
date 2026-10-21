import { useCallback, useEffect, useState } from 'react';
import type { Employee } from '../engine/types';
import { api, ApiError } from './api';

interface StaffLoginRow {
  employeeId: string;
  email: string | null;
  status: 'active' | 'invited' | 'expired';
  inviteWaiting: boolean;
  lastSignInAt: string | null;
  locked: boolean;
}

const when = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/**
 * Staff logins for clocking on their own phones. A manager sends a one-time invite link; the
 * person opens it on their phone and chooses a password. A new invite is also the password reset.
 */
export function StaffLogins({ team, siteFenced }: { team: Employee[]; siteFenced: boolean }) {
  const [rows, setRows] = useState<StaffLoginRow[]>([]);
  const [link, setLink] = useState<{ name: string; url: string; expiresAt: string } | null>(null);
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

  const invite = (person: Employee) =>
    run(async () => {
      const res = await api.post<{ path: string; expiresAt: string }>(`/v1/staff-logins/${person.id}/invite`);
      setLink({ name: person.name, url: `${window.location.origin}${res.path}`, expiresAt: res.expiresAt });
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
        Forgotten password? Send a new invite.
      </p>
      {!siteFenced && <p className="small warn-text">Set the site location above first. Phones cannot clock in at a site without one.</p>}
      {message && <p className="small bad-text" role="alert">{message}</p>}
      {link && (
        <div className="notice">
          <div className="strong">Invite for {link.name}, valid until {when(link.expiresAt)}</div>
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
                        {row.locked && <span className="tag">Locked</span>}
                        {row.inviteWaiting && <span className="tag">New invite sent</span>}
                      </>
                    ) : row.status === 'invited' ? (
                      <span className="warn-text">Invite sent, not set up yet</span>
                    ) : (
                      <span className="muted">Invite expired</span>
                    )}
                  </td>
                  <td className="num">
                    <button disabled={busy} onClick={() => void invite(person)}>{row ? 'New invite' : 'Invite'}</button>{' '}
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
