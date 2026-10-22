import { useEffect, useMemo, useState } from 'react';
import { tipsStatement, troncCompliance, troncRun } from '../engine/tronc';
import { addDays, weekDates } from '../engine/time';
import type { RotaState, TimeEntry, TipsTaken, TroncScheme } from '../engine/types';
import { api, ApiError } from './api';
import { dayLabel, download, hours, money, money2 } from './format';
import { Kpi } from './Kpi';
import { TipsTakenPanel } from './TipsTakenPanel';
import { TroncSchemeEditor } from './TroncSchemeEditor';
import { useTimeEntries } from './useTimeEntries';

interface Props {
  state: RotaState;
  siteId: string;
  week: string;
  asOf: string;
  /** Payroll records the scheme and marks tips paid: payroll.send or pay.approve. */
  canEdit: boolean;
  /** The site's cash-up records tips taken: time.approve with costs.view there, or payroll. */
  canRecord: boolean;
}

const SOURCE_LABEL = { 'service-charge': 'Service charge', 'card-tip': 'Card tips', 'cash-pooled': 'Cash into the pool' };

export function TroncView(props: Props) {
  const [feed, setFeed] = useState<{ tips: TipsTaken[]; troncSchemes: TroncScheme[] } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    api.get<{ tips: TipsTaken[]; troncSchemes: TroncScheme[] }>('/v1/tronc').then(setFeed, (e: Error) => setFailed(e.message));
  }, []);
  // Twelve weeks, for any worker's tips record, through the week shown.
  const { entries, error } = useTimeEntries(props.siteId, addDays(props.week, -7 * 11), addDays(props.week, 6));
  if (failed || error) return <p className="muted">{failed ?? error}</p>;
  if (!feed || !entries) return <p className="muted">Loading tips and clocked hours.</p>;
  const saved = (scheme: TroncScheme) => setFeed({ ...feed, troncSchemes: [...feed.troncSchemes.filter((s) => s.siteId !== scheme.siteId), scheme] });
  // The server answers with the week's tips as they now stand: they replace the same week's in the feed.
  const paid = (week: TipsTaken[]) => {
    const ids = new Set(week.map((t) => t.id));
    setFeed({ ...feed, tips: [...feed.tips.filter((t) => !ids.has(t.id)), ...week] });
  };
  // One figure per site, day and source: a saved figure replaces the one it corrects, and none removes it.
  const taken = ({ siteId, date, source, tip }: { siteId: string; date: string; source: TipsTaken['source']; tip: TipsTaken | null }) =>
    setFeed((f) => f && { ...f, tips: [...f.tips.filter((t) => !(t.siteId === siteId && t.date === date && t.source === source)), ...(tip ? [tip] : [])] });
  return <Tronc {...props} state={{ ...props.state, ...feed }} entries={entries} onSaved={saved} onPaid={paid} onTaken={taken} />;
}

type TroncProps = Props & {
  entries: TimeEntry[];
  onSaved: (scheme: TroncScheme) => void;
  onPaid: (tips: TipsTaken[]) => void;
  onTaken: (change: { siteId: string; date: string; source: TipsTaken['source']; tip: TipsTaken | null }) => void;
};

function Tronc({ state, siteId, week, asOf, entries, canEdit, canRecord, onSaved, onPaid, onTaken }: TroncProps) {
  const scheme = state.troncSchemes?.find((s) => s.siteId === siteId);
  const [editing, setEditing] = useState(false);
  const [paidOn, setPaidOn] = useState(asOf);
  const [paying, setPaying] = useState(false);
  const [payNote, setPayNote] = useState<string | null>(null);
  const weekTips = (state.tips ?? []).filter((t) => t.siteId === siteId && weekDates(week).includes(t.date));
  const unpaidTips = weekTips.filter((t) => !t.paidOn);
  // Each payment made that week, by its date, with what it paid: each can be taken back on its own.
  const payments = [...new Set(weekTips.flatMap((t) => (t.paidOn ? [t.paidOn] : [])))]
    .sort()
    .map((date) => ({ date, amount: weekTips.filter((t) => t.paidOn === date).reduce((s, t) => s + t.amount, 0) }));

  async function markPaid(change: { paidOn: string } | { undo: string }) {
    setPaying(true);
    setPayNote(null);
    try {
      const res = await api.post<{ count: number; amount: number; tips: TipsTaken[] }>('/v1/tronc/tips/paid', { siteId, weekStart: week, ...change });
      onPaid(res.tips);
      setPayNote('paidOn' in change ? `${money2(res.amount)} marked paid on ${dayLabel(change.paidOn).date}.` : `${money2(res.amount)} taken back off. It counts as unpaid again.`);
    } catch (err) {
      setPayNote(err instanceof ApiError || err instanceof Error ? err.message : String(err));
    } finally {
      setPaying(false);
    }
  }
  const run = useMemo(() => troncRun(state, entries, siteId, week, asOf), [state, entries, siteId, week, asOf]);
  const issues = useMemo(() => troncCompliance(state, entries, siteId, week, asOf), [state, entries, siteId, week, asOf]);
  const employee = (id: string) => state.employees.find((e) => e.id === id);
  const saving = run.niSaving.employer + run.niSaving.employee;
  const traded = weekDates(week).some((d) => d < asOf);

  function payrollCsv() {
    const header = 'Employee,Clocked hours,Points,Tronc payment,NI treatment';
    const treatment = run.independent ? 'Independent tronc: PAYE only, no Class 1 NI' : 'Employer allocation: PAYE and Class 1 NI';
    const rows = run.shares.map((s) => [employee(s.employeeId)?.name, s.hours, s.points, s.amount.toFixed(2), treatment].join(','));
    download(`preshift-tronc-${siteId}-${week}.csv`, [header, ...rows].join('\n'));
  }

  function statement(employeeId: string) {
    const rows = tipsStatement(state, entries, employeeId, addDays(week, -7 * 11), week, asOf);
    const header = 'Week commencing,Clocked hours,Tips paid';
    download(
      `preshift-tips-record-${employee(employeeId)?.name.replace(/\s+/g, '-').toLowerCase()}.csv`,
      [header, ...rows.map((r) => [r.weekStartDate, r.hours, r.amount.toFixed(2)].join(','))].join('\n'),
    );
  }

  const siteName = state.sites.find((s) => s.id === siteId)?.name ?? siteId;
  const editor = (
    <TroncSchemeEditor
      siteId={siteId}
      siteName={siteName}
      roles={state.roles}
      scheme={scheme}
      today={asOf}
      onSaved={(s) => { onSaved(s); setEditing(false); }}
      onCancel={() => setEditing(false)}
    />
  );
  const cashUp = (
    <TipsTakenPanel
      siteId={siteId}
      week={week}
      asOf={asOf}
      tips={(state.tips ?? []).filter((t) => t.siteId === siteId)}
      noServiceCharge={scheme?.serviceCharge === 'none'}
      canRecord={canRecord}
      onChanged={onTaken}
    />
  );
  if (!scheme) {
    if (editing) return editor;
    return (
      <div className="tronc">
        <p className="muted">No tronc scheme recorded for this site yet. {canEdit ? 'Record the one the troncmaster runs, and the allocation follows.' : 'Payroll records it here.'}</p>
        {canEdit && <button onClick={() => setEditing(true)}>Record the scheme</button>}
        {cashUp}
      </div>
    );
  }
  if (editing) return editor;

  return (
    <div className="tronc">
      <p className="muted intro">
        Every penny of tips and service charge belongs to the team. This splits it on clocked hours, so whoever stayed
        for the close is paid for it, and shows the tax: run by an independent troncmaster, the payments carry income tax
        but no National Insurance for either side.
      </p>

      <section className="kpis">
        <Kpi label="Taken this week" value={money2(run.received)} hint={traded ? 'Days traded so far' : 'Nothing traded yet'} />
        <Kpi
          label="Passed on"
          value={money2(run.allocated)}
          hint={run.unallocated > 0 ? `${money2(run.unallocated)} held for next run` : 'All of it'}
          tone={run.unallocated > 0 ? 'warn' : run.received > 0 ? 'good' : ''}
        />
        <Kpi
          label={run.independent ? 'NI saved by the tronc' : 'NI paid on tips'}
          value={money2(saving)}
          hint={`${money2(run.niSaving.employer)} employer, ${money2(run.niSaving.employee)} staff`}
          tone={run.independent ? 'good' : saving > 0 ? 'bad' : ''}
        />
        <Kpi label="A year at this rate" value={money(saving * 52)} hint={run.independent ? 'Saved' : 'Could be saved'} tone={run.independent ? 'good' : 'warn'} />
        <Kpi
          label="VAT in service charge"
          value={money2(run.vatOnServiceCharge)}
          hint={scheme.serviceCharge === 'mandatory' ? 'Mandatory charge' : 'Discretionary: no VAT'}
          tone={run.vatOnServiceCharge > 0 ? 'bad' : 'good'}
        />
        <Kpi
          label="Pay by"
          value={run.paid ? 'Paid' : run.payBy ? `${dayLabel(run.payBy).date}` : 'Nothing due'}
          hint="End of the following month"
          tone={run.paid ? 'good' : ''}
        />
      </section>

      {issues.length > 0 && (
        <ul className="issues">
          {issues.map((i) => (
            <li key={i.code} className={i.severity}>{i.message}</li>
          ))}
        </ul>
      )}

      <div className="tronc-grid">
        <div className="panel">
          <div className="section-head">
            <h3>Scheme</h3>
            {canEdit && <button className="link" onClick={() => setEditing(true)}>Change</button>}
          </div>
          <dl className="facts">
            <dt>Troncmaster</dt>
            <dd>{scheme.troncmaster}</dd>
            <dt>Allocation decided by</dt>
            <dd>{scheme.independent ? 'The troncmaster, independently of the business' : <span className="bad-text">The business</span>}</dd>
            <dt>Service charge</dt>
            <dd>{scheme.serviceCharge === 'none' ? 'None' : scheme.serviceCharge === 'mandatory' ? 'Mandatory' : 'Discretionary'}</dd>
            <dt>Written policy</dt>
            <dd>{scheme.policyPublishedOn ?? <span className="bad-text">None</span>}</dd>
            <dt>Last reviewed with staff</dt>
            <dd>{scheme.lastReviewedOn ?? <span className="warn-text">Never</span>}</dd>
            {scheme.departmentShares && (
              <>
                <dt>Department split</dt>
                <dd>
                  {Object.entries(scheme.departmentShares)
                    .map(([d, share]) => `${d} ${Math.round((share ?? 0) * 100)}%`)
                    .join(', ')}
                </dd>
              </>
            )}
          </dl>
          <h4>Points per clocked hour</h4>
          <table className="table">
            <tbody>
              {state.roles.map((r) => (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td className="num">{scheme.pointsPerHour[r.id] ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {scheme.updatedBy && (
            <p className="small muted">Recorded by {scheme.updatedBy}{scheme.updatedAt ? ` on ${dayLabel(scheme.updatedAt.slice(0, 10)).date}` : ''}.</p>
          )}
          <p className="small muted">
            The troncmaster sets points, not the business. Changing the scheme is a change to the policy: consult staff and
            republish it.
          </p>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h3>This week's allocation</h3>
            <div className="close-actions">
              <button disabled={run.shares.length === 0} onClick={payrollCsv}>Download for payroll</button>
            </div>
          </div>
          <p className="small muted">
            {Object.entries(run.bySource)
              .filter(([, v]) => v > 0)
              .map(([k, v]) => `${SOURCE_LABEL[k as keyof typeof SOURCE_LABEL]} ${money2(v)}`)
              .join(' · ') || 'No tips taken on the days traded.'}
          </p>
          {run.shares.length > 0 && (
            <div className="grid-wrap flat">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th className="num">Clocked</th>
                    <th className="num">Points</th>
                    <th className="num">Tronc</th>
                    <th className="num">Per hour</th>
                    <th className="num">NI {run.independent ? 'saved' : 'paid'}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {run.shares.map((s) => (
                    <tr key={s.employeeId}>
                      <td>{employee(s.employeeId)?.name}</td>
                      <td className="num">{hours(s.hours)}</td>
                      <td className="num">{s.points.toFixed(0)}</td>
                      <td className="num strong">{money2(s.amount)}</td>
                      <td className="num">{money2(s.amount / s.hours)}</td>
                      <td className="num">{money2(s.employerNi + s.employeeNi)}</td>
                      <td className="num">
                        <button className="link" onClick={() => statement(s.employeeId)}>Tips record</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th>Total</th>
                    <td className="num">{hours(run.shares.reduce((a, s) => a + s.hours, 0))}</td>
                    <td />
                    <td className="num strong">{money2(run.allocated)}</td>
                    <td />
                    <td className="num">{money2(saving)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          {canEdit && weekTips.length > 0 && (
            <div className="row-actions">
              {unpaidTips.length > 0 && (
                <>
                  <label className="small">
                    Paid through payroll on{' '}
                    <input type="date" max={asOf} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
                  </label>
                  <button disabled={paying || !paidOn} onClick={() => void markPaid({ paidOn })}>
                    Mark {money2(unpaidTips.reduce((s, t) => s + t.amount, 0))} paid
                  </button>
                </>
              )}
              {payments.map((p) => (
                <span key={p.date} className="small">
                  {money2(p.amount)} paid on {dayLabel(p.date).date}.{' '}
                  <button className="link" disabled={paying} onClick={() => void markPaid({ undo: p.date })}>Undo</button>
                </span>
              ))}
            </div>
          )}
          {payNote && <p className="small">{payNote}</p>}
          <p className="small muted">
            Tips never count towards minimum wage and are not labour cost: they pass through. Any worker can ask for their
            tips record and must have it within four weeks; "Tips record" gives the last twelve weeks.
          </p>
        </div>
      </div>
      {cashUp}
    </div>
  );
}
