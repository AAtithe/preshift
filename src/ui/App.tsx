import { useEffect, useMemo, useState } from 'react';
import { autoSchedule, type UnfilledGap } from '../engine/autoschedule';
import { checkWeek } from '../engine/compliance';
import { weekMetrics } from '../engine/metrics';
import { addDays, formatMinute, toISODate, weekDates, weekStart } from '../engine/time';
import type { Shift } from '../engine/types';
import { CloseView } from './CloseView';
import { DemandView } from './DemandView';
import { dayLabel } from './format';
import { KpiBar } from './KpiBar';
import { RotaGrid } from './RotaGrid';
import { ShiftEditor } from './ShiftEditor';
import { useRotaStore } from './store';
import { TeamView } from './TeamView';
import { WeekOverview } from './WeekOverview';

type Tab = 'rota' | 'demand' | 'team' | 'close';

const TABS: { id: Tab; label: string }[] = [
  { id: 'rota', label: 'Rota' },
  { id: 'demand', label: 'Demand' },
  { id: 'team', label: 'Team' },
  { id: 'close', label: 'Close' },
];

export function App() {
  const [state, dispatch] = useRotaStore();
  const [siteId, setSiteId] = useState(state.sites[0].id);
  const [week, setWeek] = useState(weekStart(toISODate(new Date())));
  const [tab, setTab] = useState<Tab>('rota');
  const [editing, setEditing] = useState<Shift | null>(null);
  const [unfilled, setUnfilled] = useState<UnfilledGap[] | null>(null);
  const [preview, setPreview] = useState<Shift | null>(null);
  const [lastChange, setLastChange] = useState<{ before: Shift; after: Shift } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  // While a shift is being dragged every figure on the page is worked from the previewed rota.
  const view = useMemo(
    () => (preview ? { ...state, shifts: state.shifts.map((s) => (s.id === preview.id ? preview : s)) } : state),
    [state, preview],
  );
  const site = state.sites.find((s) => s.id === siteId)!;
  const baseMetrics = useMemo(() => weekMetrics(state, siteId, week), [state, siteId, week]);
  const metrics = useMemo(() => (preview ? weekMetrics(view, siteId, week) : baseMetrics), [view, preview, baseMetrics, siteId, week]);
  const issues = useMemo(() => checkWeek(view, week, siteId), [view, siteId, week]);

  useEffect(() => {
    if (!refusal) return;
    const t = setTimeout(() => setRefusal(null), 5000);
    return () => clearTimeout(t);
  }, [refusal]);

  useEffect(() => {
    if (!lastChange) return;
    const t = setTimeout(() => setLastChange(null), 8000);
    return () => clearTimeout(t);
  }, [lastChange]);

  function commitChange(after: Shift, before: Shift) {
    dispatch({ type: 'upsertShift', shift: after });
    setLastChange({ before, after });
    setRefusal(null);
  }

  function refuse(message: string) {
    setRefusal(message);
    setLastChange(null);
  }
  const dates = weekDates(week);
  const blocks = issues.filter((i) => i.severity === 'block').length;
  const weekShifts = state.shifts.filter((s) => s.siteId === siteId && dates.includes(s.date));
  const published = weekShifts.length > 0 && weekShifts.every((s) => s.published);

  function runAutoBuild() {
    const result = autoSchedule(state, siteId, week);
    dispatch({ type: 'setShifts', shifts: result.shifts });
    setUnfilled(result.unfilled);
  }

  const status = blocks > 0 ? 'blocked' : published ? 'published' : 'draft';
  const statusLabel = blocks > 0 ? `${blocks} blocking issue${blocks > 1 ? 's' : ''}` : published ? 'Published to team' : weekShifts.length ? 'Draft' : 'Not started';
  const gapGroups = unfilled
    ? Array.from(
        unfilled.reduce((m, g) => {
          const name = state.roles.find((r) => r.id === g.roleId)?.name ?? g.roleId;
          m.set(name, [...(m.get(name) ?? []), g]);
          return m;
        }, new Map<string, UnfilledGap[]>()),
      )
    : [];
  const clock = (h: number) => `${String(h % 24).padStart(2, '0')}:00`;

  return (
    <>
      <div className="masthead">
        <div className="masthead-inner">
          <header className="topbar">
            <div className="brand">
              <span className="brand-mark" aria-hidden>
                <svg width="20" height="20" viewBox="0 0 32 32">
                  <path d="M11 23V9h6.2a4.6 4.6 0 0 1 0 9.2H11" fill="none" stroke="#c9e6d5" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <div>
                <div className="brand-name">Preshift</div>
                <div className="brand-sub">Rota by Preshift and Williams, Stanley &amp; Co.</div>
              </div>
            </div>
            <div className="controls">
              <div className="seg" role="tablist" aria-label="Site">
                {state.sites.map((s) => (
                  <button key={s.id} className={s.id === siteId ? 'active' : ''} onClick={() => setSiteId(s.id)}>
                    {s.name}
                  </button>
                ))}
              </div>
              <div className="week-nav">
                <button onClick={() => setWeek(addDays(week, -7))} aria-label="Previous week">&lsaquo;</button>
                <span className="week-label">
                  {dayLabel(week).date} <span className="muted">to</span> {dayLabel(dates[6]).date}
                </span>
                <button onClick={() => setWeek(addDays(week, 7))} aria-label="Next week">&rsaquo;</button>
              </div>
            </div>
          </header>
          <div className="headline">
            <div>
              <h1>{site.name}, week commencing {dayLabel(week).date}</h1>
              <p>Built from the forecast, costed the way payroll will cost it, checked against UK employment law.</p>
            </div>
            <span className={`status-pill ${status}`}>
              <span className="dot" />
              {statusLabel}
            </span>
          </div>
        </div>
      </div>

      <div className="app">
        <KpiBar metrics={metrics} issues={issues} />

        <nav className="toolbar">
          <div className="tabs">
            {TABS.map((t) => (
              <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
                {t.label}
                {t.id === 'demand' && unfilled && unfilled.length > 0 && <span className="count">{unfilled.length}</span>}
              </button>
            ))}
          </div>
          <div className="tab-actions">
            <button
              className="ghost"
              onClick={() => { dispatch({ type: 'clearWeek', siteId, weekStart: week }); setUnfilled(null); }}
            >
              Clear week
            </button>
            <button
              disabled={blocks > 0 || weekShifts.length === 0 || published}
              title={blocks > 0 ? 'Resolve blocking issues before publishing' : undefined}
              onClick={() => dispatch({ type: 'publishWeek', siteId, weekStart: week })}
            >
              {published ? 'Published' : 'Publish to team'}
            </button>
            <button onClick={runAutoBuild} className="primary">Build from forecast</button>
          </div>
        </nav>

        {unfilled && unfilled.length > 0 && (
          <div className="gaps" role="status">
            <span className="gaps-icon" aria-hidden>!</span>
            <div>
              <div className="gaps-title">{unfilled.length} gaps could not be filled legally with the current team</div>
              <div className="gaps-sub">That is a hiring or cross-training signal, not a rota problem.</div>
              <div className="gap-groups">
                {gapGroups.map(([role, gaps]) => (
                  <div className="gap-group" key={role}>
                    <b>{role}</b>
                    {gaps.map((g, i) => (
                      <span className="gap-chip" key={i}>
                        {dayLabel(g.date).short} {clock(g.fromHour)}-{clock(g.toHour)}
                      </span>
                    ))}
                  </div>
                ))}
              </div>
            </div>
            <button className="ghost" onClick={() => setUnfilled(null)}>Dismiss</button>
          </div>
        )}

        <main>
          {tab === 'rota' && <WeekOverview state={view} siteId={siteId} dates={dates} metrics={metrics} />}
          {tab === 'rota' && (
            <RotaGrid
              state={view}
              site={site}
              dates={dates}
              metrics={metrics}
              issues={issues}
              onEdit={setEditing}
              onPreview={setPreview}
              onCommit={commitChange}
              onBlocked={refuse}
              baseLabourCost={baseMetrics.labourCost}
            />
          )}
          {tab === 'demand' && <DemandView state={state} siteId={siteId} dates={dates} />}
          {tab === 'team' && <TeamView state={state} siteId={siteId} metrics={metrics} issues={issues} />}
          {tab === 'close' && <CloseView state={state} week={week} />}
        </main>

        <footer className="foot">
          <span>UK rates 2026/27. Demo data is held in this browser only.</span>
          <button className="link" onClick={() => { if (confirm('Reset to demo data?')) dispatch({ type: 'reset' }); }}>
            Reset demo
          </button>
        </footer>

        {refusal && (
          <div className="toast refused" role="alert">
            <span>{refusal}</span>
            <button className="ghost" onClick={() => setRefusal(null)}>Close</button>
          </div>
        )}

        {lastChange && (
          <div className="toast" role="status">
            <span>
              {describeChange(lastChange.before, lastChange.after, state)}
            </span>
            <button
              className="ghost"
              onClick={() => {
                dispatch({ type: 'upsertShift', shift: lastChange.before });
                setLastChange(null);
              }}
            >
              Undo
            </button>
          </div>
        )}

        {editing && (
          <ShiftEditor
            state={state}
            shift={editing}
            onSave={(shift) => { dispatch({ type: 'upsertShift', shift }); setEditing(null); }}
            onDelete={(id) => { dispatch({ type: 'deleteShift', id }); setEditing(null); }}
            onClose={() => setEditing(null)}
          />
        )}
      </div>
    </>
  );
}

function describeChange(before: Shift, after: Shift, state: { employees: { id: string; name: string }[] }) {
  const name = (id: string) => state.employees.find((e) => e.id === id)?.name.split(' ')[0] ?? '';
  const when = (s: Shift) => `${dayLabel(s.date).short} ${formatMinute(s.startMinute)}-${formatMinute(s.endMinute)}`;
  if (before.employeeId !== after.employeeId) return `Moved ${name(before.employeeId)}'s shift to ${name(after.employeeId)}, ${when(after)}`;
  if (before.date !== after.date) return `Moved ${name(after.employeeId)} to ${when(after)}`;
  return `${name(after.employeeId)} now ${when(after)}`;
}
