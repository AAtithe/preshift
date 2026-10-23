import { useCallback, useEffect, useMemo, useState } from 'react';
import { annualImpact } from '../engine/payChanges';
import { WEEKDAY_NAMES, type ChangeStanding, type PayPolicy } from '../engine/payPolicy';
import { daysBetween } from '../engine/time';
import type { PayChange, PayTerms, RotaState } from '../engine/types';
import { api } from './api';
import { money, money2 } from './format';
import type { Allow } from './permissions';
import { UpratingPanel } from './UpratingPanel';

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

type ChangeView = PayChange & { standing?: ChangeStanding };

interface PolicyView {
  policy: PayPolicy;
  nextCutoff: string;
  approvers: { id: string; name: string; ready: boolean }[];
  canApprove: boolean;
}

const STATUS_LABEL: Record<PayChange['status'], string> = {
  pending: 'Waiting',
  approved: 'Approved',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  superseded: 'Replaced',
};

const terms = (t: PayTerms) => (t.payBasis === 'salaried' ? `${money(t.annualSalary)} a year` : `£${t.hourlyRate.toFixed(2)}/h`);
const when = (iso: string) => new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const signedMoney = (n: number) => `${n >= 0 ? '+' : '-'}${money(Math.abs(n))}`;

/** How a decided change came out, in words: an approval, or pay set without one. */
function outcome(c: PayChange): string {
  if (c.direct === 'system') return 'Set by a system';
  if (c.direct === 'no_approver') return 'Set, no approver';
  if (c.status === 'approved' && !c.appliedOn) return `Approved from ${when(c.effectiveFrom!)}`;
  return STATUS_LABEL[c.status];
}

/**
 * Pay changes waiting for finance, with what each adds to the wage bill, and every change to pay
 * since. Whoever sets pay proposes; the finance director approves or rejects, never on their own.
 * The organisation's rule (how fast finance decides, and when hours go to payroll) sits on top, so
 * a proposal that would miss the pay run is plain to see.
 */
export function PayApprovalsView({ state, siteIds, today, allow, meId, meEmployeeId, onChanged }: Props) {
  const [changes, setChanges] = useState<ChangeView[] | null>(null);
  const [policy, setPolicy] = useState<PolicyView | null>(null);
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, rule] = await Promise.all([api.get<ChangeView[]>('/v1/pay-changes'), api.get<PolicyView>('/v1/pay-policy')]);
      setChanges(list);
      setPolicy(rule);
    } catch (e) {
      setMessage({ text: (e as Error).message, bad: true });
      setChanges((c) => c ?? []);
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
  const scheduled = inScope.filter((c) => c.status === 'approved' && !c.appliedOn);
  const arrears = inScope.filter((c) => c.backPay);
  const decided = inScope.filter((c) => c.status !== 'pending' && !(c.status === 'approved' && !c.appliedOn)).slice(0, 60);
  const totalGross = waiting.reduce((s, w) => s + (w.impact?.difference ?? 0), 0);
  const totalFull = waiting.reduce((s, w) => s + (w.impact?.fullDifference ?? 0), 0);
  const oldest = waiting[0] ? daysBetween(waiting[0].c.requestedAt.slice(0, 10), today) : 0;
  const overdue = waiting.filter((w) => w.c.standing?.standing === 'overdue').length;
  const setsRule = allow('pay.approve') || allow('settings.manage');

  /** Why this person cannot decide this change, or null when they can. */
  function blocked(c: PayChange): string | null {
    if (!allow('pay.approve', c.siteId)) return 'Approving pay is for finance.';
    if (meId && c.requestedById === meId) return 'You proposed this: somebody else approves it.';
    if (meEmployeeId && c.employeeId === meEmployeeId) return 'This is your own pay.';
    return null;
  }

  // Opening a team in set-up proposes every rate at once; finance can approve those it may in one confirmed step.
  const approvable = waiting.filter((w) => !blocked(w.c));
  async function approveAll() {
    const total = approvable.reduce((s, w) => s + (w.impact?.fullDifference ?? 0), 0);
    if (!confirm(`Approve ${approvable.length} pay changes, adding ${money(total)} a year to the full cost of pay? Each is recorded as approved by you.`)) return;
    let done = 0;
    const failed: string[] = [];
    for (const { c, e } of approvable) {
      try {
        await api.post(`/v1/pay-changes/${c.id}/approve`, {});
        await onChanged(c.employeeId);
        done++;
      } catch (err) {
        failed.push(`${e?.name ?? c.employeeId}: ${(err as Error).message}`);
      }
    }
    setMessage(failed.length ? { text: `Approved ${done}. Not approved: ${failed.join('; ')}`, bad: true } : { text: `Approved ${done}. Payroll is told as each takes effect.` });
    await load();
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
      const from = c.effectiveFrom ? ` from ${when(c.effectiveFrom)}` : '';
      const note = prompt(`Approve ${terms(c.after)} for ${name}${from}? Add a note if you want one.`, '');
      if (note === null) return;
      if (note.trim()) body = { note: note.trim() };
    }
    try {
      const res = await api.post<PayChange>(`/v1/pay-changes/${c.id}/${verb}`, body);
      let text = 'Withdrawn.';
      if (verb === 'reject') text = `Rejected. ${name}'s pay stays as it is.`;
      if (verb === 'approve') {
        text = res.appliedOn ? `${name} is now on ${terms(c.after)}. Payroll has been told.` : `Approved. ${name} moves to ${terms(c.after)} on ${when(res.effectiveFrom!)}.`;
        if (res.backPay) text += ` Back pay of ${money2(res.backPay.amount)} goes to payroll with the next hours sent.`;
      }
      setMessage({ text });
      await onChanged(c.employeeId);
      await load();
    } catch (e) {
      setMessage({ text: (e as Error).message, bad: true });
    }
  }

  async function remind() {
    try {
      const res = await api.post<{ sent: number; escalated: boolean }>('/v1/pay-changes/remind', {});
      setMessage({ text: res.sent ? `Reminder sent to ${res.sent} ${res.sent === 1 ? 'person' : 'people'}${res.escalated ? ', the owner included' : ''}.` : 'Email is not set up under Settings, so no reminder was sent.' });
    } catch (e) {
      setMessage({ text: (e as Error).message, bad: true });
    }
  }

  async function saveRule(next: PayPolicy) {
    try {
      await api.put('/v1/pay-policy', next);
      setEditing(false);
      await load();
    } catch (e) {
      setMessage({ text: (e as Error).message, bad: true });
    }
  }

  const notReady = policy?.approvers.filter((a) => !a.ready) ?? [];
  return (
    <div>
      {policy && policy.approvers.length === 0 && (
        <p className="notice error">
          Nobody can approve pay. Every change applies at once with no second check, and is recorded as set with no approver.
          Appoint a finance director in Access.
        </p>
      )}
      {policy && policy.approvers.length > 0 && !policy.canApprove && (
        <p className="notice error">
          {notReady.map((a) => a.name).join(' and ')} {notReady.length === 1 ? 'approves' : 'approve'} pay but {notReady.length === 1 ? 'has' : 'have'} not
          set up an authenticator, so nothing can be approved yet. Changes wait until {notReady.length === 1 ? 'they do' : 'one of them does'}.
        </p>
      )}

      <div className="kpis people-kpis">
        <div className={`kpi ${overdue ? 'bad' : waiting.length ? 'warn' : 'good'}`}>
          <div className="kpi-label">Waiting for finance</div>
          <div className="kpi-value">{waiting.length}</div>
          <div className="kpi-hint">{waiting.length ? `${overdue ? `${overdue} overdue, ` : ''}oldest ${oldest} day${oldest === 1 ? '' : 's'}` : 'Nothing to decide'}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Adds to full cost a year</div>
          <div className="kpi-value">{money(totalFull)}</div>
          <div className="kpi-hint">{money(totalGross)} gross, plus holiday, employer NI and pension</div>
        </div>
        <div className={`kpi ${policy && waiting.length && policy.nextCutoff <= today ? 'warn' : ''}`}>
          <div className="kpi-label">Next payroll cut-off</div>
          <div className="kpi-value small-value">{policy ? when(policy.nextCutoff) : '-'}</div>
          <div className="kpi-hint">Decided after it, a change misses that pay run</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Decided</div>
          <div className="kpi-value">{decided.length}</div>
          <div className="kpi-hint">{decided.filter((c) => c.status === 'approved' && !c.direct).length} approved, {decided.filter((c) => c.status === 'rejected').length} rejected, {decided.filter((c) => c.direct).length} set directly</div>
        </div>
      </div>

      {policy && (
        <div className="people-bar">
          {editing ? (
            <RuleForm policy={policy.policy} onSave={(p) => void saveRule(p)} onCancel={() => setEditing(false)} />
          ) : (
            <p className="muted small">
              The rule: finance decides within {policy.policy.turnaroundDays} working day{policy.policy.turnaroundDays === 1 ? '' : 's'} of a proposal, and hours go to
              payroll every {WEEKDAY_NAMES[policy.policy.cutoffWeekday]}. Finance hears each morning what waits; the owner is copied in once anything is overdue
              or the cut-off is a day away. Pay stays as it is until a change is approved, and nobody approves their own proposal or their own pay.
              {setsRule && <> <button className="link" onClick={() => setEditing(true)}>Change the rule</button></>}
            </p>
          )}
        </div>
      )}
      {message && <p className={`notice${message.bad ? ' error' : ''}`}>{message.text}</p>}
      {changes === null && <p className="muted">Loading</p>}

      <div className="people-bar">
        <h3 className="section-title">Waiting</h3>
        <div className="people-actions">
          {waiting.length > 0 && <button onClick={() => void remind()}>Remind finance now</button>}
          {approvable.length > 1 && <button className="primary" onClick={() => void approveAll()}>Approve all {approvable.length}</button>}
        </div>
      </div>
      <div className="grid-wrap">
        <table className="table people">
          <thead>
            <tr>
              <th>Person</th>
              <th className="num">Now</th>
              <th className="num">Proposed</th>
              <th>From</th>
              <th className="num">A year</th>
              <th>Proposed by</th>
              <th>Decide by</th>
              <th>Reason</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {waiting.length === 0 && <tr><td colSpan={9} className="muted">No pay changes waiting.</td></tr>}
            {waiting.map(({ c, e, impact }) => {
              const why = blocked(c);
              const s = c.standing;
              const late = c.effectiveFrom && c.effectiveFrom < today;
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
                  <td>
                    {c.effectiveFrom ? when(c.effectiveFrom) : 'On approval'}
                    {late && <div className="warn-text small">Back pay owed</div>}
                  </td>
                  <td className="num">
                    {/* Flexible hours with nothing rostered lately: the cost is real but cannot be put on a year yet. */}
                    {!impact || (c.after.payBasis === 'hourly' && impact.hoursPerWeek === 0) ? (
                      <span className="muted small">No hours in the last 4 weeks</span>
                    ) : (
                      <>
                        <span className="strong">{signedMoney(impact.fullDifference)}</span>
                        <div className="muted small" title={`Holiday ${money(impact.onCosts.holiday)}, employer NI ${money(impact.onCosts.employerNi)}, pension ${money(impact.onCosts.pension)}`}>
                          {signedMoney(impact.difference)} gross{c.after.payBasis === 'hourly' ? `, ${impact.hoursPerWeek.toFixed(1)}h a week` : ''}
                        </div>
                      </>
                    )}
                  </td>
                  <td>{c.requestedBy}<div className="muted small">{when(c.requestedAt)}</div></td>
                  <td>
                    {s ? (
                      <>
                        <span className={s.standing === 'overdue' ? 'tag bad' : s.standing === 'due_today' ? 'warn-text' : ''}>
                          {s.standing === 'overdue' ? `Overdue since ${when(s.dueBy)}` : s.standing === 'due_today' ? 'Today' : when(s.dueBy)}
                        </span>
                        {s.daysToCutoff <= 1 && <div className="warn-text small">Payroll {s.daysToCutoff === 0 ? 'today' : 'tomorrow'}</div>}
                      </>
                    ) : '-'}
                  </td>
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
      <p className="muted small">
        A year is the full cost: gross pay plus holiday on hourly pay, employer NI and employer pension, on contracted hours
        or the last four weeks of rota. Hover it for the split.
      </p>

      {allow('pay.edit') && <UpratingPanel today={today} siteName={siteName} onProposed={load} />}

      {scheduled.length > 0 && (
        <>
          <h3 className="section-title">Approved, taking effect later</h3>
          <div className="grid-wrap">
            <table className="table people">
              <thead><tr><th>Person</th><th className="num">From</th><th className="num">To</th><th>Takes effect</th><th>Approved by</th><th /></tr></thead>
              <tbody>
                {scheduled.map((c) => (
                  <tr key={c.id}>
                    <td>{person(c.employeeId)?.name ?? c.employeeId}</td>
                    <td className="num">{terms(c.before)}</td>
                    <td className="num strong">{terms(c.after)}</td>
                    <td>{when(c.effectiveFrom!)}</td>
                    <td>{c.decidedBy}</td>
                    <td>{allow('pay.approve', c.siteId) && !(meEmployeeId && c.employeeId === meEmployeeId) && <button className="link" onClick={() => void act(c, 'withdraw')}>Withdraw</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {arrears.length > 0 && (
        <>
          <h3 className="section-title">Back pay</h3>
          <div className="grid-wrap">
            <table className="table people">
              <thead><tr><th>Person</th><th>For</th><th className="num">Hours</th><th className="num">Owed</th><th>Payroll</th></tr></thead>
              <tbody>
                {arrears.map((c) => (
                  <tr key={c.id}>
                    <td>{person(c.employeeId)?.name ?? c.employeeId}</td>
                    <td>{when(c.backPay!.from)} to {when(c.backPay!.to)}<div className="muted small">{terms(c.before)} to {terms(c.after)}</div></td>
                    <td className="num">{c.backPay!.basis === 'salary' ? '-' : c.backPay!.hours.toFixed(2)}<div className="muted small">{c.backPay!.basis === 'clocked' ? 'Clocked' : c.backPay!.basis === 'rota' ? 'From the rota' : 'Salary by the day'}</div></td>
                    <td className="num strong">{money2(c.backPay!.amount)}</td>
                    <td>{c.backPay!.sentIn ? <span className="good-text">Sent with the hours</span> : <span className="warn-text">Goes with the next hours sent</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h3 className="section-title">Pay history</h3>
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
                <td><span className={`status ${c.direct ? 'status-bad' : c.status === 'approved' ? 'status-active' : c.status === 'rejected' ? 'status-bad' : 'status-left'}`}>{outcome(c)}</span></td>
                <td>{c.requestedBy}<div className="muted small">{when(c.requestedAt)}</div></td>
                <td>{c.direct ? '-' : c.decidedBy ?? '-'}{c.decidedAt && !c.direct && <div className="muted small">{when(c.decidedAt)}</div>}</td>
                <td className="muted small">{c.note ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">Every change to pay is here, including pay set directly by a connected system or when nobody could approve.</p>
    </div>
  );
}

function RuleForm({ policy, onSave, onCancel }: { policy: PayPolicy; onSave: (p: PayPolicy) => void; onCancel: () => void }) {
  const [days, setDays] = useState(policy.turnaroundDays);
  const [cutoff, setCutoff] = useState(policy.cutoffWeekday);
  return (
    <div className="people-actions">
      <label>
        Finance decides within{' '}
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n} working day{n === 1 ? '' : 's'}</option>)}
        </select>
      </label>
      <label>
        Hours go to payroll on{' '}
        <select value={cutoff} onChange={(e) => setCutoff(Number(e.target.value))}>
          {WEEKDAY_NAMES.map((d, i) => <option key={d} value={i}>{d}</option>)}
        </select>
      </label>
      <button className="primary" onClick={() => onSave({ turnaroundDays: days, cutoffWeekday: cutoff })}>Save the rule</button>
      <button className="link" onClick={onCancel}>Cancel</button>
    </div>
  );
}
