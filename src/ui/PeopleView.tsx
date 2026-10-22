import { useMemo, useState } from 'react';
import { employeeStatus, reviewEmployee, type EmployeeStatus } from '../engine/employees';
import { ageOn } from '../engine/time';
import type { Employee, RotaState } from '../engine/types';
import { download, money } from './format';

interface Props {
  state: RotaState;
  siteId: string;
  today: string;
  onEdit: (employee: Employee) => void;
  /** Absent when the person cannot add starters at this site. */
  onAdd?: () => void;
}

type Filter = 'current' | 'starter' | 'leaving' | 'left' | 'attention' | 'all';

const STATUS_LABEL: Record<EmployeeStatus, string> = {
  starter: 'Starting',
  active: 'Active',
  leaving: 'Leaving',
  left: 'Left',
};

function csvCell(value: string | number) {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function PeopleView({ state, siteId, today, onEdit, onAdd }: Props) {
  const [filter, setFilter] = useState<Filter>('current');
  const [query, setQuery] = useState('');

  const rows = useMemo(
    () =>
      state.employees
        .filter((e) => e.siteId === siteId)
        .map((e) => ({ e, status: employeeStatus(e, today), checks: reviewEmployee(e, today) }))
        .sort((a, b) => a.e.name.localeCompare(b.e.name)),
    [state.employees, siteId, today],
  );

  const counts = {
    current: rows.filter((r) => r.status === 'active' || r.status === 'leaving').length,
    starter: rows.filter((r) => r.status === 'starter').length,
    leaving: rows.filter((r) => r.status === 'leaving').length,
    left: rows.filter((r) => r.status === 'left').length,
    attention: rows.filter((r) => r.status !== 'left' && r.checks.length > 0).length,
    all: rows.length,
  };
  const blocking = rows.filter((r) => r.status !== 'left' && r.checks.some((c) => c.severity === 'block')).length;
  const guaranteedHours = rows
    .filter((r) => r.status === 'active' || r.status === 'leaving')
    .reduce((sum, r) => sum + (r.e.payBasis === 'hourly' ? r.e.contractedHours : 0), 0);

  const visible = rows.filter((r) => {
    if (query && !r.e.name.toLowerCase().includes(query.toLowerCase())) return false;
    switch (filter) {
      case 'current': return r.status === 'active' || r.status === 'leaving';
      case 'starter': return r.status === 'starter';
      case 'leaving': return r.status === 'leaving';
      case 'left': return r.status === 'left';
      case 'attention': return r.status !== 'left' && r.checks.length > 0;
      case 'all': return true;
    }
  });

  const roleName = (id: string) => state.roles.find((r) => r.id === id)?.name ?? id;
  const siteName = state.sites.find((s) => s.id === siteId)?.name ?? siteId;

  // Starters and leavers in the shape a payroll bureau asks for.
  function exportMovements() {
    const header = ['Name', 'Movement', 'Date', 'Date of birth', 'Primary role', 'Pay basis', 'Rate', 'Contracted hours', 'Pension enrolled', 'Email'];
    const lines = rows
      .filter((r) => r.status !== 'active')
      .map(({ e, status }) => [
        e.name,
        status === 'starter' ? 'Starter' : 'Leaver',
        (status === 'starter' ? e.startDate : e.leaveDate) ?? '',
        e.dateOfBirth,
        roleName(e.roleIds[0]),
        e.payBasis,
        e.payHidden ? '' : e.payBasis === 'salaried' ? e.annualSalary : e.hourlyRate,
        e.contractedHours,
        e.pensionEnrolled ? 'Yes' : 'No',
        e.email ?? '',
      ]);
    const csv = [header, ...lines].map((l) => l.map(csvCell).join(',')).join('\n');
    download(`starters-leavers-${siteName.toLowerCase()}-${today}.csv`, csv);
  }

  const FILTERS: { id: Filter; label: string }[] = [
    { id: 'current', label: `Current (${counts.current})` },
    { id: 'starter', label: `Starting (${counts.starter})` },
    { id: 'leaving', label: `Leaving (${counts.leaving})` },
    { id: 'attention', label: `Needs attention (${counts.attention})` },
    { id: 'left', label: `Left (${counts.left})` },
    { id: 'all', label: `All (${counts.all})` },
  ];

  return (
    <div>
      <div className="kpis people-kpis">
        <div className="kpi">
          <div className="kpi-label">Headcount</div>
          <div className="kpi-value">{counts.current}</div>
          <div className="kpi-hint">{counts.starter} starting, {counts.leaving} leaving</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Guaranteed hours</div>
          <div className="kpi-value">{guaranteedHours}h</div>
          <div className="kpi-hint">Paid every week, rostered or not</div>
        </div>
        <div className={`kpi ${blocking > 0 ? 'bad' : 'good'}`}>
          <div className="kpi-label">Records blocking work</div>
          <div className="kpi-value">{blocking}</div>
          <div className="kpi-hint">Right to work, pay below the legal minimum</div>
        </div>
        <div className={`kpi ${counts.attention > 0 ? 'warn' : 'good'}`}>
          <div className="kpi-label">Need attention</div>
          <div className="kpi-value">{counts.attention}</div>
          <div className="kpi-hint">Any open record check</div>
        </div>
      </div>

      <div className="people-bar">
        <div className="day-pills">
          {FILTERS.map((f) => (
            <button key={f.id} className={filter === f.id ? 'active' : ''} onClick={() => setFilter(f.id)}>{f.label}</button>
          ))}
        </div>
        <div className="people-actions">
          <input type="search" placeholder="Search name" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search employees" />
          <button onClick={exportMovements} disabled={counts.starter + counts.leaving + counts.left === 0}>Starters and leavers CSV</button>
          {onAdd && <button className="primary" onClick={onAdd}>Add employee</button>}
        </div>
      </div>

      <div className="grid-wrap">
        <table className="table people">
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Roles</th>
              <th className="num">Pay</th>
              <th className="num">Contract</th>
              <th>Started</th>
              <th>Right to work</th>
              <th>Checks</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr><td colSpan={8} className="muted">No one matches this view.</td></tr>
            )}
            {visible.map(({ e, status, checks }) => {
              const age = e.dateOfBirth ? ageOn(e.dateOfBirth, today) : null;
              const rtw = e.rightToWork;
              return (
                <tr key={e.id} className="clickable" onClick={() => onEdit(e)} tabIndex={0} onKeyDown={(ev) => { if (ev.key === 'Enter') onEdit(e); }}>
                  <td>
                    <span className="strong">{e.name}</span>
                    {age !== null && age < 18 && <span className="tag">Under 18</span>}
                    {e.email && <div className="muted small">{e.email}</div>}
                  </td>
                  <td>
                    <span className={`status status-${status}`}>{STATUS_LABEL[status]}</span>
                    {status === 'starter' && <div className="muted small">from {e.startDate}</div>}
                    {(status === 'leaving' || status === 'left') && <div className="muted small">last day {e.leaveDate}</div>}
                  </td>
                  <td className="muted">{e.roleIds.map(roleName).join(', ')}</td>
                  <td className="num">{e.payHidden ? <span className="muted">Withheld</span> : e.payBasis === 'salaried' ? `${money(e.annualSalary)} pa` : `£${e.hourlyRate.toFixed(2)}`}</td>
                  <td className="num">{e.contractedHours ? `${e.contractedHours}h` : 'Flexible'}</td>
                  <td className="muted">{e.startDate ?? 'Not recorded'}</td>
                  <td>
                    {!rtw?.checked ? (
                      <span className="bad-text">Not checked</span>
                    ) : rtw.expiry ? (
                      <span className={rtw.expiry < today ? 'bad-text' : ''}>Until {rtw.expiry}</span>
                    ) : (
                      <span className="muted">Unlimited</span>
                    )}
                    <div className={`small ${rtw?.checked && !rtw.documents?.length ? 'warn-text' : 'muted'}`}>
                      {rtw?.documents?.length ? `${rtw.documents.length} cop${rtw.documents.length === 1 ? 'y' : 'ies'} held` : 'No copy held'}
                    </div>
                  </td>
                  <td>
                    {checks.length === 0 ? (
                      <span className="muted">None</span>
                    ) : (
                      <ul className="issues compact">
                        {checks.slice(0, 2).map((c) => <li key={c.code} className={c.severity}>{c.message}</li>)}
                        {checks.length > 2 && <li className="muted">and {checks.length - 2} more</li>}
                      </ul>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
