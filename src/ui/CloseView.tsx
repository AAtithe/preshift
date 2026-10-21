import { useState } from 'react';
import { blendedShifts, clocksNeedingApproval, weekVariance } from '../engine/actuals';
import { actualsJournal, rotaJournal, toXeroCsv } from '../engine/journal';
import { weekCost } from '../engine/cost';
import { weekDates } from '../engine/time';
import type { RotaState } from '../engine/types';
import { download, money2, pct } from './format';

type Basis = 'clocked' | 'rota';

export function CloseView({ state, week, asOf }: { state: RotaState; week: string; asOf: string }) {
  const closedDays = weekDates(week).filter((d) => d < asOf).length;
  const [chosen, setChosen] = useState<Basis>('clocked');
  const basis: Basis = closedDays === 0 ? 'rota' : chosen;
  const lines = basis === 'clocked' ? actualsJournal(state, week, asOf) : rotaJournal(state, week);
  const debits = lines.filter((l) => l.amount > 0).reduce((s, l) => s + l.amount, 0);
  const credits = lines.filter((l) => l.amount < 0).reduce((s, l) => s + l.amount, 0);
  const variance = weekVariance(state, week, asOf);
  const pending = new Set(clocksNeedingApproval(variance));

  function payrollCsv() {
    const shifts = basis === 'clocked' ? blendedShifts(state, asOf) : state.shifts;
    const cost = weekCost({ employees: state.employees, shifts }, week);
    const header = 'Employee,Site,Paid hours,Gross,Holiday,Employer NI,Pension,Loaded cost,Clockings awaiting approval';
    const rows = state.employees
      .filter((e) => cost.employees.has(e.id))
      .map((e) => {
        const c = cost.employees.get(e.id)!;
        const site = state.sites.find((s) => s.id === e.siteId)?.name ?? '';
        const waiting = state.clocks.filter((k) => k.employeeId === e.id && pending.has(k.id)).length;
        return [e.name, site, c.paidHours, c.gross, c.holiday, c.employerNi, c.pension, c.total, waiting].join(',');
      });
    download(`preshift-hours-${basis}-${week}.csv`, [header, ...rows].join('\n'));
  }

  return (
    <div className="close">
      <div className="close-intro">
        <h2>Labour accrual journal</h2>
        <p className="muted">
          Post this accrual and the week's P&amp;L carries true labour on day one, which is what makes a 3-day close
          possible. Built from clocked hours, it is what payroll will pay; built from the rota, it is what was planned.
          Reverse it when payroll posts. The difference between the two is the rota-to-payroll variance, and it should be
          under 1%.
        </p>
        <div className="close-actions">
          <div className="segmented" role="group" aria-label="Accrual basis">
            <button className={basis === 'clocked' ? 'active' : ''} disabled={closedDays === 0} onClick={() => setChosen('clocked')}>
              Clocked hours
            </button>
            <button className={basis === 'rota' ? 'active' : ''} onClick={() => setChosen('rota')}>
              Rota
            </button>
          </div>
          <button className="primary" disabled={lines.length === 0} onClick={() => download(`preshift-journal-${basis}-${week}.csv`, toXeroCsv(lines))}>
            Download Xero journal
          </button>
          <button disabled={lines.length === 0} onClick={payrollCsv}>Download hours for payroll</button>
        </div>
        {closedDays > 0 && (
          <p className="small">
            All sites, {closedDays === 7 ? 'full week' : `${closedDays} of 7 days traded, the rest from the rota`}:
            rota {money2(variance.rotaCost)}, clocked {money2(variance.actualCost)}, difference{' '}
            <span className={Math.abs(variance.pct) <= 0.01 ? 'good-text' : 'bad-text'}>
              {money2(variance.total)} ({pct(variance.pct, 2)})
            </span>
            .{pending.size > 0 && ` ${pending.size} clockings still need a manager's approval before payroll.`}
          </p>
        )}
      </div>
      {lines.length === 0 ? (
        <p className="muted">No labour this week yet.</p>
      ) : (
        <div className="grid-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Site</th>
                <th>Account</th>
                <th>Description</th>
                <th className="num">Debit</th>
                <th className="num">Credit</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td>{l.trackingOption}</td>
                  <td>{l.accountCode}</td>
                  <td>{l.description}</td>
                  <td className="num">{l.amount > 0 ? money2(l.amount) : ''}</td>
                  <td className="num">{l.amount < 0 ? money2(-l.amount) : ''}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th colSpan={3}>Total</th>
                <td className="num strong">{money2(debits)}</td>
                <td className="num strong">{money2(-credits)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
