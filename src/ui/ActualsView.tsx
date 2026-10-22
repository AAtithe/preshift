import { useMemo } from 'react';
import { clocksNeedingApproval, VARIANCE_GUIDE, VARIANCE_ORDER, weekFlash } from '../engine/actuals';
import { formatMinute } from '../engine/time';
import type { RotaState } from '../engine/types';
import type { Command } from '../shared/commands';
import { dayLabel, hours, money, money2, pct } from './format';
import { Kpi } from './KpiBar';

interface Props {
  state: RotaState;
  siteId: string;
  week: string;
  asOf: string;
  run: (cmd: Command) => Promise<boolean>;
}

export function ActualsView({ state, siteId, week, asOf, run }: Props) {
  const flash = useMemo(() => weekFlash(state, siteId, week, asOf), [state, siteId, week, asOf]);
  const v = flash.variance;
  // Largest first: the few big overruns matter more than many two-minute clock-ins.
  const extraCost = (clockId: string) => v.items.filter((i) => i.clockId === clockId && i.needsApproval).reduce((s, i) => s + i.cost, 0);
  const pending = clocksNeedingApproval(v).sort((a, b) => extraCost(b) - extraCost(a));
  const name = (id: string) => state.employees.find((e) => e.id === id)?.name ?? id;

  if (v.closedDates.length === 0) {
    return <p className="muted">Nothing has traded this week yet. The flash fills in as each day closes.</p>;
  }

  const over = flash.varianceToTarget > 0;
  const varianceTone = Math.abs(v.pct) <= 0.01 ? 'good' : v.total > 0 ? 'bad' : 'warn';
  const closedLabel =
    v.closedDates.length === 7 ? 'Full week' : `${v.closedDates.length} day${v.closedDates.length > 1 ? 's' : ''} closed`;

  return (
    <div className="actuals">
      <section className="kpis">
        <Kpi label="Actual sales" value={money(flash.actualSales)} hint={`Forecast ${money(flash.forecastSales)} · ${closedLabel}`} />
        <Kpi label="Clocked labour" value={money(flash.actualCost)} hint={`Rota said ${money(flash.rotaCost)}`} />
        <Kpi
          label="Actual labour %"
          value={pct(flash.actualPct)}
          hint={`Target ${pct(flash.targetPct, 0)} · ${over ? '+' : ''}${money(flash.varianceToTarget)}`}
          tone={over ? 'bad' : 'good'}
        />
        <Kpi
          label="Rota to payroll"
          value={`${v.total > 0 ? '+' : ''}${money(v.total)}`}
          hint={`${v.total > 0 ? '+' : ''}${pct(v.pct, 2)} of rota · target within 1%`}
          tone={varianceTone}
        />
        <Kpi label="Awaiting approval" value={money(v.unapprovedCost)} hint={`${pending.length} clockings`} tone={pending.length ? 'warn' : 'good'} />
        <Kpi
          label="Clocked breaches"
          value={String(flash.compliance.length)}
          hint="Working Time on actual hours"
          tone={flash.compliance.length ? 'bad' : 'good'}
        />
      </section>

      <div className="grid-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Day</th>
              <th className="num">Forecast sales</th>
              <th className="num">Actual sales</th>
              <th className="num">Rota labour</th>
              <th className="num">Clocked labour</th>
              <th className="num">Clocked hours</th>
              <th className="num">Rota %</th>
              <th className="num">Actual %</th>
            </tr>
          </thead>
          <tbody>
            {flash.days.map((d) => (
              <tr key={d.date} className={d.closed ? '' : 'muted'}>
                <td>{dayLabel(d.date).short} {dayLabel(d.date).date}</td>
                <td className="num">{money(d.forecastSales)}</td>
                <td className="num">{d.closed ? money(d.actualSales) : 'Not traded'}</td>
                <td className="num">{money(d.rotaCost)}</td>
                <td className="num">{d.closed ? money(d.actualCost) : ''}</td>
                <td className="num">{d.closed ? hours(d.actualHours) : ''}</td>
                <td className="num">{pct(d.rotaPct)}</td>
                <td className={`num ${d.closed && d.actualPct > flash.targetPct ? 'bad-text' : ''}`}>{d.closed ? pct(d.actualPct) : ''}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th>Closed days</th>
              <td className="num">{money(flash.forecastSales)}</td>
              <td className="num strong">{money(flash.actualSales)}</td>
              <td className="num">{money(flash.rotaCost)}</td>
              <td className="num strong">{money(flash.actualCost)}</td>
              <td className="num">{hours(flash.actualHours)}</td>
              <td className="num">{pct(flash.rotaPct)}</td>
              <td className="num strong">{pct(flash.actualPct)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <h3 className="section">Why payroll differs from the rota</h3>
      <div className="grid-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Cause</th>
              <th className="num">Times</th>
              <th className="num">Hours</th>
              <th className="num">Cost</th>
              <th>What it means</th>
            </tr>
          </thead>
          <tbody>
            {VARIANCE_ORDER.filter((k) => v.byKind[k].count > 0).map((k) => (
              <tr key={k}>
                <td>{VARIANCE_GUIDE[k].label}</td>
                <td className="num">{v.byKind[k].count}</td>
                <td className="num">{hours(v.byKind[k].minutes / 60)}</td>
                <td className={`num ${v.byKind[k].cost > 0 ? 'bad-text' : 'good-text'}`}>{money2(v.byKind[k].cost)}</td>
                <td className="muted small">{VARIANCE_GUIDE[k].action}</td>
              </tr>
            ))}
            <tr>
              <td>Guaranteed hours and thresholds</td>
              <td />
              <td />
              <td className="num">{money2(v.onCostEffect)}</td>
              <td className="muted small">
                Guaranteed hours paid whether worked or not, and NI and pension thresholds crossed or not. Not a behaviour; a
                contract and rota design question.
              </td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <th>Rota to payroll</th>
              <td />
              <td />
              <td className="num strong">{money2(v.total)}</td>
              <td className="muted small">
                {money2(v.rotaCost)} rostered against {money2(v.actualCost)} clocked
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="section-head">
        <h3 className="section">Approve before payroll</h3>
        {pending.length > 0 && (
          <button className="primary" onClick={() => run({ type: 'approveClocks', ids: pending })}>
            Approve all {pending.length}
          </button>
        )}
      </div>
      {pending.length === 0 ? (
        <p className="muted">Every extra paid minute this week has been signed off.</p>
      ) : (
        <div className="grid-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Day</th>
                <th>Rostered</th>
                <th>Clocked</th>
                <th>Extra time</th>
                <th className="num">Cost</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pending.map((clockId) => {
                const clock = state.clocks.find((c) => c.id === clockId)!;
                const shift = state.shifts.find((s) => s.id === clock.shiftId);
                const items = v.items.filter((i) => i.clockId === clockId && i.needsApproval);
                return (
                  <tr key={clockId}>
                    <td>{name(clock.employeeId)}</td>
                    <td>{dayLabel(clock.date).short} {dayLabel(clock.date).date}</td>
                    <td>{shift ? `${formatMinute(shift.startMinute)}-${formatMinute(shift.endMinute)}` : <span className="tag">Not rostered</span>}</td>
                    <td>{formatMinute(clock.clockIn)}-{formatMinute(clock.clockOut ?? clock.clockIn)}</td>
                    <td className="small">{items.map((i) => `${VARIANCE_GUIDE[i.kind].label.toLowerCase()} ${i.minutes}m`).join(', ')}</td>
                    <td className="num">{money2(extraCost(clockId))}</td>
                    <td className="num">
                      <button onClick={() => run({ type: 'approveClocks', ids: [clockId] })}>Approve</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {flash.compliance.length > 0 && (
        <>
          <h3 className="section">Breaches on clocked hours</h3>
          <ul className="issues">
            {flash.compliance.map((i, n) => (
              <li key={n} className={i.severity}>
                {name(i.employeeId)}{i.date ? `, ${dayLabel(i.date).short} ${dayLabel(i.date).date}` : ''}: {i.message}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
