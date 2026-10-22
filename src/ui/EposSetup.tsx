import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { money } from './format';

export interface EposSyncResult {
  at: string;
  from: string;
  to: string;
  ok: boolean;
  error?: string;
  written: number;
  kept: { siteId: string; date: string }[];
  sites: { siteId: string; netSales: number; orders: number }[];
  tips?: TillTips;
  serviceCharge?: TillTips;
}

type TillTips = { written: number; kept: { siteId: string; date: string }[]; paidDiffers: { siteId: string; date: string; paid: number; till: number }[]; total: number };

export interface EposStatus {
  connection: null | {
    provider: 'square';
    environment: 'production' | 'sandbox' | 'simulator';
    connectedAt: string;
    connectedBy: string;
    accountName?: string;
    lastSync?: EposSyncResult;
  };
  tokenEndsWith: string | null;
  sites: { siteId: string; name: string; locationId: string | null }[];
  simulatorAllowed: boolean;
}

interface Location {
  id: string;
  name: string;
  timeZone: string;
  siteId: string | null;
}

const ENVIRONMENTS = { production: 'Square', sandbox: 'Square sandbox (testing)', simulator: 'Simulated till (demo)' } as const;
const problem = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const syncedAt = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** One line on a sync, for a GM: what came in, what was kept, or what went wrong. */
export function describeSync(r: EposSyncResult, siteName: (id: string) => string) {
  if (!r.ok) return r.error ?? 'The sync failed.';
  const total = r.sites.reduce((s, x) => s + x.netSales, 0);
  const kept = r.kept.length ? ` ${r.kept.length} days keyed in by hand were kept (${[...new Set(r.kept.map((k) => siteName(k.siteId)))].join(', ')}).` : '';
  const fed = (label: string, t?: TillTips) =>
    t
      ? ` ${label} ${money(t.total)}${t.kept.length ? `, ${t.kept.length} days keyed in by hand kept` : ''}.${
          t.paidDiffers.length
            ? ` The till has changed since payroll paid ${t.paidDiffers.map((d) => `${siteName(d.siteId)} ${d.date} (paid ${money(d.paid)}, till now ${money(d.till)})`).join(', ')}: payroll to check.`
            : ''
        }`
      : '';
  const tips = fed('Card tips', r.tips) + fed('Service charge', r.serviceCharge);
  return `${r.written} trading days brought in, ${r.from} to ${r.to}: ${money(total)} across ${r.sites.length} sites.${kept}${tips}`;
}

/**
 * Connects the organisation's Square account, matches each site to a Square location and brings
 * takings in. An admin sets it up once; after that a daily schedule keeps it current.
 */
export function EposSetup({ onSynced }: { onSynced?: () => void }) {
  const [status, setStatus] = useState<EposStatus | null>(null);
  const [locations, setLocations] = useState<Location[] | null>(null);
  const [environment, setEnvironment] = useState<keyof typeof ENVIRONMENTS>('production');
  const [token, setToken] = useState('');
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [from, setFrom] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);

  const load = useCallback(async () => {
    const s = await api.get<EposStatus>('/v1/integrations/epos');
    setStatus(s);
    setMapping(Object.fromEntries(s.sites.map((x) => [x.siteId, x.locationId ?? ''])));
    if (s.connection) {
      setEnvironment(s.connection.environment);
      api.get<Location[]>('/v1/integrations/epos/locations').then(setLocations).catch((e) => setMessage({ text: problem(e), bad: true }));
    } else setLocations(null);
  }, []);

  useEffect(() => {
    load().catch((e) => setMessage({ text: problem(e), bad: true }));
  }, [load]);

  async function run(label: string, fn: () => Promise<string | void>) {
    setBusy(true);
    setMessage(null);
    try {
      const text = await fn();
      await load();
      if (text) setMessage({ text });
    } catch (e) {
      setMessage({ text: `${label}: ${problem(e)}`, bad: true });
    } finally {
      setBusy(false);
    }
  }

  const connect = () =>
    run('Connect', async () => {
      await api.put('/v1/integrations/epos', { environment, ...(token ? { accessToken: token } : {}) });
      setToken('');
      return environment === 'simulator' ? 'Connected to the simulated till, with every site matched. Bring takings in below.' : 'Connected. Now match each site to its Square location.';
    });

  const saveMapping = () =>
    run('Match', async () => {
      await api.put('/v1/integrations/epos/mapping', { sites: Object.fromEntries(Object.entries(mapping).map(([k, v]) => [k, v || null])) });
      return 'Saved. Each site now takes its takings from that location.';
    });

  const sync = (range?: { from: string }) =>
    run('Sync', async () => {
      const r = await api.post<EposSyncResult>('/v1/integrations/epos/sync', range ?? {});
      onSynced?.();
      if (!r.ok) throw new Error(r.error);
      return describeSync(r, siteName);
    });

  const disconnect = () =>
    run('Disconnect', async () => {
      await api.del('/v1/integrations/epos');
      return 'Disconnected. Takings already brought in stay.';
    });

  const siteName = (id: string) => status?.sites.find((s) => s.siteId === id)?.name ?? id;
  const conn = status?.connection;
  const unmatched = status?.sites.filter((s) => !s.locationId).length ?? 0;
  const mappingChanged = status?.sites.some((s) => (s.locationId ?? '') !== (mapping[s.siteId] ?? ''));
  const chosenTwice = Object.values(mapping).filter((v, i, all) => v && all.indexOf(v) !== i);

  return (
    <section className="settings-card">
      <h2>EPOS</h2>
      <p className="muted small">
        Takings come straight from the till, net of VAT, tips and service charge, by trading day and hour. Card tips and service charge
        come in separately, as each day's figures for the tronc. Sales after midnight count
        towards the night before. Days a manager keyed in by hand are never overwritten. Once connected, the last three days are brought
        in every morning; bring in more at any time below.
      </p>

      {!status ? (
        <p className="small muted">...</p>
      ) : (
        <>
          <p className="small">
            {conn
              ? `Connected to ${conn.accountName ?? ENVIRONMENTS[conn.environment]}${conn.environment === 'sandbox' ? ' (sandbox)' : ''} by ${conn.connectedBy}, ${syncedAt(conn.connectedAt)}.${status.tokenEndsWith ? ` Access token ending ${status.tokenEndsWith}.` : ''}`
              : 'No till connected. Takings are keyed in or imported on the Takings report.'}
          </p>

          <form className="settings-form" onSubmit={(e) => { e.preventDefault(); void connect(); }}>
            <label>
              Till
              <select value={environment} onChange={(e) => setEnvironment(e.target.value as keyof typeof ENVIRONMENTS)}>
                <option value="production">{ENVIRONMENTS.production}</option>
                <option value="sandbox">{ENVIRONMENTS.sandbox}</option>
                {status.simulatorAllowed && <option value="simulator">{ENVIRONMENTS.simulator}</option>}
              </select>
            </label>
            {environment !== 'simulator' && (
              <label>
                {conn && status.tokenEndsWith ? 'Replace access token (optional)' : 'Square access token'}
                <input
                  type="password"
                  autoComplete="off"
                  placeholder="EAAA..."
                  required={!status.tokenEndsWith || conn?.environment !== environment}
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
              </label>
            )}
            <button className="primary" type="submit" disabled={busy}>{conn ? 'Reconnect' : 'Connect'}</button>
            {conn && <button type="button" className="danger" disabled={busy} onClick={() => { if (confirm('Disconnect the till? Takings already brought in stay; nothing new comes in until it is connected again.')) void disconnect(); }}>Disconnect</button>}
          </form>
          {environment !== 'simulator' && (
            <p className="muted small">
              In the Square Developer Console, create an application, then copy its production access token. It needs ORDERS_READ and
              MERCHANT_PROFILE_READ. Preshift checks it with Square before saving, keeps it on the server, and never shows it again.
            </p>
          )}

          {conn && (
            <>
              <h3 className="section-inline">Which location is each site</h3>
              {!locations ? (
                <p className="small muted">Asking Square for its locations...</p>
              ) : (
                <table className="table compact">
                  <tbody>
                    {status.sites.map((s) => (
                      <tr key={s.siteId}>
                        <td>{s.name}</td>
                        <td>
                          <select aria-label={`Till location for ${s.name}`} value={mapping[s.siteId] ?? ''} onChange={(e) => setMapping({ ...mapping, [s.siteId]: e.target.value })}>
                            <option value="">Not on this till</option>
                            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {chosenTwice.length > 0 && <p className="small bad-text">Each location can belong to one site only.</p>}
              <div className="close-actions">
                <button disabled={busy || !mappingChanged || chosenTwice.length > 0} onClick={() => void saveMapping()}>Save matching</button>
                <button className="primary" disabled={busy || mappingChanged || unmatched === status.sites.length} onClick={() => void sync()}>Bring in the last 7 days</button>
                <label className="check-inline small">
                  From
                  <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
                </label>
                <button disabled={busy || !from || mappingChanged} onClick={() => void sync({ from })}>Bring in from this date</button>
              </div>
              {conn.lastSync && (
                <p className={`small ${conn.lastSync.ok ? 'muted' : 'bad-text'}`}>
                  Last sync {syncedAt(conn.lastSync.at)}: {describeSync(conn.lastSync, siteName)}
                </p>
              )}
            </>
          )}
        </>
      )}
      {message && <p className={`small ${message.bad ? 'bad-text' : 'good-text'}`}>{message.text}</p>}
    </section>
  );
}
