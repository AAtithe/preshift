import { useCallback, useEffect, useRef, useState } from 'react';
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
}

type Till = 'square' | 'toast' | 'lightspeed';
type Environment = 'production' | 'sandbox' | 'simulator';

export interface EposBackfill {
  from: string;
  to: string;
  next: string;
  written: number;
  startedAt: string;
  startedBy: string;
  finishedAt?: string;
  error?: string;
}

export interface EposStatus {
  connection: null | {
    provider: Till;
    environment: Environment;
    connectedAt: string;
    connectedBy: string;
    accountName?: string;
    lastSync?: EposSyncResult;
    backfill?: EposBackfill;
  };
  tokenEndsWith: string | null;
  sites: { siteId: string; name: string; locationId: string | null }[];
  simulatorAllowed: boolean;
  /** Which tills this server can reach. Lightspeed needs Preshift's own Lightspeed app set up. */
  providers?: Record<Till, boolean>;
}

interface Location {
  id: string;
  name: string;
  timeZone: string;
  siteId: string | null;
}

export const TILL_LABEL: Record<Till, string> = { square: 'Square', toast: 'Toast', lightspeed: 'Lightspeed' };
const ENVIRONMENT_LABEL: Record<Environment, string> = { production: 'Live', sandbox: 'Sandbox (testing)', simulator: 'Simulated till (demo)' };
const problem = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const syncedAt = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** How far a backfill has got, as a share of its days. */
export const backfillShare = (b: EposBackfill) => (b.finishedAt ? 1 : Math.min(1, Math.max(0, daysBetween(b.from, b.next) / (daysBetween(b.from, b.to) + 1))));

/** One line on a sync, for a GM: what came in, what was kept, or what went wrong. */
export function describeSync(r: EposSyncResult, siteName: (id: string) => string) {
  if (!r.ok) return r.error ?? 'The sync failed.';
  const total = r.sites.reduce((s, x) => s + x.netSales, 0);
  const kept = r.kept.length ? ` ${r.kept.length} days keyed in by hand were kept (${[...new Set(r.kept.map((k) => siteName(k.siteId)))].join(', ')}).` : '';
  return `${r.written} trading days brought in, ${r.from} to ${r.to}: ${money(total)} across ${r.sites.length} sites.${kept}`;
}

const HOW_TO: Record<Till, string> = {
  square:
    'In the Square Developer Console, create an application, then copy its production access token. It needs ORDERS_READ and MERCHANT_PROFILE_READ.',
  toast:
    'Toast issues a client ID and secret for an integration and connects your restaurants to it. Ask Toast for API access with orders read for each restaurant.',
  lightspeed:
    'Sign in to Lightspeed Restaurant (K-Series) as the account owner and approve Preshift. Nobody pastes a secret; Preshift keeps the connection fresh itself.',
};

/**
 * Connects the organisation's till (Square, Toast or Lightspeed), matches each site to a till
 * location, and brings takings in: the last week, or thirteen months so forecasts can work from
 * the same week last year. Set up once; after that a daily schedule keeps it current.
 */
export function EposSetup({ onSynced }: { onSynced?: () => void }) {
  const [status, setStatus] = useState<EposStatus | null>(null);
  const [locations, setLocations] = useState<Location[] | null>(null);
  const [till, setTill] = useState<Till>('square');
  const [environment, setEnvironment] = useState<Environment>('production');
  const [secret, setSecret] = useState({ accessToken: '', clientId: '', clientSecret: '' });
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [from, setFrom] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);
  const stopped = useRef(false);

  const load = useCallback(async () => {
    const s = await api.get<EposStatus>('/v1/integrations/epos');
    setStatus(s);
    setMapping(Object.fromEntries(s.sites.map((x) => [x.siteId, x.locationId ?? ''])));
    if (s.connection) {
      setTill(s.connection.provider);
      setEnvironment(s.connection.environment);
      api.get<Location[]>('/v1/integrations/epos/locations').then(setLocations).catch((e) => setMessage({ text: problem(e), bad: true }));
    } else setLocations(null);
  }, []);

  useEffect(() => {
    // Set on every mount: a remount (React does one in development) must not leave the backfill stopped.
    stopped.current = false;
    load().catch((e) => setMessage({ text: problem(e), bad: true }));
    // Back from Lightspeed's sign-in page: say how it went.
    const back = new URLSearchParams(location.search).get('epos');
    if (back === 'connected') setMessage({ text: 'Connected to Lightspeed. Now match each site to its location.' });
    if (back === 'declined') setMessage({ text: 'Lightspeed was not connected: the sign-in was cancelled.', bad: true });
    return () => { stopped.current = true; };
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
      if (till === 'lightspeed' && environment !== 'simulator') {
        const { url } = await api.post<{ url: string }>('/v1/integrations/epos/lightspeed/start', { environment, next: location.pathname });
        window.location.assign(url);
        return;
      }
      const fields = till === 'square' ? { accessToken: secret.accessToken } : till === 'toast' ? { clientId: secret.clientId, clientSecret: secret.clientSecret } : {};
      await api.put('/v1/integrations/epos', { provider: till, environment, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v)) });
      setSecret({ accessToken: '', clientId: '', clientSecret: '' });
      return environment === 'simulator'
        ? 'Connected to the simulated till, with every site matched. Bring takings in below.'
        : `Connected. Now match each site to its ${TILL_LABEL[till]} location.`;
    });

  const saveMapping = () =>
    run('Match', async () => {
      await api.put('/v1/integrations/epos/mapping', { sites: Object.fromEntries(Object.entries(mapping).map(([k, v]) => [k, v || null])) });
      return 'Saved. Each site now takes its takings from that location.';
    });

  const sync = () =>
    run('Sync', async () => {
      const r = await api.post<EposSyncResult>('/v1/integrations/epos/sync', {});
      onSynced?.();
      if (!r.ok) throw new Error(r.error);
      return describeSync(r, siteName);
    });

  /** Starts a backfill (or carries on one already started) and works it a fortnight at a time while the page is open. */
  const backfill = (start?: { from?: string }) =>
    run('Backfill', async () => {
      let job = start ? await api.post<EposBackfill>('/v1/integrations/epos/backfill', start.from ? { from: start.from } : {}) : status!.connection!.backfill!;
      while (!job.finishedAt && !stopped.current) {
        job = await api.post<EposBackfill>('/v1/integrations/epos/backfill/step');
        setStatus((s) => (s?.connection ? { ...s, connection: { ...s.connection, backfill: job } } : s));
        if (job.error) throw new Error(`${job.error} It stopped at ${job.next}; carry on when it is fixed.`);
      }
      onSynced?.();
      return job.finishedAt ? `${job.written} trading days brought in, ${job.from} to ${job.to}.` : 'Paused. It carries on overnight, or press Carry on.';
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
  const lightspeedOff = till === 'lightspeed' && environment !== 'simulator' && status?.providers?.lightspeed === false;
  const sameTill = conn?.provider === till && conn?.environment === environment && !!status?.tokenEndsWith;
  const job = conn?.backfill;
  const label = TILL_LABEL[till];

  return (
    <section className="settings-card">
      <h2>EPOS</h2>
      <p className="muted small">
        Takings come straight from the till, net of VAT, tips and service charge, by trading day and hour, with covers where the till
        records them. Sales after midnight count towards the night before. Days a manager keyed in by hand are never overwritten. Once
        connected, the last three days are brought in every morning.
      </p>

      {!status ? (
        <p className="small muted">...</p>
      ) : (
        <>
          <p className="small">
            {conn
              ? `Connected to ${conn.accountName ?? TILL_LABEL[conn.provider]} (${TILL_LABEL[conn.provider]}${conn.environment === 'production' ? '' : `, ${ENVIRONMENT_LABEL[conn.environment].toLowerCase()}`}) by ${conn.connectedBy}, ${syncedAt(conn.connectedAt)}.${status.tokenEndsWith ? ` Credential ending ${status.tokenEndsWith}.` : ''}`
              : 'No till connected. Takings are keyed in or imported on the Takings report.'}
          </p>

          <form className="settings-form" onSubmit={(e) => { e.preventDefault(); void connect(); }}>
            <label>
              Till
              <select value={till} onChange={(e) => setTill(e.target.value as Till)}>
                {(['square', 'toast', 'lightspeed'] as Till[]).map((t) => <option key={t} value={t}>{TILL_LABEL[t]}</option>)}
              </select>
            </label>
            <label>
              Account
              <select value={environment} onChange={(e) => setEnvironment(e.target.value as Environment)}>
                <option value="production">{ENVIRONMENT_LABEL.production}</option>
                <option value="sandbox">{ENVIRONMENT_LABEL.sandbox}</option>
                {status.simulatorAllowed && <option value="simulator">{ENVIRONMENT_LABEL.simulator}</option>}
              </select>
            </label>
            {environment !== 'simulator' && till === 'square' && (
              <label>
                {sameTill ? 'Replace access token (optional)' : 'Square access token'}
                <input type="password" autoComplete="off" placeholder="EAAA..." required={!sameTill} value={secret.accessToken} onChange={(e) => setSecret({ ...secret, accessToken: e.target.value })} />
              </label>
            )}
            {environment !== 'simulator' && till === 'toast' && (
              <>
                <label>
                  {sameTill ? 'Replace client ID (optional)' : 'Toast client ID'}
                  <input autoComplete="off" required={!sameTill} value={secret.clientId} onChange={(e) => setSecret({ ...secret, clientId: e.target.value })} />
                </label>
                <label>
                  {sameTill ? 'Replace client secret (optional)' : 'Toast client secret'}
                  <input type="password" autoComplete="off" required={!sameTill} value={secret.clientSecret} onChange={(e) => setSecret({ ...secret, clientSecret: e.target.value })} />
                </label>
              </>
            )}
            <button className="primary" type="submit" disabled={busy || lightspeedOff}>
              {till === 'lightspeed' && environment !== 'simulator' ? 'Connect with Lightspeed' : conn ? 'Reconnect' : 'Connect'}
            </button>
            {conn && <button type="button" className="danger" disabled={busy} onClick={() => { if (confirm('Disconnect the till? Takings already brought in stay; nothing new comes in until it is connected again.')) void disconnect(); }}>Disconnect</button>}
          </form>
          {environment !== 'simulator' && (
            <p className="muted small">
              {lightspeedOff
                ? 'Lightspeed is not set up on this server yet: Preshift needs its own Lightspeed app first. Ask Williams, Stanley & Co.'
                : `${HOW_TO[till]} Preshift checks the connection with ${label} before saving, keeps it on the server, and never shows it again.`}
            </p>
          )}

          {conn && (
            <>
              <h3 className="section-inline">Which location is each site</h3>
              {!locations ? (
                <p className="small muted">Asking {TILL_LABEL[conn.provider]} for its locations...</p>
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
                <button disabled={busy || mappingChanged || unmatched === status.sites.length} onClick={() => void sync()}>Bring in the last 7 days</button>
              </div>
              {conn.lastSync && (
                <p className={`small ${conn.lastSync.ok ? 'muted' : 'bad-text'}`}>
                  Last sync {syncedAt(conn.lastSync.at)}: {describeSync(conn.lastSync, siteName)}
                </p>
              )}

              <h3 className="section-inline">History for forecasting</h3>
              <p className="muted small">
                Thirteen months of takings let next week's forecast work from the same week last year. It comes in a fortnight at a time; leave
                the page and it carries on overnight.
              </p>
              {job && (
                <div className="backfill">
                  <div className="meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(backfillShare(job) * 100)}>
                    <span style={{ width: `${Math.round(backfillShare(job) * 100)}%` }} />
                  </div>
                  <p className={`small ${job.error ? 'bad-text' : 'muted'}`}>
                    {job.finishedAt
                      ? `Done: ${job.written} trading days, ${job.from} to ${job.to}, finished ${syncedAt(job.finishedAt)}.`
                      : job.error
                        ? `Stopped at ${job.next}: ${job.error}`
                        : `${Math.round(backfillShare(job) * 100)}%: ${job.written} days in, up to ${job.next}.`}
                  </p>
                </div>
              )}
              <div className="close-actions">
                <button className="primary" disabled={busy || mappingChanged || unmatched === status.sites.length} onClick={() => void backfill({})}>
                  {job?.finishedAt ? 'Bring in the last 13 months again' : 'Bring in the last 13 months'}
                </button>
                {job && !job.finishedAt && <button disabled={busy} onClick={() => void backfill()}>Carry on</button>}
                <label className="check-inline small">
                  Or from
                  <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
                </label>
                <button disabled={busy || !from || mappingChanged} onClick={() => void backfill({ from })}>Bring in from this date</button>
              </div>
            </>
          )}
        </>
      )}
      {message && <p className={`small ${message.bad ? 'bad-text' : 'good-text'}`}>{message.text}</p>}
    </section>
  );
}
