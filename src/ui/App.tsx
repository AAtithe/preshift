import { useEffect, useMemo, useState } from 'react';
import { autoSchedule, type UnfilledGap } from '../engine/autoschedule';
import { checkWeek } from '../engine/compliance';
import { weekMetrics } from '../engine/metrics';
import { addDays, formatMinute, toISODate, weekDates, weekStart } from '../engine/time';
import type { Shift } from '../engine/types';
import { CloseView } from './CloseView';
import { DemandView } from './DemandView';
import { dayLabel, isoWeek } from './format';
import { PnlRail } from './PnlRail';
import { RotaGrid } from './RotaGrid';
import { ShiftEditor } from './ShiftEditor';
import { useRotaStore } from './store';
import { TeamView } from './TeamView';
import { Timeline } from './Timeline';

type Tab = 'rota' | 'demand' | 'team' | 'close';

const TABS: { id: Tab; label: string; sub: string }[] = [
  { id: 'rota', label: 'Rota', sub: 'Plan the week' },
  { id: 'demand', label: 'Demand', sub: 'Need against cover' },
  { id: 'team', label: 'Team', sub: 'People and cost' },
  { id: 'close', label: 'Close', sub: 'Accrual to the ledger' },
];

type RotaView = 'timeline' | 'people';
const VIEW_KEY = 'preshift.rota.view';

function savedView(): RotaView {
  try {
    return localStorage.getItem(VIEW_KEY) === 'people' ? 'people' : 'timeline';
  } catch {
    return 'timeline';
  }
}

const MONTH = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

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
  const [rotaView, setRotaView] = useState<RotaView>(savedView);

  function chooseView(v: RotaView) {
    setRotaView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // Not remembered in private mode; the choice still applies now.
    }
  }

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

  const range = `${new Date(`${week}T00:00:00Z`).getUTCDate()} to ${new Date(`${dates[6]}T00:00:00Z`).getUTCDate()} ${MONTH(dates[6])}`;

  return (
    <>
      <header className="mast">
        <div className="mast-top">
          <div className="wordmark">
            Preshift<span className="wordmark-with">with Williams, Stanley &amp; Co.</span>
          </div>
          <div className="mast-controls">
            <div className="sites" role="tablist" aria-label="Site">
              {state.sites.map((s) => (
                <button key={s.id} role="tab" aria-selected={s.id === siteId} className={s.id === siteId ? 'active' : ''} onClick={() => setSiteId(s.id)}>
                  {s.name}
                </button>
              ))}
            </div>
            <div className="weeknav">
              <button onClick={() => setWeek(addDays(week, -7))} aria-label="Previous week">&larr;</button>
              <span className="tnum">{range}</span>
              <button onClick={() => setWeek(addDays(week, 7))} aria-label="Next week">&rarr;</button>
            </div>
          </div>
        </div>
        <div className="mast-title">
          <h1>{site.name}</h1>
          <div className="mast-meta">
            <span className="eyebrow">Week {isoWeek(week)} · {dayLabel(week).date} to {dayLabel(dates[6]).date}</span>
            <span className={`stamp ${status}`}>{statusLabel}</span>
          </div>
        </div>
        <nav className="sections">
          {TABS.map((t, i) => (
            <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
              <span className="num">0{i + 1}</span>
              <span className="label">
                {t.label}
                {t.id === 'demand' && unfilled && unfilled.length > 0 && <span className="count">{unfilled.length}</span>}
              </span>
              <span className="sub">{t.sub}</span>
            </button>
          ))}
          <div className="section-actions">
            <button className="ghost" onClick={() => { dispatch({ type: 'clearWeek', siteId, weekStart: week }); setUnfilled(null); }}>
              Clear week
            </button>
            <button onClick={runAutoBuild} className="primary">Build from forecast</button>
          </div>
        </nav>
      </header>

      <div className="shell">
        <div className="main">
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
          {tab === 'rota' && (
            <div className="view-bar">
              <div className="toggle" role="tablist" aria-label="Rota view">
                <button role="tab" aria-selected={rotaView === 'timeline'} className={rotaView === 'timeline' ? 'active' : ''} onClick={() => chooseView('timeline')}>
                  Service timeline
                </button>
                <button role="tab" aria-selected={rotaView === 'people'} className={rotaView === 'people' ? 'active' : ''} onClick={() => chooseView('people')}>
                  By person
                </button>
              </div>
              <span className="muted small">
                {rotaView === 'timeline'
                  ? 'Each day over its sales curve. The strip under each day shows hours short or over. Drag a bar to move it, its ends to change the hours.'
                  : 'Every person across the week. Drag a shift to another person or day.'}
              </span>
            </div>
          )}
          {tab === 'rota' && rotaView === 'timeline' && (
            <Timeline
              state={view}
              base={state}
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
          {tab === 'rota' && rotaView === 'people' && (
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
        </div>
        <PnlRail
          state={view}
          metrics={metrics}
          issues={issues}
          canPublish={blocks === 0 && weekShifts.length > 0 && !published}
          published={published}
          blocks={blocks}
          onPublish={() => dispatch({ type: 'publishWeek', siteId, weekStart: week })}
        />


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
