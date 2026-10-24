import { useEffect, useState } from 'react';
import { DEFAULT_THRESHOLDS as T, type LeagueRow, type Scorecard, type WeekScore } from '../engine/scorecard';
import type { RotaState } from '../engine/types';
import { api, ApiError } from './api';
import { dayLabel, download, money, pct, slug, toCsv as csv } from './format';

interface Props {
  state: RotaState;
  siteIds: string[];
  week: string;
  scopeName: string;
}

interface Scorecards {
  league: LeagueRow[];
  cards: Scorecard[];
}

const RUNGS = ['Not yet on the ladder', 'Rota on time and legal', 'Labour on target', 'Daypart precision', 'Owns the forecast'];

/** The habits behind the rungs, week by week: each is a pass, a miss, or not yet measurable. */
const HABITS: { label: string; mark: (w: WeekScore) => boolean | null }[] = [
  { label: `Published ${T.noticeDays}+ days ahead`, mark: (w) => (w.rosteredHours > 0 || w.publishedAt ? w.publishedOnTime : null) },
  { label: 'Nothing blocking', mark: (w) => (w.rosteredHours > 0 ? w.legal : null) },
  { label: 'Labour on target', mark: (w) => (w.plannedLabourPct > 0 || w.actualLabourPct !== null ? w.onTarget : null) },
  { label: `Hours over demand ${pct(T.overstaffedShare, 0)} or less`, mark: (w) => (w.rosteredHours > 0 ? w.overstaffedShare <= T.overstaffedShare : null) },
  { label: `Forecast error ${pct(T.forecastWape, 0)} or less`, mark: (w) => (w.forecastWape === null ? null : w.forecastWape <= T.forecastWape) },
];

const problem = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));
const blank = <span className="muted">-</span>;

/**
 * The GM scorecard for every site in scope, side by side. The Coach screen shows one site's card to
 * its own manager; this is the view an operations director or the WS partner runs the estate from:
 * who is on which rung, which habit is holding each site back, and the one thing each GM works on next.
 */
export function ScorecardsReport({ state, siteIds, week, scopeName }: Props) {
  const [weeks, setWeeks] = useState(4);
  const [data, setData] = useState<Scorecards | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    api
      .get<Scorecards>(`/v1/scorecards?weeks=${weeks}&endWeek=${week}`)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(problem(e)));
    return () => { live = false; };
  }, [weeks, week]);

  if (error) return <div className="notice">{error}</div>;
  if (!data) return <p className="muted">Loading</p>;

  const inScope = new Set(siteIds);
  const league = data.league.filter((r) => inScope.has(r.siteId)).map((r, i) => ({ ...r, rank: i + 1 }));
  const cardOf = (siteId: string) => data.cards.find((c) => c.siteId === siteId)!;
  const siteName = (id: string) => state.sites.find((s) => s.id === id)?.name ?? id;
  if (league.length === 0) return <p className="muted">No sites here that you can see labour costs for.</p>;

  const scoredWeeks = cardOf(league[0].siteId).weeks.map((w) => w.weekStart);
  const from = dayLabel(scoredWeeks[0]).date;
  const to = dayLabel(scoredWeeks.at(-1)!).date;
  // The rung most sites are stuck below is the estate's coaching priority.
  const byRung = RUNGS.map((_, level) => league.filter((r) => r.level === level).length);
  const stuck = byRung.slice(0, 4).reduce((best, n, level) => (n > byRung[best] ? level : best), 0);

  function exportCsv() {
    const header = ['Rank', 'Site', 'Rung', 'Rung name', 'Weeks scored', 'On time and legal %', 'Nothing blocking %', 'On target %', 'Labour %', 'Target %', 'Hours over demand %', 'Clock vs rota %', 'Forecast error %', 'Moves taken %', 'Realised saving', 'Next step'];
    const p = (n: number | null) => (n === null ? '' : n * 100);
    const rows = league.map((r) => [r.rank, siteName(r.siteId), r.level, r.label, r.scoredWeeks, p(r.onTimeRate), p(r.legalRate), p(r.onTargetRate), p(r.labourPct), p(r.targetPct), p(r.overstaffedShare), p(r.rotaToPayrollVariance), p(r.forecastWape), p(r.movesTakenRate), r.realisedSaving, r.next]);
    download(`preshift-scorecards-${slug(scopeName)}-${scoredWeeks.at(-1)}.csv`, csv([header, ...rows]));
  }

  return (
    <>
      <div className="close-actions report-actions">
        <select value={weeks} onChange={(e) => setWeeks(Number(e.target.value))} aria-label="Weeks">
          <option value={4}>Last 4 weeks</option>
          <option value={8}>Last 8 weeks</option>
          <option value={13}>Last 13 weeks (a quarter)</option>
        </select>
        <span className="muted small">
          Finished weeks, w/c {from} to w/c {to}. The rung is judged on the last four of them.
        </span>
        <button onClick={exportCsv}>Download CSV</button>
      </div>

      {league.length > 1 && (
        <div className="notice">
          {byRung.map((n, level) => (n ? `${n} on rung ${level}` : '')).filter(Boolean).join(', ')}.{' '}
          {byRung[4] === league.length
            ? 'Every site holds every rung. Keep the habits and use the strongest GMs to coach the next ones.'
            : `The most common gap is rung ${stuck + 1}, ${RUNGS[stuck + 1].toLowerCase()}. Coach that habit across the group before anything else: it is the one holding most sites back.`}
        </div>
      )}

      <div className="grid-wrap report-block">
        <table className="table">
          <thead>
            <tr>
              <th className="num">#</th>
              <th>Site</th>
              <th>Rung</th>
              <th className="num">On time and legal</th>
              <th className="num">On target</th>
              <th className="num">Labour</th>
              <th className="num">Target</th>
              <th className="num">Over demand</th>
              <th className="num">Clock vs rota</th>
              <th className="num">Forecast error</th>
              <th className="num">Moves taken</th>
              <th className="num">Saved</th>
            </tr>
          </thead>
          <tbody>
            {league.map((r) => {
              // Inside the band is on target. Well under it is not a win: the floor was short or the forecast was wrong.
              const gap = r.labourPct === null || r.targetPct === null ? null : r.labourPct - r.targetPct;
              const labourTone = gap === null ? '' : gap > T.targetBand ? 'bad-text' : gap < -T.targetBand ? 'warn-text' : 'good-text';
              return (
                <tr key={r.siteId}>
                  <td className="num">{r.rank}</td>
                  <td>
                    {siteName(r.siteId)}
                    {r.scoredWeeks < weeks && <span className="tag" title="Weeks with a rota or a publish; weeks that did not trade are left out">{r.scoredWeeks} of {weeks} weeks</span>}
                  </td>
                  <td>
                    <span className={`pill ${r.level >= 3 ? 'tone-good' : r.level >= 1 ? 'tone-warn' : 'tone-bad'}`}>{r.level} of 4</span>
                  </td>
                  <td className={`num ${r.scoredWeeks ? (r.onTimeRate >= 0.75 ? 'good-text' : 'bad-text') : ''}`}>{r.scoredWeeks ? pct(r.onTimeRate, 0) : blank}</td>
                  <td className={`num ${r.scoredWeeks ? (r.onTargetRate >= 0.75 ? 'good-text' : 'bad-text') : ''}`}>{r.scoredWeeks ? pct(r.onTargetRate, 0) : blank}</td>
                  <td className={`num ${labourTone}`}>{r.labourPct === null ? blank : pct(r.labourPct)}</td>
                  <td className="num muted">{r.targetPct === null ? blank : pct(r.targetPct)}</td>
                  <td className={`num ${r.overstaffedShare === null ? '' : r.overstaffedShare > T.overstaffedShare ? 'bad-text' : 'good-text'}`}>{r.overstaffedShare === null ? blank : pct(r.overstaffedShare)}</td>
                  <td className="num">{r.rotaToPayrollVariance === null ? <span className="muted">Pending</span> : pct(r.rotaToPayrollVariance)}</td>
                  <td className={`num ${r.forecastWape === null ? '' : r.forecastWape > T.forecastWape ? 'bad-text' : 'good-text'}`}>{r.forecastWape === null ? <span className="muted">No till data</span> : pct(r.forecastWape)}</td>
                  <td className="num">{r.movesTakenRate === null ? <span className="muted">None offered</span> : pct(r.movesTakenRate, 0)}</td>
                  <td className="num">{r.realisedSaving ? money(r.realisedSaving) : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {league.map((r) => (
        <SiteCard key={r.siteId} row={r} card={cardOf(r.siteId)} name={siteName(r.siteId)} />
      ))}
    </>
  );
}

function SiteCard({ row, card, name }: { row: LeagueRow; card: Scorecard; name: string }) {
  const m = card.maturity;
  return (
    <section className="settings-card report-block scorecard-site">
      <div className="entity-journal-head">
        <h3>
          {row.rank}. {name}
        </h3>
        <span className="muted small">
          Rung {m.level} of 4: {m.label.toLowerCase()}
        </span>
      </div>
      <ol className="ladder">
        {m.rungs.map((r) => (
          <li key={r.level} className={r.met ? 'met' : r.level === m.level + 1 ? 'next' : ''}>
            <span className="step-n">{r.level}</span>
            <div>
              <strong>{r.label}</strong>
              <div className="muted small">{r.detail}</div>
            </div>
          </li>
        ))}
      </ol>
      <div className="grid-wrap">
        <table className="table scorecard-habits">
          <thead>
            <tr>
              <th>Habit</th>
              {card.weeks.map((w) => (
                <th key={w.weekStart} className="num">
                  {dayLabel(w.weekStart).date}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {HABITS.map((h) => (
              <tr key={h.label}>
                <td>{h.label}</td>
                {card.weeks.map((w) => {
                  const pass = h.mark(w);
                  return (
                    <td key={w.weekStart} className={`num ${pass === null ? 'muted' : pass ? 'good-text' : 'bad-text'}`}>
                      {pass === null ? '-' : pass ? 'Yes' : 'No'}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="notice insight-next">
        <strong>Next step.</strong> {m.next}
      </div>
    </section>
  );
}
