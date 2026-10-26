import { useEffect, useMemo, useState } from 'react';
import { forecastSalesForDay } from '../engine/demand';
import type { WeekMetrics } from '../engine/metrics';
import {
  costBricks,
  coverGrid,
  fairness,
  ganttChart,
  restThreads,
  stationBoard,
  type FairnessMeasure,
  type GanttBar,
  type PendingNotice,
  type RestThread,
} from '../engine/rotaViews';
import { addDays, formatMinute } from '../engine/time';
import type { Issue } from '../engine/compliance';
import type { Department, RotaState, Shift, Site } from '../engine/types';
import { api } from './api';
import { openingForGap, type Opening } from './assign';
import { dayLabel, hours as hrs, money, pct } from './format';

// The rota's other lenses. Each answers one decision the grid by person and the timeline leave to
// the eye: where to add or cut the next hour, who is being worn down, whether each position is
// held, which shift to cut, who a late change will reach, and who keeps getting the hard shifts.

const H = 60;
const DAY = 24 * H;
const clock = (hour: number) => `${String(hour % 24).padStart(2, '0')}:00`;
const span = (m: number) => `${Math.floor(m / H)}h${m % H ? ` ${m % H}m` : ''}`;
const firstName = (name: string) => name.split(' ')[0];

// Cover map -----------------------------------------------------------------------------------

interface CoverProps {
  state: RotaState;
  site: Site;
  dates: string[];
  /** Absent when the person cannot add shifts: short hours are then shown, not clickable. */
  onOpen?: (opening: Opening) => void;
}

/** The whole week's cover against demand at a glance: days down, trading hours across. */
export function CoverMap({ state, site, dates, onOpen }: CoverProps) {
  const [roleId, setRoleId] = useState('');
  const roles = state.roles.filter((r) => state.demandRules.some((d) => d.siteId === site.id && d.roleId === r.id));
  const grid = useMemo(() => coverGrid(state, site.id, dates, roleId || undefined), [state, site.id, dates, roleId]);
  const roleName = (id: string) => state.roles.find((r) => r.id === id)?.name ?? id;
  if (grid.hours.length === 0) return <div className="panel lens-empty muted">No demand rules for this site yet, so there is no cover to judge. Set them in Demand.</div>;
  return (
    <div className="panel lens">
      <div className="panel-head">
        <div>
          <div className="panel-title">Cover against demand, the whole week</div>
          <div className="panel-sub">
            {grid.short} person-hours short and {grid.over} over. Short hours are coral, spare hours gold.
            {onOpen ? ' Click a short hour to put someone on it.' : ''}
          </div>
        </div>
        <label className="lens-filter small">
          Role{' '}
          <select value={roleId} onChange={(e) => setRoleId(e.target.value)}>
            <option value="">All roles</option>
            {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </label>
      </div>
      <div className="panel-body lens-scroll">
        <div className="cover-map" style={{ gridTemplateColumns: `112px repeat(${grid.hours.length}, minmax(30px, 1fr)) 84px` }}>
          <span className="eyebrow" />
          {grid.hours.map((h) => <span key={h} className="eyebrow cover-hour">{clock(h)}</span>)}
          <span className="eyebrow cover-total">Short / over</span>
          {grid.days.map((day) => {
            const d = dayLabel(day.date);
            return (
              <div className="cover-row" key={day.date} style={{ display: 'contents' }}>
                <span className="cover-day"><b>{d.short}</b> <span className="muted small">{d.date}</span></span>
                {day.cells.map((c) => {
                  const label = `${d.short} ${clock(c.hour)}: need ${c.required}, rostered ${c.scheduled}`;
                  if (c.short > 0) {
                    const detail = c.shortRoles.map((r) => `${r.short} ${roleName(r.roleId)}`).join(', ');
                    const level = c.short >= 3 ? 3 : c.short;
                    const open = () => {
                      const opening = openingForGap(state, site.id, day.date, c.hour);
                      if (opening && onOpen) onOpen(roleId ? { ...opening, roleId } : opening);
                    };
                    return onOpen ? (
                      <button key={c.hour} className={`cover-cell short s${level}`} title={`${label}. Short: ${detail}. Click to fill.`} aria-label={`${label}, short ${detail}. Fill the gap`} onClick={open}>
                        -{c.short}
                      </button>
                    ) : (
                      <span key={c.hour} className={`cover-cell short s${level}`} title={`${label}. Short: ${detail}.`}>-{c.short}</span>
                    );
                  }
                  if (c.over > 0) return <span key={c.hour} className="cover-cell over" title={`${label}. ${c.over} more than needed.`}>+{c.over}</span>;
                  return <span key={c.hour} className={`cover-cell ${c.required ? 'ok' : 'shut'}`} title={label} />;
                })}
                <span className="cover-total tnum small">
                  <span className={day.short ? 'bad-text' : 'muted'}>-{day.short}</span> / <span className={day.over ? 'warn-text' : 'muted'}>+{day.over}</span>
                </span>
              </div>
            );
          })}
        </div>
        <div className="legend lens-legend">
          <span><i className="sw cover-sw short" /> Short: people needed and not rostered</span>
          <span><i className="sw cover-sw ok" /> Covered</span>
          <span><i className="sw cover-sw over" /> Over: paid for and not needed</span>
        </div>
      </div>
    </div>
  );
}

// Gantt ---------------------------------------------------------------------------------------

const DEPT_NAME: Record<Department, string> = { MGMT: 'Management', FOH: 'Front of house', BAR: 'Bar', BOH: 'Kitchen' };

interface GanttProps {
  state: RotaState;
  site: Site;
  dates: string[];
  issues: Issue[];
  /** Absent when the person cannot change shifts: bars are then shown, not clickable. */
  onEdit?: (shift: Shift) => void;
}

/** Each person as one line and their shifts as bars against the clock: one day by the hour, or the whole week. */
export function GanttView({ state, site, dates, issues, onEdit }: GanttProps) {
  const [mode, setMode] = useState<'day' | 'week'>('week');
  const [day, setDay] = useState(() => [...dates].sort((a, b) => salesOn(state, site.id, b) - salesOn(state, site.id, a))[0] ?? dates[0]);
  const date = dates.includes(day) ? day : dates[0];
  const g = useMemo(() => ganttChart(state, site.id, dates), [state, site.id, dates]);
  const lane = g.to - g.from;
  const lanes = mode === 'week' ? dates.length : 1;
  const width = lanes * lane;
  // Where a minute of a day sits along the track, as a share of it.
  const at = (dayIndex: number, minute: number) => (((mode === 'week' ? dayIndex : 0) * lane + minute - g.from) / width) * 100;
  const roleName = (id: string) => state.roles.find((r) => r.id === id)?.name ?? id;
  const siteName = (id: string) => state.sites.find((s) => s.id === id)?.name ?? id;
  const levelOf = (shiftId: string) => {
    const mine = issues.filter((i) => i.shiftId === shiftId && !i.overridden);
    return mine.some((i) => i.severity === 'block') ? 'block' : mine.some((i) => i.severity === 'warn') ? 'warn' : '';
  };
  // On one day each person stands under the department of the role they work that day.
  const deptOf = (roleId: string) => state.roles.find((r) => r.id === roleId)?.department ?? 'FOH';
  const DEPTS = Object.keys(DEPT_NAME) as Department[];
  const rows =
    mode === 'week'
      ? g.rows
      : g.rows
          .flatMap((r) => {
            const first = r.bars.find((b) => b.date === date && !b.away);
            return first ? [{ ...r, department: deptOf(first.roleId), start: first.startMinute }] : [];
          })
          .sort((a, b) => DEPTS.indexOf(a.department) - DEPTS.indexOf(b.department) || a.start - b.start || a.name.localeCompare(b.name));
  const hourTicks = Array.from({ length: lane / H + 1 }, (_, i) => g.from + i * H);
  const heads = g.heads.find((h) => h.date === date)?.hours ?? [];
  const short = heads.filter((h) => h.on < h.required).length;
  const label = (b: GanttBar) => `${formatMinute(b.startMinute)}-${formatMinute(b.endMinute)}`;
  const title = (name: string, b: GanttBar) =>
    `${name}, ${roleName(b.roleId)}${b.away ? ` at ${siteName(b.siteId)}` : ''}: ${dayLabel(b.date).short} ${label(b)}, ${hrs(b.paidHours)} paid` +
    `${b.breakMinutes ? ` after a ${b.breakMinutes}m break` : ''}${b.published ? '' : ', not yet published'}`;
  let dept: Department | null = null;
  return (
    <div className="panel lens">
      <div className="panel-head">
        <div>
          <div className="panel-title">{mode === 'week' ? 'Everyone\'s week as a Gantt chart' : `${dayLabel(date).short} ${dayLabel(date).date} as a Gantt chart`}</div>
          <div className="panel-sub">
            One line per person, by department, in the order they start. Solid bars are published, outlined are drafts; a coral or gold edge has a
            compliance issue. Shifts at another site are grey.
            {mode === 'day' && heads.length > 0 && (short ? ` ${short} ${short === 1 ? 'hour is' : 'hours are'} short of the forecast.` : ' Every hour has the heads the forecast needs.')}
            {onEdit ? ' Click a bar to change it.' : ''}
          </div>
        </div>
        <div className="gantt-controls">
          <div className="toggle small-toggle" role="tablist" aria-label="Span">
            {(['week', 'day'] as const).map((m) => (
              <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? 'active' : ''} onClick={() => setMode(m)}>
                {m === 'week' ? 'Week' : 'Day'}
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
        </div>
      </div>
      <div className="panel-body lens-scroll">
        {rows.length === 0 ? (
          <p className="muted">Nobody is rostered {mode === 'week' ? 'this week' : `on ${dayLabel(date).short}`}.</p>
        ) : (
          <div className={`gantt ${mode}`}>
            <span />
            <div className="gantt-axis">
              {mode === 'week'
                ? dates.map((d, i) => (
                    <button key={d} className="gantt-day eyebrow link" style={{ left: `${at(i, g.from)}%`, width: `${100 / lanes}%` }} title={`Open ${dayLabel(d).short} by the hour`} onClick={() => { setDay(d); setMode('day'); }}>
                      {dayLabel(d).short} {dayLabel(d).date}
                    </button>
                  ))
                : hourTicks.slice(0, -1).map((m) => (
                    <span key={m} className="gantt-hour eyebrow" style={{ left: `${at(0, m)}%`, width: `${(H / width) * 100}%` }}>{clock(m / H)}</span>
                  ))}
            </div>
            <span className="eyebrow gantt-total">Hours</span>
            {rows.map((r) => {
              const head = r.department !== dept && r.hours > 0 ? DEPT_NAME[r.department] : r.hours === 0 && dept !== null ? 'Not on this week' : null;
              dept = r.hours > 0 ? r.department : null;
              const bars = mode === 'week' ? r.bars : r.bars.filter((b) => b.date === date);
              const over = r.contractedHours > 0 && r.hours > r.contractedHours;
              return (
                <div key={r.employeeId} style={{ display: 'contents' }}>
                  {head && <h3 className="lens-sub gantt-group">{head}</h3>}
                  <span className="gantt-name" title={r.borrowed ? `Based at ${siteName(state.employees.find((e) => e.id === r.employeeId)?.siteId ?? '')}` : undefined}>
                    {r.name}
                    {r.borrowed && <span className="tag">Cover</span>}
                  </span>
                  <div className="gantt-track">
                    {(mode === 'week' ? dates.map((_, i) => at(i, g.from)) : hourTicks.map((m) => at(0, m))).map((left, i) => (
                      <span key={i} className={`gantt-tick${mode === 'week' ? ' day' : ''}`} style={{ left: `${left}%` }} />
                    ))}
                    {bars.map((b) => {
                      const left = at(b.day, Math.max(g.from, b.startMinute));
                      const w = at(b.day, Math.min(g.to, b.endMinute)) - left;
                      const cls = `gantt-bar ${b.away ? 'away' : b.published ? 'pub' : 'draft'} ${b.away ? '' : levelOf(b.shiftId)}`;
                      const shift = state.shifts.find((s) => s.id === b.shiftId);
                      const text = mode === 'day' ? `${roleName(b.roleId)} ${label(b)}` : formatMinute(b.startMinute).replace(':00', '');
                      return onEdit && shift && !b.away ? (
                        <button key={b.shiftId} className={cls} style={{ left: `${left}%`, width: `${w}%` }} title={title(r.name, b)} onClick={() => onEdit(shift)}>
                          <span className="gantt-label">{text}</span>
                        </button>
                      ) : (
                        <span key={b.shiftId} className={cls} style={{ left: `${left}%`, width: `${w}%` }} title={title(r.name, b)}>
                          <span className="gantt-label">{text}</span>
                        </span>
                      );
                    })}
                  </div>
                  <span className={`gantt-total tnum small${over ? ' warn-text' : r.hours ? '' : ' muted'}`} title={r.contractedHours ? `${r.contractedHours}h contracted, ${r.days} ${r.days === 1 ? 'day' : 'days'}` : `${r.days} ${r.days === 1 ? 'day' : 'days'}`}>
                    {hrs(r.hours)}
                  </span>
                </div>
              );
            })}
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
        </div>
      </div>
    </div>
  );
}

// Rest thread ---------------------------------------------------------------------------------

/** Each person's last week and this one as one line: shifts as blocks, the rest between them coloured. */
export function RestView({ state, site, week }: { state: RotaState; site: Site; week: string }) {
  const from = addDays(week, -7);
  const threads = useMemo(() => restThreads(state, site.id, from, 14), [state, site.id, from]);
  const days = Array.from({ length: 14 }, (_, i) => addDays(from, i));
  const total = 14 * DAY;
  const x = (m: number) => `${(Math.max(0, Math.min(total, m)) / total) * 100}%`;
  const w = (a: number, b: number) => `${((Math.min(total, b) - Math.max(0, a)) / total) * 100}%`;
  const short = threads.filter((t) => t.gaps.some((g) => g.judged && g.level === 'short')).length;
  return (
    <div className="panel lens">
      <div className="panel-head">
        <div>
          <div className="panel-title">Rest between shifts, last week and this</div>
          <div className="panel-sub">
            Each line is one person at every site they work. Rest under the legal minimum is coral, within two hours of it gold.
            {short ? ` ${short} ${short === 1 ? 'person has' : 'people have'} a short rest.` : ' Nobody has a short rest.'} Shortest rest first.
          </div>
        </div>
      </div>
      <div className="panel-body lens-scroll">
        <div className="rest-grid">
          <span />
          <div className="rest-axis">
            {days.map((d, i) => (
              <span key={d} className={`rest-day eyebrow${i === 7 ? ' week' : ''}`} style={{ left: x(i * DAY), width: `${100 / 14}%` }}>
                {dayLabel(d).short.slice(0, 2)} {Number(d.slice(8))}
              </span>
            ))}
          </div>
          <span className="eyebrow">Shortest / run</span>
          {threads.map((t) => <RestRow key={t.employeeId} t={t} x={x} w={w} siteId={site.id} />)}
        </div>
        <div className="legend lens-legend">
          <span><i className="sw rest-sw block" /> Shift here</span>
          <span><i className="sw rest-sw away" /> Shift at another site</span>
          <span><i className="sw rest-sw short" /> Under the legal rest</span>
          <span><i className="sw rest-sw tight" /> Legal but tight</span>
          <span><i className="ln rest-week" /> This week starts</span>
        </div>
      </div>
    </div>
  );
}

function RestRow({ t, x, w, siteId }: { t: RestThread; x: (m: number) => string; w: (a: number, b: number) => string; siteId: string }) {
  const worst = t.gaps.filter((g) => g.judged).reduce<string>((lvl, g) => (g.level === 'short' ? 'short' : g.level === 'tight' && lvl !== 'short' ? 'tight' : lvl), 'ok');
  return (
    <>
      <span className="rest-name">{t.name}</span>
      <div className="rest-track" role="img" aria-label={`${t.name}: ${t.blocks.length} shifts, shortest rest ${t.shortest === null ? 'not measured' : span(t.shortest)}`}>
        {Array.from({ length: 13 }, (_, i) => <span key={i} className={`rest-tick${i === 6 ? ' week' : ''}`} style={{ left: x((i + 1) * DAY) }} />)}
        {t.gaps.filter((g) => g.judged && g.level !== 'ok').map((g) => (
          <span key={`g${g.from}`} className={`rest-gap ${g.level}`} style={{ left: x(g.from), width: w(g.from, g.to) }} title={`${span(g.minutes)} rest; ${t.minRest / H}h is the legal minimum`}>
            <span className="rest-gap-label">{span(g.minutes)}</span>
          </span>
        ))}
        {t.blocks.map((b) => (
          <span
            key={b.shiftId}
            className={`rest-block${b.siteId === siteId ? '' : ' away'}${b.close ? ' close' : ''}`}
            style={{ left: x(b.from), width: w(b.from, b.to) }}
            title={`${dayLabel(b.date).short} ${dayLabel(b.date).date} ${formatMinute(((b.from % DAY) + DAY) % DAY)}-${formatMinute(b.to - Math.floor(b.from / DAY) * DAY)}${b.close ? ', closing' : ''}`}
          />
        ))}
      </div>
      <span className="rest-figures small tnum">
        <span className={worst === 'short' ? 'bad-text' : worst === 'tight' ? 'warn-text' : ''}>{t.shortest === null ? 'None' : span(t.shortest)}</span>
        {' / '}
        <span className={t.longestRun >= 7 ? 'bad-text' : t.longestRun >= 6 ? 'warn-text' : ''}>{t.longestRun}d</span>
        {t.closeThenOpen > 0 && <span className="tag">Close then open {t.closeThenOpen}</span>}
      </span>
    </>
  );
}

// Station board -------------------------------------------------------------------------------

/** One day by position: who holds each role in each hour, and the hours a needed position is empty. */
export function StationView({ state, site, dates }: { state: RotaState; site: Site; dates: string[] }) {
  const [day, setDay] = useState(() => {
    const busiest = [...dates].sort((a, b) => salesOn(state, site.id, b) - salesOn(state, site.id, a))[0];
    return busiest ?? dates[0];
  });
  const date = dates.includes(day) ? day : dates[0];
  const board = useMemo(() => stationBoard(state, site.id, date), [state, site.id, date]);
  const empty = board.rows.reduce((a, r) => a + r.empty, 0);
  return (
    <div className="panel lens">
      <div className="panel-head">
        <div>
          <div className="panel-title">Positions by hour</div>
          <div className="panel-sub">
            Who holds each position through the day. Coral is a position the forecast needs with nobody in it; gold has fewer than it needs.
            {empty ? ` ${empty} empty position-hours on ${dayLabel(date).short}.` : ` Every needed position is held on ${dayLabel(date).short}.`}
          </div>
        </div>
        <div className="toggle small-toggle" role="tablist" aria-label="Day">
          {dates.map((d) => (
            <button key={d} role="tab" aria-selected={d === date} className={d === date ? 'active' : ''} onClick={() => setDay(d)}>
              {dayLabel(d).short}
            </button>
          ))}
        </div>
      </div>
      <div className="panel-body lens-scroll">
        <table className="table station">
          <thead>
            <tr>
              <th>Position</th>
              {board.hours.map((h) => <th key={h} className="station-hour">{clock(h)}</th>)}
            </tr>
          </thead>
          <tbody>
            {board.rows.map((r) => (
              <tr key={r.roleId}>
                <th scope="row">
                  {r.name}
                  {r.empty > 0 && <span className="tag bad">{r.empty}h empty</span>}
                </th>
                {r.cells.map((c) => {
                  const level = c.required > 0 && c.people.length === 0 ? 'empty' : c.people.length < c.required ? 'short' : c.people.length ? 'held' : '';
                  return (
                    <td key={c.hour} className={`station-cell ${level}`} title={`${clock(c.hour)}: ${c.people.map((p) => p.name).join(', ') || 'nobody'}${c.required ? `; ${c.required} needed` : ''}`}>
                      {level === 'empty' ? <span className="station-nobody">Nobody</span> : c.people.map((p) => <span key={p.shiftId} className="station-person">{firstName(p.name)}</span>)}
                      {level === 'short' && <span className="station-need">{c.people.length} of {c.required}</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const salesOn = forecastSalesForDay;

// Cost bricks ---------------------------------------------------------------------------------

/** Each day's shifts laid end to end at their loaded cost, against the spend that keeps the day on target. */
export function CostView({ state, site, dates, metrics }: { state: RotaState; site: Site; dates: string[]; metrics: WeekMetrics }) {
  const days = useMemo(() => costBricks(state, metrics.cost, site.id, dates), [state, metrics.cost, site.id, dates]);
  const max = Math.max(1, ...days.map((d) => Math.max(d.cost, d.target)));
  const w = (n: number) => `${(n / max) * 100}%`;
  const priciest = days
    .flatMap((d) => d.bricks.map((b) => ({ ...b, date: d.date })))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 6);
  const roleName = (id: string) => state.roles.find((r) => r.id === id)?.name ?? id;
  return (
    <div className="panel lens">
      <div className="panel-head">
        <div>
          <div className="panel-title">What each shift costs against the day</div>
          <div className="panel-sub">
            Every shift at its fully loaded cost (pay, holiday, employer NI, pension), in the order the day runs. The line is the spend that keeps
            the day at {pct(site.labourTargetPct, 0)}; whatever runs past it is hatched coral.
          </div>
        </div>
      </div>
      <div className="panel-body lens-scroll">
        <div className="bricks">
          {days.map((d) => {
            const over = d.cost > d.target && d.sales > 0;
            return (
              <div className="brick-row" key={d.date}>
                <span className="brick-day">
                  <b>{dayLabel(d.date).short}</b> <span className="muted small">{money(d.sales)} sales</span>
                </span>
                <div className="brick-track">
                  {d.unallocated > 0 && <span className="brick fixed" style={{ width: w(d.unallocated) }} title={`Paid but not rostered: ${money(d.unallocated)}`} />}
                  {d.bricks.map((b) => (
                    <span
                      key={b.shiftId}
                      className="brick"
                      style={{ width: w(b.cost) }}
                      title={`${b.name}, ${roleName(b.roleId)} ${formatMinute(b.startMinute)}-${formatMinute(b.endMinute)}: ${money(b.cost)} for ${hrs(b.paidHours)} (${money(b.perHour)} an hour)${b.overTarget ? `. ${money(b.overTarget)} of it past target` : ''}`}
                    >
                      {b.overTarget > 0 && <span className="brick-over" style={{ width: `${(b.overTarget / b.cost) * 100}%` }} />}
                      <span className="brick-label">{firstName(b.name)}</span>
                    </span>
                  ))}
                  {d.sales > 0 && <span className="brick-target" style={{ left: w(d.target) }} title={`Target spend ${money(d.target)}`} />}
                </div>
                <span className="brick-figures tnum small">
                  {money(d.cost)}{' '}
                  {d.sales > 0 ? <span className={over ? 'bad-text' : 'good-text'}>{pct(d.labourPct)}</span> : <span className="muted">no forecast</span>}
                </span>
              </div>
            );
          })}
        </div>
        <div className="legend lens-legend">
          <span><i className="sw brick-sw" /> A shift, width is its cost</span>
          <span><i className="sw brick-sw fixed" /> Paid but not rostered</span>
          <span><i className="sw brick-sw over" /> Past the day target</span>
          <span><i className="ln brick-ln" /> Target spend</span>
        </div>
        {priciest.length > 0 && (
          <>
            <h3 className="lens-sub">The week's most expensive shifts</h3>
            <table className="table compact">
              <tbody>
                {priciest.map((b) => (
                  <tr key={b.shiftId}>
                    <td>{dayLabel(b.date).short} {formatMinute(b.startMinute)}-{formatMinute(b.endMinute)}</td>
                    <td>{b.name}, {roleName(b.roleId)}</td>
                    <td className="num tnum">{money(b.cost)}</td>
                    <td className="num tnum muted">{money(b.perHour)} an hour</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}

// Changes since published ---------------------------------------------------------------------

interface Changes {
  lastPublished: { publishedAt: string; by: string } | null;
  notices: (PendingNotice & { name: string })[];
}

/** Who the next publish will reach and what each person will be told, before anyone's phone buzzes. */
export function ChangesView({ state, site, week }: { state: RotaState; site: Site; week: string }) {
  const [changes, setChanges] = useState<Changes | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    api
      .get<Changes>(`/v1/rota/changes?siteId=${encodeURIComponent(site.id)}&weekStart=${week}`)
      .then((c) => { if (live) { setChanges(c); setFailed(false); } })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [site.id, week, state.shifts]);
  if (failed) return <div className="panel lens-empty muted">Could not work out the changes. Try again in a moment.</div>;
  if (!changes) return <div className="panel lens-empty muted">Working out the changes</div>;
  const first = changes.notices.filter((n) => n.kind === 'first');
  const changed = changes.notices.filter((n) => n.kind !== 'first');
  const when = changes.lastPublished ? new Date(changes.lastPublished.publishedAt).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' }) : null;
  return (
    <div className="panel lens">
      <div className="panel-head">
        <div>
          <div className="panel-title">What the next publish will tell people</div>
          <div className="panel-sub">
            {when ? `Last published ${when} by ${changes.lastPublished!.by}. ` : 'Not published yet: the first publish sends each person their whole week. '}
            {changes.notices.length === 0
              ? 'Nobody will hear anything: the week matches what everyone was told.'
              : `${changes.notices.length} ${changes.notices.length === 1 ? 'person' : 'people'} will be told: ${changed.length} of a change, ${first.length} of their week for the first time.`}
          </div>
        </div>
      </div>
      <div className="panel-body">
        {changed.length > 0 && (
          <ul className="changes">
            {changed.map((n) => (
              <li key={n.employeeId}>
                <span className="strong">{n.name}</span>
                <span className="tag">{n.kind === 'removed' ? 'Taken off the week' : `${n.added.length + n.removed.length} ${n.added.length + n.removed.length === 1 ? 'change' : 'changes'}`}</span>
                <ul className="change-lines">
                  {n.removed.map((l) => <li key={`r${l}`} className="removed"><span className="change-mark">Off</span> <s>{l}</s></li>)}
                  {n.added.map((l) => <li key={`a${l}`} className="added"><span className="change-mark">New</span> {l}</li>)}
                </ul>
              </li>
            ))}
          </ul>
        )}
        {first.length > 0 && (
          <>
            <h3 className="lens-sub">First told about this week</h3>
            <ul className="changes compact">
              {first.map((n) => (
                <li key={n.employeeId}>
                  <span className="strong">{n.name}</span> <span className="muted small">{n.added.length} {n.added.length === 1 ? 'shift' : 'shifts'}: {n.added.map((l) => l.split(',')[0]).join('; ')}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        {changes.notices.length > 0 && <p className="muted small">Each change is a message on someone's phone, and a late one costs goodwill. Make it only if it is worth that.</p>}
      </div>
    </div>
  );
}

// Fairness ledger -----------------------------------------------------------------------------

const MEASURES: { key: FairnessMeasure; label: string; help: string }[] = [
  { key: 'weekends', label: 'Weekend shifts', help: 'Saturday and Sunday shifts' },
  { key: 'closes', label: 'Closes', help: "Shifts to the site's close" },
  { key: 'lates', label: 'After midnight', help: 'Shifts that end after midnight' },
  { key: 'cut', label: 'Hours under contract', help: 'Hourly staff rostered below their contracted hours, summed by week' },
];

/** Four weeks of who got the hard shifts, as a dot per person so anyone carrying more than their share stands apart. */
export function FairnessView({ state, site, week }: { state: RotaState; site: Site; week: string }) {
  const f = useMemo(() => fairness(state, site.id, week), [state, site.id, week]);
  const isOutlier = (id: string, m: FairnessMeasure) => f.outliers.some((o) => o.employeeId === id && o.measure === m);
  const range = `${dayLabel(f.weekStarts[0]).date} to ${dayLabel(addDays(week, 6)).date}`;
  return (
    <div className="panel lens">
      <div className="panel-head">
        <div>
          <div className="panel-title">How the hard shifts are shared, four weeks</div>
          <div className="panel-sub">
            {range}, this week included{f.rotaWeeks.length < f.weekStarts.length ? `; ${f.rotaWeeks.length} of the ${f.weekStarts.length} weeks have a rota here, and only those count towards contracted hours` : ''}. One
            dot per person; coral dots carry at least double the team average.
            {f.outliers.length ? ` ${new Set(f.outliers.map((o) => o.employeeId)).size} to look at before this week goes out.` : ' Nobody stands out.'}
          </div>
        </div>
      </div>
      <div className="panel-body">
        <div className="dots">
          {MEASURES.map((m) => {
            const max = Math.max(1, ...f.rows.map((r) => r[m.key]));
            return (
              <div className="dot-row" key={m.key}>
                <span className="dot-label" title={m.help}>{m.label}<span className="muted small"> avg {m.key === 'cut' ? hrs(f.average[m.key]) : f.average[m.key]}</span></span>
                <div className="dot-track">
                  <span className="dot-avg" style={{ left: `${(f.average[m.key] / max) * 100}%` }} title={`Team average ${f.average[m.key]}`} />
                  {f.rows.map((r, i) => {
                    const out = isOutlier(r.employeeId, m.key);
                    return (
                      <span key={r.employeeId} className={`dot${out ? ' out' : ''}`} style={{ left: `${(r[m.key] / max) * 100}%`, top: `${8 + (i % 4) * 5}px` }} title={`${r.name}: ${r[m.key]}`}>
                        {out && <span className={`dot-name${i % 2 ? ' below' : ''}`}>{firstName(r.name)}</span>}
                      </span>
                    );
                  })}
                </div>
                <span className="dot-max muted small tnum">{m.key === 'cut' ? hrs(max) : max}</span>
              </div>
            );
          })}
        </div>
        <div className="lens-scroll">
          <table className="table compact fairness">
            <thead>
              <tr>
                <th>Person</th>
                <th className="num">Contracted</th>
                <th className="num">Rostered</th>
                {MEASURES.map((m) => <th key={m.key} className="num" title={m.help}>{m.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {f.rows.map((r) => (
                <tr key={r.employeeId}>
                  <td>{r.name}{r.payBasis === 'salaried' && <span className="muted small"> salaried</span>}</td>
                  <td className="num tnum">{hrs(r.contracted)}</td>
                  <td className="num tnum">{hrs(r.rostered)}</td>
                  {MEASURES.map((m) => (
                    <td key={m.key} className={`num tnum${isOutlier(r.employeeId, m.key) ? ' bad-text strong' : ''}`}>
                      {m.key === 'cut' ? (r.payBasis === 'hourly' ? hrs(r.cut) : '') : r[m.key]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
