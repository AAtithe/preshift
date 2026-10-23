import { useCallback, useEffect, useState } from 'react';
import type { Employee } from '../engine/types';
import { api, ApiError } from './api';

interface KioskRow {
  id: string;
  siteId: string;
  name: string;
  pairedBy: string;
  pairedAt: string;
  lastSeenAt: string | null;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });

/**
 * Shared iPads paired as this site's kiosk. Pairing happens on the iPad itself: the person
 * pressing the button is signed out there, and the iPad is left able to clock people and nothing else.
 */
export function Kiosks({ siteId, siteName, pinRequired, team }: { siteId: string; siteName: string; pinRequired: boolean; team: Employee[] }) {
  const [rows, setRows] = useState<KioskRow[]>([]);
  const [name, setName] = useState('Staff entrance iPad');
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [required, setRequired] = useState(pinRequired);
  // When each person's PIN was set, kept here as PINs are issued and removed.
  const [pinSet, setPinSet] = useState<Record<string, string | undefined>>(() => Object.fromEntries(team.map((e) => [e.id, e.kioskPinSetAt])));
  const [issued, setIssued] = useState<{ name: string; pin: string } | null>(null);
  useEffect(() => setRequired(pinRequired), [pinRequired]);

  const refresh = useCallback(async () => setRows((await api.get<KioskRow[]>('/v1/kiosks')).filter((k) => k.siteId === siteId)), [siteId]);
  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  async function pair() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await api.post<{ path: string }>('/v1/kiosks', { siteId, name: name.trim() });
      // This device is now the kiosk, and its manager session has ended.
      window.location.assign(res.path);
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : 'Could not reach Preshift. Try again.');
      setBusy(false);
    }
  }

  async function remove(k: KioskRow) {
    if (!window.confirm(`Remove ${k.name}? It stops clocking people at once.`)) return;
    setBusy(true);
    try {
      await api.del(`/v1/kiosks/${k.id}`);
      await refresh();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : 'Could not reach Preshift. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : 'Could not reach Preshift. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const issue = (e: Employee) =>
    act(async () => {
      const res = await api.post<{ pin: string; setAt: string }>(`/v1/employees/${e.id}/kiosk-pin`);
      setPinSet((m) => ({ ...m, [e.id]: res.setAt }));
      setIssued({ name: e.name, pin: res.pin });
    });

  const removePin = (e: Employee) =>
    act(async () => {
      await api.del(`/v1/employees/${e.id}/kiosk-pin`);
      setPinSet((m) => ({ ...m, [e.id]: undefined }));
    });

  const pinSection = (
    <>
      <h3>PINs for signing in by name</h3>
      <p className="muted small">
        Without a PIN, anyone at the kiosk can tap a colleague's name and clock them. With PINs on, signing in by name needs
        the person's own 4 to 6 digit PIN; cards work as before. Staff set their own in the staff app, or you issue one here to
        hand over in person. Five wrong tries lock that person's PIN for 15 minutes.
      </p>
      <label className="small">
        <input
          type="checkbox"
          checked={required}
          disabled={busy}
          onChange={(ev) => {
            const next = ev.target.checked;
            void act(async () => {
              await api.put(`/v1/sites/${siteId}/kiosk-pin`, { required: next });
              setRequired(next);
            });
          }}
        />{' '}
        Require a PIN to sign in by name at {siteName}
      </label>
      {required && team.some((e) => !pinSet[e.id]) && (
        <p className="small warn-text">{team.filter((e) => !pinSet[e.id]).length} people have no PIN yet, so they can only clock with a card until they set one.</p>
      )}
      {issued && (
        <div className="notice">
          <div className="strong">PIN for {issued.name}: <span className="tnum" style={{ fontSize: 22, letterSpacing: '0.2em' }}>{issued.pin}</span></div>
          <p className="small">Give it to {issued.name} in person. It is shown once and cannot be looked up later; they can change it in the staff app.</p>
          <button className="link" onClick={() => setIssued(null)}>Done</button>
        </div>
      )}
      <div className="grid-wrap">
        <table className="table">
          <thead><tr><th>Name</th><th>PIN</th><th className="num" /></tr></thead>
          <tbody>
            {team.map((e) => (
              <tr key={e.id}>
                <td>{e.name}</td>
                <td>{pinSet[e.id] ? <>Set {when(pinSet[e.id]!)}</> : <span className="muted">None</span>}</td>
                <td className="num">
                  <button disabled={busy} onClick={() => void issue(e)}>{pinSet[e.id] ? 'Issue new PIN' : 'Issue PIN'}</button>{' '}
                  {pinSet[e.id] && <button className="danger" disabled={busy} onClick={() => void removePin(e)}>Remove</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );

  return (
    <>
      <h3>Kiosks</h3>
      <p className="muted small">
        A kiosk is a shared iPad at the staff entrance that clocks people in and out and does nothing else. Staff tap their card
        or find their name; nobody can reach the rota, pay or records from it. Set it up on the iPad itself: sign in there, open
        this page and press the button. You are signed out of the iPad in the same step. Then lock it to the page with Guided
        Access (Settings, Accessibility, Guided Access) and plug in a USB card reader if you use cards.
      </p>
      {message && <p className="small bad-text" role="alert">{message}</p>}
      {!confirming ? (
        <div className="clock-setup-row">
          <button disabled={busy} onClick={() => setConfirming(true)}>Turn this device into a kiosk</button>
        </div>
      ) : (
        <div className="notice">
          <div className="strong">Make this device the kiosk for {siteName}?</div>
          <p className="small">You will be signed out here, and this device will only clock people in and out at {siteName}.</p>
          <label className="small muted">
            Name it{' '}
            <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} aria-label="Kiosk name" />
          </label>{' '}
          <button className="primary" disabled={busy || !name.trim()} onClick={() => void pair()}>Yes, make this the kiosk</button>{' '}
          <button className="link" onClick={() => setConfirming(false)}>Cancel</button>
        </div>
      )}
      {rows.length > 0 && (
        <div className="grid-wrap">
          <table className="table">
            <thead><tr><th>Kiosk</th><th>Set up</th><th>Last seen</th><th className="num" /></tr></thead>
            <tbody>
              {rows.map((k) => (
                <tr key={k.id}>
                  <td>{k.name}</td>
                  <td>{when(k.pairedAt)} by {k.pairedBy}</td>
                  <td>{k.lastSeenAt ? when(k.lastSeenAt) : <span className="muted">Not yet</span>}</td>
                  <td className="num"><button className="danger" disabled={busy} onClick={() => void remove(k)}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pinSection}
    </>
  );
}
