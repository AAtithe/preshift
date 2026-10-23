import { useCallback, useEffect, useState } from 'react';
import { differences, type MatchLevel } from '../engine/payrollMatch';
import type { PayrollDifference, PayrollReview, RotaState } from '../engine/types';
import { api, ApiError } from './api';
import { money2 } from './format';

interface PayrollRecord {
  payrollId: string;
  name: string;
  dateOfBirth?: string;
  payBasis?: 'hourly' | 'salaried';
  hourlyRate?: number;
  annualSalary?: number;
  contractedHours?: number;
  leaveDate?: string;
  linkedTo: string | null;
}
interface Person {
  employeeId: string;
  name: string;
  siteId: string;
  payrollId: string | null;
  missingFromPayroll: boolean;
  review: PayrollReview | null;
  held: 'possible_match' | 'ambiguous_match' | null;
  pendingPay: { id: string; requestedBy: string; requestedAt: string } | null;
  suggestions: { payrollId: string; level: MatchLevel; differences: PayrollDifference[] }[];
}
interface LinkView {
  employerId: string;
  records: PayrollRecord[];
  people: Person[];
}

interface Props {
  state: RotaState;
  entityId: string;
  /** May link and unlink (payroll.send). Settling a pay difference also needs pay.edit, which the server checks. */
  canLink: boolean;
  onChanged: () => Promise<void>;
}

const LEVEL: Record<MatchLevel, string> = { exact: 'Same name and date of birth', likely: 'Likely the same person', name: 'Same name, different date of birth' };

const show = (d: PayrollDifference, v: string | number) =>
  d.field === 'hourlyRate' ? money2(Number(v)) : d.field === 'annualSalary' ? `${money2(Number(v))} a year` : d.field === 'dateOfBirth' ? ukDate(String(v)) : String(v);
const ukDate = (iso?: string) => (iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC' }) : 'not held');
const problem = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));

export function PayrollLink({ state, entityId, canLink, onChanged }: Props) {
  const [view, setView] = useState<LinkView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const company = state.entities.find((e) => e.id === entityId)?.name ?? 'This company';
  const siteName = (id: string) => state.sites.find((s) => s.id === id)?.name ?? id;

  const load = useCallback(async () => {
    try {
      setView(await api.get<LinkView>(`/v1/integrations/payroll/link?entityId=${encodeURIComponent(entityId)}`));
      setError(null);
    } catch (e) {
      setError(problem(e));
    }
  }, [entityId]);
  useEffect(() => void load(), [load]);

  async function act(done: string, fn: () => Promise<unknown>) {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      setMessage(done);
      await load();
      await onChanged();
    } catch (e) {
      setMessage(problem(e));
    } finally {
      setBusy(false);
    }
  }

  const link = (p: Person, payrollId: string, keep?: 'payroll' | 'preshift') =>
    act(`${p.name} linked.`, () => api.post(`/v1/employees/${p.employeeId}/payroll-link`, { payrollId, ...(keep ? { keep } : {}) }));
  const settle = (p: Person, keep: 'payroll' | 'preshift') =>
    act(`${p.name}: ${keep === 'payroll' ? "TeamPay's details taken into Preshift" : "Preshift's details sent to TeamPay"}.`, () =>
      api.post(`/v1/employees/${p.employeeId}/payroll-link`, { payrollId: p.payrollId, keep }),
    );
  const confirmNew = (p: Person) =>
    act(`${p.name} will be set up in TeamPay as a new starter.`, () => api.post(`/v1/employees/${p.employeeId}/payroll-new-starter`));
  const unlink = (p: Person) => act(`${p.name} unlinked.`, () => api.del(`/v1/employees/${p.employeeId}/payroll-link`));

  if (error) return <div className="notice error">Cannot read {company}'s TeamPay records: {error}</div>;
  if (!view) return <p className="muted">Reading {company}'s TeamPay records</p>;

  const review = view.people.filter((p) => p.review);
  const unlinked = view.people.filter((p) => !p.payrollId);
  const linked = view.people.filter((p) => p.payrollId && !p.review);
  const free = view.records.filter((r) => !r.linkedTo && !r.leaveDate);

  return (
    <div className="payroll-link">
      <p className="muted small">
        {company} has {view.records.length} {view.records.length === 1 ? 'person' : 'people'} on TeamPay. Anyone already there is
        linked to their existing record, never set up a second time. A starter with exactly one record of the same name and date
        of birth is linked automatically; everyone else is linked here. Linking decides whose record their hours are paid against,
        so check each one.
      </p>
      {message && <div className="notice" role="status">{message}</div>}

      {review.length > 0 && (
        <>
          <h3 className="section-title">Needs a decision ({review.length})</h3>
          <p className="small">
            Linked, but Preshift and TeamPay disagree. Nothing is sent to TeamPay for them, and their hours wait, until it is
            settled. Pay follows the two-person rule: choosing TeamPay's pay sends it to finance as a pay change to approve, and
            sending Preshift's pay over what TeamPay pays is finance's own decision.
          </p>
          {review.map((p) => (
            <div key={p.employeeId} className="link-card">
              <div className="link-head"><b>{p.name}</b> <span className="muted small">{siteName(p.siteId)} · TeamPay {p.payrollId}</span></div>
              <Differences diffs={p.review!.differences} />
              {p.pendingPay && (
                <p className="small warn-text">
                  TeamPay's pay is with finance to approve, proposed by {p.pendingPay.requestedBy}. Hours wait until it is decided.
                </p>
              )}
              <div className="row-actions">
                <button disabled={busy || !canLink || !!p.pendingPay} onClick={() => void settle(p, 'payroll')}>TeamPay is right</button>
                <button disabled={busy || !canLink} onClick={() => void settle(p, 'preshift')}>Preshift is right</button>
                <button className="link" disabled={busy || !canLink} onClick={() => void unlink(p)}>Wrong person, unlink</button>
              </div>
            </div>
          ))}
        </>
      )}

      <h3 className="section-title">Not linked ({unlinked.length})</h3>
      {unlinked.length === 0 ? (
        <p className="muted small">Everyone at {company} is linked to TeamPay.</p>
      ) : (
        unlinked.map((p) => {
          const picked = choice[p.employeeId] ?? p.suggestions[0]?.payrollId ?? '';
          const suggestion = p.suggestions.find((s) => s.payrollId === picked);
          const record = view.records.find((r) => r.payrollId === picked);
          const employee = state.employees.find((e) => e.id === p.employeeId);
          const others = free.filter((r) => !p.suggestions.some((s) => s.payrollId === r.payrollId));
          return (
            <div key={p.employeeId} className="link-card">
              <div className="link-head">
                <b>{p.name}</b> <span className="muted small">{siteName(p.siteId)}</span>
                {p.held === 'possible_match' && <span className="tag">Held: may already be on TeamPay</span>}
                {p.held === 'ambiguous_match' && <span className="tag bad">Held: two TeamPay records match</span>}
              </div>
              <label className="link-pick">
                <span className="small muted">TeamPay record</span>
                <select value={picked} onChange={(e) => setChoice({ ...choice, [p.employeeId]: e.target.value })}>
                  <option value="">Not on TeamPay: set up as a new starter</option>
                  {p.suggestions.length > 0 && (
                    <optgroup label="Could be them">
                      {p.suggestions.map((s) => {
                        const r = view.records.find((x) => x.payrollId === s.payrollId)!;
                        return <option key={s.payrollId} value={s.payrollId}>{r.name}, born {ukDate(r.dateOfBirth)} ({LEVEL[s.level]})</option>;
                      })}
                    </optgroup>
                  )}
                  {others.length > 0 && (
                    <optgroup label="Everyone else not yet linked">
                      {others.map((r) => <option key={r.payrollId} value={r.payrollId}>{r.name}, born {ukDate(r.dateOfBirth)}</option>)}
                    </optgroup>
                  )}
                </select>
              </label>
              {record && (
                <LinkChoice
                  // The same comparison the server makes; it checks again when the link is made.
                  diffs={suggestion?.differences ?? (employee ? differences(employee, record) : [])}
                  busy={busy}
                  canLink={canLink}
                  onLink={(keep) => link(p, record.payrollId, keep)}
                />
              )}
              {!record && (
                <div className="row-actions">
                  <span className="muted small">
                    {p.suggestions.length
                      ? 'Only if none of the records above is them: a second record means two payslips and two sets of RTI.'
                      : 'Nobody on TeamPay looks like them.'}
                  </span>
                  <button disabled={busy || !canLink} onClick={() => void confirmNew(p)}>Set up as a new starter</button>
                </div>
              )}
            </div>
          );
        })
      )}

      {linked.length > 0 && (
        <details className="link-linked">
          <summary>Linked ({linked.length})</summary>
          <ul>
            {linked.map((p) => (
              <li key={p.employeeId}>
                {p.name} <span className="muted small">TeamPay {p.payrollId}</span>
                {p.missingFromPayroll && <span className="tag bad">Not found on TeamPay</span>}
                <button className="link" disabled={busy || !canLink} title="Only until hours have gone to TeamPay under this link" onClick={() => void unlink(p)}>Unlink</button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function Differences({ diffs }: { diffs: PayrollDifference[] }) {
  return (
    <table className="table compact">
      <thead><tr><th /><th>Preshift</th><th>TeamPay</th></tr></thead>
      <tbody>
        {diffs.map((d) => (
          <tr key={d.field}>
            <td>{d.label}{d.pay && <span className="tag">Pay</span>}</td>
            <td>{show(d, d.preshift)}</td>
            <td>{show(d, d.payroll)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LinkChoice({ diffs, busy, canLink, onLink }: {
  diffs: PayrollDifference[];
  busy: boolean;
  canLink: boolean;
  onLink: (keep?: 'payroll' | 'preshift') => Promise<void>;
}) {
  if (diffs.length) {
    return (
      <>
        <Differences diffs={diffs} />
        <div className="row-actions">
          <button className="primary" disabled={busy || !canLink} onClick={() => void onLink('payroll')}>Link, TeamPay is right</button>
          <button disabled={busy || !canLink} onClick={() => void onLink('preshift')}>Link, Preshift is right</button>
        </div>
      </>
    );
  }
  return (
    <div className="row-actions">
      <button className="primary" disabled={busy || !canLink} onClick={() => void onLink()}>Link to this record</button>
    </div>
  );
}
