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

export interface EposResyncResult {
  at: string;
  from: string;
  to: string;
  ok: boolean;
  error?: string;
  read: number;
  unmatched: number;
  changed: number;
  sites: { siteId: string; changed: number; before: number; after: number }[];
}

/** One line on a re-sync: how many till days were read again, and what changed, site by site. */
export function describeResync(r: EposResyncResult, siteName: (id: string) => string) {
  if (!r.ok && r.read === 0) return r.error ?? 'The re-sync failed.';
  const changes = r.sites.map((s) => `${siteName(s.siteId)} ${s.changed} day${s.changed === 1 ? '' : 's'}, ${money(s.before)} to ${money(s.after)}`).join('; ');
  const left = r.unmatched ? ` ${r.unmatched} days marked till that this till has no orders for were left as they were.` : '';
  const done = `${r.read} till days from ${r.from} to ${r.to} read again: ${r.changed ? `${r.changed} restated (${changes}).` : 'none changed.'}${left}`;
  return r.ok ? done : `${done} Stopped part way: ${r.error}`;
}

export type TillProvider = 'square' | 'lightspeed' | 'zonal' | 'tevalis';

export interface EposStatus {
  connection: null | {
    provider: TillProvider;
    environment: 'production' | 'sandbox' | 'simulator';
    connectedAt: string;
    connectedBy: string;
    accountName?: string;
    lastSync?: EposSyncResult;
    lastResync?: EposResyncResult;
    /** What a file feed last sent, and any lines it could not read. */
    feedReceived?: { at: string; rows: number; problems: { line: number; message: string }[]; by: string } | null;
  };
  tokenEndsWith: string | null;
  /** Where a Zonal or Tevalis feed posts, once one is connected. */
  feedUrl?: string | null;
  sites: { siteId: string; name: string; locationId: string | null }[];
  simulatorAllowed: boolean;
  /** The tills this server can connect: Lightspeed appears once Preshift's Lightspeed app is registered. */
  providers?: { id: TillProvider; label: string; feed: boolean }[];
}

/** The till's own name, for what is connected. */
export const tillLabel = (p: TillProvider | undefined) => ({ square: 'Square', lightspeed: 'Lightspeed', zonal: 'Zonal', tevalis: 'Tevalis' })[p ?? 'square'];

/** What Lightspeed's sign-in came back with, from the address it returned to. */
const RETURNS: Record<string, { text: string; bad?: boolean }> = {
  connected: { text: 'Connected to Lightspeed. Now match each site to its Lightspeed location.' },
  declined: { text: 'Lightspeed was not connected: the sign-in was cancelled or not approved.', bad: true },
  expired: { text: 'That Lightspeed sign-in had expired or was already used. Start again.', bad: true },
  unavailable: { text: 'Lightspeed is not set up on this server.', bad: true },
  failed: { text: 'Lightspeed could not be connected.', bad: true },
};

interface Location {
  id: string;
  name: string;
  timeZone: string;
  siteId: string | null;
}

const ENVIRONMENTS = { production: 'Square', sandbox: 'Square sandbox (testing)', simulator: 'Simulated till (demo)' } as const;
/** One choice per till: Square's environments, then each other till. */
type Choice = keyof typeof ENVIRONMENTS | Exclude<TillProvider, 'square'>;
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
  const [environment, setEnvironment] = useState<Choice>('production');
  const [feedKey, setFeedKey] = useState<string | null>(null);
  const [upload, setUpload] = useState('');
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
      setEnvironment(s.connection.provider === 'square' ? s.connection.environment : s.connection.provider);
      api.get<Location[]>('/v1/integrations/epos/locations').then(setLocations).catch((e) => setMessage({ text: problem(e), bad: true }));
    } else setLocations(null);
  }, []);

  useEffect(() => {
    load().catch((e) => setMessage({ text: problem(e), bad: true }));
    // Back from Lightspeed's sign-in: say how it went, then tidy the address.
    const q = new URLSearchParams(window.location.search);
    const back = q.get('epos');
    if (back && RETURNS[back]) {
      setMessage({ text: [RETURNS[back].text, q.get('reason')].filter(Boolean).join(' '), bad: RETURNS[back].bad });
      q.delete('epos');
      q.delete('reason');
      window.history.replaceState(null, '', `${window.location.pathname}?${q}`);
    }
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

  const isSquare = environment === 'production' || environment === 'sandbox' || environment === 'simulator';
  const isFeed = environment === 'zonal' || environment === 'tevalis';

  const connect = () =>
    run('Connect', async () => {
      if (environment === 'lightspeed') {
        const r = await api.put<{ authorizeUrl: string }>('/v1/integrations/epos', { provider: 'lightspeed' });
        // Lightspeed asks them to sign in and approve Preshift, then sends them back here.
        window.location.assign(r.authorizeUrl);
        return 'Opening Lightspeed to sign in...';
      }
      if (isFeed) {
        const r = await api.put<{ feedKey: string }>('/v1/integrations/epos', { provider: environment });
        setFeedKey(r.feedKey);
        return `Connected to ${tillLabel(environment)} by file feed. Copy the feed key now: it is shown only once.`;
      }
      await api.put('/v1/integrations/epos', { provider: 'square', environment, ...(token ? { accessToken: token } : {}) });
      setToken('');
      return environment === 'simulator' ? 'Connected to the simulated till, with every site matched. Bring takings in below.' : 'Connected. Now match each site to its Square location.';
    });

  const sendUpload = () =>
    run('Upload', async () => {
      const r = await api.post<{ received: number; problems: { line: number; message: string }[]; sync: EposSyncResult | null }>('/v1/integrations/epos/feed-upload', { csv: upload });
      setUpload('');
      onSynced?.();
      const problems = r.problems.length ? ` ${r.problems.length} line${r.problems.length === 1 ? '' : 's'} could not be read: ${r.problems.slice(0, 3).map((p) => `line ${p.line}, ${p.message}`).join('; ')}.` : '';
      return `${r.received} rows read.${problems} ${r.sync ? describeSync(r.sync, siteName) : 'Match each site reference below, then upload again to bring the days in.'}`;
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

  const resync = () =>
    run('Re-sync', async () => {
      const r = await api.post<EposResyncResult>('/v1/integrations/epos/resync', {});
      onSynced?.();
      if (!r.ok && r.read === 0) throw new Error(r.error);
      return describeResync(r, siteName);
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
              ? `Connected to ${conn.accountName ?? (conn.provider === 'square' ? ENVIRONMENTS[conn.environment] : tillLabel(conn.provider))}${conn.environment === 'sandbox' ? ' (sandbox)' : ''} by ${conn.connectedBy}, ${syncedAt(conn.connectedAt)}.${status.tokenEndsWith ? ` Access token ending ${status.tokenEndsWith}.` : ''}`
              : 'No till connected. Takings are keyed in or imported on the Takings report.'}
          </p>

          <form className="settings-form" onSubmit={(e) => { e.preventDefault(); void connect(); }}>
            <label>
              Till
              <select value={environment} onChange={(e) => setEnvironment(e.target.value as Choice)}>
                <option value="production">{ENVIRONMENTS.production}</option>
                <option value="sandbox">{ENVIRONMENTS.sandbox}</option>
                {status.providers?.some((p) => p.id === 'lightspeed') && <option value="lightspeed">Lightspeed Restaurant</option>}
                <option value="zonal">Zonal (file feed)</option>
                <option value="tevalis">Tevalis (file feed)</option>
                {status.simulatorAllowed && <option value="simulator">{ENVIRONMENTS.simulator}</option>}
              </select>
            </label>
            {isSquare && environment !== 'simulator' && (
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
            <button className="primary" type="submit" disabled={busy}>
              {environment === 'lightspeed' ? 'Sign in to Lightspeed' : isFeed && conn?.provider === environment ? 'New feed key' : conn ? 'Reconnect' : 'Connect'}
            </button>
            {conn && <button type="button" className="danger" disabled={busy} onClick={() => { if (confirm('Disconnect the till? Takings already brought in stay; nothing new comes in until it is connected again.')) void disconnect(); }}>Disconnect</button>}
          </form>
          {isSquare && environment !== 'simulator' && (
            <p className="muted small">
              In the Square Developer Console, create an application, then copy its production access token. It needs ORDERS_READ and
              MERCHANT_PROFILE_READ. Preshift checks it with Square before saving, keeps it on the server, and never shows it again.
            </p>
          )}
          {environment === 'lightspeed' && (
            <p className="muted small">
              Sign in with a Lightspeed account that owns the business and approve Preshift to read financial data. Lightspeed sends you
              back here to match each site to its location. Preshift keeps the connection on the server and renews it itself.
            </p>
          )}
          {isFeed && (
            <p className="muted small">
              {environment === 'zonal'
                ? 'Ask your Zonal account manager to send the daily sales export, by site and hour if they can, to the feed address below with the feed key.'
                : 'Schedule the Daily Flash Sales report (Net) in the Tevalis portal to the feed address below with the feed key, or upload the export here each morning.'}{' '}
              Each row needs the site reference, trading date and net sales ex VAT; hour, tips, service charge and checks are read where
              given. A file sent again replaces what it sent before.
            </p>
          )}
          {feedKey && (
            <div className="settings-form">
              <label>
                Feed key (shown once)
                <input readOnly value={feedKey} onFocus={(e) => e.currentTarget.select()} />
              </label>
              <span className="small muted">Send it as Authorization: Bearer, with the file as text/csv.</span>
            </div>
          )}
          {conn && status.feedUrl && (
            <>
              <p className="small">
                Feed address: <code>{status.feedUrl}</code>
                {conn.feedReceived ? ` Last file ${syncedAt(conn.feedReceived.at)}: ${conn.feedReceived.rows} rows${conn.feedReceived.problems.length ? `, ${conn.feedReceived.problems.length} lines not read` : ''}.` : ' Nothing received yet.'}
              </p>
              <form className="settings-form" onSubmit={(e) => { e.preventDefault(); void sendUpload(); }}>
                <label>
                  Upload an export
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void f.text().then(setUpload);
                    }}
                  />
                </label>
                <button type="submit" disabled={busy || !upload}>Upload</button>
              </form>
            </>
          )}

          {conn && (
            <>
              <h3 className="section-inline">Which location is each site</h3>
              {!locations ? (
                <p className="small muted">Asking {tillLabel(conn.provider)} for its locations...</p>
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
              <div className="close-actions">
                <button disabled={busy || mappingChanged || unmatched === status.sites.length} onClick={() => void resync()}>Re-sync past takings</button>
                <span className="small muted">
                  Reads again every day the till already brought in, after a fix to how takings are worked out. Days keyed in by hand
                  or loaded from a file, and tips, are left as they are.
                </span>
              </div>
              {conn.lastResync && (
                <p className={`small ${conn.lastResync.ok ? 'muted' : 'bad-text'}`}>
                  Last re-sync {syncedAt(conn.lastResync.at)}: {describeResync(conn.lastResync, siteName)}
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
