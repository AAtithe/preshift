import { useMemo } from 'react';
import { employeeStatus } from '../engine/employees';
import { CASE_LABEL, PROBATION_NOTICE_DAYS, REVIEW_LABEL } from '../engine/hr';
import { addDays, daysBetween } from '../engine/time';
import type { Employee, HrRecord, RotaState } from '../engine/types';
import type { HrSection } from './HrFile';
import type { HrRecords } from './store';

interface Props {
  state: RotaState;
  siteIds: string[];
  today: string;
  hr: HrRecords;
  onOpen: (employee: Employee, section?: HrSection) => void;
}

/** Probation and reviews: who needs a conversation, and when. */
export function ReviewsView({ state, siteIds, today, hr, onOpen }: Props) {
  const people = useMemo(
    () => state.employees.filter((e) => siteIds.includes(e.siteId) && employeeStatus(e, today) !== 'left'),
    [state.employees, siteIds, today],
  );
  const records = (hr.records ?? []).filter((r) => r.kind === 'review');

  const probation = people
    .filter((e) => e.hr?.probationEnd && !e.hr.probationPassedOn)
    .sort((a, b) => a.hr!.probationEnd!.localeCompare(b.hr!.probationEnd!));

  const reviewRows = people
    .map((e) => {
      const mine = records.filter((r) => r.employeeId === e.id).sort((a, b) => b.date.localeCompare(a.date));
      const last = mine[0];
      const due = last?.nextDue ?? (last ? addDays(last.date, 365) : e.startDate && e.startDate > addDays(today, -365) ? addDays(e.startDate, 365) : today);
      return { e, last, due };
    })
    .sort((a, b) => a.due.localeCompare(b.due));
  const overdue = reviewRows.filter((r) => r.due < today).length;
  const dueSoon = reviewRows.filter((r) => r.due >= today && r.due <= addDays(today, 30)).length;

  return (
    <div>
      <div className="kpis people-kpis">
        <div className={`kpi ${probation.some((e) => e.hr!.probationEnd! < today) ? 'bad' : probation.length ? 'warn' : 'good'}`}>
          <div className="kpi-label">On probation</div>
          <div className="kpi-value">{probation.length}</div>
          <div className="kpi-hint">{probation.filter((e) => e.hr!.probationEnd! < today).length} past the end date with no outcome</div>
        </div>
        <div className={`kpi ${overdue ? 'warn' : 'good'}`}>
          <div className="kpi-label">Reviews overdue</div>
          <div className="kpi-value">{overdue}</div>
          <div className="kpi-hint">{dueSoon} more due in 30 days</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Reviews held, 12 months</div>
          <div className="kpi-value">{records.filter((r) => r.date > addDays(today, -365) && people.some((e) => e.id === r.employeeId)).length}</div>
          <div className="kpi-hint">Appraisals, one to ones and probation reviews</div>
        </div>
      </div>

      <h3 className="section-title">Probation</h3>
      <div className="grid-wrap">
        <table className="table people">
          <thead><tr><th>Name</th><th>Started</th><th>Probation ends</th><th>Status</th></tr></thead>
          <tbody>
            {probation.length === 0 && <tr><td colSpan={4} className="muted">No one is on probation.</td></tr>}
            {probation.map((e) => {
              const end = e.hr!.probationEnd!;
              const days = daysBetween(today, end);
              return (
                <tr key={e.id} className="clickable" onClick={() => onOpen(e, 'reviews')}>
                  <td className="strong">{e.name}</td>
                  <td>{e.startDate ?? '-'}</td>
                  <td>{end}</td>
                  <td>
                    {days < 0 ? <span className="bad-text">Ended {-days} days ago, no outcome</span>
                      : days <= PROBATION_NOTICE_DAYS ? <span className="warn-text">Review due in {days} days</span>
                      : <span className="muted">{days} days to go</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        Record the outcome on the person's file under Contract and details. Unless the contract says otherwise, a probation
        that runs out with nothing said is generally taken as passed, so decide before the end date and confirm it in writing.
      </p>

      <h3 className="section-title">Appraisals and one to ones</h3>
      <div className="grid-wrap">
        <table className="table people">
          <thead><tr><th>Name</th><th>Last review</th><th>Outcome</th><th>Next due</th></tr></thead>
          <tbody>
            {reviewRows.map(({ e, last, due }) => (
              <tr key={e.id} className="clickable" onClick={() => onOpen(e, 'reviews')}>
                <td className="strong">{e.name}</td>
                <td>{last ? `${REVIEW_LABEL[last.reviewType ?? 'one-to-one']}, ${last.date}` : <span className="muted">None recorded</span>}</td>
                <td className="muted">{last?.outcome ?? '-'}</td>
                <td className={due < today ? 'bad-text' : due <= addDays(today, 30) ? 'warn-text' : ''}>{!last && due <= today ? 'Due now' : due < today ? `Overdue since ${due}` : due}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Disciplinary, grievance and capability cases. Admins only: the server sends cases to no one else. */
export function CasesView({ state, siteIds, today, hr, onOpen }: Props) {
  const inScope = new Set(state.employees.filter((e) => siteIds.includes(e.siteId)).map((e) => e.id));
  const cases = (hr.records ?? []).filter((r) => r.kind === 'case' && inScope.has(r.employeeId));
  const open = cases.filter((c) => c.caseStatus !== 'closed').sort((a, b) => a.date.localeCompare(b.date));
  const live = cases.filter((c) => c.caseStatus === 'closed' && c.warningExpires && c.warningExpires >= today);
  const closed = cases.filter((c) => c.caseStatus === 'closed').sort((a, b) => b.date.localeCompare(a.date));
  const person = (id: string) => state.employees.find((e) => e.id === id)!;

  const table = (list: HrRecord[], empty: string, showAge: boolean) => (
    <div className="grid-wrap">
      <table className="table people">
        <thead><tr><th>Name</th><th>Type</th><th>Summary</th><th>Opened</th><th>{showAge ? 'Open for' : 'Outcome'}</th></tr></thead>
        <tbody>
          {list.length === 0 && <tr><td colSpan={5} className="muted">{empty}</td></tr>}
          {list.map((c) => (
            <tr key={c.id} className="clickable" onClick={() => onOpen(person(c.employeeId), 'cases')}>
              <td className="strong">{person(c.employeeId)?.name}</td>
              <td>{CASE_LABEL[c.caseType ?? 'investigation']}</td>
              <td>{c.title}</td>
              <td>{c.date}</td>
              <td>
                {showAge
                  ? `${daysBetween(c.date, today)} days`
                  : <>{c.outcome ?? '-'}{c.warningExpires && <div className="muted small">Live until {c.warningExpires}</div>}</>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div>
      <div className="kpis people-kpis">
        <div className={`kpi ${open.length ? 'warn' : 'good'}`}>
          <div className="kpi-label">Open cases</div>
          <div className="kpi-value">{open.length}</div>
          <div className="kpi-hint">Oldest {open[0] ? `${daysBetween(open[0].date, today)} days` : 'none'}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Live warnings</div>
          <div className="kpi-value">{live.length}</div>
          <div className="kpi-hint">Can be relied on if conduct repeats</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Closed</div>
          <div className="kpi-value">{closed.length}</div>
          <div className="kpi-hint">Kept for the record</div>
        </div>
      </div>
      <p className="muted small">
        Delay is the commonest failure in a case. The ACAS code expects each step without unreasonable delay: investigate,
        put the allegations in writing, hold the hearing with the right to be accompanied, confirm the outcome in writing,
        and offer an appeal. Open a case from the person's file.
      </p>
      <h3 className="section-title">Open</h3>
      {table(open, 'No open cases.', true)}
      <h3 className="section-title">Closed</h3>
      {table(closed, 'No closed cases.', false)}
    </div>
  );
}
