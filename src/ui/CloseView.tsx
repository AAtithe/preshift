import { useEffect, useState } from 'react';
import type { AllowanceWeek } from '../engine/allowance';
import type { IntercompanyBalance, JournalLine } from '../engine/journal';
import type { RotaState } from '../engine/types';
import { api } from './api';
import { download, money2 } from './format';

interface Journal {
  basis: 'rota' | 'actual';
  lines: JournalLine[];
  intercompany: IntercompanyBalance[];
  employmentAllowance: AllowanceWeek | null;
  employmentAllowanceIssues: string[];
}

interface Props {
  state: RotaState;
  week: string;
  /** Entities in scope; each one is its own ledger and its own Xero file. */
  entityIds: string[];
}

export function CloseView({ state, week, entityIds }: Props) {
  const [data, setData] = useState<Journal | null>(null);
  const [basis, setBasis] = useState<'auto' | 'rota' | 'actual'>('auto');

  // Shifts are in the dependencies so the journal follows a build or an edit without a reload.
  useEffect(() => {
    setData(null);
    void api.get<Journal>(`/v1/journal?weekStart=${week}&basis=${basis}`).then(setData);
  }, [week, basis, state.shifts]);

  const nameOf = (id: string) => state.entities.find((e) => e.id === id)?.name ?? id;
  const ledgers = state.entities
    .filter((e) => entityIds.includes(e.id))
    .map((entity) => ({ entity, lines: (data?.lines ?? []).filter((l) => l.entityId === entity.id) }))
    .filter((l) => l.lines.length > 0);
  const ic = (data?.intercompany ?? []).filter((b) => entityIds.includes(b.entityId) || entityIds.includes(b.counterpartyId));
  const ea = data?.employmentAllowance;
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  async function downloadCsv(entityId: string) {
    const csv = await api.get<string>(`/v1/journal?weekStart=${week}&basis=${basis}&format=xero-csv&entityId=${entityId}`);
    download(`preshift-journal-${slug(nameOf(entityId))}-${week}.csv`, csv);
  }

  return (
    <div className="close">
      <div className="close-intro">
        <h2>Labour accrual journals</h2>
        <p className="muted">
          Post these at week end and the P&amp;L carries true labour on day one, which is what makes a 3-day close possible.
          They are built from approved clocked hours once the week has them, and from the rota before that. When TeamPay
          completes the pay run, the Payroll tab shows how far the accrual was from what payroll actually cost.
        </p>
        <p className="muted">
          There is one journal per company, because each company is its own set of books. Cost lands in the company
          whose site the work was done at. The wages accrual stays with the company that employs the person, because
          its PAYE scheme pays them. Where those differ, the journal books an intercompany recharge on both sides.
        </p>
        <div className="close-actions">
          <select value={basis} onChange={(e) => setBasis(e.target.value as typeof basis)} aria-label="Basis">
            <option value="auto">Best available</option>
            <option value="rota">Rota</option>
            <option value="actual">Approved actuals</option>
          </select>
          {data && <span className="muted small">Basis: {data.basis === 'actual' ? 'approved actuals' : 'rota'}</span>}
        </div>
      </div>

      {!data ? (
        <p className="muted">Loading</p>
      ) : (
        <>
          {ea && entityIds.includes(ea.entityId) && (
            <div className="grid-wrap entity-journal">
              <div className="entity-journal-head">
                <h3>Employment Allowance {ea.taxYear}</h3>
                <span className="muted small">
                  Claimed by {nameOf(ea.entityId)} for the group. Used against employer NI week by week until it runs
                  out, the way payroll applies it, so the accrual reverses cleanly. Site labour % stays before the
                  allowance: it is tax relief, not site performance.
                </span>
              </div>
              {ea.coveredByPayroll ? (
                <p className="muted small ea-note">Payroll has already run for this week; its actuals carry the allowance.</p>
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th className="num">Available at start of week</th>
                      <th className="num">Employer NI this week</th>
                      <th className="num">Used this week</th>
                      <th className="num">Remaining</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="num">{money2(ea.available)}</td>
                      <td className="num">{money2(ea.employerNi)}</td>
                      <td className="num strong">{money2(ea.used)}</td>
                      <td className={`num ${ea.remainingAfter === 0 ? 'warn-text' : ''}`}>
                        {ea.remainingAfter === 0 && ea.used > 0 ? 'Used up this week' : ea.remainingAfter === 0 ? 'Used up' : money2(ea.remainingAfter)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              )}
              {data.employmentAllowanceIssues.length > 0 && (
                <ul className="issues compact ea-note">
                  {data.employmentAllowanceIssues.map((m, i) => <li key={i} className="warn">{m}</li>)}
                </ul>
              )}
            </div>
          )}

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
                  {ic.map((b) => {
                    const agrees = Math.abs(b.inOwnBooks - b.inCounterpartyBooks) < 0.005;
                    return (
                      <tr key={`${b.entityId}-${b.counterpartyId}`}>
                        <td>{nameOf(b.entityId)}</td>
                        <td>{nameOf(b.counterpartyId)}</td>
                        <td className="num">{money2(b.inOwnBooks)}</td>
                        <td className="num">{money2(b.inCounterpartyBooks)}</td>
                        <td className={agrees ? 'good-text' : 'bad-text'}>{agrees ? 'Agrees' : 'Does not agree'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {ledgers.length === 0 && <p className="muted">No labour for this week yet.</p>}

          {ledgers.map(({ entity, lines }) => {
            const debits = lines.filter((l) => l.amount > 0).reduce((s, l) => s + l.amount, 0);
            const credits = lines.filter((l) => l.amount < 0).reduce((s, l) => s + l.amount, 0);
            return (
              <div key={entity.id} className="grid-wrap entity-journal">
                <div className="entity-journal-head">
                  <div>
                    <h3>{entity.name}</h3>
                    <span className="muted small">Company {entity.companyNumber || 'not set'} · PAYE {entity.payeReference || 'not set'}</span>
                  </div>
                  <button className="primary" onClick={() => void downloadCsv(entity.id)}>Download Xero journal</button>
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
        </>
      )}
    </div>
  );
}
