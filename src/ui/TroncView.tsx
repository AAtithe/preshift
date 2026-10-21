import { useMemo } from 'react';
import { tipsStatement, troncCompliance, troncRun } from '../engine/tronc';
import { addDays, weekDates } from '../engine/time';
import type { RotaState, TroncScheme } from '../engine/types';
import type { Action } from './store';
import { dayLabel, download, hours, money, money2 } from './format';
import { Kpi } from './KpiBar';

interface Props {
  state: RotaState;
  siteId: string;
  week: string;
  asOf: string;
  dispatch: (action: Action) => void;
}

const SOURCE_LABEL = { 'service-charge': 'Service charge', 'card-tip': 'Card tips', 'cash-pooled': 'Cash into the pool' };

export function TroncView({ state, siteId, week, asOf, dispatch }: Props) {
  const scheme = state.troncSchemes.find((s) => s.siteId === siteId);
  const run = useMemo(() => troncRun(state, siteId, week, asOf), [state, siteId, week, asOf]);
  const issues = useMemo(() => troncCompliance(state, siteId, week, asOf), [state, siteId, week, asOf]);
  const employee = (id: string) => state.employees.find((e) => e.id === id);
  const update = (patch: Partial<TroncScheme>) => scheme && dispatch({ type: 'updateTroncScheme', scheme: { ...scheme, ...patch } });
  const saving = run.niSaving.employer + run.niSaving.employee;
  const traded = weekDates(week).some((d) => d < asOf);

  function payrollCsv() {
    const header = 'Employee,Clocked hours,Points,Tronc payment,NI treatment';
    const treatment = run.independent ? 'Independent tronc: PAYE only, no Class 1 NI' : 'Employer allocation: PAYE and Class 1 NI';
    const rows = run.shares.map((s) => [employee(s.employeeId)?.name, s.hours, s.points, s.amount.toFixed(2), treatment].join(','));
    download(`preshift-tronc-${siteId}-${week}.csv`, [header, ...rows].join('\n'));
  }

  function statement(employeeId: string) {
    const rows = tipsStatement(state, employeeId, addDays(week, -7 * 11), week, asOf);
    const header = 'Week commencing,Clocked hours,Tips paid';
    download(
      `preshift-tips-record-${employee(employeeId)?.name.replace(/\s+/g, '-').toLowerCase()}.csv`,
      [header, ...rows.map((r) => [r.weekStartDate, r.hours, r.amount.toFixed(2)].join(','))].join('\n'),
    );
  }

  if (!scheme) return <p className="muted">No tronc scheme set up for this site.</p>;

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
          <h3>Scheme</h3>
          <dl className="facts">
            <dt>Troncmaster</dt>
            <dd>{scheme.troncmaster}</dd>
            <dt>Allocation decided by</dt>
            <dd>
              <label className="inline">
                <input type="checkbox" checked={scheme.independent} onChange={(e) => update({ independent: e.target.checked })} />
                The troncmaster, independently of the business
              </label>
            </dd>
            <dt>Service charge</dt>
            <dd>
              <select value={scheme.serviceCharge} onChange={(e) => update({ serviceCharge: e.target.value as TroncScheme['serviceCharge'] })}>
                <option value="discretionary">Discretionary</option>
                <option value="mandatory">Mandatory</option>
                <option value="none">None</option>
              </select>
            </dd>
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
          <div className="points">
            {state.roles.map((r) => (
              <label key={r.id}>
                {r.name}
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={scheme.pointsPerHour[r.id] ?? 0}
                  onChange={(e) => update({ pointsPerHour: { ...scheme.pointsPerHour, [r.id]: Number(e.target.value) } })}
                />
              </label>
            ))}
          </div>
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
              <button
                className="primary"
                disabled={run.shares.length === 0 || run.paid}
                onClick={() => dispatch({ type: 'markTipsPaid', siteId, weekStart: week, date: asOf })}
              >
                {run.paid ? 'Paid' : 'Mark paid'}
              </button>
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
          <p className="small muted">
            Tips never count towards minimum wage and are not labour cost: they pass through. Any worker can ask for their
            tips record and must have it within four weeks; "Tips record" gives the last twelve weeks.
          </p>
        </div>
      </div>
    </div>
  );
}
