import { useMemo, useState } from 'react';
import { employeeStatus } from '../engine/employees';
import { COURSES, requiredCourses, trainingStatus, type TrainingStatus } from '../engine/hr';
import type { Employee, RotaState } from '../engine/types';
import { csvLine, download } from './format';
import type { HrSection } from './HrFile';
import type { HrRecords } from './store';

interface Props {
  state: RotaState;
  siteIds: string[];
  today: string;
  hr: HrRecords;
  onOpen: (employee: Employee, section?: HrSection) => void;
}

const CELL: Record<TrainingStatus, { label: string; cls: string }> = {
  valid: { label: 'In date', cls: 'cell-good' },
  expiring: { label: 'Expiring', cls: 'cell-warn' },
  expired: { label: 'Expired', cls: 'cell-bad' },
  missing: { label: 'Missing', cls: 'cell-bad' },
};

export function TrainingView({ state, siteIds, today, hr, onOpen }: Props) {
  const [onlyGaps, setOnlyGaps] = useState(false);
  const records = hr.records ?? [];
  const rows = useMemo(
    () =>
      state.employees
        .filter((e) => siteIds.includes(e.siteId) && employeeStatus(e, today) !== 'left')
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => {
          const required = new Set(requiredCourses(e, state.roles).map((c) => c.name));
          const cells = COURSES.map((c) => {
            const { status, latest } = trainingStatus(records, e.id, c.name, today);
            return { course: c.name, required: required.has(c.name), status, latest };
          });
          const gaps = cells.filter((c) => (c.required && c.status !== 'valid') || (!c.required && c.status === 'expired')).length;
          return { e, cells, gaps };
        }),
    [state.employees, state.roles, siteIds, today, records],
  );
  const cellsRequired = rows.flatMap((r) => r.cells.filter((c) => c.required));
  const compliant = cellsRequired.filter((c) => c.status === 'valid' || c.status === 'expiring').length;
  const expiring = rows.flatMap((r) => r.cells).filter((c) => c.status === 'expiring').length;
  const missing = cellsRequired.filter((c) => c.status === 'missing' || c.status === 'expired').length;
  const visible = onlyGaps ? rows.filter((r) => r.gaps > 0) : rows;

  function exportCsv() {
    const header = ['Name', ...COURSES.flatMap((c) => [`${c.name} status`, `${c.name} expires`])];
    const lines = rows.map(({ e, cells }) => [
      e.name,
      ...cells.flatMap((c) => [c.status === 'missing' && !c.required ? '' : CELL[c.status].label, c.latest?.expiresOn ?? '']),
    ]);
    download(`training-matrix-${today}.csv`, [header, ...lines].map(csvLine).join('\n'));
  }

  return (
    <div>
      <div className="kpis people-kpis">
        <div className={`kpi ${compliant < cellsRequired.length ? 'warn' : 'good'}`}>
          <div className="kpi-label">Required training in date</div>
          <div className="kpi-value">{cellsRequired.length ? Math.round((compliant / cellsRequired.length) * 100) : 100}%</div>
          <div className="kpi-hint">{compliant} of {cellsRequired.length} certificates</div>
        </div>
        <div className={`kpi ${missing ? 'bad' : 'good'}`}>
          <div className="kpi-label">Missing or expired</div>
          <div className="kpi-value">{missing}</div>
          <div className="kpi-hint">What an EHO or licensing visit would find today</div>
        </div>
        <div className={`kpi ${expiring ? 'warn' : 'good'}`}>
          <div className="kpi-label">Expiring in 60 days</div>
          <div className="kpi-value">{expiring}</div>
          <div className="kpi-hint">Book refreshers now</div>
        </div>
      </div>

      <div className="people-bar">
        <span className="muted small">Required is set by role: kitchen, front of house, bar and management each have their own list.</span>
        <div className="people-actions">
          <label className="muted small check-inline">
            <input type="checkbox" checked={onlyGaps} onChange={(e) => setOnlyGaps(e.target.checked)} /> Gaps only
          </label>
          <button onClick={exportCsv} disabled={rows.length === 0}>Training matrix CSV</button>
        </div>
      </div>

      {hr.records === null && <p className="muted small">Loading training records.</p>}

      <div className="grid-wrap">
        <table className="table training-matrix">
          <thead>
            <tr>
              <th>Name</th>
              {COURSES.map((c) => <th key={c.name} className="course-head">{c.name}</th>)}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && <tr><td colSpan={COURSES.length + 1} className="muted">No one matches this view.</td></tr>}
            {visible.map(({ e, cells }) => (
              <tr key={e.id} className="clickable" onClick={() => onOpen(e, 'training')}>
                <td className="strong nowrap">{e.name}</td>
                {cells.map((c) => {
                  const show = c.required || c.status !== 'missing';
                  return (
                    <td key={c.course} className={show ? CELL[c.status].cls : 'muted'} title={c.latest ? `Passed ${c.latest.date}${c.latest.expiresOn ? `, expires ${c.latest.expiresOn}` : ''}` : undefined}>
                      {show ? (c.latest?.expiresOn && c.status !== 'missing' ? c.latest.expiresOn : CELL[c.status].label) : '-'}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
