import { intercompanyBalances, rotaJournal, toXeroCsv } from '../engine/journal';
import { weekCost } from '../engine/cost';
import type { RotaState } from '../engine/types';
import { download, money2 } from './format';

interface Props {
  state: RotaState;
  week: string;
  /** Entities in scope; each one is its own ledger and its own Xero file. */
  entityIds: string[];
}

export function CloseView({ state, week, entityIds }: Props) {
  const all = rotaJournal(state, week);
  const ic = intercompanyBalances(state, all).filter((b) => entityIds.includes(b.entityId) || entityIds.includes(b.counterpartyId));
  const ledgers = state.entities
    .filter((e) => entityIds.includes(e.id))
    .map((entity) => ({ entity, lines: all.filter((l) => l.entityId === entity.id) }));
  const nameOf = (id: string) => state.entities.find((e) => e.id === id)?.name ?? id;
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  function payrollCsv() {
    const cost = weekCost(state, week);
    const header = 'Employer,PAYE reference,Employee,Home site,Paid hours,Gross,Holiday,Employer NI,Pension,Loaded cost';
    // Payroll runs per PAYE scheme, so group the file by employer.
    const rows = state.entities
      .filter((entity) => entityIds.includes(entity.id))
      .flatMap((entity) =>
        state.employees
          .filter((e) => e.entityId === entity.id && cost.employees.has(e.id))
          .map((e) => {
            const c = cost.employees.get(e.id)!;
            const site = state.sites.find((s) => s.id === e.siteId)?.name ?? '';
            return [entity.name, entity.payeReference, e.name, site, c.paidHours, c.gross, c.holiday, c.employerNi, c.pension, c.total]
              .map((v) => (typeof v === 'string' && v.includes(',') ? `"${v}"` : v))
              .join(',');
          }),
      );
    download(`preshift-hours-${week}.csv`, [header, ...rows].join('\n'));
  }

  const hasLines = ledgers.some((l) => l.lines.length > 0);

  return (
    <div className="close">
      <div className="close-intro">
        <h2>Labour accrual journals</h2>
        <p className="muted">
          The rota is the best estimate of labour you will have before payroll runs. Post these accruals and the
          week's P&amp;L carries true labour on day one, which is what makes a 3-day close possible. Reverse them when
          payroll posts the actuals; the difference is your rota-to-payroll variance, and it should be small.
        </p>
        <p className="muted">
          There is one journal per company, because each company is its own set of books. Cost lands in the company
          whose site the work was done at. The wages accrual stays with the company that employs the person, because
          its PAYE scheme pays them. Where those differ, the journal books an intercompany recharge on both sides.
        </p>
        <div className="close-actions">
          <button disabled={!hasLines} onClick={payrollCsv}>Download hours for payroll</button>
        </div>
      </div>

      {ic.length > 0 && (
        <div className="grid-wrap entity-journal">
          <div className="entity-journal-head">
            <h3>Intercompany recharges</h3>
            <span className="muted small">
              Both sides must agree before posting. If the companies are not in the same VAT group, a staff recharge
              is a taxable supply and needs a VAT invoice.
            </span>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Owed to</th>
                <th>Owed by</th>
                <th className="num">Receivable booked</th>
                <th className="num">Payable booked</th>
                <th>Check</th>
              </tr>
            </thead>
            <tbody>
              {ic.map((b) => (
                <tr key={`${b.entityId}-${b.counterpartyId}`}>
                  <td>{nameOf(b.entityId)}</td>
                  <td>{nameOf(b.counterpartyId)}</td>
                  <td className="num">{money2(b.inOwnBooks)}</td>
                  <td className="num">{money2(b.inCounterpartyBooks)}</td>
                  <td className={Math.abs(b.inOwnBooks - b.inCounterpartyBooks) < 0.005 ? 'good-text' : 'bad-text'}>
                    {Math.abs(b.inOwnBooks - b.inCounterpartyBooks) < 0.005 ? 'Agrees' : 'Does not agree'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!hasLines && <p className="muted">No rostered labour this week yet.</p>}

      {ledgers.filter((l) => l.lines.length > 0).map(({ entity, lines }) => {
        const debits = lines.filter((l) => l.amount > 0).reduce((s, l) => s + l.amount, 0);
        const credits = lines.filter((l) => l.amount < 0).reduce((s, l) => s + l.amount, 0);
        return (
          <div key={entity.id} className="grid-wrap entity-journal">
            <div className="entity-journal-head">
              <div>
                <h3>{entity.name}</h3>
                <span className="muted small">Company {entity.companyNumber} · PAYE {entity.payeReference}</span>
              </div>
              <button className="primary" onClick={() => download(`preshift-journal-${slug(entity.name)}-${week}.csv`, toXeroCsv(lines))}>
                Download Xero journal
              </button>
            </div>
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
                    <td>{l.trackingOption || <span className="muted">None</span>}</td>
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
        );
      })}
    </div>
  );
}
