import { Fragment } from 'react';
import { rotaJournal, toXeroCsv } from '../engine/journal';
import { weekCost } from '../engine/cost';
import type { RotaState } from '../engine/types';
import { download, money2 } from './format';

export function CloseView({ state, week }: { state: RotaState; week: string }) {
  const lines = rotaJournal(state, week);
  const debits = lines.filter((l) => l.amount > 0).reduce((s, l) => s + l.amount, 0);
  const credits = lines.filter((l) => l.amount < 0).reduce((s, l) => s + l.amount, 0);
  const balanced = Math.abs(debits + credits) < 0.005;
  const sites = [...new Set(lines.map((l) => l.trackingOption))];

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
      <div className="close-hero">
        <div className="panel panel-body" style={{ paddingTop: 18 }}>
          <h2>Labour accrual journal</h2>
          <p>
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
        <div className="panel panel-body" style={{ paddingTop: 16 }}>
          <div className="ledger-tiles">
            <div className="ledger-tile">
              <div className="panel-sub">Debits</div>
              <div className="v">{money2(debits)}</div>
            </div>
            <div className="ledger-tile">
              <div className="panel-sub">Credits</div>
              <div className="v">{money2(-credits)}</div>
            </div>
            <div className="ledger-tile">
              <div className="panel-sub">Lines</div>
              <div className="v">{lines.length}</div>
            </div>
            <div className="ledger-tile">
              <div className="panel-sub">Sites</div>
              <div className="v">{sites.length}</div>
            </div>
            {lines.length > 0 && (
              <div className={`balanced${balanced ? '' : ' off'}`}>
                <span className="tick" aria-hidden>
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    {balanced ? <path d="M2.5 6.2l2.4 2.3 4.6-5" /> : <path d="M3 3l6 6M9 3l-6 6" />}
                  </svg>
                </span>
                {balanced ? 'Journal balances. Ready to post.' : `Out of balance by ${money2(Math.abs(debits + credits))}`}
              </div>
            )}
          </div>
        </div>
      </div>
      {lines.length === 0 ? (
        <div className="panel empty">
          <b>No rostered labour this week yet</b>
          Build the rota from the forecast and the accrual appears here.
        </div>
      ) : (
        <div className="panel grid-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Description</th>
                <th className="num">Debit</th>
                <th className="num">Credit</th>
              </tr>
            </thead>
            <tbody>
              {sites.map((site) => {
                const siteLines = lines.filter((l) => l.trackingOption === site);
                const siteDr = siteLines.filter((l) => l.amount > 0).reduce((s, l) => s + l.amount, 0);
                return (
                  <Fragment key={site}>
                    <tr className="site-row">
                      <th colSpan={4}>
                        {site} <span className="muted" style={{ fontWeight: 400 }}>tracking category</span>
                      </th>
                    </tr>
                    {siteLines.map((l, i) => (
                      <tr key={i}>
                        <td><span className="code-pill">{l.accountCode}</span></td>
                        <td className={l.amount < 0 ? 'cr' : ''} style={l.amount < 0 ? { paddingLeft: 32 } : undefined}>{l.description}</td>
                        <td className="num tnum">{l.amount > 0 ? money2(l.amount) : ''}</td>
                        <td className="num tnum">{l.amount < 0 ? money2(-l.amount) : ''}</td>
                      </tr>
                    ))}
                    <tr className="subtotal">
                      <td />
                      <td className="muted">{site} labour</td>
                      <td className="num tnum">{money2(siteDr)}</td>
                      <td />
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <th colSpan={2}>Total</th>
                <td className="num tnum strong">{money2(debits)}</td>
                <td className="num tnum strong">{money2(-credits)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
