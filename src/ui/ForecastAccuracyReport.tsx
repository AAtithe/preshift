import { useEffect, useState } from 'react';
import type { AccuracyFigures, AccuracyReport } from '../engine/forecastreport';
import type { RotaState } from '../engine/types';
import { api } from './api';
import { dayLabel, download, money, pct, slug, toCsv as csv } from './format';

interface Props {
  state: RotaState;
  siteIds: string[];
  week: string;
  scopeName: string;
}

const signedPct = (n: number) => `${n > 0 ? '+' : ''}${pct(n)}`;
const biasWords = (b: number | null) => (b === null ? '' : Math.abs(b) < 0.005 ? 'Balanced' : b > 0 ? 'Forecast too high: rotas too heavy' : 'Forecast too low: floors too light');

/** Forecast against takings over the estate and the weeks: where the forecast can be staffed from, and where it cannot. */
export function ForecastAccuracyReport({ state, siteIds, week, scopeName }: Props) {
  const [weeks, setWeeks] = useState(8);
  const [report, setReport] = useState<AccuracyReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Keyed on the ids, not the array, so a fresh array with the same sites does not refetch.
  const ids = siteIds.join(',');
  useEffect(() => {
    let live = true;
    setReport(null);
    setError(null);
    api
      .get<AccuracyReport>(`/v1/forecast/accuracy/report?siteIds=${encodeURIComponent(ids)}&week=${week}&weeks=${weeks}`)
      .then((r) => live && setReport(r))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [ids, week, weeks]);

  const siteName = (id: string) => state.sites.find((s) => s.id === id)?.name ?? id;
  if (error) return <p className="bad-text">{error}</p>;
  if (!report) return <p className="muted">Loading</p>;

  const { total, threshold } = report;
  const tone = (f: AccuracyFigures) => (f.dayWape === null ? '' : f.dayWape > threshold ? 'bad-text' : 'good-text');
  // Weeks before the first one measured are history the forecast does not reach: one line, not empty rows.
  const first = report.weeks.findIndex((w) => w.total.measuredDays > 0);
  const shown = first > 0 ? report.weeks.slice(first) : report.weeks;
  const typical = report.sites.filter((s) => s.total.typicalDays > 0);
  const patterns = report.sites.filter((s) => s.patterns.length > 0);

  function exportCsv() {
    const header = ['Week commencing', 'Site', 'Days measured', 'Forecast', 'Takings', 'Day error %', 'Hourly error %', 'Bias %', 'Over forecast', 'Under forecast', 'Labour planned for sales that did not come', 'Labour the unforecast sales would have paid for', 'Days on the typical week'];
    const p = (n: number | null) => (n === null ? '' : Math.round(n * 1000) / 10);
    const rows = report!.weeks.flatMap((w) =>
      w.sites.map((m) => [w.weekStart, siteName(m.siteId), m.measuredDays, m.forecast, m.actual, p(m.dayWape), p(m.hourWape), p(m.bias), m.over, m.under, m.labourOver, m.labourUnder, m.typicalDays]),
    );
    download(`preshift-forecast-accuracy-${slug(scopeName)}-${week}.csv`, csv([header, ...rows]));
  }

  return (
    <>
      <div className="close-actions report-actions">
        <select value={weeks} onChange={(e) => setWeeks(Number(e.target.value))} aria-label="Weeks">
          <option value={4}>Last 4 weeks</option>
          <option value={8}>Last 8 weeks</option>
          <option value={13}>Last 13 weeks (a quarter)</option>
        </select>
        <button onClick={exportCsv} disabled={total.measuredDays === 0}>Download CSV</button>
      </div>

      {total.measuredDays === 0 ? (
        <div className="notice">Nothing to measure yet. A day counts once it has both a forecast and takings, keyed in or from the till.</div>
      ) : (
        <>
          <section className="kpis people-kpis">
            <Stat label="Day error" value={pct(total.dayWape!)} hint={`Line is ${pct(threshold, 0)}: ${total.dayWape! > threshold ? 'too loose to staff from' : 'good enough to staff from'}`} tone={tone(total)} />
            <Stat label="Hourly error" value={total.hourWape === null ? 'Not known' : pct(total.hourWape)} hint={total.hourWape === null ? 'The till sends no hours' : 'What the floor feels'} />
            <Stat label="Bias" value={signedPct(total.bias!)} hint={biasWords(total.bias)} />
            <Stat label="Labour planned for sales that did not come" value={money(total.labourOver)} hint={`${money(total.over)} over forecast, at each site's target`} />
            <Stat label="Sales the rota was not built for" value={money(total.under)} hint={`Worth ${money(total.labourUnder)} of labour at target`} />
          </section>

          <div className="grid-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Week commencing</th>
                  <th className="num">Days</th>
                  <th className="num">Forecast</th>
                  <th className="num">Takings</th>
                  <th className="num">Day error</th>
                  <th className="num">Hourly error</th>
                  <th className="num">Bias</th>
                  <th className="num">Labour on sales that did not come</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((w) => (
                  <tr key={w.weekStart}>
                    <td>{dayLabel(w.weekStart).date}</td>
                    <td className="num">{w.total.measuredDays || <span className="muted">-</span>}</td>
                    <td className="num">{w.total.measuredDays ? money(w.total.forecast) : ''}</td>
                    <td className="num">{w.total.measuredDays ? money(w.total.actual) : ''}</td>
                    <td className={`num ${tone(w.total)}`}>{w.total.dayWape === null ? '' : pct(w.total.dayWape)}</td>
                    <td className="num">{w.total.hourWape === null ? '' : pct(w.total.hourWape)}</td>
                    <td className="num">{w.total.bias === null ? '' : signedPct(w.total.bias)}</td>
                    <td className="num">{w.total.measuredDays ? money(w.total.labourOver) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {first > 0 && <p className="muted small">{first} earlier {first === 1 ? 'week has' : 'weeks have'} no day with both a forecast and takings, so {first === 1 ? 'it is' : 'they are'} left out.</p>}
          </div>

          {report.sites.length > 1 && (
            <div className="grid-wrap report-block">
              <div className="entity-journal-head">
                <h3>Day error by site</h3>
                <span className="muted small">Red is above the {pct(threshold, 0)} line. The last column is the period, worked from the days.</span>
              </div>
              <table className="table">
                <thead>
                  <tr>
                    <th>Site</th>
                    {shown.map((w) => <th key={w.weekStart} className="num">{dayLabel(w.weekStart).date}</th>)}
                    <th className="num">Period</th>
                    <th className="num">Bias</th>
                  </tr>
                </thead>
                <tbody>
                  {report.sites.map((s) => (
                    <tr key={s.siteId}>
                      <td>{siteName(s.siteId)}</td>
                      {shown.map((w) => {
                        const m = w.sites.find((x) => x.siteId === s.siteId)!;
                        return <td key={w.weekStart} className={`num ${tone(m)}`}>{m.dayWape === null ? <span className="muted">-</span> : pct(m.dayWape)}</td>;
                      })}
                      <td className={`num strong ${tone(s.total)}`}>{s.total.dayWape === null ? '' : pct(s.total.dayWape)}</td>
                      <td className="num">{s.total.bias === null ? '' : signedPct(s.total.bias)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {(patterns.length > 0 || typical.length > 0) && (
            <div className="report-block">
              <div className="entity-journal-head">
                <h3>What to fix</h3>
              </div>
              <ul className="accuracy-findings">
                {patterns.flatMap((s) => s.patterns.map((p) => <li key={`${s.siteId}${p}`}><strong>{siteName(s.siteId)}:</strong> {p}</li>))}
                {typical.map((s) => (
                  <li key={`${s.siteId}-typical`}>
                    <strong>{siteName(s.siteId)}:</strong> {s.total.typicalDays} of {s.total.measuredDays} measured days were forecast from the typical week entered at set-up. Forecast them from past takings on the Demand screen.
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </>
  );
}

function Stat({ label, value, hint, tone = '' }: { label: string; value: string; hint: string; tone?: string }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value ${tone}`}>{value}</div>
      <div className="kpi-hint">{hint}</div>
    </div>
  );
}
