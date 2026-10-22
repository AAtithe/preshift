import { useMemo } from 'react';
import { chooseCohort, compare, MIN_PEER_CLIENTS, MIN_PEER_SITES, siteWeek, type MetricComparison, type MetricDefinition } from '../engine/benchmark';
import { demoPeerPanel } from '../engine/benchmarkDemo';
import { addDays, weekDates, weekStart } from '../engine/time';
import type { RotaState } from '../engine/types';
import { dayLabel, money, money2, pct } from './format';
import { Kpi } from './KpiBar';

interface Props {
  state: RotaState;
  siteId: string;
  week: string;
  asOf: string;
}

/** The business this demo runs as. In production this is the WS client record. */
const CLIENT_KEY = 'demo-group';

function show(metric: MetricDefinition, v: number | undefined) {
  if (v === undefined) return 'n/a';
  if (metric.unit === 'pct') return pct(v, 1);
  if (metric.unit === 'money') return money2(v);
  return `${v.toFixed(1)} min`;
}

function standing(r: MetricComparison) {
  if (r.betterThan === null) return '';
  return r.betterThan >= 0.75 ? 'good' : r.betterThan < 0.25 ? 'bad' : r.betterThan < 0.5 ? 'warn' : '';
}

export function BenchmarkView({ state, siteId, week, asOf }: Props) {
  // Only a fully traded week is benchmarked: the selected one if it has closed, otherwise the last one that has.
  const closedWeek = weekDates(week).every((d) => d < asOf) ? week : addDays(weekStart(asOf), -7);
  const panel = useMemo(() => demoPeerPanel(closedWeek), [closedWeek]);
  const result = useMemo(() => {
    const you = siteWeek(state, siteId, closedWeek, asOf, CLIENT_KEY);
    const cohort = you && chooseCohort(you.contribution, panel);
    return { you, cohort, rows: you && cohort ? compare(you, cohort) : [] };
  }, [state, siteId, closedWeek, asOf, panel]);
  const group = useMemo(
    () =>
      state.sites.map((site) => {
        const w = siteWeek(state, site.id, closedWeek, asOf, CLIENT_KEY);
        const c = w && chooseCohort(w.contribution, panel);
        return { site, rows: w && c ? compare(w, c) : [] };
      }),
    [state, closedWeek, asOf, panel],
  );

  const { you, cohort, rows } = result;
  if (!you) return <p className="muted">No fully traded week with clocked hours to benchmark yet.</p>;
  if (!cohort) {
    return (
      <p className="muted">
        Not enough peers yet. A comparison is only shown against at least {MIN_PEER_SITES} sites from {MIN_PEER_CLIENTS} separate
        businesses, so no one business can be picked out.
      </p>
    );
  }

  const ranked = rows.filter((r) => r.betterThan !== null);
  const strongest = [...ranked].sort((a, b) => b.betterThan! - a.betterThan!)[0];
  const weakest = [...ranked].sort((a, b) => a.betterThan! - b.betterThan!)[0];
  const labour = rows.find((r) => r.metric.id === 'labourPct')!;

  return (
    <div className="bench">
      <div className="notice small">
        Illustrative peer panel. The method is the product: reconciled clocked data, peers matched on concept, region and
        size, and no group shown below {MIN_PEER_SITES} sites from {MIN_PEER_CLIENTS} businesses. The peers themselves are
        invented until WS clients contribute. Do not quote these figures to a client as market data.
      </div>

      <p className="muted intro">
        Week commencing {dayLabel(closedWeek).date}, against {cohort.label}: {cohort.peers.length} sites from {cohort.clients}{' '}
        businesses.
        {cohort.level > 0 && ' Widened from a closer match to keep every business in the group anonymous.'}
      </p>

      <section className="kpis">
        <Kpi
          label="Labour % position"
          value={labour.betterThan === null ? 'n/a' : `Top ${Math.max(1, Math.round((1 - labour.betterThan) * 100))}%`}
          hint={`${show(labour.metric, labour.you)} against a median of ${show(labour.metric, labour.median)}`}
          tone={standing(labour)}
        />
        <Kpi
          label="To the median"
          value={`${money(labour.valueAtMedian ?? 0)}/wk`}
          hint={(labour.valueAtMedian ?? 0) > 0 ? 'Labour saving at median labour %' : 'Already at or better than median'}
          tone={(labour.valueAtMedian ?? 0) > 0 ? 'warn' : 'good'}
        />
        <Kpi
          label="To the top quartile"
          value={`${money(labour.valueAtTopQuartile ?? 0)}/wk`}
          hint={`${money((labour.valueAtTopQuartile ?? 0) * 52)} a year`}
          tone={(labour.valueAtTopQuartile ?? 0) > 0 ? 'warn' : 'good'}
        />
        <Kpi label="Strongest" value={strongest?.metric.label ?? 'n/a'} hint={strongest ? `Better than ${pct(strongest.betterThan!, 0)} of peers` : ''} tone="good" />
        <Kpi label="Weakest" value={weakest?.metric.label ?? 'n/a'} hint={weakest ? `Better than ${pct(weakest.betterThan!, 0)} of peers` : ''} tone={standing(weakest)} />
        <Kpi label="Peer group" value={`${cohort.peers.length} sites`} hint={`${cohort.clients} businesses`} />
      </section>

      <div className="grid-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Metric</th>
              <th className="num">This site</th>
              <th className="range-head">Peers: middle half and median</th>
              <th className="num">Median</th>
              <th className="num">Top quartile</th>
              <th className="num">Better than</th>
              <th className="num">To median</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.metric.id}>
                <td>
                  {r.metric.label}
                  <div className="muted small">{r.metric.meaning}</div>
                </td>
                <td className={`num strong ${standing(r) ? `${standing(r)}-text` : ''}`}>{show(r.metric, r.you)}</td>
                <td>{r.suppressed ? <span className="muted small">Too few peers</span> : <RangeBar r={r} />}</td>
                <td className="num">{r.suppressed ? '' : show(r.metric, r.median)}</td>
                <td className="num">{r.suppressed || r.metric.better === 'context' ? '' : show(r.metric, r.metric.better === 'lower' ? r.p25 : r.p75)}</td>
                <td className="num">{r.betterThan === null ? (r.metric.better === 'context' ? 'Context' : '') : pct(r.betterThan, 0)}</td>
                <td className="num">{r.valueAtMedian ? `${money(r.valueAtMedian)}/wk` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted">
        Pounds are shown only where the metric is a cost the site controls directly. They overlap, since overruns are part
        of labour %, so they are not added up. Hours on flexible contracts is context, not a ranking: it says how much of the
        labour line the Employment Rights Act will touch.
      </p>

      <div className="bench-grid">
        <div className="panel">
          <h3>Across your sites</h3>
          <div className="grid-wrap flat">
            <table className="table">
              <thead>
                <tr>
                  <th>Better than peers on</th>
                  {group.map((g) => (
                    <th key={g.site.id} className="num">{g.site.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows
                  .filter((r) => r.metric.better !== 'context')
                  .map((r) => (
                    <tr key={r.metric.id}>
                      <td>{r.metric.label}</td>
                      {group.map((g) => {
                        const x = g.rows.find((y) => y.metric.id === r.metric.id);
                        return (
                          <td key={g.site.id} className={`num ${x ? `${standing(x)}-text` : ''}`}>
                            {x?.betterThan == null ? 'n/a' : pct(x.betterThan, 0)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <p className="small muted">
            Where one site is strong and another weak on the same metric, the fix is inside the group: the better GM's
            habits, not a consultant.
          </p>
        </div>

        <div className="panel">
          <h3>What leaves this site</h3>
          <dl className="facts">
            <dt>Site</dt>
            <dd><code>{you.contribution.siteKey}</code></dd>
            <dt>Business</dt>
            <dd><code>{you.contribution.clientKey}</code></dd>
            <dt>Profile</dt>
            <dd>
              {you.contribution.region} {you.contribution.concept}, {you.contribution.sizeBand} a week
            </dd>
            {rows.map((r) => (
              <FactRow key={r.metric.id} label={r.metric.label} value={show(r.metric, r.you)} />
            ))}
          </dl>
          <p className="small muted">
            That is all. No names, no people, no pay rates, no site or business name: an opaque key, a profile, and {rows.length}{' '}
            measures for a week that has fully traded. Sales band rather than sales. Nothing leaves until the client has signed
            the data sharing terms.
          </p>
        </div>
      </div>
    </div>
  );
}

function FactRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

/** The peers' middle half as a band, their median as a line, this site as a dot. */
function RangeBar({ r }: { r: MetricComparison }) {
  const you = r.you ?? r.median;
  const lo = Math.min(r.p25, you) * 0.85;
  const hi = Math.max(r.p75, you) * 1.15 || 1;
  const at = (v: number) => `${((v - lo) / (hi - lo)) * 100}%`;
  return (
    <div className="range" aria-label={`Peers ${r.p25.toFixed(3)} to ${r.p75.toFixed(3)}, this site ${you.toFixed(3)}`}>
      <span className="band" style={{ left: at(r.p25), width: `calc(${at(r.p75)} - ${at(r.p25)})` }} />
      <span className="median" style={{ left: at(r.median) }} />
      <span className={`dot ${standing(r)}`} style={{ left: at(you) }} />
    </div>
  );
}
