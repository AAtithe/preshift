import { useEffect, useState } from 'react';
import type { JournalLine } from '../engine/journal';
import { api } from './api';
import { download, money2 } from './format';

export function CloseView({ week }: { week: string }) {
  const [data, setData] = useState<{ basis: 'rota' | 'actual'; lines: JournalLine[] } | null>(null);
  const [basis, setBasis] = useState<'auto' | 'rota' | 'actual'>('auto');

  useEffect(() => {
    setData(null);
    void api.get<{ basis: 'rota' | 'actual'; lines: JournalLine[] }>(`/v1/journal?weekStart=${week}&basis=${basis}`).then(setData);
  }, [week, basis]);

  const lines = data?.lines ?? [];
  const debits = lines.filter((l) => l.amount > 0).reduce((s, l) => s + l.amount, 0);
  const credits = lines.filter((l) => l.amount < 0).reduce((s, l) => s + l.amount, 0);

  async function downloadCsv() {
    const csv = await api.get<string>(`/v1/journal?weekStart=${week}&basis=${basis}&format=xero-csv`);
    download(`preshift-journal-${week}.csv`, csv);
  }

  return (
    <div className="close">
      <div className="close-intro">
        <h2>Labour accrual journal</h2>
        <p className="muted">
          Post this at week end and the P&amp;L carries true labour on day one, which is what makes a 3-day close possible.
          It is built from approved clocked hours once the week has them, and from the rota before that. When TeamPay
          completes the pay run, the Payroll tab shows how far the accrual was from what payroll actually cost.
        </p>
        <div className="close-actions">
          <select value={basis} onChange={(e) => setBasis(e.target.value as typeof basis)} aria-label="Basis">
            <option value="auto">Best available</option>
            <option value="rota">Rota</option>
            <option value="actual">Approved actuals</option>
          </select>
          <button className="primary" disabled={lines.length === 0} onClick={() => void downloadCsv()}>
            Download Xero journal
          </button>
          {data && <span className="muted small">Basis: {data.basis === 'actual' ? 'approved actuals' : 'rota'}</span>}
        </div>
      </div>
      {!data ? (
        <p className="muted">Loading</p>
      ) : lines.length === 0 ? (
        <p className="muted">No labour for this week yet.</p>
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
