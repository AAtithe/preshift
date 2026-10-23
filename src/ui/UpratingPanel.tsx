import { useEffect, useState } from 'react';
import type { UpratingMethod, UpratingRates, UpratingResult } from '../engine/uprating';
import { api } from './api';
import { money, money2 } from './format';

interface Props {
  today: string;
  siteName: (id: string) => string;
  /** Rises were proposed: reload the list they now wait in. */
  onProposed: () => Promise<unknown>;
}

interface Start {
  rates: UpratingRates;
  margin: number;
  last: { rates: UpratingRates; method: UpratingMethod; proposedAt: string; by: string; count: number } | null;
}

const when = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

/**
 * The April minimum wage uprating: enter the new rates once announced, see who falls below them on
 * the day and what lifting them costs, and propose every rise dated 1 April in one go, for finance
 * to approve as a batch in March. From December, until it is done, the screen says it is due.
 */
export function UpratingPanel({ today, siteName, onProposed }: Props) {
  const [start, setStart] = useState<Start | null>(null);
  const [open, setOpen] = useState(false);
  const [rates, setRates] = useState<UpratingRates | null>(null);
  const [method, setMethod] = useState<UpratingMethod>('floor');
  const [margin, setMargin] = useState(1);
  const [preview, setPreview] = useState<UpratingResult | null>(null);
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);

  useEffect(() => {
    api.get<Start>('/v1/pay-changes/uprating').then((s) => {
      setStart(s);
      setRates(s.rates);
      setMargin(s.margin);
    }).catch(() => setStart(null));
  }, []);
  if (!start || !rates) return null;

  const done = start.last?.rates.effectiveFrom === start.rates.effectiveFrom;
  // December to the day itself: the new rates are out and the rises need deciding before April's pay.
  const due = !done && today >= `${Number(start.rates.effectiveFrom.slice(0, 4)) - 1}-12-01`;
  const body = { ...rates, method, ...(method === 'differential' ? { margin } : {}) };

  async function run() {
    setMessage(null);
    try {
      setPreview(await api.post<UpratingResult>('/v1/pay-changes/uprating/preview', body));
    } catch (e) {
      setPreview(null);
      setMessage({ text: (e as Error).message, bad: true });
    }
  }

  async function propose() {
    if (!preview) return;
    const ready = preview.lines.filter((l) => !l.blocked);
    if (!confirm(`Propose ${ready.length} rises from ${when(rates!.effectiveFrom)}, adding ${money(preview.total)} a year at full cost? Finance approves them; pay moves on the day.`)) return;
    try {
      const res = await api.post<{ proposed: unknown[]; skipped: { name: string }[] }>('/v1/pay-changes/uprating', body);
      setMessage({ text: `Proposed ${res.proposed.length} rises from ${when(rates!.effectiveFrom)}.${res.skipped.length ? ` Left out, pay already moving: ${res.skipped.map((s) => s.name).join(', ')}.` : ''}` });
      setPreview(null);
      setStart({ ...start!, last: { rates: rates!, method, proposedAt: new Date().toISOString(), by: 'you', count: res.proposed.length } });
      await onProposed();
    } catch (e) {
      setMessage({ text: (e as Error).message, bad: true });
    }
  }

  const setBand = (i: number, hourly: number) => setRates({ ...rates, bands: rates.bands.map((b, j) => (j === i ? { ...b, hourly } : b)) });

  return (
    <div className="grid-wrap">
      <div className="people-bar">
        <h3 className="section-title">Minimum wage from {when(start.rates.effectiveFrom)}</h3>
        <button onClick={() => setOpen(!open)}>{open ? 'Close' : done ? 'Run it again' : 'Work out the rises'}</button>
      </div>
      {due && !open && (
        <p className="notice">
          The minimum wage rises on {when(start.rates.effectiveFrom)}. Enter the new rates once announced and propose the rises now,
          so finance approves them before April&apos;s pay and nobody is underpaid on the day.
        </p>
      )}
      {done && !open && (
        <p className="muted small">{start.last!.count} rises proposed by {start.last!.by} on {when(start.last!.proposedAt)}, waiting under Waiting or approved to take effect.</p>
      )}
      {open && (
        <>
          <p className="muted small">
            Enter the rates the government announced for {when(rates.effectiveFrom)}; today&apos;s are filled in to start from. Each person&apos;s
            band is their age on that day, so a birthday before it counts.
          </p>
          <div className="form">
            <label>
              Takes effect
              <input type="date" value={rates.effectiveFrom} onChange={(e) => setRates({ ...rates, effectiveFrom: e.target.value })} />
            </label>
            {rates.bands.map((b, i) => (
              <label key={b.minAge}>
                {b.label} (£ an hour)
                <input type="number" min={0} step={0.01} value={b.hourly} onChange={(e) => setBand(i, Number(e.target.value))} />
              </label>
            ))}
            <label>
              Apprentice rate (£ an hour)
              <input type="number" min={0} step={0.01} value={rates.apprentice} onChange={(e) => setRates({ ...rates, apprentice: Number(e.target.value) })} />
            </label>
            <label>
              Rises
              <select value={method} onChange={(e) => setMethod(e.target.value as UpratingMethod)}>
                <option value="floor">Lift those below the new rate onto it</option>
                <option value="differential">Keep the gap for those near the old rate</option>
              </select>
            </label>
            {method === 'differential' && (
              <label>
                Near means within (£ an hour above the old rate)
                <input type="number" min={0} max={5} step={0.05} value={margin} onChange={(e) => setMargin(Number(e.target.value))} />
              </label>
            )}
          </div>
          <div className="people-actions">
            <button className="primary" onClick={() => void run()}>Show who needs a rise</button>
          </div>
        </>
      )}
      {message && <p className={`notice${message.bad ? ' error' : ''}`}>{message.text}</p>}
      {open && preview && (
        <>
          <table className="table people">
            <thead>
              <tr><th>Person</th><th className="num">Age on the day</th><th>Band</th><th className="num">Now</th><th className="num">New minimum</th><th className="num">Proposed</th><th className="num">Full cost a year</th></tr>
            </thead>
            <tbody>
              {preview.lines.length === 0 && <tr><td colSpan={7} className="muted">Everyone is already at or above the new rates.</td></tr>}
              {preview.lines.map((l) => (
                <tr key={l.employeeId}>
                  <td>{l.name}<div className="muted small">{l.blocked ?? siteName(l.siteId)}</div></td>
                  <td className="num">{l.age}</td>
                  <td>{l.band}</td>
                  <td className="num">£{l.current.toFixed(2)}</td>
                  <td className="num">£{l.newMinimum.toFixed(2)}</td>
                  <td className="num strong">{l.blocked ? '-' : `£${l.proposed.toFixed(2)}`}</td>
                  <td className="num">{l.blocked ? '-' : l.hoursPerWeek === 0 ? <span className="muted small">No hours in the last 4 weeks</span> : money2(l.fullCostAYear)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {preview.salaryChecks.length > 0 && (
            <p className="notice error">
              Salaries to put right by hand, below the new minimum on their maximum hours:{' '}
              {preview.salaryChecks.map((s) => `${s.name} (£${s.effectiveHourly.toFixed(2)} an hour against £${s.newMinimum.toFixed(2)})`).join('; ')}.
            </p>
          )}
          <div className="people-bar">
            <span className="muted small">
              Adds {money(preview.total)} a year at full cost, holiday, employer NI and pension included, on contracted hours or the last four
              weeks of rota{preview.lines.some((l) => !l.blocked && l.hoursPerWeek === 0) ? '. People with no hours lately add cost as they are rostered' : ''}.
            </span>
            {preview.lines.some((l) => !l.blocked) && <button className="primary" onClick={() => void propose()}>Propose {preview.lines.filter((l) => !l.blocked).length} rises</button>}
          </div>
        </>
      )}
    </div>
  );
}
