import { useEffect, useMemo, useState } from 'react';
import { ONBOARDING_AHEAD_DAYS, ONBOARDING_WINDOW_DAYS, onboardingList, type Onboarding, type OnboardingArea, type OnboardingStep } from '../engine/onboarding';
import type { Employee, RotaState } from '../engine/types';
import { api } from './api';
import { csvLine, download } from './format';
import type { HrSection } from './HrFile';
import type { Allow } from './permissions';
import type { HrRecords } from './store';

// Onboarding: every new person in scope, from 60 days before their first day to 90 days after, as
// one checklist each. The legal steps (right to work, pay, the written statement) come first and
// are due by day one; payroll, clocking and training follow in the first weeks. A starter is done
// when every step they can be seen to have is done, and then they drop off at the end of the window.

interface Props {
  state: RotaState;
  siteIds: string[];
  today: string;
  hr: HrRecords;
  allow: Allow;
  onEdit: (employee: Employee) => void;
  onOpenHr: (employee: Employee, section?: HrSection) => void;
  /** Payroll and Clock in run one site at a time. */
  onOpenSite: (siteId: string, tab: 'payroll' | 'clock') => void;
}

interface StaffLoginRow { employeeId: string; status: 'active' | 'invited' | 'expired' }

const STATE_LABEL: Record<OnboardingStep['state'], string> = { done: 'Done', todo: 'To do', late: 'Late', hidden: '' };
const when = (iso?: string) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '');

function startLabel(o: Onboarding) {
  if (o.daysToStart === null) return '';
  if (o.daysToStart > 1) return `Starts in ${o.daysToStart} days`;
  if (o.daysToStart === 1) return 'Starts tomorrow';
  if (o.daysToStart === 0) return 'Starts today';
  return `Day ${-o.daysToStart + 1}`;
}

export function OnboardingView({ state, siteIds, today, hr, allow, onEdit, onOpenHr, onOpenSite }: Props) {
  const [logins, setLogins] = useState<Map<string, StaffLoginRow['status']>>(new Map());
  const [open, setOpen] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);

  // Staff app status is the server's to know; without the right to see it, clocking reads from the card alone.
  useEffect(() => {
    api.get<StaffLoginRow[]>('/v1/staff-logins').then((rows) => setLogins(new Map(rows.map((r) => [r.employeeId, r.status])))).catch(() => setLogins(new Map()));
  }, []);

  const list = useMemo(
    () =>
      onboardingList(
        state.employees.filter((e) => siteIds.includes(e.siteId)),
        hr.records ?? [],
        state.roles,
        today,
        (e) => ({ hr: allow('hr.view', e.siteId), pay: allow('costs.view', e.siteId) }),
        (e) => ({ staffApp: logins.get(e.id) }),
      ),
    [state.employees, state.roles, siteIds, hr.records, today, allow, logins],
  );

  const inProgress = list.filter((o) => !o.complete);
  const blocked = inProgress.filter((o) => o.steps.some((s) => s.blocking && s.state !== 'done' && s.state !== 'hidden'));
  const startingSoon = list.filter((o) => o.daysToStart !== null && o.daysToStart >= 0 && o.daysToStart <= 14);
  const late = list.reduce((n, o) => n + o.late, 0);
  const shown = showDone ? list : inProgress;
  const siteName = (id: string) => state.sites.find((s) => s.id === id)?.name ?? id;
  const roleName = (id?: string) => state.roles.find((r) => r.id === id)?.name ?? '';

  function fix(o: Onboarding, step: OnboardingStep) {
    const area: OnboardingArea = step.area;
    if (area === 'record') return onEdit(o.employee);
    if (area === 'profile') return onOpenHr(o.employee, 'profile');
    if (area === 'training') return onOpenHr(o.employee, 'training');
    return onOpenSite(o.employee.siteId, area === 'payroll' ? 'payroll' : 'clock');
  }

  function exportCsv() {
    const header = ['Name', 'Site', 'Role', 'First day', 'Done', 'Of', 'Outstanding'];
    const lines = list.map((o) => [
      o.employee.name, siteName(o.employee.siteId), roleName(o.employee.roleIds[0]), o.firstDay ?? '', o.done, o.total,
      o.steps.filter((s) => s.state === 'todo' || s.state === 'late').map((s) => s.label).join('; '),
    ]);
    download(`onboarding-${today}.csv`, [header, ...lines].map(csvLine).join('\n'));
  }

  return (
    <div className="onboarding">
      <p className="muted small">
        Everyone starting in the next {ONBOARDING_AHEAD_DAYS} days or who started in the last {ONBOARDING_WINDOW_DAYS}. Finish each person
        once, properly: the legal steps by their first day, payroll and clocking in their first week, training in their first month.
      </p>
      <div className="kpis people-kpis">
        <div className="kpi">
          <div className="kpi-label">Onboarding</div>
          <div className="kpi-value">{inProgress.length}</div>
          <div className="kpi-hint">{list.length - inProgress.length} complete in the window</div>
        </div>
        <div className={`kpi ${startingSoon.length ? 'warn' : 'good'}`}>
          <div className="kpi-label">Starting in 14 days</div>
          <div className="kpi-value">{startingSoon.length}</div>
          <div className="kpi-hint">Paperwork due before day one</div>
        </div>
        <div className={`kpi ${blocked.length ? 'bad' : 'good'}`}>
          <div className="kpi-label">Cannot work yet</div>
          <div className="kpi-value">{blocked.length}</div>
          <div className="kpi-hint">Right to work or record not complete</div>
        </div>
        <div className={`kpi ${late ? 'bad' : 'good'}`}>
          <div className="kpi-label">Steps overdue</div>
          <div className="kpi-value">{late}</div>
          <div className="kpi-hint">Past the date they were due</div>
        </div>
      </div>

      {hr.records === null && <p className="muted small">Loading training records.</p>}

      <div className="people-bar">
        <h3 className="section-title">New people</h3>
        <div className="people-actions">
          <label className="check small">
            <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Show complete
          </label>
          <button onClick={exportCsv} disabled={list.length === 0}>Onboarding CSV</button>
        </div>
      </div>

      {shown.length === 0 ? (
        <p className="muted">
          {list.length === 0
            ? 'Nobody is starting or new in this scope. Add a starter from Staff and they appear here with their checklist.'
            : 'Everyone new in this scope is fully onboarded.'}
        </p>
      ) : (
        <div className="grid-wrap">
          <table className="table people onboarding-table">
            <thead>
              <tr>
                <th>Name</th>
                {siteIds.length > 1 && <th>Site</th>}
                <th>First day</th>
                <th>Progress</th>
                <th>Next step</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((o) => {
                const next = o.steps.find((s) => s.state === 'late' && s.blocking) ?? o.steps.find((s) => s.state !== 'done' && s.state !== 'hidden' && s.blocking) ??
                  o.steps.find((s) => s.state === 'late') ?? o.steps.find((s) => s.state === 'todo');
                const expanded = open === o.employee.id;
                const toggle = () => setOpen(expanded ? null : o.employee.id);
                return [
                  <tr key={o.employee.id} className="clickable" tabIndex={0} aria-expanded={expanded} onClick={toggle} onKeyDown={(ev) => { if (ev.key === 'Enter') toggle(); }}>
                    <td><span className="strong">{o.employee.name}</span><div className="muted small">{roleName(o.employee.roleIds[0])}</div></td>
                    {siteIds.length > 1 && <td className="muted">{siteName(o.employee.siteId)}</td>}
                    <td>{when(o.firstDay)}<div className="muted small">{startLabel(o)}</div></td>
                    <td>
                      <div className="onboarding-progress" aria-label={`${o.done} of ${o.total} done`}>
                        <span style={{ width: `${o.total ? (o.done / o.total) * 100 : 0}%` }} className={o.complete ? 'good' : o.blocked ? 'bad' : 'warn'} />
                      </div>
                      <div className="muted small">{o.done} of {o.total}</div>
                    </td>
                    <td>
                      {next ? (
                        <span className={next.state === 'late' || next.blocking ? 'bad-text' : undefined}>{next.label}{next.due ? <span className="muted small"> by {when(next.due)}</span> : null}</span>
                      ) : (
                        <span className="badge good">Onboarded</span>
                      )}
                    </td>
                  </tr>,
                  expanded && (
                    <tr key={`${o.employee.id}-steps`} className="onboarding-detail">
                      <td colSpan={siteIds.length > 1 ? 5 : 4}>
                        <ol className="onboarding-steps">
                          {o.steps.filter((s) => s.state !== 'hidden').map((s) => (
                            <li key={s.code} className={s.state}>
                              <span className={`badge ${s.state === 'done' ? 'good' : s.state === 'late' || s.blocking ? 'bad' : 'warn'}`}>{STATE_LABEL[s.state]}</span>
                              <span className="strong">{s.label}</span>
                              {s.blocking && s.state !== 'done' && <span className="muted small"> before any shift</span>}
                              <div className="muted small">{s.detail}{s.state !== 'done' && s.due ? ` Due ${when(s.due)}.` : ''}</div>
                              {s.state !== 'done' && <button className="link" onClick={() => fix(o, s)}>Open</button>}
                            </li>
                          ))}
                        </ol>
                        {o.steps.some((s) => s.state === 'hidden') && (
                          <p className="muted small">Some steps are on the personnel file or pay, which your roles do not show. Whoever holds them sees the full list.</p>
                        )}
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
