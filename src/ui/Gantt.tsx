import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { Issue } from '../engine/compliance';
import { forecastSalesForDay } from '../engine/demand';
import type { WeekMetrics } from '../engine/metrics';
import { ganttChart, type GanttBar, type GanttRow } from '../engine/rotaViews';
import { formatMinute } from '../engine/time';
import type { Department, Employee, RotaState, Shift, Site } from '../engine/types';
import { rangeFromDraw } from './assign';
import { dropBlocker, keyChange, moveShift, nudgeShift, resizeShift, sameShift } from './drag';
import { DragReadout } from './DragReadout';
import { dayLabel, hours as hrs, money, pct } from './format';
import { pointAt, slide, type Lanes } from './gantt';
import { type Resolve, useShiftDrag } from './useShiftDrag';

const H = 60;
const DEPTS: Department[] = ['MGMT', 'FOH', 'BAR', 'BOH'];
const DEPT_NAME: Record<Department, string> = { MGMT: 'Management', FOH: 'Front of house', BAR: 'Bar', BOH: 'Kitchen' };
const clock = (hour: number) => `${String(hour % 24).padStart(2, '0')}:00`;
/** A tap that moves further than this is a scroll, not a request for a shift. */
const TAP_SLOP = 8;

interface Props {
  /** The rota as previewed mid-drag. */
  state: RotaState;
  /** The rota before the drag, which fixes the rows so nobody's line jumps under the pointer. */
  base: RotaState;
  site: Site;
  dates: string[];
  metrics: WeekMetrics;
  issues: Issue[];
  showCost: boolean;
  /** Absent when the person cannot change the rota: the chart is then read only. */
  onEdit?: (shift: Shift) => void;
  onPreview: (shift: Shift | null) => void;
  onCommit: (shift: Shift, before: Shift) => void;
  onBlocked: (message: string) => void;
  baseLabourCost: number;
}

interface Draw {
  employeeId: string;
  a: number;
  b: number;
  left: number;
  width: number;
  x: number;
  y: number;
  touch: boolean;
  moved: boolean;
}

interface Line extends GanttRow {
  /** Where the person stands on this chart: the department of the first role they work in it. */
  dept: Department;
  start: number;
  onLeave: boolean;
}

/**
 * The rota as a Gantt chart: one line per person and their shifts as bars against the clock,
 * the whole week or one day by the hour. Bars drag along the line to move, by their ends to change
 * the hours, and onto another person's line to hand the shift over. Drag across an empty stretch
 * of someone's line to give them a shift.
 */
export function Gantt({ state, base, site, dates, metrics, issues, showCost, onEdit, onPreview, onCommit, onBlocked, baseLabourCost }: Props) {
  const [mode, setMode] = useState<'day' | 'week'>('week');
  const [day, setDay] = useState(() => [...dates].sort((a, b) => forecastSalesForDay(state, site.id, b) - forecastSalesForDay(state, site.id, a))[0] ?? dates[0]);
  const [dept, setDept] = useState<Department | ''>('');
  const [showFree, setShowFree] = useState(false);
  const [draw, setDraw] = useState<Draw | null>(null);
  const drawRef = useRef<Draw | null>(null);
  const chart = useRef<HTMLDivElement>(null);
  const date = dates.includes(day) ? day : dates[0];
  const dayIndex = dates.indexOf(date);

  // Rows come from the rota before the drag; bars, hours and heads from the rota as previewed.
  const layout = useMemo(() => ganttChart(base, site.id, dates), [base, site.id, dates]);
  const live = useMemo(() => (state === base ? layout : ganttChart(state, site.id, dates)), [state, base, layout, site.id, dates]);
  const from = Math.min(layout.from, live.from);
  const to = Math.max(layout.to, live.to);
  const lane = to - from;
  const lanes: Lanes = { from, lane, days: mode === 'week' ? dates.length : 1 };
  const width = lanes.days * lane;
  const at = (d: number, minute: number) => (((mode === 'week' ? d : 0) * lane + minute - from) / width) * 100;

  const employee = (id: string) => state.employees.find((e) => e.id === id);
  const roleName = (id: string) => state.roles.find((r) => r.id === id)?.name ?? id;
  const deptOf = (roleId: string) => state.roles.find((r) => r.id === roleId)?.department ?? 'FOH';
  const siteName = (id: string) => state.sites.find((s) => s.id === id)?.name ?? id;
  const shiftCost = (id: string) => metrics.cost.shifts.get(id)?.total ?? 0;
  const levelOf = (shiftId: string) => {
    const mine = issues.filter((i) => i.shiftId === shiftId && !i.overridden);
    return mine.some((i) => i.severity === 'block') ? 'block' : mine.some((i) => i.severity === 'warn') ? 'warn' : '';
  };
  const liveRow = new Map(live.rows.map((r) => [r.employeeId, r]));

  // The lines shown, in the order they stand. On a day, those not on it are listed after, when asked for.
  const lines: Line[] = layout.rows.map((r) => {
    const first = r.bars.find((b) => !b.away && (mode === 'week' || b.date === date));
    return {
      ...r,
      dept: first ? deptOf(first.roleId) : r.department,
      start: first ? (mode === 'week' ? first.day * 24 * H : 0) + first.startMinute : Infinity,
      onLeave: mode === 'day' && !!employee(r.employeeId)?.leave.includes(date),
    };
  });
  const filtered = lines.filter((l) => !dept || l.dept === dept);
  const working = filtered
    .filter((l) => l.start !== Infinity)
    .sort((a, b) => DEPTS.indexOf(a.dept) - DEPTS.indexOf(b.dept) || a.start - b.start || a.name.localeCompare(b.name));
  const idle = filtered.filter((l) => l.start === Infinity).sort((a, b) => Number(a.onLeave) - Number(b.onLeave) || a.name.localeCompare(b.name));
  const idleLabel = mode === 'week' ? 'Not on this week' : `Not on ${dayLabel(date).short}`;
  const shownIdle = mode === 'week' || showFree ? idle : [];

  const resolve: Resolve = (d, e, dx) => {
    const box = chart.current?.querySelector<HTMLElement>('.gantt-track[data-emp]')?.getBoundingClientRect();
    if (!box) return { next: d.current, blocked: null };
    const minutes = (dx / box.width) * width;
    const owner = employee(d.original.employeeId);
    const wasAllowed = owner && !dropBlocker(owner, d.original);
    if (d.mode !== 'move') {
      const candidate = resizeShift(d.original, d.mode, minutes);
      const reason = wasAllowed ? dropBlocker(owner, candidate) : null;
      if (reason) return { next: d.current, blocked: { employeeId: d.original.employeeId, date: d.original.date, reason, refuse: false } };
      return { next: candidate, blocked: null };
    }
    const placed = slide(Math.max(0, dates.indexOf(d.original.date)), d.original.startMinute, minutes, lanes);
    let candidate = { ...nudgeShift(d.original, placed.startMinute - d.original.startMinute), date: mode === 'week' ? dates[placed.day] : d.original.date };
    // Onto another person's line hands the shift to them; off every line it stays with its owner.
    const target = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-emp]')?.dataset.emp;
    const person = (target && employee(target)) || owner;
    if (person && person.id !== d.original.employeeId) candidate = moveShift(candidate, person, candidate.date);
    const reason = person ? dropBlocker(person, candidate) : null;
    if (reason && (candidate.date !== d.original.date || candidate.employeeId !== d.original.employeeId)) {
      return { next: d.original, blocked: { employeeId: candidate.employeeId, date: candidate.date, reason, refuse: true } };
    }
    if (reason && wasAllowed) return { next: d.current, blocked: { employeeId: d.original.employeeId, date: d.original.date, reason, refuse: false } };
    return { next: candidate, blocked: null };
  };

  const { dragging, pointer, startDrag, wasDrag } = useShiftDrag({
    resolve,
    scroller: () => chart.current?.closest<HTMLElement>('.lens-scroll') ?? null,
    onPreview,
    onCommit,
    onBlocked,
  });

  function keyMove(e: KeyboardEvent, shift: Shift) {
    const change = keyChange(e, shift, dates, employee(shift.employeeId));
    if (!change) return;
    e.preventDefault();
    if (change.reason) onBlocked(`Not changed. ${change.reason}`);
    else onCommit(change.next, shift);
  }

  // Drag across an empty stretch of someone's line to give them a shift there; a click drops four hours.
  const geometry = useRef({ lanes, dates, mode, date, site, onEdit, employee });
  geometry.current = { lanes, dates, mode, date, site, onEdit, employee };
  useEffect(() => {
    const update = (d: Draw | null) => {
      drawRef.current = d;
      setDraw(d);
    };
    function move(e: PointerEvent) {
      const d = drawRef.current;
      if (!d) return;
      const travelled = Math.hypot(e.clientX - d.x, e.clientY - d.y) > TAP_SLOP;
      if (d.touch) return travelled ? update(null) : undefined;
      update({ ...d, moved: d.moved || travelled, b: (e.clientX - d.left) / d.width });
    }
    function up() {
      const d = drawRef.current;
      if (!d) return;
      update(null);
      const g = geometry.current;
      const person = g.employee(d.employeeId);
      if (!person || !g.onEdit) return;
      const a = pointAt(d.a, g.lanes);
      // The stretch stays inside the day it was started on.
      const b = d.moved ? pointAt(d.b, g.lanes) : a;
      const end = b.day === a.day ? b.minute : b.day > a.day ? g.lanes.from + g.lanes.lane : g.lanes.from;
      const on = g.mode === 'week' ? g.dates[a.day] : g.date;
      const range = rangeFromDraw(a.minute, end, person.roleIds[0], g.site.id, on);
      g.onEdit(newShift(person, range.roleId, g.site.id, on, range.startMinute, range.endMinute));
    }
    const cancel = () => update(null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
  }, []);

  function startDraw(e: ReactPointerEvent<HTMLDivElement>, employeeId: string) {
    if (!onEdit || e.button !== 0 || (e.target as HTMLElement).closest('.gantt-bar')) return;
    const box = e.currentTarget.getBoundingClientRect();
    const share = (e.clientX - box.left) / box.width;
    const d: Draw = { employeeId, a: share, b: share, left: box.left, width: box.width, x: e.clientX, y: e.clientY, touch: e.pointerType === 'touch', moved: false };
    drawRef.current = d;
    setDraw(d);
    if (!d.touch) e.preventDefault();
  }

  const hourTicks = Array.from({ length: lane / H + 1 }, (_, i) => from + i * H);
  const heads = live.heads.find((h) => h.date === date)?.hours ?? [];
  const short = heads.filter((h) => h.on < h.required).length;
  const m = metrics.days[dayIndex];
  const label = (b: Pick<GanttBar, 'startMinute' | 'endMinute'>) => `${formatMinute(b.startMinute)}-${formatMinute(b.endMinute)}`;
  const rowCost = (r: GanttRow | undefined) => (r ? r.bars.filter((b) => !b.away).reduce((a, b) => a + shiftCost(b.shiftId), 0) : 0);

  // The bars on one person's line: their shifts as previewed, with the one being dragged drawn where it is heading.
  function barsFor(employeeId: string): GanttBar[] {
    const own = (liveRow.get(employeeId)?.bars ?? []).filter((b) => dragging?.original.id !== b.shiftId);
    const d = dragging?.current;
    const dragged: GanttBar[] =
      d && d.employeeId === employeeId
        ? [{ shiftId: d.id, date: d.date, day: dates.indexOf(d.date), siteId: d.siteId, roleId: d.roleId, startMinute: d.startMinute, endMinute: d.endMinute, breakMinutes: d.breakMinutes, paidHours: 0, published: !!d.published, away: false }]
        : [];
    return [...own, ...dragged].filter((b) => mode === 'week' || b.date === date);
  }

  function renderLine(l: Line, head: string | null) {
    const r = liveRow.get(l.employeeId) ?? l;
    const over = r.contractedHours > 0 && r.hours > r.contractedHours;
    const bars = barsFor(l.employeeId);
    const ghost = dragging && dragging.original.employeeId === l.employeeId && !sameShift(dragging.current, dragging.original) ? dragging.original : null;
    const refused = dragging?.blocked?.refuse && dragging.blocked.employeeId === l.employeeId;
    const target = dragging?.mode === 'move' && dragging.current.employeeId === l.employeeId && dragging.original.employeeId !== l.employeeId;
    const drawing = draw?.employeeId === l.employeeId && draw.moved ? draw : null;
    const homeSite = employee(l.employeeId)?.siteId ?? '';
    return (
      <div key={l.employeeId} style={{ display: 'contents' }}>
        {head && <h3 className="lens-sub gantt-group">{head}</h3>}
        <span className="gantt-name" title={l.borrowed ? `Based at ${siteName(homeSite)}` : undefined}>
          <span className="gantt-person">{l.name}</span>
          {l.borrowed && <span className="tag">Cover</span>}
          {l.onLeave && <span className="tag">On leave</span>}
        </span>
        <div
          className={`gantt-track${onEdit ? ' editable' : ''}${target ? ' drop' : ''}${refused ? ' refused' : ''}`}
          data-emp={l.employeeId}
          onPointerDown={(e) => startDraw(e, l.employeeId)}
          title={onEdit && bars.length === 0 ? `Drag across ${l.name.split(' ')[0]}'s line to give them a shift` : undefined}
        >
          {(mode === 'week' ? dates.map((_, i) => at(i, from)) : hourTicks.map((t) => at(0, t))).map((left, i) => (
            <span key={i} className={`gantt-tick${mode === 'week' ? ' day' : ''}`} style={{ left: `${left}%` }} />
          ))}
          {ghost && (mode === 'week' || ghost.date === date) && (
            <span className="gantt-ghost" style={{ left: `${at(dates.indexOf(ghost.date), ghost.startMinute)}%`, width: `${((ghost.endMinute - ghost.startMinute) / width) * 100}%` }} />
          )}
          {drawing && <DrawBand draw={drawing} lanes={lanes} at={at} />}
          {bars.map((b) => {
            const left = at(b.day, Math.max(from, b.startMinute));
            const w = at(b.day, Math.min(to, b.endMinute)) - left;
            const level = b.away ? '' : levelOf(b.shiftId);
            const isDragged = dragging?.current.id === b.shiftId;
            const cls = `gantt-bar ${b.away ? 'away' : b.published ? 'pub' : 'draft'} ${level}${isDragged ? ' is-dragging' : ''}`;
            const shift = base.shifts.find((s) => s.id === b.shiftId);
            const text = mode === 'day' ? `${roleName(b.roleId)} ${label(b)}${showCost && !b.away ? ` · ${money(shiftCost(b.shiftId))}` : ''}` : formatMinute(b.startMinute).replace(':00', '');
            const flags = issues.filter((i) => i.shiftId === b.shiftId && !i.overridden).map((i) => i.message);
            const title =
              `${l.name}, ${roleName(b.roleId)}${b.away ? ` at ${siteName(b.siteId)}` : ''}: ${dayLabel(b.date).short} ${label(b)}, ${hrs(b.paidHours)} paid` +
              `${b.breakMinutes ? ` after a ${b.breakMinutes}m break` : ''}${showCost && !b.away ? `, ${money(shiftCost(b.shiftId))} loaded` : ''}` +
              `${b.published ? '' : ', not yet published'}.${flags.length ? `\n${flags.join('\n')}` : ''}${onEdit && !b.away ? '\nDrag to move, drag the ends to change the hours, or drop on another person.' : ''}`;
            const style = { left: `${left}%`, width: `${w}%` };
            if (!onEdit || !shift || b.away) {
              return (
                <span key={b.shiftId} className={cls} style={style} title={title}>
                  <span className="gantt-label">{text}</span>
                </span>
              );
            }
            return (
              <button
                key={b.shiftId}
                className={cls}
                style={style}
                title={title}
                onPointerDown={(ev) => startDrag(ev, shift)}
                onClick={() => !wasDrag() && onEdit(shift)}
                onKeyDown={(ev) => keyMove(ev, shift)}
                onContextMenu={(ev) => ev.preventDefault()}
              >
                <span className="gantt-edge start" data-edge="start" aria-hidden />
                <span className="gantt-label">{text}</span>
                {level && <span className="gantt-flag" aria-label={level === 'block' ? 'Blocking issue' : 'Needs review'}>!</span>}
                <span className="gantt-edge end" data-edge="end" aria-hidden />
              </button>
            );
          })}
        </div>
        <span className={`gantt-total tnum small${over ? ' warn-text' : r.hours ? '' : ' muted'}`} title={r.contractedHours ? `${r.contractedHours}h contracted, ${r.days} ${r.days === 1 ? 'day' : 'days'} this week` : `${r.days} ${r.days === 1 ? 'day' : 'days'} this week`}>
          {hrs(r.hours)}
        </span>
        {showCost && <span className="gantt-total tnum small muted">{r.hours ? money(rowCost(liveRow.get(l.employeeId))) : ''}</span>}
      </div>
    );
  }

  let group: Department | null = null;
  return (
    <div className="panel lens">
      <div className="panel-head">
        <div>
          <div className="panel-title">{mode === 'week' ? "Everyone's week as a Gantt chart" : `${dayLabel(date).short} ${dayLabel(date).date} as a Gantt chart`}</div>
          <div className="panel-sub">
            One line per person, by department, in the order they start. Solid bars are published, outlined are drafts, grey is another site; a
            coral or gold edge has a compliance issue.
            {mode === 'day' && heads.length > 0 && (short ? ` ${short} ${short === 1 ? 'hour is' : 'hours are'} short of the forecast.` : ' Every hour has the heads the forecast needs.')}
            {onEdit ? ' Drag a bar to move it, its ends to change the hours, or onto another line to hand it over. Drag across an empty line to add a shift.' : ''}
          </div>
          {showCost && (
            <div className="gantt-pnl tnum small">
              {mode === 'week' ? (
                <>
                  Week: {money(metrics.labourCost)} labour on {money(metrics.forecastSales)} sales,{' '}
                  <b className={metrics.labourPct > metrics.targetPct ? 'bad-text' : 'good-text'}>{pct(metrics.labourPct)}</b> against {pct(metrics.targetPct, 0)}
                </>
              ) : (
                m && (
                  <>
                    {dayLabel(date).short}: {money(m.labourCost)} labour on {money(m.forecastSales)} sales,{' '}
                    <b className={m.labourPct > metrics.targetPct ? 'bad-text' : 'good-text'}>{m.forecastSales ? pct(m.labourPct) : 'no forecast'}</b>, {hrs(m.paidHours)} paid
                  </>
                )
              )}
            </div>
          )}
        </div>
        <div className="gantt-controls">
          <div className="toggle small-toggle" role="tablist" aria-label="Span">
            {(['week', 'day'] as const).map((x) => (
              <button key={x} role="tab" aria-selected={mode === x} className={mode === x ? 'active' : ''} onClick={() => setMode(x)}>
                {x === 'week' ? 'Week' : 'Day'}
              </button>
            ))}
          </div>
          {mode === 'day' && (
            <div className="toggle small-toggle" role="tablist" aria-label="Day">
              {dates.map((d) => (
                <button key={d} role="tab" aria-selected={d === date} className={d === date ? 'active' : ''} onClick={() => setDay(d)}>
                  {dayLabel(d).short}
                </button>
              ))}
            </div>
          )}
          <label className="lens-filter small">
            Department{' '}
            <select value={dept} onChange={(e) => setDept(e.target.value as Department | '')}>
              <option value="">All</option>
              {DEPTS.filter((x) => lines.some((l) => l.dept === x)).map((x) => <option key={x} value={x}>{DEPT_NAME[x]}</option>)}
            </select>
          </label>
        </div>
      </div>
      <div className="panel-body lens-scroll">
        {working.length === 0 && shownIdle.length === 0 ? (
          <p className="muted">Nobody is rostered {mode === 'week' ? 'this week' : `on ${dayLabel(date).short}`}{dept ? ` in ${DEPT_NAME[dept]}` : ''}.</p>
        ) : (
          <div ref={chart} className={`gantt ${mode}${showCost ? ' costed' : ''}`}>
            <span />
            <div className="gantt-axis">
              {mode === 'week'
                ? dates.map((d, i) => (
                    <button key={d} className="gantt-day eyebrow" style={{ left: `${at(i, from)}%`, width: `${100 / lanes.days}%` }} title={`Open ${dayLabel(d).short} by the hour`} onClick={() => { setDay(d); setMode('day'); }}>
                      {dayLabel(d).short} {dayLabel(d).date}
                    </button>
                  ))
                : hourTicks.slice(0, -1).map((t) => (
                    <span key={t} className="gantt-hour eyebrow" style={{ left: `${at(0, t)}%`, width: `${(H / width) * 100}%` }}>{clock(t / H)}</span>
                  ))}
            </div>
            <span className="eyebrow gantt-total">Hours</span>
            {showCost && <span className="eyebrow gantt-total">Cost</span>}
            {working.map((l) => {
              const head = l.dept !== group ? DEPT_NAME[l.dept] : null;
              group = l.dept;
              return renderLine(l, head);
            })}
            {shownIdle.map((l, i) => renderLine(l, i === 0 ? idleLabel : null))}
            {mode === 'day' && idle.length > 0 && (
              <button className="link small gantt-more" onClick={() => setShowFree(!showFree)}>
                {showFree ? `Hide those not on ${dayLabel(date).short}` : `Show ${idle.length} not on ${dayLabel(date).short}, to hand a shift to or give one`}
              </button>
            )}
            {mode === 'day' && heads.length > 0 && (
              <>
                <span className="gantt-name eyebrow">On / needed</span>
                <div className="gantt-track gantt-heads">
                  {heads.map((h) => (
                    <span
                      key={h.hour}
                      className={`gantt-head ${h.on < h.required ? 'short' : h.required && h.on > h.required ? 'over' : ''}`}
                      style={{ left: `${at(0, h.hour * H)}%`, width: `${(H / width) * 100}%` }}
                      title={`${clock(h.hour)}: ${h.on} on, ${h.required} needed`}
                    >
                      {h.on}{h.required ? `/${h.required}` : ''}
                    </span>
                  ))}
                </div>
                <span />
                {showCost && <span />}
              </>
            )}
            {mode === 'week' && showCost && (
              <>
                <span className="gantt-name eyebrow">Labour %</span>
                <div className="gantt-track gantt-heads">
                  {metrics.days.map((x, i) => (
                    <span
                      key={x.date}
                      className={`gantt-head ${x.forecastSales && x.labourPct > metrics.targetPct ? 'short' : ''}`}
                      style={{ left: `${at(i, from)}%`, width: `${100 / lanes.days}%` }}
                      title={`${dayLabel(x.date).short}: ${money(x.labourCost)} labour on ${money(x.forecastSales)} forecast sales`}
                    >
                      {x.forecastSales ? pct(x.labourPct) : '-'}
                    </span>
                  ))}
                </div>
                <span className="gantt-total tnum small">{hrs(metrics.paidHours)}</span>
                <span className="gantt-total tnum small">{money(metrics.labourCost)}</span>
              </>
            )}
          </div>
        )}
        <div className="legend lens-legend">
          <span><i className="sw gantt-sw pub" /> Published</span>
          <span><i className="sw gantt-sw draft" /> Draft</span>
          <span><i className="sw gantt-sw away" /> At another site</span>
          <span><i className="sw gantt-sw block" /> Breaks a rule</span>
          {mode === 'week' && <span className="muted">Click a day's name to see it by the hour.</span>}
          {onEdit && <span className="muted">Alt and the arrow keys move a selected bar.</span>}
        </div>
      </div>

      {pointer && dragging && (
        <DragReadout
          x={pointer.x}
          y={pointer.y}
          shift={dragging.current}
          name={employee(dragging.current.employeeId)?.name ?? ''}
          shiftCost={shiftCost(dragging.current.id)}
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
  );
}

/** A new shift for one person, opened in the shift editor before anything is saved. */
function newShift(person: Employee, roleId: string, siteId: string, date: string, startMinute: number, endMinute: number): Shift {
  return {
    id: `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    employeeId: person.id,
    roleId,
    siteId,
    date,
    startMinute,
    endMinute,
    breakMinutes: 0,
  };
}

/** The stretch being drawn on someone's line, with its snapped times and length. */
function DrawBand({ draw, lanes, at }: { draw: Draw; lanes: Lanes; at: (day: number, minute: number) => number }) {
  const a = pointAt(draw.a, lanes);
  const b = pointAt(draw.b, lanes);
  const end = b.day === a.day ? b.minute : b.day > a.day ? lanes.from + lanes.lane : lanes.from;
  const range = rangeFromDraw(a.minute, end, '', '', '');
  return (
    <span className="gantt-draw" style={{ left: `${at(a.day, range.startMinute)}%`, width: `${at(a.day, range.endMinute) - at(a.day, range.startMinute)}%` }}>
      <span className="tnum">
        {formatMinute(range.startMinute)}-{formatMinute(range.endMinute)} · {((range.endMinute - range.startMinute) / 60).toFixed(1)}h
      </span>
    </span>
  );
}
