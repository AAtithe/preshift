import { useCallback, useEffect, useMemo, useState } from 'react';
import { annualImpact } from '../engine/payChanges';
import { daysBetween } from '../engine/time';
import type { PayChange, PayTerms, RotaState } from '../engine/types';
import { api } from './api';
import { money } from './format';
import type { Allow } from './permissions';

interface Props {
  state: RotaState;
  siteIds: string[];
  today: string;
  allow: Allow;
  /** The signed-in person's access record and rota record, to keep them off their own decisions. */
  meId?: string;
  meEmployeeId?: string;
  /** A decision moved someone's pay: re-read them. */
  onChanged: (employeeId: string) => Promise<unknown>;
}

const STATUS_LABEL: Record<PayChange['status'], string> = {
  pending: 'Waiting',
  approved: 'Approved',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  superseded: 'Replaced by a later proposal',
};

const terms = (t: PayTerms) => (t.payBasis === 'salaried' ? `${money(t.annualSalary)} a year` : `£${t.hourlyRate.toFixed(2)}/h`);
const when = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/**
 * Pay changes waiting for finance, with what each adds to the wage bill, and every decision since.
 * Whoever sets pay proposes; the finance director approves or rejects, never on their own.
 */
export function PayApprovalsView({ state, siteIds, today, allow, meId, meEmployeeId, onChanged }: Props) {
  const [changes, setChanges] = useState<PayChange[] | null>(null);
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      setChanges(await api.get<PayChange[]>('/v1/pay-changes'));
    } catch (e) {
      setMessage({ text: (e as Error).message, bad: true });
      setChanges([]);
    }
  }, []);
  useEffect(() => void load(), [load]);

  const person = (id: string) => state.employees.find((e) => e.id === id);
  const siteName = (id: string) => state.sites.find((s) => s.id === id)?.name ?? id;
  const inScope = (changes ?? []).filter((c) => siteIds.includes(c.siteId));
  const waiting = useMemo(
    () =>
      inScope
        .filter((c) => c.status === 'pending')
        .map((c) => {
          const e = person(c.employeeId);
          return { c, e, impact: e ? annualImpact(c, e, state.shifts, today) : null };
        })
        .sort((a, b) => a.c.requestedAt.localeCompare(b.c.requestedAt)),
    [changes, siteIds, state, today],
  );
  const decided = inScope.filter((c) => c.status !== 'pending').slice(0, 40);
  const totalImpact = waiting.reduce((s, w) => s + (w.impact?.difference ?? 0), 0);
  const oldest = waiting[0] ? daysBetween(waiting[0].c.requestedAt.slice(0, 10), today) : 0;

  /** Why this person cannot decide this change, or null when they can. */
  function blocked(c: PayChange): string | null {
    if (!allow('pay.approve', c.siteId)) return 'Approving pay is for finance.';
    if (meId && c.requestedById === meId) return 'You proposed this: somebody else approves it.';
    if (meEmployeeId && c.employeeId === meEmployeeId) return 'This is your own pay.';
    return null;
  }

  async function act(c: PayChange, verb: 'approve' | 'reject' | 'withdraw') {
    const name = person(c.employeeId)?.name ?? c.employeeId;
    let body: Record<string, string> = {};
    if (verb === 'reject') {
      const note = prompt(`Why is ${name}'s change rejected? ${c.requestedBy} sees this.`);
      if (!note?.trim()) return;
      body = { note: note.trim() };
    }
    if (verb === 'approve') {
      const note = prompt(`Approve ${terms(c.after)} for ${name}? Add a note if you want one.`, '');
      if (note === null) return;
      if (note.trim()) body = { note: note.trim() };
    }
    try {
      await api.post(`/v1/pay-changes/${c.id}/${verb}`, body);
      setMessage({ text: verb === 'approve' ? `${name} is now on ${terms(c.after)}. Payroll has been told.` : verb === 'reject' ? `Rejected. ${name}'s pay stays as it is.` : 'Withdrawn.' });
      await onChanged(c.employeeId);
      await load();
    } catch (e) {
      setMessage({ text: (e as Error).message, bad: true });
    }
  }

  return (
    <div>
      <div className="kpis people-kpis">
        <div className={`kpi ${waiting.length ? 'warn' : 'good'}`}>
          <div className="kpi-label">Waiting for finance</div>
          <div className="kpi-value">{waiting.length}</div>
          <div className="kpi-hint">{waiting.length ? `Oldest ${oldest} day${oldest === 1 ? '' : 's'}` : 'Nothing to decide'}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Adds to gross pay a year</div>
          <div className="kpi-value">{money(totalImpact)}</div>
          <div className="kpi-hint">If every change waiting is approved. Before holiday, employer NI and pension</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Decided</div>
          <div className="kpi-value">{decided.length}</div>
          <div className="kpi-hint">{decided.filter((c) => c.status === 'approved').length} approved, {decided.filter((c) => c.status === 'rejected').length} rejected</div>
        </div>
      </div>

      <p className="muted small">
        Whoever sets pay proposes a change; the finance director approves it. Pay stays as it is until then, so the rota,
        the accrual and payroll never run on a rate nobody checked. Nobody approves their own proposal or their own pay.
      </p>
      {message && <p className={`notice${message.bad ? ' error' : ''}`}>{message.text}</p>}
      {changes === null && <p className="muted">Loading</p>}

      <h3 className="section-title">Waiting</h3>
      <div className="grid-wrap">
        <table className="table people">
          <thead>
            <tr>
              <th>Person</th>
              <th className="num">Now</th>
              <th className="num">Proposed</th>
              <th className="num">Gross a year</th>
              <th>Proposed by</th>
              <th>Reason</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {waiting.length === 0 && <tr><td colSpan={7} className="muted">No pay changes waiting.</td></tr>}
            {waiting.map(({ c, e, impact }) => {
              const why = blocked(c);
              return (
                <tr key={c.id}>
                  <td>
                    <span className="strong">{e?.name ?? c.employeeId}</span>
                    <div className="muted small">{siteName(c.siteId)}</div>
                  </td>
                  <td className="num">{terms(c.before)}</td>
                  <td className="num strong">
                    {terms(c.after)}
                    {impact?.pct != null && <div className="muted small">{impact.pct >= 0 ? '+' : ''}{(impact.pct * 100).toFixed(1)}%</div>}
                  </td>
                  <td className="num">
                    {/* Flexible hours with nothing rostered lately: the cost is real but cannot be put on a year yet. */}
                    {!impact || (c.after.payBasis === 'hourly' && impact.hoursPerWeek === 0) ? (
                      <span className="muted small">No hours in the last 4 weeks</span>
                    ) : (
                      <>
                        {`${impact.difference >= 0 ? '+' : ''}${money(impact.difference)}`}
                        {c.after.payBasis === 'hourly' && <div className="muted small">on {impact.hoursPerWeek.toFixed(1)}h a week</div>}
                      </>
                    )}
                  </td>
                  <td>{c.requestedBy}<div className="muted small">{when(c.requestedAt)}</div></td>
                  <td className="muted small">{c.reason ?? 'No reason given'}</td>
                  <td className="nowrap">
                    <button className="primary" disabled={!!why} title={why ?? undefined} onClick={() => void act(c, 'approve')}>Approve</button>{' '}
                    <button disabled={!!why} title={why ?? undefined} onClick={() => void act(c, 'reject')}>Reject</button>{' '}
                    {allow('pay.edit', c.siteId) && <button className="link" onClick={() => void act(c, 'withdraw')}>Withdraw</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h3 className="section-title">Decided</h3>
      <div className="grid-wrap">
        <table className="table people">
          <thead>
            <tr><th>Person</th><th className="num">From</th><th className="num">To</th><th>Outcome</th><th>Proposed by</th><th>Decided by</th><th>Note</th></tr>
          </thead>
          <tbody>
            {decided.length === 0 && <tr><td colSpan={7} className="muted">Nothing decided yet.</td></tr>}
            {decided.map((c) => (
              <tr key={c.id}>
                <td>{person(c.employeeId)?.name ?? c.employeeId}</td>
                <td className="num">{terms(c.before)}</td>
                <td className="num">{terms(c.after)}</td>
                <td><span className={`status ${c.status === 'approved' ? 'status-active' : c.status === 'rejected' ? 'status-bad' : 'status-left'}`}>{STATUS_LABEL[c.status]}</span></td>
                <td>{c.requestedBy}<div className="muted small">{when(c.requestedAt)}</div></td>
                <td>{c.decidedBy ?? '-'}{c.decidedAt && <div className="muted small">{when(c.decidedAt)}</div>}</td>
                <td className="muted small">{c.note ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
