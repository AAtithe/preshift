import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { addDays } from '../engine/time';
import type { Site } from '../engine/types';
import { parseSalesCsv, SALES_CSV_COLUMNS } from '../engine/salesCsv';
import { api, ApiError } from './api';

export interface EposStatus {
  provider: 'square' | 'demo' | null;
  providerName: string | null;
  environment: 'production' | 'sandbox' | null;
  connected: boolean;
  demoAvailable: boolean;
  lastSync: { at: string; from: string; to: string; bills: number; hours: number } | null;
  lastError: { at: string; message: string } | null;
  sites: { siteId: string; name: string; locationId: string | null; daysHeld: number; latest: { date: string; hour: number; source: string } | null }[];
}

interface TillLocation { id: string; name: string; active: boolean }

const problem = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));
const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;

/** Connected and every site fed, connected with gaps, or nothing yet. Pushed or imported sales count as fed. */
export function eposHealth(s: EposStatus | null): 'live' | 'partial' | 'attention' | 'off' | null {
  if (!s) return null;
  if (s.lastError) return 'attention';
  const fed = s.sites.filter((x) => x.daysHeld > 0).length;
  if (!s.provider) return fed > 0 ? 'attention' : 'off';
  if (!s.connected || s.sites.some((x) => !x.locationId)) return 'attention';
  return s.provider === 'demo' ? 'partial' : 'live';
}

interface Props {
  status: EposStatus;
  admin: boolean;
  sites: Site[];
  today: string;
  onChange: (status: EposStatus) => void;
}

export function EposPanel({ status, admin, sites, today, onChange }: Props) {
  const [locations, setLocations] = useState<TillLocation[]>([]);
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!status.connected) return setLocations([]);
    api.get<TillLocation[]>('/v1/integrations/epos/locations').then(setLocations).catch((e) => setMessage({ text: problem(e), bad: true }));
  }, [status.connected, status.provider]);

  async function act(fn: () => Promise<unknown>, done: (result: unknown) => string) {
    setBusy(true);
    setMessage(null);
    try {
      const result = await fn();
      setMessage({ text: done(result) });
    } catch (e) {
      setMessage({ text: problem(e), bad: true });
    }
    onChange(await api.get<EposStatus>('/v1/integrations/epos'));
    setBusy(false);
  }

  const sync = () =>
    act(
      () => api.post<{ bills: number; hours: number }>('/v1/integrations/epos/sync', {}),
      (r) => `Synced: ${(r as { bills: number }).bills} bills into ${(r as { hours: number }).hours} trading hours.`,
    );

  // Eight weeks in two reads, each inside the per-call limit, so a six week forecast has enough to work from.
  const importHistory = () =>
    act(async () => {
      let bills = 0;
      for (const [from, to] of [[addDays(today, -55), addDays(today, -28)], [addDays(today, -27), today]]) {
        bills += (await api.post<{ bills: number }>('/v1/integrations/epos/sync', { from, to })).bills;
      }
      return bills;
    }, (bills) => `Imported eight weeks: ${bills} bills. Demand can now forecast from till history.`);

  const mapped = status.sites.filter((s) => s.locationId).length;

  return (
    <>
      <dl className="facts">
        <dt>Till</dt>
        <dd>
          {status.provider
            ? `${status.providerName}${status.environment === 'sandbox' ? ' (sandbox)' : ''}${status.connected ? '' : ', token missing'}`
            : 'Not connected'}
        </dd>
        <dt>Sites matched</dt>
        <dd className={status.provider && mapped < status.sites.length ? 'bad-text' : undefined}>{mapped} of {status.sites.length}</dd>
        <dt>Last sync</dt>
        <dd>{status.lastSync ? `${when(status.lastSync.at)}, ${status.lastSync.bills} bills` : 'Never'}</dd>
      </dl>
      {status.lastError && <p className="bad-text small">Last sync failed {when(status.lastError.at)}: {status.lastError.message}</p>}

      {status.provider && (
        <table className="table">
          <thead>
            <tr><th>Site</th><th>Till location</th><th className="num">Days held</th><th>Latest hour</th></tr>
          </thead>
          <tbody>
            {status.sites.map((s) => (
              <tr key={s.siteId}>
                <td>{s.name}</td>
                <td>
                  {admin && status.connected ? (
                    <select
                      aria-label={`Till location for ${s.name}`}
                      value={s.locationId ?? ''}
                      disabled={busy}
                      onChange={(e) =>
                        void act(
                          () => api.put(`/v1/integrations/epos/sites/${s.siteId}`, { locationId: e.target.value || null }),
                          () => (e.target.value ? `${s.name} now reads from that till location.` : `${s.name} is no longer synced.`),
                        )
                      }
                    >
                      <option value="">Not synced</option>
                      {locations.filter((l) => l.active || l.id === s.locationId).map((l) => (
                        <option key={l.id} value={l.id}>{l.name}</option>
                      ))}
                    </select>
                  ) : (
                    <span className={s.locationId ? undefined : 'bad-text'}>{locations.find((l) => l.id === s.locationId)?.name ?? s.locationId ?? 'Not matched'}</span>
                  )}
                </td>
                <td className="num">{s.daysHeld}</td>
                <td className="muted">{s.latest ? `${s.latest.date} ${hh(s.latest.hour)}` : 'None'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {status.provider && status.connected && (
        <div className="integration-actions">
          <button className="primary" disabled={busy || mapped === 0} onClick={() => void sync()}>Sync now</button>
          <button disabled={busy || mapped === 0} onClick={() => void importHistory()}>Import eight weeks</button>
          {admin && (
            <button
              className="danger"
              disabled={busy}
              onClick={() => {
                if (confirm('Disconnect the till? Sales already imported are kept, but nothing new arrives.')) {
                  void act(() => api.del('/v1/integrations/epos'), () => 'Disconnected. Imported sales are kept.');
                }
              }}
            >
              Disconnect
            </button>
          )}
        </div>
      )}

      {admin && !status.connected && <Connect demoAvailable={status.demoAvailable} busy={busy} onConnect={(body) => act(() => api.put('/v1/integrations/epos', body), () => 'Connected. Sites were matched by name where it was clear; check the rest below.')} />}
      {!admin && !status.provider && <p className="small muted">An admin connects the till here.</p>}

      <CsvImport sites={sites} onImported={(text) => act(async () => text, (t) => String(t))} />

      {message && <p className={`small ${message.bad ? 'bad-text' : 'muted'}`}>{message.text}</p>}
    </>
  );
}

function Connect({ demoAvailable, busy, onConnect }: { demoAvailable: boolean; busy: boolean; onConnect: (body: object) => Promise<void> }) {
  const [provider, setProvider] = useState<'square' | 'demo'>(demoAvailable ? 'demo' : 'square');
  const [token, setToken] = useState('');
  const [environment, setEnvironment] = useState<'production' | 'sandbox'>('production');

  function submit(e: FormEvent) {
    e.preventDefault();
    void onConnect(provider === 'square' ? { provider, accessToken: token, environment } : { provider }).then(() => setToken(''));
  }

  return (
    <form className="settings-form" onSubmit={submit}>
      <label>
        Till
        <select value={provider} onChange={(e) => setProvider(e.target.value as 'square' | 'demo')}>
          <option value="square">Square</option>
          {demoAvailable && <option value="demo">Demo till</option>}
        </select>
      </label>
      {provider === 'square' && (
        <>
          <label>
            Access token
            <input type="password" autoComplete="off" required placeholder="EAAA..." value={token} onChange={(e) => setToken(e.target.value)} />
          </label>
          <label>
            Account
            <select value={environment} onChange={(e) => setEnvironment(e.target.value as 'production' | 'sandbox')}>
              <option value="production">Live</option>
              <option value="sandbox">Sandbox</option>
            </select>
          </label>
        </>
      )}
      <button className="primary" type="submit" disabled={busy}>Connect</button>
      {provider === 'square' && (
        <p className="small muted" style={{ flexBasis: '100%', margin: 0 }}>
          From the Square Developer Dashboard, an access token with ORDERS_READ and MERCHANT_PROFILE_READ. It is checked against Square
          now, kept on the server, and never shown again.
        </p>
      )}
    </form>
  );
}

function CsvImport({ sites, onImported }: { sites: Site[]; onImported: (summary: string) => void }) {
  const [errors, setErrors] = useState<string[]>([]);

  async function pick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const { rows, errors } = parseSalesCsv(await file.text(), sites);
    setErrors(errors);
    if (errors.length || rows.length === 0) return;
    try {
      const res = await api.put<{ upserted: number }>('/v1/sales/actuals', { rows, source: 'csv' });
      onImported(`Imported ${res.upserted} hours from ${file.name}.`);
    } catch (err) {
      setErrors([problem(err)]);
    }
  }

  return (
    <details className="small">
      <summary>Another till: import an hourly sales export</summary>
      <p className="muted">
        For Lightspeed, Tevalis, Zonal or any till without a native connection. A CSV with columns {SALES_CSV_COLUMNS}, sales net of VAT. Each
        hour replaces what is held for it. A system can push the same rows to the API instead.
      </p>
      <input type="file" accept=".csv,text/csv" onChange={(e) => void pick(e)} />
      {errors.slice(0, 5).map((e) => <p key={e} className="bad-text">{e}</p>)}
      {errors.length > 5 && <p className="bad-text">and {errors.length - 5} more.</p>}
    </details>
  );
}
