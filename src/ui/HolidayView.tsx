import { useEffect, useMemo, useState } from 'react';
import { employeeStatus } from '../engine/employees';
import { holidayBalance, leaveYear, workedShifts, type HolidayBalance } from '../engine/holiday';
import { entriesAsShifts } from '../engine/timesheet';
import type { Employee, RotaState, TimeEntry } from '../engine/types';
import { api } from './api';
import { download, money } from './format';

interface Props {
  state: RotaState;
  siteIds: string[];
  today: string;
  onEdit: (employee: Employee) => void;
  onSetLeaveYear: (entityId: string, leaveYearStart: string) => Promise<unknown>;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const h = (n: number) => `${n.toFixed(1)}h`;

export function HolidayView({ state, siteIds, today, onEdit, onSetLeaveYear }: Props) {
  const [entries, setEntries] = useState<TimeEntry[] | null>(null);
  const [onlyFlagged, setOnlyFlagged] = useState(false);

  const entityIds = [...new Set(state.sites.filter((s) => siteIds.includes(s.id)).map((s) => s.entityId))];
  const entities = state.entities.filter((e) => entityIds.includes(e.id));
  const yearStartOf = (entityId: string) => state.entities.find((e) => e.id === entityId)?.leaveYearStart ?? '01-01';
  // Earliest leave year start across the companies in view, so one fetch covers everyone.
  const from = entities.map((e) => leaveYear(today, e.leaveYearStart).start).sort()[0] ?? leaveYear(today).start;

  useEffect(() => {
    let live = true;
    setEntries(null);
    // Time at any site counts: someone covering elsewhere still accrues holiday.
    api
      .get<TimeEntry[]>(`/v1/time-entries?from=${from}&to=${today}`)
      .then((list) => live && setEntries(list))
      .catch(() => live && setEntries([]));
    return () => { live = false; };
  }, [from, today]);

  const rows = useMemo(() => {
    const worked = workedShifts(state.shifts.filter((s) => s.date <= today), entriesAsShifts(entries ?? []));
    return state.employees
      .filter((e) => siteIds.includes(e.siteId) && employeeStatus(e, today) !== 'left')
      .map((e) => ({ e, b: holidayBalance(e, worked, today, yearStartOf(e.entityId)) }))
      .sort((a, b) => a.e.name.localeCompare(b.e.name));
  }, [state, siteIds, today, entries]);

  const visible = onlyFlagged ? rows.filter((r) => r.b.checks.length > 0) : rows;
  const sum = (f: (b: HolidayBalance) => number) => rows.reduce((s, r) => s + f(r.b), 0);
  const liability = sum((b) => b.liability);
  const liabilityWithNi = sum((b) => b.liabilityWithNi);
  const owedToCompany = rows.filter((r) => r.b.untakenHours < 0).reduce((s, r) => s - r.b.untakenHours * r.b.hourlyRate, 0);
  const flagged = rows.filter((r) => r.b.checks.length > 0).length;

  function exportCsv() {
    const header = ['Name', 'Company', 'Basis', 'Leave year', 'Entitlement h', 'Carried over h', 'Taken h', 'Booked h', 'Remaining h', 'Accrued untaken h', 'Hourly rate', 'Provision', 'Provision with employer NI'];
    const lines = rows.map(({ e, b }) => [
      e.name,
      state.entities.find((x) => x.id === e.entityId)?.name ?? e.entityId,
      b.basis,
      `${b.year.start} to ${b.year.end}`,
      b.entitlementHours, b.carriedOverHours, b.takenHours, b.bookedHours, b.remainingHours, b.untakenHours,
      b.hourlyRate, b.liability, b.liabilityWithNi,
    ]);
    const csv = [header, ...lines].map((l) => l.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(',')).join('\n');
    download(`holiday-balances-${today}.csv`, csv);
  }

  return (
    <div>
      <div className="kpis people-kpis">
        <div className="kpi">
          <div className="kpi-label">Holiday pay provision</div>
          <div className="kpi-value">{money(liabilityWithNi)}</div>
          <div className="kpi-hint">{money(liability)} pay plus employer NI, earned and not taken</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Untaken hours</div>
          <div className="kpi-value">{Math.round(sum((b) => Math.max(0, b.untakenHours)))}h</div>
          <div className="kpi-hint">{Math.round(sum((b) => b.bookedHours))}h already booked ahead</div>
        </div>
        <div className={`kpi ${owedToCompany > 0 ? 'warn' : 'good'}`}>
          <div className="kpi-label">Taken ahead of accrual</div>
          <div className="kpi-value">{money(owedToCompany)}</div>
          <div className="kpi-hint">Only recoverable on leaving if the contract says so</div>
        </div>
        <div className={`kpi ${flagged > 0 ? 'warn' : 'good'}`}>
          <div className="kpi-label">Need attention</div>
          <div className="kpi-value">{flagged}</div>
          <div className="kpi-hint">Overbooked, unused near year end, leavers</div>
        </div>
      </div>

      <div className="people-bar">
        <div className="leave-years">
          {entities.map((ent) => {
            const [mm, dd] = (ent.leaveYearStart ?? '01-01').split('-');
            const y = leaveYear(today, ent.leaveYearStart);
            return (
              <label key={ent.id} className="muted small">
                {ent.name} leave year starts{' '}
                <select
                  value={`${mm}-${dd}`}
                  onChange={(e) => void onSetLeaveYear(ent.id, e.target.value)}
                  aria-label={`${ent.name} leave year start`}
                >
                  {MONTHS.map((m, i) => {
                    const v = `${String(i + 1).padStart(2, '0')}-01`;
                    return <option key={v} value={v}>1 {m}</option>;
                  })}
                  {dd !== '01' && <option value={`${mm}-${dd}`}>{dd} {MONTHS[Number(mm) - 1]}</option>}
                </select>{' '}
                ({y.start} to {y.end})
              </label>
            );
          })}
        </div>
        <div className="people-actions">
          <label className="muted small check-inline">
            <input type="checkbox" checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)} /> Needs attention only
          </label>
          <button onClick={exportCsv} disabled={rows.length === 0}>Balances CSV</button>
        </div>
      </div>

      {entries === null && <p className="muted small">Loading clocked hours for the leave year. Showing the rota until they arrive.</p>}

      <div className="grid-wrap">
        <table className="table people">
          <thead>
            <tr>
              <th>Name</th>
              <th>Basis</th>
              <th className="num">Entitlement</th>
              <th className="num">Carried</th>
              <th className="num">Taken</th>
              <th className="num">Booked</th>
              <th className="num">Remaining</th>
              <th className="num">Accrued untaken</th>
              <th className="num">Provision</th>
              <th>Checks</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && <tr><td colSpan={10} className="muted">No one matches this view.</td></tr>}
            {visible.map(({ e, b }) => (
              <tr key={e.id} className="clickable" onClick={() => onEdit(e)} tabIndex={0} onKeyDown={(ev) => { if (ev.key === 'Enter') onEdit(e); }}>
                <td>
                  <span className="strong">{e.name}</span>
                  <div className="muted small">{h(b.dayHours)} a day</div>
                </td>
                <td className="muted">{b.basis === 'fixed' ? 'Fixed hours' : '12.07% accrual'}</td>
                <td className="num">{h(b.entitlementHours)}</td>
                <td className="num">{b.carriedOverHours ? h(b.carriedOverHours) : '-'}</td>
                <td className="num">{h(b.takenHours)}</td>
                <td className="num">{b.bookedHours ? h(b.bookedHours) : '-'}</td>
                <td className={`num strong${b.remainingHours < 0 ? ' bad-text' : ''}`}>{h(b.remainingHours)}</td>
                <td className={`num${b.untakenHours < 0 ? ' bad-text' : ''}`}>{h(b.untakenHours)}</td>
                <td className="num">{money(b.liabilityWithNi)}</td>
                <td>
                  {b.checks.length === 0 ? (
                    <span className="muted">None</span>
                  ) : (
                    <ul className="issues compact">
                      {b.checks.map((c) => <li key={c.code} className={c.severity}>{c.message}</li>)}
                    </ul>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th colSpan={8}>Total provision, with employer NI at 15%</th>
              <td className="num strong">{money(liabilityWithNi)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="muted small">
        Fixed hours staff earn 5.6 weeks (or their contract) evenly through the leave year. Irregular hours staff
        earn 12.07% of hours worked, from approved clocked time where it exists and the rota otherwise. The
        provision is what the business owes in holiday pay today; it should match the holiday accrual on the
        balance sheet.
      </p>
    </div>
  );
}
