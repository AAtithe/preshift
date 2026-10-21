import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { Issue } from '../engine/compliance';
import { dayDemand } from '../engine/demand';
import type { WeekMetrics } from '../engine/metrics';
import { formatMinute, toISODate } from '../engine/time';
import type { Department, RotaState, Shift, Site } from '../engine/types';
import { openingForGap, rangeFromDraw, shortestRole, type Opening } from './assign';
import { dropBlocker, keyChange, nudgeShift, resizeShift } from './drag';
import { DragReadout } from './DragReadout';
import { money, pct } from './format';
import { type Resolve, useShiftDrag } from './useShiftDrag';

const DEPT_ORDER: Department[] = ['MGMT', 'FOH', 'BAR', 'BOH'];
const DEPT_SHORT: Record<Department, string> = { MGMT: 'Mgmt', FOH: 'FOH', BAR: 'Bar', BOH: 'BOH' };
const WEEKDAY = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const ROW = 30;
const PAD = 12;
const STRIP = 22;

interface Props {
  /** The rota as previewed mid-drag. */
  state: RotaState;
  /** The rota before the drag, which fixes the layout so rows never jump under the pointer. */
  base: RotaState;
  site: Site;
  dates: string[];
  metrics: WeekMetrics;
  issues: Issue[];
  onEdit: (shift: Shift) => void;
  onPreview: (shift: Shift | null) => void;
  onCommit: (shift: Shift, before: Shift) => void;
  onBlocked: (message: string) => void;
  /** Open the picker for a new shift drawn on a day or picked from a short hour. */
  onOpen: (opening: Opening) => void;
  baseLabourCost: number;
}

interface Draw {
  date: string;
  a: number;
  b: number;
  left: number;
  width: number;
  x: number;
  y: number;
  touch: boolean;
  moved: boolean;
}

/** A tap that moves further than this is a scroll, not a request for a shift. */
const TAP_SLOP = 8;

interface Placed {
  shift: Shift;
  row: number;
  dept: Department;
}

interface Lane {
  date: string;
  top: number;
  height: number;
  placed: Placed[];
  rows: number;
  /** First row of each department, for the faint labels in the plot. */
  groups: { dept: Department; row: number }[];
}

/**
 * The week as seven service timelines. Each day is drawn over its own sales curve, with
 * shifts stacked as bars by department and a coverage strip that reads short or over by the
 * hour. Bars drag along the day to move, by their ends to resize, and up or down to another day.
 */
export function Timeline({ state, base, site, dates, metrics, issues, onEdit, onPreview, onCommit, onBlocked, onOpen, baseLabourCost }: Props) {
  const layer = useRef<HTMLDivElement>(null);
  const [draw, setDraw] = useState<Draw | null>(null);
  const drawRef = useRef<Draw | null>(null);
  const deptOf = (roleId: string) => base.roles.find((r) => r.id === roleId)?.department ?? 'FOH';
  const siteShifts = base.shifts.filter((s) => s.siteId === site.id && dates.includes(s.date));

  // The axis covers trading hours with an hour either side, widened for any shift outside them.
  const from = Math.floor(Math.min(site.openMinute - 60, ...siteShifts.map((s) => s.startMinute)) / 60) * 60;
  const to = Math.ceil(Math.max(site.closeMinute + 60, ...siteShifts.map((s) => s.endMinute)) / 60) * 60;
  const span = to - from;
  const x = (m: number) => ((m - from) / span) * 100;
  const hours = Array.from({ length: span / 60 + 1 }, (_, i) => from + i * 60);
  const minuteAt = (d: Draw, clientX: number) => from + ((clientX - d.left) / d.width) * span;
  const geometry = useRef({ from, span, siteId: site.id, state, onOpen });
  geometry.current = { from, span, siteId: site.id, state, onOpen };

  // Drag across an empty stretch of a day to draw a shift; a click or tap drops a four hour block.
  useEffect(() => {
    const update = (d: Draw | null) => {
      drawRef.current = d;
      setDraw(d);
    };
    function move(e: PointerEvent) {
      const d = drawRef.current;
      if (!d) return;
      const travelled = Math.hypot(e.clientX - d.x, e.clientY - d.y) > TAP_SLOP;
      // On touch any real movement is a scroll, so the draw is abandoned.
      if (d.touch) return travelled ? update(null) : undefined;
      const g = geometry.current;
      update({ ...d, moved: d.moved || travelled, b: g.from + ((e.clientX - d.left) / d.width) * g.span });
    }
    function up() {
      const d = drawRef.current;
      if (!d) return;
      update(null);
      const g = geometry.current;
      const b = d.moved ? d.b : d.a;
      const lo = Math.min(d.a, b);
      const hi = Math.max(d.a, b);
      const role = shortestRole(g.state, g.siteId, d.date, Math.floor(lo / 60) * 60, Math.max(hi, lo + 60)) ?? g.state.demandRules.find((r) => r.siteId === g.siteId)?.roleId ?? g.state.roles[0].id;
      g.onOpen(rangeFromDraw(d.a, b, role, g.siteId, d.date));
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

  function startDraw(e: ReactPointerEvent<HTMLDivElement>, date: string) {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.tl-cell')) return;
    const box = e.currentTarget.getBoundingClientRect();
    const d: Draw = { date, a: 0, b: 0, left: box.left, width: box.width, x: e.clientX, y: e.clientY, touch: e.pointerType === 'touch', moved: false };
    d.a = d.b = minuteAt(d, e.clientX);
    drawRef.current = d;
    setDraw(d);
    if (!d.touch) e.preventDefault();
  }

  // Lay out every day once from the rota as it was before the drag.
  let top = 0;
  const lanes: Lane[] = dates.map((date) => {
    const placed: Placed[] = [];
    const groups: Lane['groups'] = [];
    let rows = 0;
    for (const dept of DEPT_ORDER) {
      const mine = siteShifts
        .filter((s) => s.date === date && deptOf(s.roleId) === dept)
        .sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute);
      if (mine.length === 0) continue;
      groups.push({ dept, row: rows });
      const ends: number[] = [];
      for (const shift of mine) {
        let r = ends.findIndex((end) => end <= shift.startMinute);
        if (r === -1) r = ends.push(0) - 1;
        ends[r] = shift.endMinute;
        placed.push({ shift, row: rows + r, dept });
      }
      rows += ends.length;
    }
    // One spare row at the foot of every day takes shifts dragged in from other days.
    const height = PAD + (rows + 1) * ROW + STRIP + PAD;
    const lane = { date, top, height, placed, rows, groups };
    top += height;
    return lane;
  });
  const totalHeight = top;

  const resolve: Resolve = (d, e, dx) => {
    const box = layer.current?.getBoundingClientRect();
    if (!box) return { next: d.current, blocked: null };
    const minutes = (dx / box.width) * span;
    const person = state.employees.find((p) => p.id === d.original.employeeId);
    const wasAllowed = person && !dropBlocker(person, d.original);
    if (d.mode !== 'move') {
      const candidate = resizeShift(d.original, d.mode, minutes);
      const reason = wasAllowed ? dropBlocker(person, candidate) : null;
      if (reason) return { next: d.current, blocked: { employeeId: d.original.employeeId, date: d.original.date, reason, refuse: false } };
      return { next: candidate, blocked: null };
    }
    const y = e.clientY - box.top;
    const lane = lanes.find((l) => y >= l.top && y < l.top + l.height) ?? (y < 0 ? lanes[0] : lanes[lanes.length - 1]);
    const candidate = { ...nudgeShift(d.original, minutes), date: lane.date };
    const reason = person ? dropBlocker(person, candidate) : null;
    if (reason && candidate.date !== d.original.date) {
      // Another day the person cannot work: the shift goes home and letting go changes nothing.
      return { next: d.original, blocked: { employeeId: d.original.employeeId, date: lane.date, reason, refuse: true } };
    }
    // Along the same day, hold at the last time that fits their availability.
    if (reason && wasAllowed) return { next: d.current, blocked: { employeeId: d.original.employeeId, date: lane.date, reason, refuse: false } };
    return { next: candidate, blocked: null };
  };

  const { dragging, pointer, startDrag, wasDrag } = useShiftDrag({
    resolve,
    scroller: () => document.querySelector<HTMLElement>('.tl'),
    onPreview,
    onCommit,
    onBlocked,
  });

  function keyMove(e: KeyboardEvent, shift: Shift) {
    const change = keyChange(e, shift, dates, state.employees.find((p) => p.id === shift.employeeId));
    if (!change) return;
    e.preventDefault();
    if (change.reason) onBlocked(`Not changed. ${change.reason}`);
    else onCommit(change.next, shift);
  }

  const forecastMax = Math.max(1, ...state.forecast.filter((f) => f.siteId === site.id && dates.includes(f.date)).map((f) => f.sales));
  const today = toISODate(new Date());
  const name = (id: string) => state.employees.find((p) => p.id === id)?.name ?? '';
  const homeOf = (id: string) => state.employees.find((p) => p.id === id)?.siteId ?? site.id;
  const siteOf = (id: string) => state.sites.find((x) => x.id === id)?.name ?? '';
  const short = (full: string) => {
    const [first, last] = full.split(' ');
    return last ? `${first} ${last[0]}` : first;
  };

  return (
    <div className="tl panel">
      <div className="tl-axis" data-sticky-top>
        <div className="tl-corner">
          <span className="eyebrow">Service day</span>
        </div>
        <div className="tl-ticks">
          {hours.map((m, i) => (
            <span key={m} className="tl-tick" style={{ left: `${x(m)}%` }}>
              {i < hours.length - 1 ? formatMinute(m).slice(0, 2) : ''}
            </span>
          ))}
        </div>
        <div className="tl-corner right">
          <span className="eyebrow">Day P&amp;L</span>
        </div>
      </div>

      <div className="tl-body" style={{ height: totalHeight }}>
        {lanes.map((lane, i) => {
          const m = metrics.days[i];
          const over = m.labourPct > metrics.targetPct;
          const pts = (m.labourPct - metrics.targetPct) * 100;
          const forecast = state.forecast.filter((f) => f.siteId === site.id && f.date === lane.date);
          const coverage = coverageFor(state, site.id, lane.date);
          const plotH = lane.height - PAD * 2 - STRIP;
          const target = dragging?.mode === 'move' && dragging.current.date === lane.date && dragging.original.date !== lane.date;
          const refused = dragging?.blocked?.refuse && dragging.blocked.date === lane.date;
          const d = new Date(`${lane.date}T00:00:00Z`);
          return (
            <section
              key={lane.date}
              className={`tl-lane${lane.date === today ? ' today' : ''}${target ? ' drop' : ''}${refused ? ' refused' : ''}`}
              style={{ top: lane.top, height: lane.height }}
            >
              <header className="tl-day">
                <div className="tl-dayname">{WEEKDAY[i]}</div>
                <div className="eyebrow">{d.getUTCDate()} {d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })}</div>
                <div className="tl-daysales tnum">{money(m.forecastSales)}</div>
                <div className="muted small">forecast sales</div>
              </header>
              <div className="tl-plot" onPointerDown={(e) => startDraw(e, lane.date)}>
                <svg className="tl-curve" viewBox={`0 0 ${span} 100`} preserveAspectRatio="none" aria-hidden style={{ top: PAD, height: plotH }}>
                  <path d={curvePath(forecast, from, forecastMax)} />
                </svg>
                {lane.groups.map((g) => (
                  <span key={g.dept} className="tl-group" style={{ top: PAD + g.row * ROW }}>
                    {DEPT_SHORT[g.dept]}
                  </span>
                ))}
                {lane.rows === 0 && <span className="tl-empty">No shifts. Drag across the day to add one, or build from the forecast.</span>}
                {draw?.date === lane.date && draw.moved && (
                  <DraftBand from={Math.min(draw.a, draw.b)} to={Math.max(draw.a, draw.b)} x={x} top={PAD} height={plotH} />
                )}
                <div className="tl-strip" style={{ bottom: PAD }}>
                  {coverage.map((c) =>
                    c.hour * 60 >= from && c.hour * 60 < to ? (
                      c.gap > 0 ? (
                        <button
                          key={c.hour}
                          className="tl-cell short"
                          style={{ left: `${x(c.hour * 60)}%`, width: `${(60 / span) * 100}%` }}
                          title={`${formatMinute(c.hour * 60)}: need ${c.required}, rostered ${c.scheduled}. Click to fill the gap.`}
                          aria-label={`${c.gap} short at ${formatMinute(c.hour * 60)}. Fill the gap`}
                          onClick={() => {
                            const opening = openingForGap(state, site.id, lane.date, c.hour);
                            if (opening) onOpen(opening);
                          }}
                        >
                          -{c.gap}
                        </button>
                      ) : (
                        <span
                          key={c.hour}
                          className={`tl-cell ${c.gap < 0 ? 'over' : c.required ? 'ok' : ''}`}
                          style={{ left: `${x(c.hour * 60)}%`, width: `${(60 / span) * 100}%` }}
                          title={`${formatMinute(c.hour * 60)}: need ${c.required}, rostered ${c.scheduled}`}
                        >
                          {c.gap < 0 ? `+${-c.gap}` : ''}
                        </span>
                      )
                    ) : null,
                  )}
                </div>
              </div>
              <aside className="tl-pnl">
                <div className="tnum">{money(m.labourCost)}</div>
                <div className="muted small">labour</div>
                <div className={`tl-pct tnum ${m.labourCost ? (over ? 'bad-text' : 'good-text') : ''}`}>{pct(m.labourPct)}</div>
                {m.labourCost > 0 && (
                  <div className={`small tnum ${over ? 'bad-text' : 'good-text'}`}>
                    {pts > 0 ? '+' : ''}
                    {pts.toFixed(1)} pts
                  </div>
                )}
              </aside>
            </section>
          );
        })}

        <div className="tl-layer" ref={layer}>
          {hours.map((m) => (
            <span key={m} className="tl-hour" style={{ left: `${x(m)}%` }} />
          ))}
          {lanes.flatMap((lane) =>
            lane.placed.map(({ shift: original, row }) => {
              const live = state.shifts.find((s) => s.id === original.id) ?? original;
              const isDragged = dragging?.original.id === original.id;
              const shift = isDragged ? dragging.current : live;
              const home = lanes.find((l) => l.date === shift.date) ?? lane;
              // Same day keeps its row; another day lands in that day's spare row.
              const y = home.top + PAD + (shift.date === original.date ? row : home.rows) * ROW;
              const flagged = issues.filter((i) => i.shiftId === shift.id);
              const level = flagged.some((i) => i.severity === 'block') ? 'block' : flagged.length ? 'warn' : '';
              const role = state.roles.find((r) => r.id === shift.roleId);
              const cost = metrics.cost.shifts.get(shift.id)?.total ?? 0;
              const moved = isDragged && (shift.date !== original.date || shift.startMinute !== original.startMinute || shift.endMinute !== original.endMinute);
              return [
                moved ? (
                  <span
                    key={`${original.id}-home`}
                    className="tl-ghost"
                    style={{ top: lane.top + PAD + row * ROW, left: `${x(original.startMinute)}%`, width: `${x(original.endMinute) - x(original.startMinute)}%` }}
                  />
                ) : null,
                <button
                  key={original.id}
                  className={`tl-bar ${shift.published ? 'pub' : 'draft'} ${level} ${isDragged ? 'is-dragging' : ''}`}
                  style={{ top: y, left: `${x(shift.startMinute)}%`, width: `${x(shift.endMinute) - x(shift.startMinute)}%` }}
                  onPointerDown={(ev) => startDrag(ev, live)}
                  onClick={() => !wasDrag() && onEdit(live)}
                  onKeyDown={(ev) => keyMove(ev, live)}
                  onContextMenu={(ev) => ev.preventDefault()}
                  title={
                    flagged.map((i) => i.message).join('\n') ||
                    `${name(shift.employeeId)}, ${role?.name} ${formatMinute(shift.startMinute)}-${formatMinute(shift.endMinute)}. Drag to move, drag the ends to change the hours.`
                  }
                >
                  <span className="tl-edge start" data-edge="start" aria-hidden />
                  <span className="tl-name">{short(name(shift.employeeId))}</span>
                  {homeOf(shift.employeeId) !== site.id && <span className="tl-from">{siteOf(homeOf(shift.employeeId))}</span>}
                  <span className="tl-meta">
                    {role?.name} · {formatMinute(shift.startMinute)}-{formatMinute(shift.endMinute)}
                  </span>
                  <span className="tl-cost tnum">{money(cost)}</span>
                  {level && <span className="tl-flag" aria-label={level === 'block' ? 'Blocking issue' : 'Needs review'}>!</span>}
                  <span className="tl-edge end" data-edge="end" aria-hidden />
                </button>,
              ];
            }),
          )}
        </div>
      </div>

      {pointer && dragging && (
        <DragReadout
          x={pointer.x}
          y={pointer.y}
          shift={dragging.current}
          name={name(dragging.current.employeeId)}
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
  );
}

/** The stretch being drawn, with its snapped times and length. */
function DraftBand({ from, to, x, top, height }: { from: number; to: number; x: (m: number) => number; top: number; height: number }) {
  const opening = rangeFromDraw(from, to, '', '', '');
  return (
    <div className="tl-draft" style={{ left: `${x(opening.startMinute)}%`, width: `${x(opening.endMinute) - x(opening.startMinute)}%`, top, height }}>
      <span className="tnum">
        {formatMinute(opening.startMinute)}-{formatMinute(opening.endMinute)} · {((opening.endMinute - opening.startMinute) / 60).toFixed(1)}h
      </span>
    </div>
  );
}

/** Headcount needed against rostered, summed across every role, for each hour of the day. */
function coverageFor(state: RotaState, siteId: string, date: string) {
  const rules = state.demandRules.filter((r) => r.siteId === siteId);
  const byHour = new Map<number, { hour: number; required: number; scheduled: number; gap: number }>();
  for (const rule of rules) {
    for (const h of dayDemand(state, siteId, rule.roleId, date)) {
      const c = byHour.get(h.hour) ?? { hour: h.hour, required: 0, scheduled: 0, gap: 0 };
      c.required += h.required;
      c.scheduled += h.scheduled;
      c.gap += h.gap;
      byHour.set(h.hour, c);
    }
  }
  return [...byHour.values()].filter((c) => c.required > 0 || c.scheduled > 0);
}

/** A smooth sales curve across the day, scaled to the week's busiest hour so days compare. */
function curvePath(forecast: { hour: number; sales: number }[], from: number, max: number) {
  const pts = forecast
    .filter((f) => f.sales > 0)
    .sort((a, b) => a.hour - b.hour)
    .map((f) => [f.hour * 60 + 30 - from, 100 - (f.sales / max) * 92] as const);
  if (pts.length === 0) return '';
  const first = pts[0][0] - 30;
  const last = pts[pts.length - 1][0] + 30;
  let d = `M${first},100L${first},${pts[0][1]}`;
  for (let i = 0; i < pts.length; i++) {
    const [px, py] = pts[i];
    const prev = pts[i - 1];
    d += prev ? `C${(prev[0] + px) / 2},${prev[1]} ${(prev[0] + px) / 2},${py} ${px},${py}` : `L${px},${py}`;
  }
  d += `L${last},${pts[pts.length - 1][1]}L${last},100Z`;
  return d.replace(/(\d+\.\d{2})\d+/g, '$1');
}
