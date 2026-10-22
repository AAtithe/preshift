import { useMemo, useState } from 'react';
import { liveBoard, type LiveStatus } from '../engine/actuals';
import { checkClockIn } from '../engine/clocking';
import { cutCall, type ShortHour } from '../engine/cutcall';
import { ERA_ASSUMPTIONS } from '../engine/era';
import { formatMinute, parseClock } from '../engine/time';
import type { GeoPoint, RotaState } from '../engine/types';
import type { Command } from '../shared/commands';
import { dayLabel, money, pct } from './format';
import { Kpi } from './KpiBar';

interface Props {
  state: RotaState;
  siteId: string;
  today: string;
  initialMinute: number;
  run: (cmd: Command) => Promise<boolean>;
  /** Whether this person runs the floor: the cut call and clocking other people in. */
  canManage: boolean;
}

type Where = 'on-site' | 'away' | 'manager';

const STATUS_LABEL: Record<LiveStatus, string> = { due: 'Due', late: 'Late', on: 'On shift', done: 'Finished', missed: 'No-show' };
const STATUS_TONE: Record<LiveStatus, string> = { due: '', late: 'warn', on: 'good', done: '', missed: 'bad' };

export function LiveView({ state, siteId, today, initialMinute, run, canManage }: Props) {
  const [now, setNow] = useState(initialMinute);
  const [where, setWhere] = useState<Where>('on-site');
  const [message, setMessage] = useState<{ tone: 'bad' | 'warn'; text: string } | null>(null);
  const [walkIn, setWalkIn] = useState('');
  const [priceEra, setPriceEra] = useState(false);

  const site = state.sites.find((s) => s.id === siteId)!;
  const call = useMemo(
    () => cutCall(state, siteId, today, now, priceEra ? { era: ERA_ASSUMPTIONS } : {}),
    [state, siteId, today, now, priceEra],
  );
  const board = useMemo(() => liveBoard(state, siteId, today, now), [state, siteId, today, now]);
  const name = (id: string) => state.employees.find((e) => e.id === id)?.name ?? id;
  const roleName = (id: string) => state.roles.find((r) => r.id === id)?.name ?? id;
  const onBoard = new Set(board.map((r) => r.employeeId));

  function position(): GeoPoint | undefined {
    if (where === 'manager' || !site.location) return undefined;
    // "Away" puts the phone about 600m north of the site.
    return where === 'away' ? { lat: site.location.lat + 0.0055, lng: site.location.lng } : site.location;
  }

  async function clockIn(employeeId: string) {
    // The same check the server makes, so the reason shows before anything is sent.
    const check = checkClockIn(state, employeeId, siteId, today, now, position());
    if (!check.ok) {
      setMessage({ tone: 'bad', text: `${name(employeeId)}: ${check.reason}` });
      return;
    }
    if (!(await run({ type: 'clockIn', employeeId, siteId, position: position(), demoAt: { date: today, minute: now } }))) return;
    setMessage(check.warnings.length ? { tone: 'warn', text: `${name(employeeId)}: ${check.warnings.join(' ')}` } : null);
  }

  async function clockOut(clockId: string, breakMinutes: number) {
    if (await run({ type: 'clockOut', id: clockId, breakMinutes, demoAt: { date: today, minute: now } })) setMessage(null);
  }

  const tradedShare = call.forecastDay > 0 ? call.forecastSoFar / call.forecastDay : 0;
  const forecastToDate = call.forecastSoFar;

  return (
    <div className="live">
      <div className="live-head">
        <h2>
          {site.name} today, {dayLabel(today).short} {dayLabel(today).date}
        </h2>
        <label className="inline">
          As at
          <input type="time" value={formatMinute(now)} onChange={(e) => setNow(parseClock(e.target.value))} />
        </label>
        <label className="inline">
          Phone location
          <select value={where} onChange={(e) => setWhere(e.target.value as Where)}>
            <option value="on-site">On site</option>
            <option value="away">600m away</option>
            <option value="manager">Manager clock-in</option>
          </select>
        </label>
      </div>
      <p className="muted small">Demo trading data runs to {formatMinute(initialMinute)}. Move the clock back to replay the afternoon.</p>

      <section className="kpis four">
        <Kpi label="Sales so far" value={money(call.salesSoFar)} hint={`Forecast ${money(forecastToDate)} to ${formatMinute(Math.floor(now / 60) * 60)}`} />
        <Kpi
          label="Trading pace"
          value={pct(call.pace, 0)}
          hint={call.confident ? 'Of forecast, hours traded' : `Only ${pct(tradedShare, 0)} of the day traded`}
          tone={!call.confident ? '' : call.pace < 0.95 ? 'warn' : 'good'}
        />
        <Kpi label="Reforecast day" value={money(call.reforecastDay)} hint={`Forecast ${money(call.forecastDay)}`} />
        <Kpi
          label="Cut call saving"
          value={money(call.totalSaving)}
          hint={call.recommendations.length ? `${call.recommendations.length} early finish${call.recommendations.length > 1 ? 'es' : ''}` : 'Nothing to cut'}
          tone={call.totalSaving > 0 ? 'good' : ''}
        />
      </section>

      <div className={canManage ? 'live-grid' : ''}>
        {canManage && <div className="panel">
          <div className="panel-head">
            <h3>The cut call</h3>
            <label className="inline">
              <input type="checkbox" checked={priceEra} onChange={(e) => setPriceEra(e.target.checked)} />
              Price Employment Rights Act compensation (assumed)
            </label>
          </div>
          {!call.confident ? (
            <p className="muted">Too early to call. Wait until at least a tenth of the day's forecast has traded.</p>
          ) : call.recommendations.length === 0 ? (
            <p className="muted">
              {call.pace >= 1
                ? 'Trading at or ahead of forecast. Keep everyone.'
                : 'Every remaining hour still needs the people rostered. The rota is already as lean as the reforecast allows.'}
            </p>
          ) : (
            <ul className="calls">
              {call.recommendations.map((r) => (
                <li key={r.shiftId}>
                  <div>
                    <strong>{name(r.employeeId)}</strong> <span className="muted">{roleName(r.roleId)}</span>
                    <div className="small">
                      {r.standDown
                        ? `Stand down before the ${formatMinute(r.newEnd)} start.`
                        : `Finish at ${formatMinute(r.newEnd)}, not ${formatMinute(r.currentEnd)}.`}{' '}
                      {(r.minutesSaved / 60).toFixed(1)}h saved
                      {r.compensation > 0 ? `, less ${money(r.compensation)} compensation` : ''}.
                    </div>
                  </div>
                  <div className="call-act">
                    <span className="good-text strong">{money(r.saving)}</span>
                    <button onClick={() => run({ type: 'applyCut', shiftId: r.shiftId, endMinute: r.newEnd, breakMinutes: r.newBreakMinutes })}>
                      Apply
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {call.keptAtNoCost.length > 0 && (
            <p className="small muted">
              Kept on: {call.keptAtNoCost.map(name).join(', ')}.{' '}
              {priceEra
                ? 'Compensation for the short-notice cut would cancel the saving.'
                : 'Still inside guaranteed hours, so an early finish saves nothing.'}
            </p>
          )}
          {call.short.length > 0 && (
            <div className="notice small">
              Short on the reforecast:{' '}
              {groupShort(call.short)
                .map((g) => `${roleName(g.roleId)} ${formatMinute(g.from * 60)} to ${formatMinute(g.to * 60)}`)
                .join('; ')}
              . Move someone across or call someone in.
            </div>
          )}
          <p className="small muted">
            Savings are worked on each person's whole week, after guaranteed hours and the NI and pension thresholds,
            so they are what payroll will actually not pay.
          </p>
        </div>}

        <div className="panel">
          <h3>Who is in</h3>
          {message && <div className={`notice small ${message.tone}`}>{message.text}</div>}
          <div className="grid-wrap flat">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Rostered</th>
                  <th>Clocked</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {board.map((row) => (
                  <tr key={row.shift?.id ?? row.clock!.id}>
                    <td>
                      {name(row.employeeId)}
                      <div className="muted small">{roleName(row.roleId)}</div>
                    </td>
                    <td>{row.shift ? `${formatMinute(row.shift.startMinute)}-${formatMinute(row.shift.endMinute)}` : <span className="tag">Not rostered</span>}</td>
                    <td>
                      {row.clock
                        ? `${formatMinute(row.clock.clockIn)}-${row.clock.clockOut !== undefined ? formatMinute(row.clock.clockOut) : ''}`
                        : ''}
                    </td>
                    <td className={`${STATUS_TONE[row.status]}-text`}>{STATUS_LABEL[row.status]}</td>
                    <td className="num">
                      {row.status === 'on' ? (
                        <button onClick={() => clockOut(row.clock!.id, row.shift?.breakMinutes ?? 0)}>Clock out</button>
                      ) : row.status === 'due' || row.status === 'late' ? (
                        <button onClick={() => clockIn(row.employeeId)}>Clock in</button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="walk-in">
            <select value={walkIn} onChange={(e) => setWalkIn(e.target.value)} aria-label="Clock in someone not on the rota">
              <option value="">Someone not on today's rota</option>
              {state.employees
                .filter((e) => e.siteId === siteId && !onBoard.has(e.id))
                .map((e) => (
                  <option key={e.id} value={e.id}>{e.name}</option>
                ))}
            </select>
            <button disabled={!walkIn} onClick={() => { clockIn(walkIn); setWalkIn(''); }}>Clock in</button>
          </div>
          <p className="small muted">
            Clock-in only works on site and from 10 minutes before the shift. Time is never rounded: what is clocked is
            what is paid, which keeps the site safe on minimum wage.
          </p>
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
