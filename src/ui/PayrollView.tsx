import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { addDays } from '../engine/time';
import type { PayrollVariance, RosterVsActual } from '../engine/timesheet';
import type { RotaState, TimeEntry } from '../engine/types';
import { api, ApiError } from './api';
import { hours, money, money2, pct } from './format';
import { NOT_YOURS, type Allow } from './permissions';

interface Status {
  provider: string;
  employees: { total: number; synced: number };
  outbox: { pending: number; failed: number; delivered: number };
}
interface Submission { id: string; periodStart: string; version: number; status: string; totalHours: number; lineCount: number; createdAt: string }
interface PayRun { id: string; periodStart: string; receivedAt: string; variance: PayrollVariance }
interface OutboxItem { id: string; type: string; status: string; attempts: number; lastError?: string }

interface Props {
  state: RotaState;
  siteId: string;
  week: string;
  allow: Allow;
  onChanged: () => Promise<void>;
}

export function PayrollView({ state, siteId, week, allow, onChanged }: Props) {
  const [status, setStatus] = useState<Status | null>(null);
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [compare, setCompare] = useState<RosterVsActual[]>([]);
  const [subs, setSubs] = useState<Submission[]>([]);
  const [runs, setRuns] = useState<PayRun[]>([]);
  const [failed, setFailed] = useState<OutboxItem[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const end = addDays(week, 6);
  // Demo controls depend on running against the simulator, which people without payroll rights learn from the demo routes.
  const [demo, setDemo] = useState(false);
  useEffect(() => {
    void api.get('/v1/dev/people').then(() => setDemo(true)).catch(() => setDemo(false));
  }, []);
  const isSimulator = status ? status.provider.includes('simulator') : demo;

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
    setFailed(ob.filter((i) => i.status === 'failed'));
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
  const latestRun = runs[0];

  return (
    <div className="payroll">
      <section className="pipeline">
        <Step n={1} title="People in TeamPay" done={!!status && status.employees.synced === status.employees.total}>
          <div>{status ? `${status.employees.synced} of ${status.employees.total} set up` : seesPayroll ? '...' : 'For those who run payroll'}</div>
          <button disabled={busy || !sends || !status || status.employees.synced === status.employees.total} title={sends ? undefined : NOT_YOURS} onClick={() => step('Sync people', () => api.post('/v1/integrations/payroll/sync-employees'))}>
            Set up in TeamPay
          </button>
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
          <button disabled={busy || !approves || count('submitted') === 0} title={approves ? 'Your own hours are left for someone else to approve' : NOT_YOURS} onClick={() => step('Approve', () => api.post('/v1/time-entries/approve', { siteId, from: week, to: end }))}>
            Approve all
          </button>
        </Step>
        <Step n={4} title="Hours to TeamPay" done={subs[0]?.status === 'sent'}>
          <div>{subs[0] ? `v${subs[0].version} ${subs[0].status}, ${hours(subs[0].totalHours)}` : 'Not sent'}</div>
          <button className="primary" disabled={busy || !sends || count('approved') === 0 || unapproved > 0} title={sends ? undefined : NOT_YOURS} onClick={() => step('Send hours', () => api.post('/v1/payroll/submissions', { weekStart: week }))}>
            {subs[0] ? 'Resend' : 'Send to TeamPay'}
          </button>
        </Step>
        <Step n={5} title="Pay run back" done={!!latestRun}>
          <div>{latestRun ? `Variance ${money2(latestRun.variance.variance)} (${pct(latestRun.variance.variancePct, 2)})` : 'Waiting for TeamPay'}</div>
          {isSimulator && (
            <button disabled={busy || !sends || subs[0]?.status !== 'sent'} title={sends ? undefined : NOT_YOURS} onClick={() => step('Run payroll', () => api.post('/v1/dev/teampay/run-payroll', { weekStart: week }))}>
              Run payroll (simulator)
            </button>
          )}
        </Step>
      </section>

      {!seesPayroll && (
        <p className="notice">You see this site's hours. Payroll submissions and pay runs are for those who run payroll.</p>
      )}
      <p className="muted small">
        {status ? `Connected to ${status.provider}. ` : ''}Hours go to payroll only once approved, every change is queued and retried
        until TeamPay confirms it, and the period locks once sent. Tronc stays in TeamPay Tronc, fed by the same hours.
        {status && status.outbox.pending > 0 && ` ${status.outbox.pending} change(s) on their way.`}
      </p>
      {message && <div className="notice">{message}</div>}
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
            <tbody>
              {!latestRun && (
                <tr><td colSpan={4} className="muted">Appears when TeamPay completes the pay run for this week.</td></tr>
              )}
              {latestRun?.variance.lines.slice(0, 15).map((l) => (
                <tr key={l.employeeId}>
                  <td>{name(l.employeeId)}</td>
                  <td className="num">{money(l.accrued)}</td>
                  <td className="num">{money(l.actual)}</td>
                  <td className={`num ${Math.abs(l.variance) > 5 ? 'bad-text' : ''}`}>{money2(l.variance)}</td>
                </tr>
              ))}
            </tbody>
            {latestRun && (
              <tfoot>
                <tr>
                  <th>Total</th>
                  <td className="num strong">{money(latestRun.variance.accrued)}</td>
                  <td className="num strong">{money(latestRun.variance.actual)}</td>
                  <td className="num strong">{money2(latestRun.variance.variance)}</td>
                </tr>
              </tfoot>
            )}
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
  created: 'created',
  queued: 'queued',
};

function summarise(res: object) {
  return Object.entries(res)
    .filter(([k, v]) => typeof v === 'number' && !(k === 'ownSkipped' && v === 0))
    .map(([k, v]) => `${v} ${WORDS[k] ?? k}`)
    .join(', ');
}
