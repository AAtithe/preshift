import { useMemo, useState } from 'react';
import { employeeStatus } from '../engine/employees';
import { hrChecks, hrSummary, lengthOfService } from '../engine/hr';
import type { Employee, RotaState } from '../engine/types';
import { csvLine, download, pct } from './format';
import type { HrSection } from './HrFile';
import type { HrRecords } from './store';

interface Props {
  state: RotaState;
  siteIds: string[];
  today: string;
  hr: HrRecords;
  onOpen: (employee: Employee, section?: HrSection) => void;
}

// Which part of the file a check is fixed in, so a click lands on the right form.
function sectionFor(code: string): HrSection {
  const prefix = code.split(':')[0];
  if (['statement', 'contract-signed', 'ni-number', 'emergency-contact', 'probation', 'fixed-term'].includes(prefix)) return 'profile';
  if (['off', 'fit-note', 'rtw', 'bradford'].includes(prefix)) return 'absence';
  if (prefix === 'training') return 'training';
  if (prefix === 'review-due') return 'reviews';
  if (prefix === 'case' || prefix === 'warning') return 'cases';
  return 'summary';
}

export function HrOverview({ state, siteIds, today, hr, onOpen }: Props) {
  const [query, setQuery] = useState('');
  const people = useMemo(() => state.employees.filter((e) => siteIds.includes(e.siteId)), [state.employees, siteIds]);
  const summary = useMemo(() => hrSummary(people, today), [people, today]);
  const rows = useMemo(
    () =>
      people
        .filter((e) => employeeStatus(e, today) !== 'left')
        .map((e) => ({ e, checks: hrChecks(e, hr.records ?? [], state.roles, today, state.shifts) }))
        .sort((a, b) => a.e.name.localeCompare(b.e.name)),
    [people, hr.records, state.roles, state.shifts, today],
  );
  const actions = rows
    .flatMap(({ e, checks }) => checks.map((c) => ({ e, c })))
    .sort((a, b) => (a.c.severity === b.c.severity ? a.e.name.localeCompare(b.e.name) : a.c.severity === 'block' ? -1 : 1));
  const blocking = actions.filter((a) => a.c.severity === 'block').length;
  const siteName = (id: string) => state.sites.find((s) => s.id === id)?.name ?? id;
  const roleName = (id: string) => state.roles.find((r) => r.id === id)?.name ?? id;
  const nameOf = (id?: string) => state.employees.find((e) => e.id === id)?.name;
  const visible = rows.filter((r) => !query || r.e.name.toLowerCase().includes(query.toLowerCase()));

  function exportDirectory() {
    const header = ['Name', 'Site', 'Job title', 'Contract', 'Start date', 'Service', 'Line manager', 'Email', 'Phone', 'Emergency contact', 'Emergency phone', 'Open actions'];
    const lines = rows.map(({ e, checks }) => [
      e.name, siteName(e.siteId), e.hr?.jobTitle ?? roleName(e.roleIds[0]), e.hr?.contractType ?? '', e.startDate ?? '',
      lengthOfService(e, today), nameOf(e.hr?.managerId) ?? '', e.email ?? '', e.phone ?? '',
      e.hr?.emergencyContact?.name ?? '', e.hr?.emergencyContact?.phone ?? '', checks.length,
    ]);
    download(`staff-directory-${today}.csv`, [header, ...lines].map(csvLine).join('\n'));
  }

  return (
    <div>
      <div className="kpis people-kpis">
        <div className="kpi">
          <div className="kpi-label">Headcount</div>
          <div className="kpi-value">{summary.headcount}</div>
          <div className="kpi-hint">{summary.startersLastYear} joined, {summary.leaversLastYear} left in 12 months</div>
        </div>
        <div className={`kpi ${summary.turnover > 0.5 ? 'warn' : 'good'}`}>
          <div className="kpi-label">Staff turnover</div>
          <div className="kpi-value">{pct(summary.turnover, 0)}</div>
          <div className="kpi-hint">Leavers over average headcount. Average service {summary.averageTenureYears.toFixed(1)} years</div>
        </div>
        <div className={`kpi ${summary.offToday > 0 ? 'warn' : 'good'}`}>
          <div className="kpi-label">Absence</div>
          <div className="kpi-value">{summary.sickDaysPerHead.toFixed(1)}</div>
          <div className="kpi-hint">Sick days per head in 12 months. {summary.offToday} off today</div>
        </div>
        <div className={`kpi ${blocking > 0 ? 'bad' : actions.length > 0 ? 'warn' : 'good'}`}>
          <div className="kpi-label">HR actions</div>
          <div className="kpi-value">{actions.length}</div>
          <div className="kpi-hint">{blocking} legal gaps to close first</div>
        </div>
      </div>

      {hr.records === null && <p className="muted small">Loading training, reviews and cases.</p>}

      <h3 className="section-title">To act on</h3>
      {actions.length === 0 ? (
        <p className="muted">Every file in scope is in order.</p>
      ) : (
        <ul className="issues hr-actions">
          {actions.slice(0, 40).map(({ e, c }) => (
            <li key={`${e.id}-${c.code}`} className={`${c.severity} clickable`} onClick={() => onOpen(e, sectionFor(c.code))}>
              <span className="strong">{e.name}</span> <span className="muted small">{siteIds.length > 1 ? siteName(e.siteId) : ''}</span> {c.message}
            </li>
          ))}
          {actions.length > 40 && <li className="muted">and {actions.length - 40} more. Open a file to see them all.</li>}
        </ul>
      )}

      <div className="people-bar">
        <h3 className="section-title">Directory</h3>
        <div className="people-actions">
          <input type="search" placeholder="Search name" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search staff" />
          <button onClick={exportDirectory} disabled={rows.length === 0}>Directory CSV</button>
        </div>
      </div>
      <div className="grid-wrap">
        <table className="table people">
          <thead>
            <tr>
              <th>Name</th>
              {siteIds.length > 1 && <th>Site</th>}
              <th>Job title</th>
              <th>Contract</th>
              <th>Service</th>
              <th>Line manager</th>
              <th>Emergency contact</th>
              <th className="num">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && <tr><td colSpan={8} className="muted">No one matches this view.</td></tr>}
            {visible.map(({ e, checks }) => (
              <tr key={e.id} className="clickable" tabIndex={0} onClick={() => onOpen(e)} onKeyDown={(ev) => { if (ev.key === 'Enter') onOpen(e); }}>
                <td><span className="strong">{e.name}</span>{e.email && <div className="muted small">{e.email}</div>}</td>
                {siteIds.length > 1 && <td className="muted">{siteName(e.siteId)}</td>}
                <td>{e.hr?.jobTitle ?? roleName(e.roleIds[0])}</td>
                <td className="muted">{e.hr?.contractType ?? 'Not set'}{e.hr?.fixedTermEnd ? ` to ${e.hr.fixedTermEnd}` : ''}</td>
                <td className="muted">{lengthOfService(e, today)}</td>
                <td className="muted">{nameOf(e.hr?.managerId) ?? '-'}</td>
                <td className="muted">{e.hr?.emergencyContact ? `${e.hr.emergencyContact.name}, ${e.hr.emergencyContact.phone}` : <span className="warn-text">None</span>}</td>
                <td className={`num${checks.some((c) => c.severity === 'block') ? ' bad-text' : ''}`}>{checks.length || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
