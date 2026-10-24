import { useCallback, useEffect, useState } from 'react';
import type { CutCall, ShortHour } from '../engine/cutcall';
import type { IntradayFlash } from '../engine/labourFlash';
import { formatMinute } from '../engine/time';
import type { RotaState, Site } from '../engine/types';
import { api } from './api';
import { dayLabel, money, pct } from './format';
import { Kpi } from './Kpi';

interface Props {
  state: RotaState;
  site: Site;
  /** Whether the reader can edit the rota, and so apply early finishes. */
  canApply: boolean;
  /** Reloads the rota after early finishes are applied. */
  onApplied: () => void;
}

const REFRESH_MS = 2 * 60 * 1000;

/**
 * The afternoon call every GM makes on instinct, made on numbers: trading so far against forecast,
 * the rest of the day reforecast at that pace, labour so far and by close, and who to send home,
 * dearest saving first. Worked out on the server, so it is the same call the alert email makes,
 * priced with the organisation's Employment Rights Act settings.
 */
export function CutCallView({ state, site, canApply, onApplied }: Props) {
  const [data, setData] = useState<{ date: string; call: CutCall; flash: IntradayFlash } | null>(null);
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const name = (id: string) => state.employees.find((e) => e.id === id)?.name ?? id;
  const roleName = (id: string) => state.roles.find((r) => r.id === id)?.name ?? id;

  const load = useCallback(async () => {
    try {
      setData(await api.get(`/v1/cut-call?siteId=${encodeURIComponent(site.id)}`));
    } catch (e) {
      setMessage({ text: (e as Error).message, bad: true });
    }
  }, [site.id]);
  useEffect(() => {
    void load();
    // Trading moves through service: the call refreshes on its own while the screen is open.
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  if (!data) return <p className="muted">{message?.text ?? "Loading today's trading."}</p>;
  const { call, flash } = data;

  async function apply(recs: CutCall['recommendations']) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await api.post<{ told: number }>('/v1/cut-call/apply', {
        siteId: site.id,
        cuts: recs.map((r) => ({ shiftId: r.shiftId, endMinute: r.newEnd, breakMinutes: r.newBreakMinutes })),
      });
      setMessage({ text: `${recs.length === 1 ? 'Early finish applied' : `${recs.length} early finishes applied`}. ${res.told ? `${res.told} told on their phone now.` : ''}` });
      onApplied();
      await load();
    } catch (e) {
      setMessage({ text: (e as Error).message, bad: true });
    }
    setBusy(false);
  }

  const owedNote = (r: CutCall['recommendations'][number]) =>
    r.compensation > 0 ? `, less ${money(r.compensation)} short notice pay` : r.wouldOwe ? `. Would owe ${money(r.wouldOwe)} short notice pay once the Employment Rights Act measure starts` : '';
  const tone = (p: number | null) => (p === null ? '' : p > flash.targetPct ? 'warn' : 'good');

  return (
    <div className="cut-call">
      <p className="muted intro">
        {site.name}, {dayLabel(data.date).short} {dayLabel(data.date).date}, as at {formatMinute(call.now)}. Savings are worked on each person's
        whole week, after guaranteed hours and the NI and pension thresholds, so they are what payroll will actually not pay. Refreshes every two minutes.
      </p>
      {message && <p className={`notice${message.bad ? ' error' : ' good'}`}>{message.text}</p>}

      <section className="kpis">
        <Kpi label="Sales so far" value={money(call.salesSoFar)} hint={`Forecast ${money(call.forecastSoFar)}`} />
        <Kpi
          label="Trading pace"
          value={call.confident ? pct(call.pace, 0) : 'n/a'}
          hint={call.confident ? 'Of forecast, hours traded' : 'Not enough to call'}
          tone={!call.confident ? '' : call.pace < 0.95 ? 'warn' : 'good'}
        />
        <Kpi label="Reforecast day" value={money(call.reforecastDay)} hint={`Forecast ${money(call.forecastDay)}`} />
        <Kpi
          label="Saving available"
          value={money(call.totalSaving)}
          hint={call.recommendations.length ? `${call.recommendations.length} early finish${call.recommendations.length > 1 ? 'es' : ''}` : 'Nothing to cut'}
          tone={call.totalSaving > 0 ? 'good' : ''}
        />
      </section>

      <section className="kpis">
        <Kpi label="Labour so far" value={flash.labourPctNow === null ? 'n/a' : pct(flash.labourPctNow)} hint={`${money(flash.labourSoFar)}, ${flash.onShift} clocked in`} tone={tone(flash.labourPctNow)} />
        <Kpi label="Labour by close" value={flash.labourPctDay === null ? 'n/a' : pct(flash.labourPctDay)} hint={`${money(flash.labourDay)} on the reforecast`} tone={tone(flash.labourPctDay)} />
        <Kpi
          label="With the cuts"
          value={flash.labourPctAfterCuts === null ? 'n/a' : pct(flash.labourPctAfterCuts)}
          hint={`Target ${pct(flash.targetPct, 0)}`}
          tone={tone(flash.labourPctAfterCuts)}
        />
        <Kpi
          label={flash.headroom >= 0 ? 'Headroom' : 'Over target'}
          value={money(Math.abs(flash.headroom))}
          hint="Labour against target on the reforecast"
          tone={flash.headroom >= 0 ? 'good' : 'warn'}
        />
      </section>

      <div className="panel">
        <div className="panel-head">
          <div className="panel-title">The cut call</div>
          {canApply && call.recommendations.length > 1 && (
            <button className="primary" disabled={busy} onClick={() => void apply(call.recommendations)}>
              Apply all, save {money(call.totalSaving)}
            </button>
          )}
        </div>
        <div className="panel-body">
          {!call.confident ? (
            <p className="muted">{call.reason}</p>
          ) : call.recommendations.length === 0 ? (
            <p className="muted">
              {call.pace >= 1
                ? 'Trading at or ahead of forecast. Keep everyone.'
                : 'Every remaining hour still needs the people rostered. The rota is already as lean as the reforecast allows.'}
            </p>
          ) : (
            <table className="table">
              <tbody>
                {call.recommendations.map((r) => (
                  <tr key={r.shiftId}>
                    <td>
                      <b>{name(r.employeeId)}</b> <span className="muted">{roleName(r.roleId)}</span>
                      <div className="small">
                        {r.standDown ? `Stand down before the ${formatMinute(r.newEnd)} start.` : `Finish at ${formatMinute(r.newEnd)}, not ${formatMinute(r.currentEnd)}.`}{' '}
                        {(r.minutesSaved / 60).toFixed(1)}h saved{owedNote(r)}.
                      </div>
                    </td>
                    <td className="num good-text">{money(r.saving)}</td>
                    <td className="num">{canApply && <button disabled={busy} onClick={() => void apply([r])}>Apply</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {call.keptAtNoCost.length > 0 && (
            <p className="small muted">
              Kept on: {call.keptAtNoCost.map(name).join(', ')}. An early finish saves nothing: they are inside guaranteed hours, or short notice pay would cancel the saving.
            </p>
          )}
          {call.short.length > 0 && (
            <div className="notice small">
              Short on the reforecast: {groupShort(call.short).map((g) => `${roleName(g.roleId)} ${formatMinute(g.from * 60)} to ${formatMinute(g.to * 60)}`).join('; ')}.
              Move someone across or call someone in.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function groupShort(short: ShortHour[]) {
  const out: { roleId: string; from: number; to: number }[] = [];
  for (const s of [...short].sort((a, b) => a.roleId.localeCompare(b.roleId) || a.hour - b.hour)) {
    const last = out[out.length - 1];
    if (last && last.roleId === s.roleId && last.to === s.hour) last.to = s.hour + 1;
    else out.push({ roleId: s.roleId, from: s.hour, to: s.hour + 1 });
  }
  return out;
}
