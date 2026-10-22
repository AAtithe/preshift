import { useEffect, useMemo, useState } from 'react';
import { accrualAccuracy, type PayRunSummary } from '../engine/reports';
import type { RotaState } from '../engine/types';
import { api } from './api';
import { dayLabel, download, money, money2, pct, signed, slug, toCsv } from './format';

interface Props {
  state: RotaState;
  entityIds: string[];
  scopeName: string;
}

export function PayrollAccuracy({ state, entityIds, scopeName }: Props) {
  const [runs, setRuns] = useState<PayRunSummary[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .get<PayRunSummary[]>('/v1/payroll/runs')
      .then((list) => live && setRuns(list))
      .catch(() => live && setRuns([]));
    return () => { live = false; };
  }, []);

  // Runs from before per-scheme payroll carry no company; they belong to the only one there was.
  const inScope = (r: PayRunSummary) => entityIds.includes(r.entityId ?? state.entities[0]?.id ?? '');
  const report = useMemo(() => accrualAccuracy((runs ?? []).filter(inScope)), [runs, entityIds.join()]);
  const entityName = (id?: string) => state.entities.find((e) => e.id === (id ?? state.entities[0]?.id))?.name ?? '';
  const personName = (id: string) => state.employees.find((e) => e.id === id)?.name ?? id;

  if (!runs) return <p className="muted">Loading</p>;
  if (report.runs.length === 0) {
    return <p className="muted">No pay runs have come back yet. Once TeamPay completes a run, it lands here against the accrual sent with its hours. In the demo, send hours and run payroll on the Payroll tab.</p>;
  }

  function exportCsv() {
    const header = ['Period start', 'Period end', 'Company', 'Accrued', 'Payroll actual', 'Variance', 'Variance %', 'Within tolerance'];
    const rows = report.runs.map((r) => [r.periodStart, r.periodEnd, entityName(r.entityId), r.variance.accrued, r.variance.actual, r.variance.variance, r.variance.variancePct * 100, r.withinTolerance ? 'Yes' : 'No']);
    download(`preshift-payroll-accuracy-${slug(scopeName)}.csv`, toCsv([header, ...rows]));
  }

  const hitRate = report.within / report.runs.length;
  return (
    <>
      <div className="kpis report-kpis">
        <div className="kpi">
          <div className="kpi-label">Runs inside {pct(report.tolerance, 0)}</div>
          <div className={`kpi-value ${hitRate === 1 ? 'good-text' : hitRate < 0.75 ? 'bad-text' : 'warn-text'}`}>{report.within} of {report.runs.length}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Average miss</div>
          <div className={`kpi-value ${report.meanAbsolutePct <= report.tolerance ? 'good-text' : 'bad-text'}`}>{pct(report.meanAbsolutePct, 2)}</div>
          <div className="kpi-hint">Size of the miss, ignoring direction</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Net over all runs</div>
          <div className="kpi-value">{signed(report.variance, money2)}</div>
          <div className="kpi-hint">{report.variance > 0 ? 'Payroll cost more than accrued' : report.variance < 0 ? 'Accrued more than payroll cost' : 'Even'}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Payroll actual</div>
          <div className="kpi-value">{money(report.actual)}</div>
          <div className="kpi-hint">Accrued {money(report.accrued)}</div>
        </div>
      </div>

      <div className="close-actions report-actions">
        <span className="muted small">
          Click a run to see who made up the difference.
          {report.superseded > 0 && ` ${report.superseded} earlier runs were replaced by a rerun of the same period and are left out.`}
        </span>
        <button onClick={exportCsv}>Download CSV</button>
      </div>

      <div className="grid-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Pay period</th>
              <th>Company</th>
              <th className="num">Accrued</th>
              <th className="num">Payroll</th>
              <th className="num">Variance</th>
              <th className="num">%</th>
              <th>Check</th>
            </tr>
          </thead>
          <tbody>
            {report.runs.map((r) => (
              <RunRows key={r.id} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} run={r} entity={entityName(r.entityId)} personName={personName} />
            ))}
          </tbody>
        </table>
      </div>

      {report.repeatOffenders.length > 0 && (
        <div className="grid-wrap report-block">
          <div className="entity-journal-head">
            <h3>Missed the same way more than once</h3>
            <span className="muted small">A one-off miss is a late clock-out. The same miss every week is a rate, a contract or a pension setting that differs between Preshift and payroll. Fix the record.</span>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th className="num">Runs</th>
                <th className="num">Total variance</th>
              </tr>
            </thead>
            <tbody>
              {report.repeatOffenders.map((p) => (
                <tr key={p.employeeId}>
                  <td>{personName(p.employeeId)}</td>
                  <td className="num">{p.runs}</td>
                  <td className={`num ${p.variance > 0 ? 'bad-text' : 'good-text'}`}>{signed(p.variance, money2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function RunRows({ run, entity, open, onToggle, personName }: { run: ReturnType<typeof accrualAccuracy>['runs'][number]; entity: string; open: boolean; onToggle: () => void; personName: (id: string) => string }) {
  const v = run.variance;
  const lines = v.lines.filter((l) => Math.abs(l.variance) >= 0.5).slice(0, 10);
  return (
    <>
      <tr className="clickable" onClick={onToggle} aria-expanded={open}>
        <td>{dayLabel(run.periodStart).date} to {dayLabel(run.periodEnd).date}</td>
        <td>{entity}</td>
        <td className="num">{money2(v.accrued)}</td>
        <td className="num">{money2(v.actual)}</td>
        <td className={`num ${run.withinTolerance ? '' : 'bad-text'}`}>{signed(v.variance, money2)}</td>
        <td className={`num ${run.withinTolerance ? '' : 'bad-text'}`}>{signed(v.variancePct, (n) => pct(n, 2))}</td>
        <td>{run.withinTolerance ? <span className="good-text">Inside</span> : <span className="tag bad">Outside</span>}</td>
      </tr>
      {open && (
        <tr className="detail">
          <td colSpan={7}>
            {lines.length === 0 ? (
              <span className="muted small">Nobody was out by 50p or more.</span>
            ) : (
              <table className="table compact">
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.employeeId}>
                      <td>{personName(l.employeeId)}</td>
                      <td className="num muted">Accrued {money2(l.accrued)}</td>
                      <td className="num muted">Payroll {money2(l.actual)}</td>
                      <td className={`num ${l.variance > 0 ? 'bad-text' : 'good-text'}`}>{signed(l.variance, money2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
