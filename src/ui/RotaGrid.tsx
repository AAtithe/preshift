import type { ReactNode } from 'react';
import type { Issue } from '../engine/compliance';
import type { WeekMetrics } from '../engine/metrics';
import { ageOn, formatMinute, toISODate, weekday } from '../engine/time';
import type { Department, Employee, RotaState, Shift, Site } from '../engine/types';
import { dayLabel, hours, money, pct } from './format';
import { Avatar, Bullet, DEPT_COLOR } from './viz';

const DEPT_ORDER: Department[] = ['MGMT', 'FOH', 'BAR', 'BOH'];
const DEPT_LABEL: Record<Department, string> = { MGMT: 'Management', FOH: 'Front of house', BAR: 'Bar', BOH: 'Kitchen' };

interface Props {
  state: RotaState;
  site: Site;
  dates: string[];
  metrics: WeekMetrics;
  issues: Issue[];
  onEdit: (shift: Shift) => void;
}

export function RotaGrid({ state, site, dates, metrics, issues, onEdit }: Props) {
  const roleOf = (id: string) => state.roles.find((r) => r.id === id);
  const deptOf = (e: Employee) => roleOf(e.roleIds[0])?.department ?? 'FOH';
  const people = state.employees.filter(
    (e) => e.siteId === site.id || state.shifts.some((s) => s.employeeId === e.id && s.siteId === site.id && dates.includes(s.date)),
  );
  const groups = DEPT_ORDER.map((dept) => ({
    dept,
    people: people.filter((e) => deptOf(e) === dept),
  })).filter((g) => g.people.length > 0);

  const issuesFor = (employeeId: string) => issues.filter((i) => i.employeeId === employeeId);
  const today = toISODate(new Date());
  const isWeekend = (d: string) => weekday(d) >= 5;
  // The trading day the chip timeline is drawn against, widened for any shift outside it.
  const dayStart = Math.min(site.openMinute - 120, ...state.shifts.filter((s) => s.siteId === site.id).map((s) => s.startMinute));
  const dayEnd = Math.max(site.closeMinute + 60, ...state.shifts.filter((s) => s.siteId === site.id).map((s) => s.endMinute));
  const span = dayEnd - dayStart;
  const scaleMax = Math.max(metrics.targetPct * 1.5, ...metrics.days.map((d) => d.labourPct));

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
    <div className="panel grid-wrap">
      <table className="rota">
        <thead>
          <tr>
            <th className="who">
              <div className="panel-title">Team</div>
              <div className="muted small" style={{ fontWeight: 400 }}>{people.length} people</div>
            </th>
            {dates.map((d, i) => {
              const l = dayLabel(d);
              const m = metrics.days[i];
              const over = m.labourPct > metrics.targetPct;
              return (
                <th key={d} className={`${isWeekend(d) ? 'weekend' : ''} ${d === today ? 'today' : ''}`}>
                  <div className="day-head">
                    <span className="d">{l.short}</span>
                    <span className="dt">{l.date}</span>
                  </div>
                  <div className="day-kpi">
                    <span className="tnum">{money(m.forecastSales)}</span>
                    {m.labourCost > 0 && <span className={`tnum ${over ? 'over' : 'ok'}`}>{pct(m.labourPct)}</span>}
                  </div>
                  <Bullet mini value={m.labourPct} target={metrics.targetPct} max={scaleMax} />
                </th>
              );
            })}
            <th className="tot">
              <div className="panel-title">Week</div>
              <div className="muted small" style={{ fontWeight: 400 }}>Hours and cost</div>
            </th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => {
            const groupCost = g.people.reduce((s, e) => s + (metrics.cost.employees.get(e.id)?.total ?? 0), 0);
            return (
              <Group key={g.dept} dept={g.dept} meta={`${g.people.length} · ${money(groupCost)}`} span={dates.length + 2}>
                {g.people.map((e) => {
                  const personIssues = issuesFor(e.id);
                  const weekLevel = personIssues.filter((i) => !i.shiftId);
                  const ec = metrics.cost.employees.get(e.id);
                  const paid = ec?.paidHours ?? 0;
                  const benchmark = e.contractedHours || e.maxWeeklyHours || 40;
                  const under = e.contractedHours > 0 && paid < e.contractedHours;
                  return (
                    <tr key={e.id}>
                      <th className="who">
                        <div className="person">
                          <Avatar name={e.name} dept={deptOf(e)} />
                          <div>
                            <div className="name">
                              {e.name}
                              {ageOn(e.dateOfBirth, dates[0]) < 18 && <span className="tag">Under 18</span>}
                            </div>
                            <div className="meta">
                              {e.roleIds.map((r) => roleOf(r)?.name).join(', ')}
                              {e.payBasis === 'salaried' ? ' · salaried' : ` · £${e.hourlyRate.toFixed(2)}`}
                            </div>
                          </div>
                        </div>
                      </th>
                      {dates.map((date) => {
                        const shifts = state.shifts.filter((s) => s.employeeId === e.id && s.date === date);
                        const onLeave = e.leave.includes(date);
                        return (
                          <td key={date} className={`${onLeave ? 'leave' : ''} ${isWeekend(date) ? 'weekend' : ''}`}>
                            {shifts.map((s) => {
                              const sc = metrics.cost.shifts.get(s.id);
                              const flagged = personIssues.filter((i) => i.shiftId === s.id);
                              const level = flagged.some((i) => i.severity === 'block') ? 'block' : flagged.length ? 'warn' : '';
                              const role = roleOf(s.roleId);
                              const elsewhere = s.siteId !== site.id;
                              return (
                                <button
                                  key={s.id}
                                  className={`chip dept-${role?.department ?? 'FOH'} ${level} ${elsewhere ? 'elsewhere' : ''}`}
                                  onClick={() => onEdit(s)}
                                  title={flagged.map((i) => i.message).join('\n') || undefined}
                                >
                                  <span className="chip-top">
                                    <span className="chip-time">
                                      {formatMinute(s.startMinute)}-{formatMinute(s.endMinute)}
                                    </span>
                                    {level ? (
                                      <span className="chip-flag">{level === 'block' ? 'Blocked' : 'Review'}</span>
                                    ) : s.published ? (
                                      <span className="chip-pub" aria-label="Published">&#10003;</span>
                                    ) : null}
                                  </span>
                                  <span className="chip-meta">
                                    <span>{elsewhere ? state.sites.find((x) => x.id === s.siteId)?.name : role?.name}</span>
                                    {sc && <b>{money(sc.total)}</b>}
                                  </span>
                                  <span className="chip-track" aria-hidden>
                                    <span
                                      style={{
                                        left: `${((s.startMinute - dayStart) / span) * 100}%`,
                                        width: `${((s.endMinute - s.startMinute) / span) * 100}%`,
                                      }}
                                    />
                                  </span>
                                </button>
                              );
                            })}
                            {onLeave && shifts.length === 0 && <span className="leave-tag">On leave</span>}
                            {!onLeave && (
                              <button className="add" onClick={() => onEdit(newShift(e, date))} aria-label={`Add shift for ${e.name}`}>
                                +
                              </button>
                            )}
                          </td>
                        );
                      })}
                      <td className="tot">
                        <div className="tot-hours tnum">{hours(paid)}</div>
                        {e.payBasis === 'hourly' && (
                          <div className="util" title={e.contractedHours ? `${hours(paid)} of ${e.contractedHours}h contracted` : `${hours(paid)} of ${benchmark}h max`}>
                            <div className={under ? 'under' : ''} style={{ width: `${Math.min(100, (paid / benchmark) * 100)}%` }} />
                          </div>
                        )}
                        <div className="muted tnum">{ec ? money(ec.total) : '£0'}</div>
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
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <th className="who">Labour cost</th>
            {metrics.days.map((d) => <td key={d.date} className="tnum">{money(d.labourCost)}</td>)}
            <td className="tot tnum">{money(metrics.labourCost)}</td>
          </tr>
          <tr>
            <th className="who">Labour %</th>
            {metrics.days.map((d) => (
              <td key={d.date} className={`tnum ${d.labourPct > metrics.targetPct ? 'over' : 'under'}`}>{pct(d.labourPct)}</td>
            ))}
            <td className={`tot tnum ${metrics.labourPct > metrics.targetPct ? 'over' : 'under'}`}>{pct(metrics.labourPct)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function Group({ dept, meta, span, children }: { dept: Department; meta: string; span: number; children: ReactNode }) {
  return (
    <>
      <tr className="group">
        <th colSpan={span}>
          <span className="group-label">
            <i style={{ background: DEPT_COLOR[dept] }} />
            {DEPT_LABEL[dept]}
            <span className="muted">{meta}</span>
          </span>
        </th>
      </tr>
      {children}
    </>
  );
}
