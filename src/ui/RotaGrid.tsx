import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { Issue } from '../engine/compliance';
import type { WeekMetrics } from '../engine/metrics';
import { addDays, ageOn, formatMinute, toISODate, weekday } from '../engine/time';
import type { Department, Employee, RotaState, Shift, Site } from '../engine/types';
import { type Edge, moveShift, nudgeShift, pixelsToMinutes, resizeShift, sameShift } from './drag';
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
  /** A shift being dragged, shown live across the grid and the KPIs; null when the drag ends. */
  onPreview: (shift: Shift | null) => void;
  onCommit: (shift: Shift, before: Shift) => void;
  /** Week labour cost before the drag started, for the live delta. */
  baseLabourCost: number;
}

interface Drag {
  mode: 'move' | Edge;
  original: Shift;
  x: number;
  y: number;
  started: boolean;
  current: Shift;
}

/** Pointer travel before a press becomes a drag, so a plain click still opens the editor. */
const DRAG_THRESHOLD = 4;

export function RotaGrid({ state, site, dates, metrics, issues, onEdit, onPreview, onCommit, baseLabourCost }: Props) {
  const drag = useRef<Drag | null>(null);
  const justDragged = useRef(false);
  const [pointer, setPointer] = useState<{ x: number; y: number; mode: Drag['mode'] } | null>(null);
  const callbacks = useRef({ onPreview, onCommit });
  callbacks.current = { onPreview, onCommit };
  const employees = useRef(state.employees);
  employees.current = state.employees;

  useEffect(() => {
    function move(e: PointerEvent) {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.started) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        d.started = true;
        document.body.classList.add(d.mode === 'move' ? 'dragging-move' : 'dragging-resize');
      }
      let next = d.current;
      if (d.mode === 'move') {
        const cell = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>('td[data-emp]');
        const to = cell && employees.current.find((x) => x.id === cell.dataset.emp);
        if (to && cell.dataset.date) next = moveShift(d.original, to, cell.dataset.date);
      } else {
        next = resizeShift(d.original, d.mode, pixelsToMinutes(dx));
      }
      if (!sameShift(next, d.current)) {
        d.current = next;
        callbacks.current.onPreview(next);
      }
      setPointer({ x: e.clientX, y: e.clientY, mode: d.mode });
    }
    function end(commit: boolean) {
      const d = drag.current;
      if (!d) return;
      drag.current = null;
      document.body.classList.remove('dragging-move', 'dragging-resize');
      setPointer(null);
      if (!d.started) return;
      justDragged.current = true;
      setTimeout(() => (justDragged.current = false), 0);
      callbacks.current.onPreview(null);
      if (commit && !sameShift(d.current, d.original)) callbacks.current.onCommit(d.current, d.original);
    }
    const up = () => end(true);
    const key = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && end(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('keydown', key);
    };
  }, []);

  function startDrag(e: ReactPointerEvent<HTMLElement>, shift: Shift) {
    if (e.button !== 0) return;
    const edge = (e.target as HTMLElement).closest<HTMLElement>('[data-edge]')?.dataset.edge as Edge | undefined;
    drag.current = { mode: edge ?? 'move', original: shift, current: shift, x: e.clientX, y: e.clientY, started: false };
    if (edge) e.preventDefault();
  }

  // Keyboard equivalent: Alt+Left/Right moves a day, Alt+Up/Down moves 15 minutes,
  // Alt+Shift+Up/Down changes the finish time.
  function keyMove(e: KeyboardEvent, shift: Shift) {
    if (!e.altKey) return;
    let next: Shift | null = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const date = addDays(shift.date, e.key === 'ArrowLeft' ? -1 : 1);
      if (dates.includes(date)) next = { ...shift, date };
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const step = e.key === 'ArrowUp' ? -15 : 15;
      next = e.shiftKey ? resizeShift(shift, 'end', step) : nudgeShift(shift, step);
    }
    if (next && !sameShift(next, shift)) {
      e.preventDefault();
      onCommit(next, shift);
    }
  }

  const dragging = drag.current?.started ? drag.current : null;
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
              <div className="muted small" style={{ fontWeight: 400 }}>{people.length} people · drag to move, edges to resize</div>
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
                          <td
                            key={date}
                            data-emp={e.id}
                            data-date={date}
                            className={`${onLeave ? 'leave' : ''} ${isWeekend(date) ? 'weekend' : ''} ${
                              dragging?.mode === 'move' && dragging.current.employeeId === e.id && dragging.current.date === date ? 'drop-target' : ''
                            }`}
                          >
                            {shifts.map((s) => {
                              const sc = metrics.cost.shifts.get(s.id);
                              const flagged = personIssues.filter((i) => i.shiftId === s.id);
                              const level = flagged.some((i) => i.severity === 'block') ? 'block' : flagged.length ? 'warn' : '';
                              const role = roleOf(s.roleId);
                              const elsewhere = s.siteId !== site.id;
                              return (
                                <button
                                  key={s.id}
                                  className={`chip dept-${role?.department ?? 'FOH'} ${level} ${elsewhere ? 'elsewhere' : ''} ${
                                    dragging?.original.id === s.id ? 'is-dragging' : ''
                                  }`}
                                  onClick={() => !justDragged.current && onEdit(s)}
                                  onPointerDown={elsewhere ? undefined : (ev) => startDrag(ev, s)}
                                  onKeyDown={elsewhere ? undefined : (ev) => keyMove(ev, s)}
                                  title={flagged.map((i) => i.message).join('\n') || 'Drag to move. Drag either edge to change the hours. Alt and arrow keys also work.'}
                                >
                                  {!elsewhere && <span className="chip-edge start" data-edge="start" aria-hidden />}
                                  {!elsewhere && <span className="chip-edge end" data-edge="end" aria-hidden />}
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
      {pointer && dragging && (
        <DragReadout
          x={pointer.x}
          y={pointer.y}
          shift={dragging.current}
          name={state.employees.find((x) => x.id === dragging.current.employeeId)?.name ?? ''}
          shiftCost={metrics.cost.shifts.get(dragging.current.id)?.total ?? 0}
          delta={metrics.labourCost - baseLabourCost}
          labourPct={metrics.labourPct}
          over={metrics.labourPct > metrics.targetPct}
          flags={issues.filter((i) => i.shiftId === dragging.current.id || (!i.shiftId && i.employeeId === dragging.current.employeeId))}
        />
      )}
    </div>
  );
}

interface ReadoutProps {
  x: number;
  y: number;
  shift: Shift;
  name: string;
  shiftCost: number;
  delta: number;
  labourPct: number;
  over: boolean;
  flags: Issue[];
}

/** Follows the pointer during a drag: where the shift lands and what it does to the week. */
function DragReadout({ x, y, shift, name, shiftCost, delta, labourPct, over, flags }: ReadoutProps) {
  const l = dayLabel(shift.date);
  const blocked = flags.some((f) => f.severity === 'block');
  const sign = delta > 0.5 ? '+' : delta < -0.5 ? '-' : '';
  return (
    <div className="drag-readout" style={{ left: x + 16, top: y + 18 }} role="status">
      <div className="tip-title">
        {name} · {l.short} {l.date}
      </div>
      <div className="tip-row">
        <span>Hours</span>
        <span>
          {formatMinute(shift.startMinute)}-{formatMinute(shift.endMinute)} · {hours((shift.endMinute - shift.startMinute - shift.breakMinutes) / 60)}
        </span>
      </div>
      <div className="tip-row">
        <span>This shift</span>
        <span>{money(shiftCost)}</span>
      </div>
      <div className="tip-row">
        <span>Week labour</span>
        <span className={sign === '+' ? 'up' : sign === '-' ? 'down' : ''}>
          {sign}
          {money(Math.abs(delta))}
        </span>
      </div>
      <div className="tip-row">
        <span>Labour %</span>
        <span className={over ? 'up' : 'down'}>{pct(labourPct)}</span>
      </div>
      {flags.length > 0 && (
        <div className={`drag-flag ${blocked ? 'block' : 'warn'}`}>{flags[0].message}{flags.length > 1 ? ` (+${flags.length - 1} more)` : ''}</div>
      )}
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
