import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';

interface TapPointRow {
  id: string;
  siteId: string;
  name: string;
  addedBy: string;
  addedAt: string;
  tagSerial: string | null;
  lastTapAt: string | null;
  path: string;
}

interface Added {
  tapPoint: TapPointRow;
  keys: { metaRead: string; fileRead: string };
}

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });

/**
 * Secure NFC tags at the site's staff entrance. Staff touch one with their own phone, iPhone or
 * Android, and are clocked in or out with no card, no app to install and no location needed.
 */
export function TapPoints({ siteId, siteName }: { siteId: string; siteName: string }) {
  const [rows, setRows] = useState<TapPointRow[]>([]);
  const [name, setName] = useState('Staff entrance');
  const [added, setAdded] = useState<Added | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => setRows((await api.get<TapPointRow[]>('/v1/tap-points')).filter((t) => t.siteId === siteId)), [siteId]);
  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

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

  const add = () =>
    act(async () => {
      setAdded(await api.post<Added>('/v1/tap-points', { siteId, name: name.trim() }));
      await refresh();
    });

  const remove = (t: TapPointRow) => {
    if (!window.confirm(`Remove ${t.name}? Taps on it stop working at once.`)) return;
    void act(async () => {
      await api.del(`/v1/tap-points/${t.id}`);
      await refresh();
    });
  };

  return (
    <>
      <h3>Phone tags</h3>
      <p className="muted small">
        A phone tag is a secure NFC sticker (NTAG 424 DNA) by the staff entrance. Staff touch it with their own phone and are
        clocked in, out, or back from a break. It works on iPhone and Android with nothing to install: the phone opens the staff
        app and the tap is recorded. Every touch writes a one-time code only that sticker can make, so a link sent to someone at
        home does not work, and no location is needed. Each person needs a staff app login, invited above.
      </p>
      {message && <p className="small bad-text" role="alert">{message}</p>}
      {added && (
        <div className="notice">
          <div className="strong">Program {added.tapPoint.name} for {siteName}</div>
          <p className="small">
            These keys are shown once. Program the tag now with NXP TagXplorer or TagWriter, or send them securely to whoever is
            programming it. If they are lost, remove the tag and add it again.
          </p>
          <ol className="small">
            <li>
              Write this address as a URL record:{' '}
              <code style={{ wordBreak: 'break-all' }}>{window.location.origin}{added.tapPoint.path}</code>
            </li>
            <li>Turn on Secure Unique NFC (SDM) for the NDEF file, with reading free and the counter on.</li>
            <li>Mirror the UID and read counter, encrypted, over the 32 zeros after <code>picc=</code>, using this SDM meta read key:{' '}
              <code className="tnum">{added.keys.metaRead}</code></li>
            <li>Put the MAC over the 16 zeros after <code>cmac=</code>, with the MAC input starting at the same place, using this SDM file read key:{' '}
              <code className="tnum">{added.keys.fileRead}</code></li>
            <li>Change the tag's own application keys from the factory default, so nobody can reprogram it.</li>
            <li>Stick it inside the entrance at hand height, away from metal, and ask someone to touch it to check.</li>
          </ol>
          <button className="link" onClick={() => setAdded(null)}>Done, I have programmed it</button>
        </div>
      )}
      <div className="clock-setup-row">
        <label className="small muted">
          Name{' '}
          <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} aria-label="Tag name" />
        </label>{' '}
        <button disabled={busy || !name.trim()} onClick={() => void add()}>Add a phone tag</button>
      </div>
      {rows.length > 0 && (
        <div className="grid-wrap">
          <table className="table">
            <thead><tr><th>Tag</th><th>Added</th><th>Last touched</th><th className="num" /></tr></thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}{t.tagSerial && <div className="small muted tnum">Serial {t.tagSerial}</div>}</td>
                  <td>{when(t.addedAt)} by {t.addedBy}</td>
                  <td>{t.lastTapAt ? when(t.lastTapAt) : <span className="muted">Not yet</span>}</td>
                  <td className="num"><button className="danger" disabled={busy} onClick={() => remove(t)}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
