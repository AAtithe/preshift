import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { ForecastAccuracy } from '../engine/forecast';
import { addDays, weekDates } from '../engine/time';
import type { AdjustmentReason, ForecastAdjustment, RotaState } from '../engine/types';
import { api, ApiError } from './api';
import { dayLabel, money, pct } from './format';

interface Props {
  state: RotaState;
  siteId: string;
  week: string;
  /** Reloads the organisation after the forecast changes. */
  onChanged: () => Promise<void>;
}

const problem = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));
const REASONS: { id: AdjustmentReason; label: string }[] = [
  { id: 'weather', label: 'Weather' },
  { id: 'event', label: 'Local event' },
  { id: 'bank_holiday', label: 'Bank holiday' },
  { id: 'closure', label: 'Closure' },
  { id: 'other', label: 'Other' },
];
const signed = (n: number) => `${n > 0 ? '+' : ''}${pct(n)}`;

/**
 * The forecast as something the GM owns: run the model, tell it about the
 * one-offs it cannot know, override with a reason, and then see, once the
 * week has traded, how the forecast and each person's overrides actually did.
 */
export function ForecastView({ state, siteId, week, onChanged }: Props) {
  // Accuracy is about a week that has traded: the week in view if it has, otherwise the one before.
  const [accuracyWeek, setAccuracyWeek] = useState(addDays(week, -7));
  const [accuracy, setAccuracy] = useState<ForecastAccuracy | null>(null);
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [adj, setAdj] = useState({ date: week, factor: '110', reason: 'event' as AdjustmentReason, note: '', fromHour: '', toHour: '' });
  const [hour, setHour] = useState({ date: week, hour: '19', sales: '', covers: '', reason: '' });

  // Moving week resets the forms, so nothing is posted against a day from the week before.
  useEffect(() => {
    setAccuracyWeek(addDays(week, -7));
    setAdj((a) => ({ ...a, date: week }));
    setHour((h) => ({ ...h, date: week }));
  }, [week]);

  const loadAccuracy = useCallback(async () => {
    try {
      setAccuracy(await api.get<ForecastAccuracy>(`/v1/forecast/accuracy?siteId=${siteId}&from=${accuracyWeek}&to=${addDays(accuracyWeek, 6)}`));
    } catch (e) {
      setMessage({ text: problem(e), bad: true });
    }
  }, [siteId, accuracyWeek]);
  useEffect(() => void loadAccuracy(), [loadAccuracy]);

  async function act(fn: () => Promise<string>) {
    setBusy(true);
    try {
      setMessage({ text: await fn() });
      await onChanged();
      await loadAccuracy();
    } catch (e) {
      setMessage({ text: problem(e), bad: true });
    } finally {
      setBusy(false);
    }
  }

  const runModel = () =>
    act(async () => {
      const r = await api.post<{ rows: number; skipped: string[]; trend: number; bankHolidayFactor: number | null; automatic?: { kind: string }[] }>('/v1/forecast/model', { siteId, weekStart: week });
      const trend = r.trend === 1 ? 'no trend' : `trend ${signed(r.trend - 1)}`;
      const skipped = r.skipped.length ? ` No history for ${r.skipped.map((d) => dayLabel(d).short).join(', ')}: set those by hand.` : '';
      const booked = (r.automatic ?? []).filter((a) => a.kind === 'bookings').length;
      const other = (r.automatic ?? []).length - booked;
      const applied = [booked ? `bookings moved ${booked} ${booked === 1 ? 'daypart' : 'dayparts'}` : '', other ? `${other} occasion, event or weather ${other === 1 ? 'effect' : 'effects'} applied` : '']
        .filter(Boolean)
        .join('; ');
      return `Forecast built from till history: ${r.rows} trading hours, ${trend}${applied ? `; ${applied}` : ''}. Your overrides were kept; see the Calendar tab for why.${skipped}`;
    });

  function addAdjustment(e: FormEvent) {
    e.preventDefault();
    void act(async () => {
      const factor = adj.reason === 'closure' ? 0 : Number(adj.factor) / 100;
      await api.post('/v1/forecast/adjustments', {
        siteId,
        date: adj.date,
        factor,
        reason: adj.reason,
        note: adj.note || undefined,
        fromHour: adj.fromHour ? Number(adj.fromHour) : undefined,
        toHour: adj.toHour ? Number(adj.toHour) : undefined,
      });
      return 'Saved. Run the model again to apply it to the forecast.';
    });
  }

  function override(e: FormEvent) {
    e.preventDefault();
    void act(async () => {
      await api.patch('/v1/forecast/hour', {
        siteId,
        date: hour.date,
        hour: Number(hour.hour),
        sales: Number(hour.sales),
        covers: Number(hour.covers || Math.round(Number(hour.sales) / 40)),
        reason: hour.reason || undefined,
      });
      return 'Override saved. The model figure is kept underneath, so you will see whether you were right.';
    });
  }

  const adjustments = (state.forecastAdjustments ?? []).filter((a) => a.siteId === siteId && a.date >= addDays(week, -7)).sort((a, b) => a.date.localeCompare(b.date));
  const overridden = state.forecast.filter((f) => f.siteId === siteId && weekDates(week).includes(f.date) && f.overriddenBy);
  const dates = weekDates(week);

  return (
    <div className="coach">
      {message && (
        <div className={`notice ${message.bad ? 'error' : ''}`}>
          {message.text} <button className="link" onClick={() => setMessage(null)}>Dismiss</button>
        </div>
      )}

      <section className="settings-card">
        <div className="coach-head">
          <div>
            <h2>Forecast for w/c {dayLabel(week).date}</h2>
            <p className="muted small">
              The model learns from this site's own till: the same weekday and hour over the last eight weeks, recent weeks counting
              most, with the recent trend on top. Bank holidays trade like past bank holidays, or like a Sunday until there is
              history. Check it before you build: the rota is only as good as the forecast.
            </p>
          </div>
          <button className="primary" disabled={busy} onClick={() => void runModel()}>Build forecast from till history</button>
        </div>
        {overridden.length > 0 && (
          <p className="small">
            {overridden.length} hours overridden this week:{' '}
            {overridden.slice(0, 6).map((f) => `${dayLabel(f.date).short} ${String(f.hour).padStart(2, '0')}:00 ${money(f.sales)} (model ${money(f.modelSales ?? 0)})`).join('; ')}
            {overridden.length > 6 ? ' and more' : ''}.
          </p>
        )}
      </section>

      <div className="split">
        <section className="settings-card">
          <h2>Tell the model what it cannot know</h2>
          <p className="muted small">A heatwave, a match down the road, a refit. Applied as a multiplier when the model next runs.</p>
          <form className="form" onSubmit={addAdjustment}>
            <label>
              Day
              <select value={adj.date} onChange={(e) => setAdj({ ...adj, date: e.target.value })}>
                {dates.map((d) => <option key={d} value={d}>{dayLabel(d).short} {dayLabel(d).date}</option>)}
              </select>
            </label>
            <label>
              Reason
              <select value={adj.reason} onChange={(e) => setAdj({ ...adj, reason: e.target.value as AdjustmentReason })}>
                {REASONS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              </select>
            </label>
            {adj.reason !== 'closure' && (
              <label>
                Trade as % of normal
                <input type="number" required min={1} max={500} value={adj.factor} onChange={(e) => setAdj({ ...adj, factor: e.target.value })} />
              </label>
            )}
            <label>
              Note
              <input value={adj.note} maxLength={200} onChange={(e) => setAdj({ ...adj, note: e.target.value })} placeholder="e.g. Arsenal at home, 17:30" />
            </label>
            <label>
              From hour (optional)
              <input type="number" min={0} max={23} value={adj.fromHour} onChange={(e) => setAdj({ ...adj, fromHour: e.target.value })} />
            </label>
            <label>
              To hour (optional)
              <input type="number" min={1} max={24} value={adj.toHour} onChange={(e) => setAdj({ ...adj, toHour: e.target.value })} />
            </label>
            <button disabled={busy}>Add</button>
          </form>
          {adjustments.length > 0 && (
            <ul className="adjustments">
              {adjustments.map((a: ForecastAdjustment) => (
                <li key={a.id}>
                  {dayLabel(a.date).short} {dayLabel(a.date).date}: {REASONS.find((r) => r.id === a.reason)?.label}, {a.factor === 0 ? 'closed' : `${Math.round(a.factor * 100)}% of normal`}
                  {a.fromHour !== undefined || a.toHour !== undefined ? ` ${a.fromHour ?? 0}:00 to ${a.toHour ?? 24}:00` : ''}
                  {a.note ? `, ${a.note}` : ''}{' '}
                  <button className="link danger" disabled={busy} onClick={() => void act(async () => { await api.del(`/v1/forecast/adjustments/${a.id}`); return 'Removed. Run the model again to take it out of the forecast.'; })}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="settings-card">
          <h2>Override an hour</h2>
          <p className="muted small">Only with a reason you can name. Every override is scored against the model once the hour has traded.</p>
          <form className="form" onSubmit={override}>
            <label>
              Day
              <select value={hour.date} onChange={(e) => setHour({ ...hour, date: e.target.value })}>
                {dates.map((d) => <option key={d} value={d}>{dayLabel(d).short} {dayLabel(d).date}</option>)}
              </select>
            </label>
            <label>
              Hour
              <input type="number" min={0} max={23} value={hour.hour} onChange={(e) => setHour({ ...hour, hour: e.target.value })} />
            </label>
            <label>
              Sales, net of VAT
              <input type="number" min={0} required value={hour.sales} onChange={(e) => setHour({ ...hour, sales: e.target.value })} />
            </label>
            <label>
              Covers
              <input type="number" min={0} value={hour.covers} onChange={(e) => setHour({ ...hour, covers: e.target.value })} placeholder="From sales if blank" />
            </label>
            <label>
              Why
              <input value={hour.reason} maxLength={200} onChange={(e) => setHour({ ...hour, reason: e.target.value })} placeholder="e.g. 40 cover party booked" />
            </label>
            <button disabled={busy}>Override</button>
          </form>
        </section>
      </div>

      <section className="settings-card">
        <div className="coach-head">
          <h2>How the forecast did</h2>
          <div className="week-nav">
            <button onClick={() => setAccuracyWeek(addDays(accuracyWeek, -7))} aria-label="Earlier week">&lsaquo;</button>
            <span>w/c {dayLabel(accuracyWeek).date}</span>
            <button onClick={() => setAccuracyWeek(addDays(accuracyWeek, 7))} aria-label="Later week">&rsaquo;</button>
          </div>
        </div>
        {!accuracy ? null : accuracy.measuredDays === 0 ? (
          <p className="muted">No till sales for this week yet.</p>
        ) : (
          <>
            <section className="kpis people-kpis">
              <Stat label="Hourly error" value={pct(accuracy.wape)} hint="What staffing feels" />
              <Stat label="Day error" value={pct(accuracy.dayWape)} hint="Whole-day totals" />
              <Stat label="Bias" value={signed(accuracy.bias)} hint={Math.abs(accuracy.bias) < 0.005 ? 'Balanced' : accuracy.bias > 0 ? 'Forecast too high: rota too heavy' : 'Forecast too low: floor too light'} />
              <Stat
                label="Model alone"
                value={accuracy.modelWape === null ? 'Not known' : pct(accuracy.modelWape)}
                hint={accuracy.overrides.hours ? `Overrides ${accuracy.overrides.errorRemoved >= 0 ? 'removed' : 'added'} ${money(Math.abs(accuracy.overrides.errorRemoved))} of error` : 'No overrides'}
              />
            </section>
            <div className="split">
              <div className="grid-wrap">
              <table className="table">
                <thead>
                  <tr><th>Day</th><th className="num">Forecast</th><th className="num">Actual</th><th className="num">Error</th><th className="num">Bias</th></tr>
                </thead>
                <tbody>
                  {accuracy.days.map((d) => (
                    <tr key={d.date}>
                      <td>{dayLabel(d.date).short} {dayLabel(d.date).date}</td>
                      <td className="num">{money(d.forecast)}</td>
                      <td className="num">{money(d.actual)}</td>
                      <td className="num">{pct(d.wape)}</td>
                      <td className={`num ${Math.abs(d.bias) > 0.1 ? 'bad-text' : ''}`}>{signed(d.bias)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
              <div className="grid-wrap">
                <table className="table">
                  <thead>
                    <tr><th>Daypart</th><th className="num">Forecast</th><th className="num">Actual</th><th className="num">Error</th><th className="num">Bias</th></tr>
                  </thead>
                  <tbody>
                    {accuracy.dayparts.map((d) => (
                      <tr key={d.id}>
                        <td>{d.label}</td>
                        <td className="num">{money(d.forecast)}</td>
                        <td className="num">{money(d.actual)}</td>
                        <td className="num">{pct(d.wape)}</td>
                        <td className={`num ${Math.abs(d.bias) > 0.1 ? 'bad-text' : ''}`}>{signed(d.bias)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {accuracy.overrides.byPerson.length > 0 && (
                  <table className="table">
                    <thead>
                      <tr><th>Overrides by</th><th className="num">Hours</th><th className="num">Helped</th><th className="num">Hurt</th><th className="num">Net</th></tr>
                    </thead>
                    <tbody>
                      {accuracy.overrides.byPerson.map((p) => (
                        <tr key={p.by}>
                          <td>{p.by}</td>
                          <td className="num">{p.hours}</td>
                          <td className="num">{p.helped}</td>
                          <td className="num">{p.hurt}</td>
                          <td className={`num ${p.errorRemoved >= 0 ? 'good-text' : 'bad-text'}`}>{p.errorRemoved >= 0 ? '' : '-'}{money(Math.abs(p.errorRemoved))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-hint">{hint}</div>
    </div>
  );
}
