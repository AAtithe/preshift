import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { breakShortfalls } from '../engine/breaks';
import { addDays } from '../engine/time';
import type { PayrollVariance, RosterVsActual } from '../engine/timesheet';
import type { RotaState, TimeEntry } from '../engine/types';
import { api, ApiError } from './api';
import { BreakShortfalls } from './BreakShortfalls';
import { BreakRule, BreakSteps } from './guides/breaks';
import { HelpModal } from './HelpModal';
import { hours, money, money2, pct } from './format';
import { NOT_YOURS, type Allow } from './permissions';
import { PayrollLink } from './PayrollLink';

interface Employer {
  entityId: string;
  name: string;
  payeReference: string;
  employerId: string | null;
  problem: string | null;
  employees: { total: number; synced: number };
}
interface Status {
  provider: string;
  employees: { total: number; synced: number };
  employers: Employer[];
  outbox: { pending: number; failed: number; delivered: number };
}
interface Submission { id: string; entityId?: string; periodStart: string; version: number; status: string; totalHours: number; lineCount: number; createdAt: string }
interface PayRun { id: string; entityId?: string; periodStart: string; receivedAt: string; variance: PayrollVariance }
interface OutboxItem { id: string; type: string; status: string; attempts: number; lastError?: string; reason?: string; payload?: { employeeId?: string } }

interface Props {
  state: RotaState;
  siteId: string;
  week: string;
  allow: Allow;
  simulator: boolean;
  onChanged: () => Promise<void>;
  onOpenGuide: (id: string) => void;
}

export function PayrollView({ state, siteId, week, allow, simulator, onChanged, onOpenGuide }: Props) {
  const [confirmApprove, setConfirmApprove] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [compare, setCompare] = useState<RosterVsActual[]>([]);
  const [subs, setSubs] = useState<Submission[]>([]);
  const [runs, setRuns] = useState<PayRun[]>([]);
  const [failed, setFailed] = useState<OutboxItem[]>([]);
  const [heldItems, setHeldItems] = useState<OutboxItem[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [employerDraft, setEmployerDraft] = useState<Record<string, string>>({});
  const [linking, setLinking] = useState(false);
  const end = addDays(week, 6);
  // Demo controls depend on running against the simulator, which /v1/me says for those who cannot read payroll.
  const isSimulator = status ? status.provider.includes('simulator') : simulator;

  const seesTime = allow('time.record', siteId) || allow('time.approve', siteId) || allow('payroll.view');
  const seesPayroll = allow('payroll.view');
  const sends = allow('payroll.send');
  const approves = allow('time.approve', siteId);
  const records = allow('time.record', siteId);

  const refresh = useCallback(async () => {
    // Ask only for what this person may read; the API would refuse the rest.
    const none = <T,>(v: T) => Promise.resolve(v);
    const [st, te, cmp, sb, rn, ob] = await Promise.all([
      seesPayroll ? api.get<Status>('/v1/integrations/payroll') : none(null),
      seesTime ? api.get<TimeEntry[]>(`/v1/time-entries?siteId=${siteId}&from=${week}&to=${end}`) : none([]),
      seesTime ? api.get<RosterVsActual[]>(`/v1/time-entries/compare?siteId=${siteId}&weekStart=${week}`) : none([]),
      seesPayroll ? api.get<Submission[]>('/v1/payroll/submissions') : none([]),
      seesPayroll ? api.get<PayRun[]>('/v1/payroll/runs') : none([]),
      seesPayroll ? api.get<OutboxItem[]>('/v1/integrations/payroll/outbox') : none([]),
    ]);
    setStatus(st);
    setEntries(te);
    setCompare(cmp);
    setSubs(sb.filter((s) => s.periodStart === week));
    setRuns(rn.filter((r) => r.periodStart === week));
    // A starter held for a possible match on TeamPay waits for a person, not a retry: it is shown under linking.
    setFailed(ob.filter((i) => i.status === 'failed' && !i.reason));
    setHeldItems(ob.filter((i) => i.status === 'failed' && i.reason));
  }, [siteId, week, end, seesPayroll, seesTime]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function step(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fn();
      const detail = res && typeof res === 'object' ? summarise(res) : '';
      setMessage(`${label}: done${detail ? ` (${detail})` : ''}`);
    } catch (e) {
      setMessage(e instanceof ApiError ? `${label}: ${e.message}` : `${label} failed`);
    }
    // Delivery to TeamPay is asynchronous; give the outbox a moment before refreshing.
    await new Promise((r) => setTimeout(r, 400));
    await refresh();
    await onChanged();
    setBusy(false);
  }

  const name = (id: string) => state.employees.find((e) => e.id === id)?.name ?? id;
  const count = (s: TimeEntry['status']) => entries.filter((e) => e.status === s).length;
  const unapproved = count('open') + count('submitted');
  const shortBreaks = breakShortfalls(entries, state.employees);
  const shortWaiting = shortBreaks.filter((b) => entries.find((t) => t.id === b.entryId)?.status === 'submitted').length;
  // Each company is its own PAYE scheme: its latest batch and pay run this week, newest first from the API.
  const only = state.entities.length === 1 ? state.entities[0].id : undefined;
  const companyOf = (x: { entityId?: string }) => x.entityId ?? only;
  const employers = status?.employers ?? [];
  const latestSub = (entityId: string) => subs.find((s) => companyOf(s) === entityId);
  const latestRunOf = (entityId: string) => runs.find((r) => companyOf(r) === entityId);
  const sent = employers.filter((e) => latestSub(e.entityId)).length;
  const allSent = sent > 0 && employers.filter((e) => latestSub(e.entityId)).every((e) => latestSub(e.entityId)!.status === 'sent');
  const ranFor = employers.filter((e) => latestRunOf(e.entityId));
  const missingEmployer = employers.filter((e) => !e.employerId);

  const entityId = state.sites.find((s) => s.id === siteId)?.entityId ?? '';
  const awaitingDecision = state.employees.filter((e) => e.entityId === entityId && e.payrollReview).length;
  const held = heldItems.filter((i) => state.employees.find((e) => e.id === i.payload?.employeeId)?.entityId === entityId).length;

  const approveAll = () => step('Approve', () => api.post('/v1/time-entries/approve', { siteId, from: week, to: end }));

  return (
    <div className="payroll">
      {confirmApprove && (
        <HelpModal
          title={`${shortWaiting} ${shortWaiting === 1 ? 'shift is' : 'shifts are'} below the legal break minimum`}
          onClose={() => setConfirmApprove(false)}
          actions={
            <>
              <button onClick={() => setConfirmApprove(false)}>Review them first</button>
              <button className="primary" onClick={() => { setConfirmApprove(false); void approveAll(); }}>I have checked them, approve all</button>
              <span className="spacer" />
              <button className="link" onClick={() => { setConfirmApprove(false); onOpenGuide('breaks'); }}>Full guide</button>
            </>
          }
        >
          <BreakRule />
          <p>Before you approve, check each flagged shift:</p>
          <BreakSteps />
        </HelpModal>
      )}
      <section className="pipeline">
        <Step n={1} title="People in TeamPay" done={!!status && status.employees.synced === status.employees.total && missingEmployer.length === 0}>
          {employers.length > 1 ? (
            employers.map((e) => (
              <div key={e.entityId} className={e.employerId ? '' : 'bad-text'}>
                {e.name}: {e.employerId ? `${e.employees.synced} of ${e.employees.total}` : 'no TeamPay employer'}
              </div>
            ))
          ) : (
            <div>{status ? `${status.employees.synced} of ${status.employees.total} set up` : seesPayroll ? '...' : 'For those who run payroll'}</div>
          )}
          <button disabled={busy || !sends || !status || status.employees.synced === status.employees.total} title={sends ? undefined : NOT_YOURS} onClick={() => step('Sync people', () => api.post('/v1/integrations/payroll/sync-employees'))}>
            Set up in TeamPay
          </button>
          {awaitingDecision > 0 && <div className="warn-text">{awaitingDecision} linked with differences to decide</div>}
          {held > 0 && <div className="warn-text">{held} held: may already be on TeamPay</div>}
          {seesPayroll && (
            <button className="link" onClick={() => setLinking(!linking)}>
              {linking ? 'Close linking' : 'Link existing TeamPay people'}
            </button>
          )}
        </Step>
        <Step n={2} title="Clocked hours" done={entries.length > 0}>
          <div>{entries.length} records, {count('open')} still clocked in</div>
          {isSimulator && (
            <button disabled={busy || !records} title={records ? undefined : NOT_YOURS} onClick={() => step('Simulate clocking', () => api.post('/v1/dev/simulate-clocking', { siteId, weekStart: week }))}>
              Simulate clocking
            </button>
          )}
        </Step>
        <Step n={3} title="Manager approval" done={entries.length > 0 && unapproved === 0}>
          <div>{count('approved')} approved, {unapproved} waiting</div>
          {shortBreaks.length > 0 && <div className="warn-text">{shortBreaks.length} below the legal break minimum</div>}
          <button disabled={busy || !approves || count('submitted') === 0} title={approves ? 'Your own hours are left for someone else to approve' : NOT_YOURS} onClick={() => (shortWaiting ? setConfirmApprove(true) : approveAll())}>
            {shortWaiting ? `Approve all (${shortWaiting} short of break)` : 'Approve all'}
          </button>
        </Step>
        <Step n={4} title="Hours to TeamPay" done={allSent}>
          {sent === 0 ? (
            <div>Not sent</div>
          ) : (
            employers.map((e) => {
              const s = latestSub(e.entityId);
              return s ? <div key={e.entityId}>{employers.length > 1 ? `${e.name}: ` : ''}v{s.version} {s.status}, {hours(s.totalHours)}</div> : null;
            })
          )}
          <button
            className="primary"
            disabled={busy || !sends || count('approved') === 0 || unapproved > 0 || missingEmployer.length > 0}
            title={!sends ? NOT_YOURS : missingEmployer.length ? 'Set a TeamPay employer for every company first' : undefined}
            onClick={() => step('Send hours', () => api.post('/v1/payroll/submissions', { weekStart: week }))}
          >
            {sent ? 'Resend' : 'Send to TeamPay'}
          </button>
        </Step>
        <Step n={5} title="Pay run back" done={ranFor.length > 0 && ranFor.length === sent}>
          {ranFor.length === 0 ? (
            <div>Waiting for TeamPay</div>
          ) : (
            ranFor.map((e) => {
              const r = latestRunOf(e.entityId)!;
              return (
                <div key={e.entityId}>
                  {employers.length > 1 ? `${e.name}: ` : ''}variance {money2(r.variance.variance)} ({pct(r.variance.variancePct, 2)})
                </div>
              );
            })
          )}
          {isSimulator && (
            <button disabled={busy || !sends || !allSent} title={sends ? undefined : NOT_YOURS} onClick={() => step('Run payroll', () => api.post('/v1/dev/teampay/run-payroll', { weekStart: week }))}>
              Run payroll (simulator)
            </button>
          )}
        </Step>
      </section>
      {linking && seesPayroll && entityId && (
        <section className="settings-card">
          <h2>People already on TeamPay</h2>
          <PayrollLink state={state} entityId={entityId} canLink={sends} onChanged={async () => { await refresh(); await onChanged(); }} />
        </section>
      )}

      {!seesPayroll && (
        <p className="notice">You see this site's hours. Payroll submissions and pay runs are for those who run payroll.</p>
      )}
      <p className="muted small">
        {status ? `Connected to ${status.provider}. ` : ''}Hours go to payroll only once approved, every change is queued and retried
        until TeamPay confirms it, and the period locks once sent. Tronc stays in TeamPay Tronc, fed by the same hours.
        {status && status.outbox.pending > 0 && ` ${status.outbox.pending} change(s) on their way.`}
      </p>
      {message && <div className="notice">{message}</div>}
      <BreakShortfalls
        shortfalls={shortBreaks}
        entries={entries}
        name={name}
        busy={busy}
        onCorrect={(id, breakMinutes) => void step('Correct break', () => api.patch(`/v1/time-entries/${id}`, { breakMinutes }))}
        onOpenGuide={() => onOpenGuide('breaks')}
      />
      {missingEmployer.length > 0 && (
        <div className="notice error">
          <strong>Each company runs its own PAYE scheme, so each needs its own TeamPay employer.</strong> Nothing is sent
          to TeamPay until every company with hours has one.
          {!allow('settings.manage') && <div>Whoever manages settings sets each company's TeamPay employer.</div>}
          {allow('settings.manage') && missingEmployer.map((e) => (
            <div key={e.entityId} className="employer-row">
              <span>{e.name}{e.payeReference ? ` (PAYE ${e.payeReference})` : ''}</span>
              <input
                placeholder="TeamPay employer id"
                value={employerDraft[e.entityId] ?? ''}
                onChange={(ev) => setEmployerDraft((d) => ({ ...d, [e.entityId]: ev.target.value }))}
                aria-label={`TeamPay employer for ${e.name}`}
              />
              <button
                disabled={busy || !employerDraft[e.entityId]?.trim()}
                onClick={() => step(`Set ${e.name}'s employer`, () => api.patch(`/v1/entities/${e.entityId}`, { payrollEmployerId: employerDraft[e.entityId].trim() }))}
              >
                Save
              </button>
            </div>
          ))}
        </div>
      )}
      {failed.length > 0 && (
        <div className="notice error">
          <strong>{failed.length} change(s) TeamPay rejected.</strong>
          <ul>
            {failed.map((f) => (
              <li key={f.id}>
                {f.type}: {f.lastError}{' '}
                <button className="link" onClick={() => step('Retry', () => api.post(`/v1/integrations/payroll/outbox/${f.id}/retry`))}>Retry</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="split">
        <div className="grid-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Rota against clock</th>
                <th className="num">Rostered</th>
                <th className="num">Clocked</th>
                <th className="num">Difference</th>
              </tr>
            </thead>
            <tbody>
              {compare.length === 0 && (
                <tr><td colSpan={4} className="muted">No shifts or clocking this week.</td></tr>
              )}
              {compare
                .slice()
                .sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance))
                .map((r) => (
                  <tr key={r.employeeId}>
                    <td>{name(r.employeeId)}</td>
                    <td className="num">{hours(r.rosteredHours)}</td>
                    <td className="num">{hours(r.actualHours)}</td>
                    <td className={`num ${r.variance > 0.25 ? 'bad-text' : ''}`}>{r.variance > 0 ? '+' : ''}{hours(r.variance)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>

        <div className="grid-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Accrual against TeamPay, all sites</th>
                <th className="num">Accrued</th>
                <th className="num">Payroll</th>
                <th className="num">Variance</th>
              </tr>
            </thead>
            {ranFor.length === 0 && (
              <tbody>
                <tr><td colSpan={4} className="muted">Appears when TeamPay completes the pay run for this week.</td></tr>
              </tbody>
            )}
            {ranFor.map((e) => {
              const r = latestRunOf(e.entityId)!;
              return (
                <tbody key={e.entityId}>
                  {employers.length > 1 && (
                    <tr className="entity-head"><th colSpan={4}>{e.name}</th></tr>
                  )}
                  {r.variance.lines.slice(0, 15).map((l) => (
                    <tr key={l.employeeId}>
                      <td>{name(l.employeeId)}</td>
                      <td className="num">{money(l.accrued)}</td>
                      <td className="num">{money(l.actual)}</td>
                      <td className={`num ${Math.abs(l.variance) > 5 ? 'bad-text' : ''}`}>{money2(l.variance)}</td>
                    </tr>
                  ))}
                  <tr className="subtotal">
                    <td>{employers.length > 1 ? `Total ${e.name}` : 'Total'}</td>
                    <td className="num strong">{money(r.variance.accrued)}</td>
                    <td className="num strong">{money(r.variance.actual)}</td>
                    <td className="num strong">{money2(r.variance.variance)}</td>
                  </tr>
                </tbody>
              );
            })}
          </table>
        </div>
      </div>
    </div>
  );
}

function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children: ReactNode }) {
  return (
    <div className={`step ${done ? 'done' : ''}`}>
      <div className="step-head">
        <span className="step-n">{done ? '✓' : n}</span>
        <strong>{title}</strong>
      </div>
      <div className="step-body">{children}</div>
    </div>
  );
}

const WORDS: Record<string, string> = {
  approved: 'approved',
  ownSkipped: 'your own, left for someone else to approve',
  stillOpen: 'still clocked in',
  belowBreakMinimum: 'below the legal break minimum',
  created: 'created',
  queued: 'queued',
};

function summarise(res: object) {
  return Object.entries(res)
    .filter(([k, v]) => typeof v === 'number' && !((k === 'ownSkipped' || k === 'belowBreakMinimum') && v === 0))
    .map(([k, v]) => `${v} ${WORDS[k] ?? k}`)
    .join(', ');
}
