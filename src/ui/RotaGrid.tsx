import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { dayCover, isOpenHour, type CoverHour } from '../engine/demand';
import type { Issue } from '../engine/compliance';
import { isEmployedOn, ruleAge } from '../engine/employees';
import type { WeekMetrics } from '../engine/metrics';
import { formatMinute, toISODate, weekday } from '../engine/time';
import type { Department, Employee, RotaState, Shift, Site } from '../engine/types';
import { dropBlocker, keyChange, moveShift, pasteShift, pixelsToMinutes, resizeShift, sameShift, templateOf, type ShiftTemplate } from './drag';
import { DragReadout } from './DragReadout';
import { dayLabel, hours, money, pct } from './format';
import { type Resolve, useShiftDrag } from './useShiftDrag';
import { Avatar, Bullet, DEPT_COLOR } from './viz';

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
  /** A shift being dragged, shown live across the grid and the KPIs; null when the drag ends. */
  onPreview: (shift: Shift | null) => void;
  onCommit: (shift: Shift, before: Shift) => void;
  /** A drag or key move refused by leave or availability. */
  onBlocked: (message: string) => void;
  /** Week labour cost before the drag started, for the live delta. */
  baseLabourCost: number;
  /** A shift or shift type held to drop on other people and days; null when nothing is. */
  clip: ShiftTemplate | null;
  onClip: (template: ShiftTemplate | null) => void;
  /** Saves a new shift straight away, as a paste does. */
  onAdd: (shift: Shift) => void;
  /** Opens the site's shift types to set up. Absent for those who cannot edit. */
  onManageTypes?: () => void;
}

/** How a chip renders mid-drag: in place, as the empty slot it left, or floating where it will land. */
interface ChipEntry {
  s: Shift;
  kind: 'normal' | 'slot' | 'float';
}

const HINT_KEY = 'preshift.hint.drag.v1';

function hintSeen() {
  try {
    return localStorage.getItem(HINT_KEY) === '1';
  } catch {
    return false;
  }
}

export function RotaGrid({ state, site, dates, metrics, issues, showCost, onEdit, onPreview, onCommit, onBlocked, baseLabourCost, clip, onClip, onAdd, onManageTypes }: Props) {
  const [hint, setHint] = useState(() => !hintSeen());

  // Escape puts down whatever is held, wherever the focus is.
  useEffect(() => {
    if (!clip) return;
    const key = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && onClip(null);
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [clip, onClip]);

  function dismissHint() {
    setHint(false);
    try {
      localStorage.setItem(HINT_KEY, '1');
    } catch {
      // Private mode: the hint simply shows again next time.
    }
  }

  const resolve: Resolve = (d, e, dx) => {
    if (d.mode === 'move') {
      const cell = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>('td[data-emp]');
      const to = cell && state.employees.find((x) => x.id === cell.dataset.emp);
      // Off the grid the shift goes home, so letting go there changes nothing.
      if (!to || !cell.dataset.date) return { next: d.original, blocked: null };
      const candidate = moveShift(d.original, to, cell.dataset.date);
      const reason = sameShift(candidate, d.original) ? null : dropBlocker(to, candidate);
      // Refused cells leave the shift where it started; the readout says why.
      if (reason) return { next: d.original, blocked: { employeeId: to.id, date: cell.dataset.date, reason, refuse: true } };
      return { next: candidate, blocked: null };
    }
    const candidate = resizeShift(d.original, d.mode, pixelsToMinutes(dx));
    const person = state.employees.find((x) => x.id === d.original.employeeId);
    // Hold the edge at the last allowed time, unless the shift was already outside availability.
    const reason = person && !dropBlocker(person, d.original) ? dropBlocker(person, candidate) : null;
    if (reason) return { next: d.current, blocked: { employeeId: d.original.employeeId, date: d.original.date, reason, refuse: false } };
    return { next: candidate, blocked: null };
  };

  const { dragging, pointer, startDrag, wasDrag } = useShiftDrag({
    resolve,
    scroller: () => document.querySelector<HTMLElement>('.grid-wrap'),
    onPreview,
    onCommit,
    onBlocked,
    onCommitted: dismissHint,
  });

  function keyMove(e: KeyboardEvent, shift: Shift) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      onClip(templateOf(shift, roleOf(shift.roleId)?.name ?? 'Shift'));
      return;
    }
    const change = keyChange(e, shift, dates, state.employees.find((x) => x.id === shift.employeeId));
    if (!change) return;
    e.preventDefault();
    if (change.reason) onBlocked(`Not changed. ${change.reason}`);
    else onCommit(change.next, shift);
  }

  // A shift moved to another cell floats there and leaves a slot behind, so no row changes
  // height under the pointer and the drop lands where the user is looking.
  const moved =
    dragging?.mode === 'move' &&
    (dragging.current.employeeId !== dragging.original.employeeId || dragging.current.date !== dragging.original.date)
      ? dragging
      : null;
  // While the hint is showing, the first draggable shift demonstrates its grips.
  let pulsed = false;
  const pulse = (elsewhere: boolean) => {
    if (!hint || pulsed || elsewhere) return false;
    pulsed = true;
    return true;
  };
  const roleOf = (id: string) => state.roles.find((r) => r.id === id);
  const deptOf = (e: Employee) => roleOf(e.roleIds[0])?.department ?? 'FOH';
  const people = state.employees.filter(
    (e) =>
      (e.siteId === site.id && dates.some((d) => isEmployedOn(e, d))) ||
      state.shifts.some((s) => s.employeeId === e.id && s.siteId === site.id && dates.includes(s.date)),
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

  const newId = () => `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  function paste(employee: Employee, date: string) {
    if (!clip) return;
    const shift = pasteShift(clip, employee, date, site.id, newId());
    const reason = dropBlocker(employee, shift);
    if (reason) onBlocked(`Not pasted. ${reason}`);
    else onAdd(shift);
  }

  const types = (state.shiftTypes ?? []).filter((t) => t.siteId === site.id);
  const cover = dates.map((d) => dayCover(state, site.id, d));
  const coverMax = Math.max(1, ...cover.flat().map((h) => Math.max(h.required, h.scheduled)));

  function newShift(employee: Employee, date: string): Shift {
    return {
      id: newId(),
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
    <>
    {onEdit && (
      <div className="grid-tools">
        {types.length > 0 && (
          <label className="type-pick">
            <span className="muted small">Build from</span>
            <select
              value=""
              onChange={(e) => {
                const t = types.find((x) => x.id === e.target.value);
                if (t) onClip({ label: t.name, startMinute: t.startMinute, endMinute: t.endMinute, breakMinutes: t.breakMinutes, roleId: t.roleId });
              }}
            >
              <option value="">a shift type...</option>
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} · {formatMinute(t.startMinute)}-{formatMinute(t.endMinute)}{t.roleId ? ` · ${roleOf(t.roleId)?.name ?? ''}` : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        {onManageTypes && <button className="ghost" onClick={onManageTypes}>{types.length ? 'Shift types' : 'Set up shift types'}</button>}
        {clip ? (
          <div className="clip-bar" role="status">
            <span>
              Holding <b>{clip.label}</b> {formatMinute(clip.startMinute)}-{formatMinute(clip.endMinute)}
              {clip.breakMinutes ? `, ${clip.breakMinutes}m break` : ''}. Click Paste on any person and day.
            </span>
            <button className="primary" onClick={() => onClip(null)}>Done</button>
          </div>
        ) : (
          <span className="muted small">To copy a shift, open it and press Copy, or select it and press Ctrl+C.</span>
        )}
      </div>
    )}
    <div className={`panel grid-wrap${hint ? ' hinting' : ''}${clip ? ' pasting' : ''}`}>
      {hint && <DragHint onDismiss={dismissHint} />}
      <table className="rota">
        <thead data-sticky-top>
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
                  {state.demandRules.some((r) => r.siteId === site.id) && <CoverBars hours={cover[i]} site={site} max={coverMax} />}
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
              <Group key={g.dept} dept={g.dept} meta={showCost ? `${g.people.length} · ${money(groupCost)}` : `${g.people.length}`} span={dates.length + 2}>
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
                              {ruleAge(e, dates[0]) < 18 && <span className="tag">Under 18</span>}
                            </div>
                            <div className="meta">
                              {e.siteId !== site.id && <span className="tag borrowed">Cover from {state.sites.find((x) => x.id === e.siteId)?.name}</span>}
                              {e.roleIds.map((r) => roleOf(r)?.name).join(', ')}
                              {e.payBasis === 'salaried' ? ' · salaried' : showCost && !e.payHidden ? ` · £${e.hourlyRate.toFixed(2)}` : ''}
                            </div>
                          </div>
                        </div>
                      </th>
                      {dates.map((date) => {
                        const here = (x: Shift) => x.employeeId === e.id && x.date === date;
                        // The picked-up chip keeps its element in the home cell (a touch keeps talking to
                        // the element it started on) and a floating copy shows where it will land.
                        const entries: ChipEntry[] = [];
                        for (const s of state.shifts) {
                          if (moved?.original.id !== s.id) {
                            if (here(s)) entries.push({ s, kind: 'normal' });
                            continue;
                          }
                          if (here(moved.original)) entries.push({ s: moved.original, kind: 'slot' });
                          if (here(s)) entries.push({ s, kind: 'float' });
                        }
                        const shifts = entries.filter((x) => x.kind !== 'slot').map((x) => x.s);
                        const onLeave = e.leave.includes(date);
                        return (
                          <td
                            key={date}
                            data-emp={e.id}
                            data-date={date}
                            className={`${onLeave ? 'leave' : ''} ${isWeekend(date) ? 'weekend' : ''} ${
                              dragging?.mode !== 'move'
                                ? ''
                                : dragging.blocked?.employeeId === e.id && dragging.blocked.date === date
                                  ? 'no-drop'
                                  : dragging.current.employeeId === e.id && dragging.current.date === date
                                    ? 'drop-target'
                                    : ''
                            }`}
                          >
                            {entries.map(({ s, kind }) => {
                              const sc = metrics.cost.shifts.get(s.id);
                              const flagged = personIssues.filter((i) => i.shiftId === s.id);
                              const level = flagged.some((i) => i.severity === 'block') ? 'block' : flagged.length ? 'warn' : '';
                              const role = roleOf(s.roleId);
                              const elsewhere = s.siteId !== site.id;
                              return (
                                <button
                                  key={kind === 'float' ? `${s.id}-float` : s.id}
                                  tabIndex={kind === 'slot' ? -1 : undefined}
                                  aria-hidden={kind === 'slot' || undefined}
                                  className={`chip dept-${role?.department ?? 'FOH'} ${level} ${elsewhere ? 'elsewhere' : ''} ${
                                    dragging?.original.id === s.id ? 'is-dragging' : ''
                                  } ${pulse(elsewhere) ? 'hint-pulse' : ''} ${kind === 'normal' ? '' : kind === 'float' ? 'floating' : 'chip-slot'}`}
                                  onContextMenu={(ev) => ev.preventDefault()}
                                  onClick={() => !wasDrag() && onEdit?.(s)}
                                  onPointerDown={elsewhere || !onEdit ? undefined : (ev) => startDrag(ev, s)}
                                  onKeyDown={elsewhere || !onEdit ? undefined : (ev) => keyMove(ev, s)}
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
                                    {sc && showCost && <b>{money(sc.total)}</b>}
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
                            {!onLeave && onEdit && (clip ? (
                              <button className="add paste" onClick={() => paste(e, date)} aria-label={`Paste ${clip.label} for ${e.name}`}>
                                Paste
                              </button>
                            ) : (
                              <button className="add" onClick={() => onEdit(newShift(e, date))} aria-label={`Add shift for ${e.name}`}>
                                +
                              </button>
                            ))}
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
                        {showCost && <div className="muted tnum">{ec ? money(ec.total) : '£0'}</div>}
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
        {showCost && <tfoot data-sticky-bottom>
          <tr>
            <th className="who">Labour cost</th>
            {metrics.days.map((d) => <td key={d.date} className="tnum">{money(d.labourCost)}</td>)}
            <td className="tot tnum">{money(metrics.labourCost)}</td>
          </tr>
          <tr>
            <th className="who">Labour %</th>
            {metrics.days.map((d) => (
              <td key={d.date} className={`tnum ${d.forecastSales === 0 ? 'muted' : d.labourPct > metrics.targetPct ? 'over' : 'under'}`}>{d.forecastSales === 0 ? 'No forecast' : pct(d.labourPct)}</td>
            ))}
            <td className={`tot tnum ${metrics.forecastSales === 0 ? 'muted' : metrics.labourPct > metrics.targetPct ? 'over' : 'under'}`}>{metrics.forecastSales === 0 ? 'No forecast' : pct(metrics.labourPct)}</td>
          </tr>
        </tfoot>}
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
          blocked={dragging.blocked?.reason ?? null}
          resizing={dragging.mode !== 'move'}
          touch={pointer.touch}
        />
      )}
    </div>
    </>
  );
}

/**
 * The day's cover against demand, hour by hour across every role: a bar for who is on, a tick
 * for who is needed, red where any role is short, amber where only over.
 */
function CoverBars({ hours, site, max }: { hours: CoverHour[]; site: Site; max: number }) {
  const shown = hours.filter((h) => h.required > 0 || h.scheduled > 0 || isOpenHour(site, h.hour));
  if (shown.length === 0) return null;
  const short = shown.reduce((s, h) => s + h.short, 0);
  const over = shown.reduce((s, h) => s + h.over, 0);
  const H = 24;
  const w = 100 / shown.length;
  const hh = (h: number) => `${String(h % 24).padStart(2, '0')}:00`;
  return (
    <div className="cover-bars" title={shown.map((h) => `${hh(h.hour)}  ${h.scheduled} on, ${h.required} needed${h.short ? `, ${h.short} short` : h.over ? `, ${h.over} over` : ''}`).join('\n')}>
      <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" aria-hidden>
        {shown.map((h, i) => {
          const bar = (h.scheduled / max) * H;
          const need = H - (h.required / max) * H;
          return (
            <g key={h.hour}>
              <rect className={h.short ? 'short' : h.over ? 'over' : 'ok'} x={i * w + w * 0.12} width={w * 0.76} y={H - bar} height={bar} />
              {h.required > 0 && <line x1={i * w} x2={(i + 1) * w} y1={need} y2={need} />}
            </g>
          );
        })}
      </svg>
      <span className={`cover-sum ${short ? 'short' : over ? 'over' : 'ok'}`}>
        {short ? `${short}h short` : over ? `${over}h over` : 'Cover on plan'}
      </span>
    </div>
  );
}

function DragHint({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="coach" role="note">
      <div className="coach-demo" aria-hidden>
        <span className="coach-chip">
          <i className="g start" />
          <span>11:00-19:00</span>
          <i className="g end" />
        </span>
        <span className="coach-arrow">&harr;</span>
      </div>
      <div className="coach-text">
        <div className="coach-title">Change the rota by dragging</div>
        <ul>
          <li>Drag a shift onto another person or day to move it.</li>
          <li>Drag either edge to change the start or finish, in 15 minute steps.</li>
          <li>On a tablet, press and hold a shift to pick it up.</li>
          <li>Cost and labour % update as you drag. Leave and availability are respected.</li>
        </ul>
      </div>
      <button className="primary" onClick={onDismiss}>Got it</button>
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
