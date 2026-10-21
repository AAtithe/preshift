import { rotaJournal, toXeroCsv } from '../engine/journal';
import { weekCost } from '../engine/cost';
import type { RotaState } from '../engine/types';
import { download, money2 } from './format';

export function CloseView({ state, week }: { state: RotaState; week: string }) {
  const lines = rotaJournal(state, week);
  const debits = lines.filter((l) => l.amount > 0).reduce((s, l) => s + l.amount, 0);
  const credits = lines.filter((l) => l.amount < 0).reduce((s, l) => s + l.amount, 0);

  function payrollCsv() {
    const cost = weekCost(state, week);
    const header = 'Employee,Site,Paid hours,Gross,Holiday,Employer NI,Pension,Loaded cost';
    const rows = state.employees
      .filter((e) => cost.employees.has(e.id))
      .map((e) => {
        const c = cost.employees.get(e.id)!;
        const site = state.sites.find((s) => s.id === e.siteId)?.name ?? '';
        return [e.name, site, c.paidHours, c.gross, c.holiday, c.employerNi, c.pension, c.total].join(',');
      });
    download(`preshift-hours-${week}.csv`, [header, ...rows].join('\n'));
  }

  return (
    <div className="close">
      <div className="close-intro">
        <h2>Labour accrual journal</h2>
        <p className="muted">
          The rota is the best estimate of labour you will have before payroll runs. Post this accrual and the
          week's P&amp;L carries true labour on day one, which is what makes a 3-day close possible. Reverse it when
          payroll posts the actuals; the difference is your rota-to-payroll variance, and it should be small.
        </p>
        <div className="close-actions">
          <button className="primary" disabled={lines.length === 0} onClick={() => download(`preshift-journal-${week}.csv`, toXeroCsv(lines))}>
            Download Xero journal
          </button>
          <button disabled={lines.length === 0} onClick={payrollCsv}>Download hours for payroll</button>
        </div>
      </div>
      {lines.length === 0 ? (
        <p className="muted">No rostered labour this week yet.</p>
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
