import { useEffect, useState } from 'react';
import { parseCoversCsv, parseTakingsCsv, type CoversImport, type TakingsImport } from '../engine/reports';
import { weekDates } from '../engine/time';
import type { DaySales, RotaState } from '../engine/types';
import { api } from './api';
import { describeSync, syncedAt, type EposStatus, type EposSyncResult } from './EposSetup';
import { dayLabel, money, pct, signed } from './format';

interface Props {
  state: RotaState;
  siteIds: string[];
  week: string;
  today: string;
  onSave: (rows: Omit<DaySales, 'source'>[], cleared: { siteId: string; date: string }[], source: DaySales['source']) => Promise<unknown>;
  /** Called after the till has been synced, so the figures reload. */
  onSynced: () => void;
}

const SOURCES: Record<DaySales['source'], string> = { till: 'From the till', manual: 'Keyed in', import: 'Imported' };
const key = (siteId: string, date: string) => `${siteId}|${date}`;

/**
 * Keys in or imports a week of takings. Only days up to today take a figure: a day not yet traded
 * has a forecast, not takings.
 */
export function TakingsEntry({ state, siteIds, week, today, onSave, onSynced }: Props) {
  const dates = weekDates(week);
  const sites = state.sites.filter((s) => siteIds.includes(s.id));
  const recorded = (siteId: string, date: string) => state.sales?.find((x) => x.siteId === siteId && x.date === date);
  const forecastFor = (siteId: string, date: string) => state.forecast.filter((f) => f.siteId === siteId && f.date === date).reduce((s, f) => s + f.sales, 0);

  // Shown to the pound. A till figure with pence only counts as changed if someone retypes it.
  const shown = (siteId: string, date: string) => {
    const r = recorded(siteId, date);
    return r ? String(Math.round(r.netSales)) : '';
  };
  const initial = () => Object.fromEntries(sites.flatMap((s) => dates.map((d) => [key(s.id, d), shown(s.id, d)])));
  const [draft, setDraft] = useState<Record<string, string>>(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [parsed, setParsed] = useState<TakingsImport | null>(null);
  const [till, setTill] = useState<EposStatus | null>(null);

  useEffect(() => {
    api.get<EposStatus>('/v1/integrations/epos').then(setTill).catch(() => setTill(null));
  }, []);

  async function syncTill() {
    setBusy(true);
    setMessage(null);
    try {
      const r = await api.post<EposSyncResult>('/v1/integrations/epos/sync', {});
      setMessage(r.ok ? describeSync(r, (id) => state.sites.find((s) => s.id === id)?.name ?? id) : `The till sync failed: ${r.error}`);
      setTill(await api.get<EposStatus>('/v1/integrations/epos'));
      onSynced();
    } catch (e) {
      setMessage(`The till sync failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  // Start again from what is recorded when the week, the scope or the saved figures change.
  useEffect(() => setDraft(initial()), [week, siteIds.join(), state.sales]);

  const value = (siteId: string, date: string) => {
    const v = draft[key(siteId, date)];
    return v === undefined || v.trim() === '' ? null : Number(v);
  };
  const invalid = Object.values(draft).some((v) => v.trim() !== '' && (!Number.isFinite(Number(v)) || Number(v) < 0));
  const changes = sites.flatMap((s) =>
    dates
      .filter((d) => d <= today)
      .filter((d) => (draft[key(s.id, d)] ?? '').trim() !== shown(s.id, d))
      .map((d) => ({ siteId: s.id, date: d, now: value(s.id, d) })),
  );

  async function save() {
    setBusy(true);
    const rows = changes.filter((c) => c.now !== null).map((c) => ({ siteId: c.siteId, date: c.date, netSales: c.now! }));
    const cleared = changes.filter((c) => c.now === null).map(({ siteId, date }) => ({ siteId, date }));
    if (await onSave(rows, cleared, 'manual')) setMessage(`Saved ${rows.length + cleared.length} days.`);
    setBusy(false);
  }

  async function readFile(file: File) {
    setMessage(null);
    setParsed(parseTakingsCsv(await file.text(), state.sites));
  }

  // Covers from a booking system attach to days that already have takings.
  const [covers, setCovers] = useState<CoversImport | null>(null);
  async function readCovers(file: File) {
    setMessage(null);
    setCovers(parseCoversCsv(await file.text(), state.sites));
  }
  async function importCovers() {
    if (!covers) return;
    setBusy(true);
    try {
      const r = await api.put<{ updated: number; missing: { siteId: string; date: string }[] }>('/v1/sales/covers', { rows: covers.rows });
      setMessage(`Covers set on ${r.updated} days.${r.missing.length ? ` ${r.missing.length} days have no takings yet, so their covers were not kept: bring the takings in first.` : ''}`);
      setCovers(null);
      onSynced();
    } catch (e) {
      setMessage(`The covers import failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function importParsed() {
    if (!parsed) return;
    setBusy(true);
    if (await onSave(parsed.rows, [], 'import')) {
      setMessage(`Imported ${parsed.rows.length} days of takings.`);
      setParsed(null);
    }
    setBusy(false);
  }

  const total = (siteId: string) => dates.reduce((s, d) => s + (value(siteId, d) ?? 0), 0);
  const forecastTotal = (siteId: string, upTo = '9999-12-31') => dates.filter((d) => d <= upTo).reduce((s, d) => s + forecastFor(siteId, d), 0);
  const traded = (siteId: string) => dates.filter((d) => value(siteId, d) !== null);

  return (
    <>
      <div className="close-actions report-actions">
        <span className="muted small">
          {till?.connection
            ? `Takings come from ${till.connection.accountName ?? 'the till'} every morning${till.connection.lastSync ? `, last synced ${syncedAt(till.connection.lastSync.at)}` : ''}. A figure you key in here is kept: the till never overwrites it.`
            : "Net of VAT, as the till's Z read shows it. Enter the whole day's takings, or connect the till in Settings."}
        </span>
        <span className="close-actions">
          {till?.connection && (
            <button disabled={busy} onClick={() => void syncTill()} title={till.connection.lastSync ? `Last synced ${syncedAt(till.connection.lastSync.at)}` : 'Not synced yet'}>
              Sync from till
            </button>
          )}
          <label className="button-like">
            Import CSV
            <input type="file" accept=".csv,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void readFile(f); e.target.value = ''; }} />
          </label>
          <label className="button-like" title="A booking system export: date, site, guests. One line per booking or per day.">
            Import covers
            <input type="file" accept=".csv,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void readCovers(f); e.target.value = ''; }} />
          </label>
          <button className="primary" disabled={busy || invalid || changes.length === 0} onClick={() => void save()}>
            {changes.length ? `Save ${changes.length} ${changes.length === 1 ? 'day' : 'days'}` : 'Saved'}
          </button>
        </span>
      </div>

      {message && <div className="notice good">{message} <button className="link" onClick={() => setMessage(null)}>Dismiss</button></div>}

      {covers && (
        <div className="notice">
          <strong>{covers.rows.reduce((s, r) => s + r.covers, 0)} guests over {covers.rows.length} days read from the file.</strong>{' '}
          Covers are set on days that already have takings, replacing any the till sent.
          {covers.errors.length > 0 && (
            <ul>
              {covers.errors.slice(0, 8).map((e) => <li key={e}>{e}</li>)}
              {covers.errors.length > 8 && <li>and {covers.errors.length - 8} more</li>}
            </ul>
          )}
          <div className="close-actions">
            <button className="primary" disabled={busy || covers.rows.length === 0} onClick={() => void importCovers()}>Set covers on {covers.rows.length} days</button>
            <button onClick={() => setCovers(null)}>Cancel</button>
          </div>
          <p className="muted small">Columns: date, site (name, id or tracking code), guests. OpenTable, ResDiary and SevenRooms exports work once trimmed to those three.</p>
        </div>
      )}

      {parsed && (
        <div className="notice">
          <strong>{parsed.rows.length} days read from the file.</strong>{' '}
          {parsed.rows.length > 0 && `${money(parsed.rows.reduce((s, r) => s + r.netSales, 0))} across ${new Set(parsed.rows.map((r) => r.siteId)).size} sites, ${parsed.rows.map((r) => r.date).sort()[0]} to ${parsed.rows.map((r) => r.date).sort().at(-1)}. Days already recorded are replaced.`}
          {parsed.errors.length > 0 && (
            <ul>
              {parsed.errors.slice(0, 8).map((e) => <li key={e}>{e}</li>)}
              {parsed.errors.length > 8 && <li>and {parsed.errors.length - 8} more</li>}
            </ul>
          )}
          <div className="close-actions">
            <button className="primary" disabled={busy || parsed.rows.length === 0} onClick={() => void importParsed()}>Import {parsed.rows.length} days</button>
            <button onClick={() => setParsed(null)}>Cancel</button>
          </div>
          <p className="muted small">Columns: date, site (name, id or tracking code), net sales, then covers if you have them.</p>
        </div>
      )}

      <div className="grid-wrap">
        <table className="table takings">
          <thead>
            <tr>
              <th>Site</th>
              {dates.map((d) => (
                <th key={d} className="num">{dayLabel(d).short} {dayLabel(d).date}</th>
              ))}
              <th className="num">Week</th>
            </tr>
          </thead>
          <tbody>
            {sites.map((s) => {
              const days = traded(s.id);
              const vsForecast = days.length ? total(s.id) / days.reduce((t, d) => t + forecastFor(s.id, d), 0) - 1 : null;
              return (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  {dates.map((d) => {
                    const f = forecastFor(s.id, d);
                    const v = value(s.id, d);
                    const rec = recorded(s.id, d);
                    return (
                      <td key={d} className="num">
                        <input
                          className="takings-input"
                          inputMode="decimal"
                          aria-label={`${s.name} ${d}`}
                          disabled={d > today}
                          placeholder={d > today ? '' : String(Math.round(f))}
                          title={rec ? SOURCES[rec.source] : d > today ? 'Not traded yet' : `Forecast ${money(f)}`}
                          value={draft[key(s.id, d)] ?? ''}
                          onChange={(e) => setDraft({ ...draft, [key(s.id, d)]: e.target.value })}
                        />
                        <div className={`small ${v !== null && f ? (v < f ? 'warn-text' : 'good-text') : 'muted'}`}>
                          {v !== null && f ? signed(v / f - 1, (n) => pct(n)) : `F ${money(f)}`}
                        </div>
                      </td>
                    );
                  })}
                  <td className="num strong">
                    {money(total(s.id))}
                    <div className={`small ${vsForecast === null ? 'muted' : vsForecast < 0 ? 'warn-text' : 'good-text'}`}>
                      {vsForecast === null ? `F ${money(forecastTotal(s.id))}` : `${signed(vsForecast, (n) => pct(n))} on ${days.length} days`}
                    </div>
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
