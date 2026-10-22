import { useCallback, useEffect, useState } from 'react';
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
export function Kiosks({ siteId, siteName }: { siteId: string; siteName: string }) {
  const [rows, setRows] = useState<KioskRow[]>([]);
  const [name, setName] = useState('Staff entrance iPad');
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

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
    </>
  );
}
