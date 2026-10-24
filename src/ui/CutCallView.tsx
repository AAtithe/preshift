import { useMemo, useState } from 'react';
import { cutCall, type ShortHour } from '../engine/cutcall';
import { ERA_ASSUMPTIONS } from '../engine/era';
import { formatMinute, weekStart } from '../engine/time';
import type { RotaState, Shift, Site } from '../engine/types';
import { dayLabel, money, pct } from './format';
import { Kpi } from './Kpi';
import { useTimeEntries } from './useTimeEntries';

interface Props {
  state: RotaState;
  site: Site;
  today: string;
  /** Minutes past midnight in London, now. */
  now: number;
  /** Saves a shortened shift through the same route as any rota edit; absent for those who cannot edit the rota. */
  onApply?: (shift: Shift) => Promise<unknown>;
}

/**
 * The afternoon call every GM makes on instinct, made on numbers: trading so far against forecast,
 * the rest of the day reforecast at that pace, and who to send home, dearest saving first.
 */
export function CutCallView({ state, site, today, now, onApply }: Props) {
  const [priceEra, setPriceEra] = useState(false);
  // The week so far, so each saving is worked on the person's whole week, after guaranteed hours.
  const { entries, error } = useTimeEntries(site.id, weekStart(today), today);
  const call = useMemo(
    () => (entries ? cutCall(state, entries, site.id, today, now, priceEra ? { era: ERA_ASSUMPTIONS } : {}) : null),
    [state, entries, site.id, today, now, priceEra],
  );
  const name = (id: string) => state.employees.find((e) => e.id === id)?.name ?? id;
  const roleName = (id: string) => state.roles.find((r) => r.id === id)?.name ?? id;

  if (error) return <p className="muted">{error}</p>;
  if (!call) return <p className="muted">Loading the week's clocked hours.</p>;

  async function apply(shiftId: string, endMinute: number, breakMinutes: number) {
    const shift = state.shifts.find((s) => s.id === shiftId);
    if (shift && onApply) await onApply({ ...shift, endMinute, breakMinutes });
  }

  return (
    <div className="cut-call">
      <p className="muted intro">
        {site.name}, {dayLabel(today).short} {dayLabel(today).date}, as at {formatMinute(now)}. Savings are worked on each person's
        whole week, after guaranteed hours and the NI and pension thresholds, so they are what payroll will actually not pay.
      </p>

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

      <div className="panel">
        <div className="panel-head">
          <div className="panel-title">The cut call</div>
          <label className="small">
            <input type="checkbox" checked={priceEra} onChange={(e) => setPriceEra(e.target.checked)} /> Price Employment Rights Act
            compensation (assumed)
          </label>
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
                        {(r.minutesSaved / 60).toFixed(1)}h saved{r.compensation > 0 ? `, less ${money(r.compensation)} compensation` : ''}.
                      </div>
                    </td>
                    <td className="num good-text">{money(r.saving)}</td>
                    <td className="num">
                      {onApply && <button onClick={() => void apply(r.shiftId, r.newEnd, r.newBreakMinutes)}>Apply</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {call.keptAtNoCost.length > 0 && (
            <p className="small muted">
              Kept on: {call.keptAtNoCost.map(name).join(', ')}.{' '}
              {priceEra ? 'Compensation for the short-notice cut would cancel the saving.' : 'Still inside guaranteed hours, so an early finish saves nothing.'}
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
