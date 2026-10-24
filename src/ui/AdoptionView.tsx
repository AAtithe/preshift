import { useEffect, useState } from 'react';
import type { SiteAdoption } from '../engine/adoption';
import type { RotaState } from '../engine/types';
import { api } from './api';

interface Adoption {
  weeks: number;
  from: string;
  to: string;
  targets: { onAppPct: number; pushPct: number; decisionHours: number; fillPct: number; noShowPct: number };
  sites: SiteAdoption[];
  total: { team: number; onApp: number; withPush: number; decided: number; waiting: number; openShiftsPosted: number; openShiftsFilled: number; noShows: number | null; shiftsChecked: number };
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : null);
const date = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const hours = (h: number | null) => (h === null ? 'None' : h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${h} h` : `${Math.round(h / 24)} days`);

/**
 * Whether the staff app is working at each site: who is on it, who will hear about a change, how
 * fast their requests are answered, how cover is found and how many shifts nobody turned up for.
 * The point is the GM's habits, not the software: every red cell is a conversation with a GM.
 */
export function AdoptionView({ state, siteIds }: { state: RotaState; siteIds: string[] }) {
  const [data, setData] = useState<Adoption | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [weeks, setWeeks] = useState(4);
  useEffect(() => {
    api.get<Adoption>(`/v1/insights/adoption?weeks=${weeks}`).then(setData).catch((e) => setError((e as Error).message));
  }, [weeks]);
  if (error) return <p className="notice error">{error}</p>;
  if (!data) return <p className="muted">Loading</p>;

  const t = data.targets;
  const rows = data.sites.filter((s) => siteIds.includes(s.siteId));
  const sum = (f: (s: SiteAdoption) => number) => rows.reduce((n, s) => n + f(s), 0);
  const team = sum((s) => s.team);
  const onApp = sum((s) => s.onApp);
  const withPush = sum((s) => s.withPush);
  const posted = sum((s) => s.openShiftsPosted);
  const filled = sum((s) => s.openShiftsFilled);
  const waiting = sum((s) => s.waiting);
  const clocking = rows.filter((s) => s.noShows !== null);
  const noShows = clocking.reduce((n, s) => n + (s.noShows ?? 0), 0);
  const checked = clocking.reduce((n, s) => n + s.shiftsChecked, 0);
  const tone = (good: boolean | null) => (good === null ? '' : good ? 'good' : 'warn');
  const cell = (good: boolean | null) => (good === null ? 'muted' : good ? 'good-text' : 'bad-text');
  const siteName = (id: string) => state.sites.find((x) => x.id === id)?.name ?? id;

  return (
    <div>
      <div className="kpis people-kpis">
        <div className={`kpi ${tone(team ? (pct(onApp, team) ?? 0) >= t.onAppPct : null)}`}>
          <div className="kpi-label">On the staff app</div>
          <div className="kpi-value">{pct(onApp, team) ?? 0}%</div>
          <div className="kpi-hint">{onApp} of {team} people. Aim for {t.onAppPct}%</div>
        </div>
        <div className={`kpi ${tone(team ? (pct(withPush, team) ?? 0) >= t.pushPct : null)}`}>
          <div className="kpi-label">Notifications on</div>
          <div className="kpi-value">{pct(withPush, team) ?? 0}%</div>
          <div className="kpi-hint">Hear about a change when it happens. Aim for {t.pushPct}%</div>
        </div>
        <div className={`kpi ${tone(waiting === 0)}`}>
          <div className="kpi-label">Requests waiting now</div>
          <div className="kpi-value">{waiting}</div>
          <div className="kpi-hint">Decide them the same day</div>
        </div>
        <div className={`kpi ${tone(posted ? (pct(filled, posted) ?? 0) >= t.fillPct : null)}`}>
          <div className="kpi-label">Open shifts filled</div>
          <div className="kpi-value">{posted ? `${pct(filled, posted)}%` : 'None'}</div>
          <div className="kpi-hint">{filled} of {posted} posted</div>
        </div>
        <div className={`kpi ${tone(checked ? (pct(noShows, checked) ?? 0) <= t.noShowPct : null)}`}>
          <div className="kpi-label">No-shows</div>
          <div className="kpi-value">{checked ? noShows : 'None'}</div>
          <div className="kpi-hint">{checked ? `${((noShows / checked) * 100).toFixed(1)}% of ${checked} shifts` : 'Only where people clock in'}</div>
        </div>
      </div>

      <div className="people-bar">
        <p className="muted small">
          {date(data.from)} to {date(data.to)}. Red is below target. Every red cell is a conversation with that site's GM about how
          they run their team, not about the software.
        </p>
        <label className="muted small">
          Over{' '}
          <select value={weeks} onChange={(e) => setWeeks(Number(e.target.value))}>
            {[1, 2, 4, 8, 13].map((w) => <option key={w} value={w}>{w} week{w === 1 ? '' : 's'}</option>)}
          </select>
        </label>
      </div>

      <div className="grid-wrap">
        <table className="table people">
          <thead>
            <tr>
              <th>Site</th>
              <th className="num">On the app</th>
              <th className="num">Notifications on</th>
              <th className="num">Decided in a day</th>
              <th className="num">Median to decide</th>
              <th className="num">Waiting now</th>
              <th className="num">Open shifts filled</th>
              <th className="num">Median to fill</th>
              <th className="num">No-shows</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={9} className="muted">No sites you run in this view.</td></tr>}
            {rows.map((s) => {
              const app = pct(s.onApp, s.team);
              const push = pct(s.withPush, s.team);
              const fill = pct(s.openShiftsFilled, s.openShiftsPosted);
              const ns = s.noShows === null ? null : pct(s.noShows, s.shiftsChecked);
              return (
                <tr key={s.siteId}>
                  <td>
                    <span className="strong">{siteName(s.siteId)}</span>
                    {(s.notOnApp?.length || s.noNotifications?.length) ? (
                      <details className="small">
                        <summary className="muted">Who to chase</summary>
                        {s.notOnApp?.length ? <div>Not on the app: {s.notOnApp.join(', ')}</div> : null}
                        {s.noNotifications?.length ? <div>Notifications off: {s.noNotifications.join(', ')}</div> : null}
                      </details>
                    ) : null}
                  </td>
                  <td className={`num ${cell(app === null ? null : app >= t.onAppPct)}`}>{app ?? 0}%<div className="muted small">{s.onApp} of {s.team}</div></td>
                  <td className={`num ${cell(push === null ? null : push >= t.pushPct)}`}>{push ?? 0}%</td>
                  <td className={`num ${cell(s.decidedInADayPct === null ? null : s.decidedInADayPct >= 90)}`}>{s.decidedInADayPct === null ? 'None' : `${s.decidedInADayPct}%`}<div className="muted small">{s.decided} decided</div></td>
                  <td className={`num ${cell(s.medianDecisionHours === null ? null : s.medianDecisionHours <= t.decisionHours)}`}>{hours(s.medianDecisionHours)}{s.slowestDecisionHours !== null && <div className="muted small">slowest {hours(s.slowestDecisionHours)}</div>}</td>
                  <td className={`num ${cell(s.waiting === 0 ? true : (s.oldestWaitingHours ?? 0) <= t.decisionHours)}`}>{s.waiting}{s.oldestWaitingHours !== null && <div className="muted small">oldest {hours(s.oldestWaitingHours)}</div>}</td>
                  <td className={`num ${cell(fill === null ? null : fill >= t.fillPct)}`}>{fill === null ? 'None' : `${fill}%`}<div className="muted small">{s.openShiftsFilled} of {s.openShiftsPosted}</div></td>
                  <td className="num">{hours(s.medianFillHours)}</td>
                  <td className={`num ${cell(ns === null ? null : ns <= t.noShowPct)}`}>{s.noShows === null ? <span className="muted small">Not clocking</span> : <>{s.noShows}<div className="muted small">of {s.shiftsChecked}</div></>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        On the app: people based at the site with a staff app login they have set up. Notifications on: on at least one phone.
        Decided in a day: holiday, time off, availability, swaps once the colleague agreed, and open shift claims, answered within 24
        hours. No-shows: published shifts with nothing clocked, leaving out leave and sickness, at sites where people clock in.
      </p>
    </div>
  );
}
