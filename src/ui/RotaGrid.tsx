import type { ReactNode } from 'react';
import type { Issue } from '../engine/compliance';
import { isEmployedOn } from '../engine/employees';
import type { WeekMetrics } from '../engine/metrics';
import { formatMinute } from '../engine/time';
import type { Department, Employee, RotaState, Shift, Site } from '../engine/types';
import { dayLabel, hours, money, pct } from './format';

const DEPT_ORDER: Department[] = ['MGMT', 'FOH', 'BAR', 'BOH'];
const DEPT_LABEL: Record<Department, string> = { MGMT: 'Management', FOH: 'Front of house', BAR: 'Bar', BOH: 'Kitchen' };

interface Props {
  state: RotaState;
  site: Site;
  dates: string[];
  metrics: WeekMetrics;
  issues: Issue[];
  /** Labour cost is shown only to those who may see pay. */
  showCost: boolean;
  /** Absent when the person cannot edit this site's rota: the grid is then read only. */
  onEdit?: (shift: Shift) => void;
}

export function RotaGrid({ state, site, dates, metrics, issues, showCost, onEdit }: Props) {
  const roleOf = (id: string) => state.roles.find((r) => r.id === id);
  const people = state.employees.filter(
    (e) =>
      (e.siteId === site.id && dates.some((d) => isEmployedOn(e, d))) ||
      state.shifts.some((s) => s.employeeId === e.id && s.siteId === site.id && dates.includes(s.date)),
  );
  const groups = DEPT_ORDER.map((dept) => ({
    dept,
    people: people.filter((e) => roleOf(e.roleIds[0])?.department === dept),
  })).filter((g) => g.people.length > 0);

  const issuesFor = (employeeId: string) => issues.filter((i) => i.employeeId === employeeId);

  function newShift(employee: Employee, date: string): Shift {
    return {
      id: `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      employeeId: employee.id,
      roleId: employee.roleIds[0],
      siteId: site.id,
      date,
      startMinute: 17 * 60,
      endMinute: 23 * 60,
      breakMinutes: 0,
    };
  }

  return (
    <div className="grid-wrap">
      <table className="rota">
        <thead>
          <tr>
            <th className="who">Team</th>
            {dates.map((d) => {
              const l = dayLabel(d);
              return (
                <th key={d}>
                  <div>{l.short}</div>
                  <div className="muted">{l.date}</div>
                </th>
              );
            })}
            <th className="tot">Week</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <Group key={g.dept} label={DEPT_LABEL[g.dept]} span={dates.length + 2}>
              {g.people.map((e) => {
                const personIssues = issuesFor(e.id);
                const weekLevel = personIssues.filter((i) => !i.shiftId);
                const ec = metrics.cost.employees.get(e.id);
                return (
                  <tr key={e.id}>
                    <th className="who">
                      <div className="name">{e.name}</div>
                      <div className="muted">
                        {e.roleIds.map((r) => roleOf(r)?.name).join(', ')}
                        {e.payBasis === 'salaried' ? ' · salaried' : showCost && !e.payHidden ? ` · £${e.hourlyRate.toFixed(2)}` : ''}
                      </div>
                      {e.siteId !== site.id && (
                        <div className="muted small">Cover from {state.sites.find((x) => x.id === e.siteId)?.name}</div>
                      )}
                    </th>
                    {dates.map((date) => {
                      const shifts = state.shifts.filter((s) => s.employeeId === e.id && s.date === date);
                      const onLeave = e.leave.includes(date);
                      return (
                        <td key={date} className={onLeave ? 'leave' : ''}>
                          {shifts.map((s) => {
                            const sc = metrics.cost.shifts.get(s.id);
                            const flagged = personIssues.filter((i) => i.shiftId === s.id);
                            const level = flagged.some((i) => i.severity === 'block') ? 'block' : flagged.length ? 'warn' : '';
                            const role = roleOf(s.roleId);
                            const elsewhere = s.siteId !== site.id;
                            return (
                              <button
                                key={s.id}
                                className={`chip dept-${role?.department ?? 'FOH'} ${level} ${s.published ? 'pub' : ''} ${elsewhere ? 'elsewhere' : ''}`}
                                disabled={!onEdit}
                                onClick={() => onEdit?.(s)}
                                title={flagged.map((i) => i.message).join('\n') || undefined}
                              >
                                <span className="chip-time">
                                  {formatMinute(s.startMinute)}-{formatMinute(s.endMinute)}
                                </span>
                                <span className="chip-meta">
                                  {elsewhere ? state.sites.find((x) => x.id === s.siteId)?.name : role?.name}
                                  {sc && showCost ? ` · ${money(sc.total)}` : ''}
                                </span>
                              </button>
                            );
                          })}
                          {onLeave && shifts.length === 0 && <span className="muted small">Leave</span>}
                          {!onLeave && onEdit && (
                            <button className="add" onClick={() => onEdit(newShift(e, date))} aria-label={`Add shift for ${e.name}`}>
                              +
                            </button>
                          )}
                        </td>
                      );
                    })}
                    <td className="tot">
                      <div>{ec ? hours(ec.paidHours) : '0.0h'}</div>
                      {showCost && <div className="muted">{ec ? money(ec.total) : '£0'}</div>}
                      {weekLevel.length > 0 && (
                        <div className={`flag ${weekLevel.some((i) => i.severity === 'block') ? 'block' : 'warn'}`} title={weekLevel.map((i) => i.message).join('\n')}>
                          {weekLevel.length} flag{weekLevel.length > 1 ? 's' : ''}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </Group>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th className="who">Forecast sales</th>
            {metrics.days.map((d) => <td key={d.date}>{money(d.forecastSales)}</td>)}
            <td className="tot">{money(metrics.forecastSales)}</td>
          </tr>
          {showCost && (<>
          <tr>
            <th className="who">Labour cost</th>
            {metrics.days.map((d) => <td key={d.date}>{money(d.labourCost)}</td>)}
            <td className="tot">{money(metrics.labourCost)}</td>
          </tr>
          <tr>
            <th className="who">Labour %</th>
            {metrics.days.map((d) => (
              <td key={d.date} className={d.labourPct > metrics.targetPct ? 'over' : 'under'}>{pct(d.labourPct)}</td>
            ))}
            <td className={`tot ${metrics.labourPct > metrics.targetPct ? 'over' : 'under'}`}>{pct(metrics.labourPct)}</td>
          </tr>
          </>)}
        </tfoot>
      </table>
    </div>
  );
}

function Group({ label, span, children }: { label: string; span: number; children: ReactNode }) {
  return (
    <>
      <tr className="group">
        <th colSpan={span}>{label}</th>
      </tr>
      {children}
    </>
  );
}
