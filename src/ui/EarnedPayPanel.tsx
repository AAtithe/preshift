import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { money } from './format';

interface Settings {
  on: boolean;
  sharePct: number;
  minDraw: number;
  maxDrawsPerPeriod: number;
}

interface EarnedPayList {
  companies: { entityId: string; name: string; settings: Settings; outstanding: number }[];
  draws: { id: string; amount: number; requestedAt: string; payDate: string; status: 'requested' | 'paid' | 'failed' | 'cancelled'; failure?: string; name: string; entityId: string; deductedIn: string | null }[];
}

const STATUS = { requested: 'Sent to payroll', paid: 'Paid', failed: 'Not paid', cancelled: 'Cancelled' } as const;
const problem = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Early pay for finance: each company's rules, who has drawn what, and what is still to come off a
 * payslip. Switching it on moves money, so it needs the right to send payroll.
 */
export function EarnedPayPanel({ entityIds, canManage }: { entityIds: string[]; canManage: boolean }) {
  const [data, setData] = useState<EarnedPayList | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Settings>>({});
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);
  const load = useCallback(async () => {
    const d = await api.get<EarnedPayList>('/v1/earned-pay');
    setData(d);
    setDrafts(Object.fromEntries(d.companies.map((c) => [c.entityId, c.settings])));
  }, []);
  useEffect(() => {
    load().catch((e) => setMessage({ text: problem(e), bad: true }));
  }, [load]);
  if (!data) return message ? <p className="small bad-text">{message.text}</p> : null;
  const companies = data.companies.filter((c) => entityIds.includes(c.entityId));
  if (!companies.length) return null;

  const save = async (entityId: string) => {
    try {
      await api.put(`/v1/entities/${entityId}/earned-pay`, drafts[entityId]);
      await load();
      setMessage({ text: drafts[entityId].on ? 'Saved. Staff see early pay on the Pay tab of their app.' : 'Saved. Early pay is off; draws already made still come off payday.' });
    } catch (e) {
      setMessage({ text: problem(e), bad: true });
    }
  };
  const cancel = async (id: string) => {
    try {
      await api.post(`/v1/earned-pay/${id}/cancel`, {});
      await load();
    } catch (e) {
      setMessage({ text: problem(e), bad: true });
    }
  };
  const set = (id: string, patch: Partial<Settings>) => setDrafts({ ...drafts, [id]: { ...drafts[id], ...patch } });

  return (
    <section className="settings-card">
      <h2>Early pay</h2>
      <p className="muted small">
        Staff can draw part of what they have already earned this pay period before payday, from the Pay tab of their app. TeamPay pays
        it to the bank details it holds and takes it off that payday's net pay, so it costs nothing extra and is not a loan: no fee
        and no interest. Only approved hours count, at each person's own rate, with tax, NI and pension allowed for at the highest
        usual rates, and only the share set here may be drawn, so payday always has more than was drawn.
      </p>
      {companies.map((c) => {
        const d = drafts[c.entityId];
        return (
          <form key={c.entityId} className="settings-form" onSubmit={(e) => { e.preventDefault(); void save(c.entityId); }}>
            <strong>{c.name}</strong>
            <label className="check-inline">
              <input type="checkbox" disabled={!canManage} checked={d.on} onChange={(e) => set(c.entityId, { on: e.target.checked })} /> Offer early pay
            </label>
            <label>
              Share of earned net pay
              <input type="number" min={10} max={50} step={5} disabled={!canManage} value={d.sharePct} onChange={(e) => set(c.entityId, { sharePct: Number(e.target.value) })} />
            </label>
            <label>
              Smallest draw (£)
              <input type="number" min={5} max={100} disabled={!canManage} value={d.minDraw} onChange={(e) => set(c.entityId, { minDraw: Number(e.target.value) })} />
            </label>
            <label>
              Draws a pay period
              <input type="number" min={1} max={5} disabled={!canManage} value={d.maxDrawsPerPeriod} onChange={(e) => set(c.entityId, { maxDrawsPerPeriod: Number(e.target.value) })} />
            </label>
            {canManage && <button type="submit">Save</button>}
            <span className="small muted">Still to come off payslips: {money(c.outstanding)}</span>
          </form>
        );
      })}
      {data.draws.length > 0 && (
        <table className="table compact">
          <thead>
            <tr><th>Requested</th><th>Person</th><th className="num">Amount</th><th>Off pay on</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {data.draws.filter((d) => entityIds.includes(d.entityId)).slice(0, 50).map((d) => (
              <tr key={d.id}>
                <td>{d.requestedAt.slice(0, 10)}</td>
                <td>{d.name}</td>
                <td className="num">{money(d.amount)}</td>
                <td>{d.payDate}</td>
                <td>{STATUS[d.status]}{d.failure ? `: ${d.failure}` : ''}{d.deductedIn ? ', sent with the hours' : ''}</td>
                <td>{canManage && d.status === 'requested' && <button className="link" onClick={() => void cancel(d.id)}>Cancel</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {message && <p className={`small ${message.bad ? 'bad-text' : 'good-text'}`}>{message.text}</p>}
    </section>
  );
}
