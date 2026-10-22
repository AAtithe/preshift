import { useMemo, useState } from 'react';
import { autoSchedule, type UnfilledGap } from '../engine/autoschedule';
import { checkWeek } from '../engine/compliance';
import { weekMetrics } from '../engine/metrics';
import { addDays, toISODate, weekDates, weekStart } from '../engine/time';
import { DEMO_MINUTE } from '../engine/simulate';
import type { Shift } from '../engine/types';
import { ActualsView } from './ActualsView';
import { BenchmarkView } from './BenchmarkView';
import { CloseView } from './CloseView';
import { DemandView } from './DemandView';
import { dayLabel } from './format';
import { KpiBar } from './KpiBar';
import { LiveView } from './LiveView';
import { RetentionView } from './RetentionView';
import { RiskView } from './RiskView';
import { RotaGrid } from './RotaGrid';
import { ShiftEditor } from './ShiftEditor';
import { useRotaStore } from './store';
import { TeamView } from './TeamView';
import { TroncView } from './TroncView';

type Tab = 'rota' | 'demand' | 'team' | 'today' | 'actuals' | 'tronc' | 'risk' | 'retention' | 'benchmark' | 'close';

const TABS: { id: Tab; label: string }[] = [
  { id: 'rota', label: 'Rota' },
  { id: 'demand', label: 'Demand' },
  { id: 'team', label: 'Team' },
  { id: 'today', label: 'Today' },
  { id: 'actuals', label: 'Actuals' },
  { id: 'tronc', label: 'Tronc' },
  { id: 'risk', label: 'Risk' },
  { id: 'retention', label: 'Retention' },
  { id: 'benchmark', label: 'Benchmark' },
  { id: 'close', label: 'Close' },
];

export function App() {
  const [state, dispatch] = useRotaStore();
  const [siteId, setSiteId] = useState(state.sites[0].id);
  const today = toISODate(new Date());
  const [week, setWeek] = useState(weekStart(today));
  const [tab, setTab] = useState<Tab>('rota');
  const [editing, setEditing] = useState<Shift | null>(null);
  const [unfilled, setUnfilled] = useState<UnfilledGap[] | null>(null);

  const site = state.sites.find((s) => s.id === siteId)!;
  const metrics = useMemo(() => weekMetrics(state, siteId, week), [state, siteId, week]);
  const issues = useMemo(() => checkWeek(state, week, siteId), [state, siteId, week]);
  const dates = weekDates(week);
  const blocks = issues.filter((i) => i.severity === 'block').length;
  const weekShifts = state.shifts.filter((s) => s.siteId === siteId && dates.includes(s.date));
  const published = weekShifts.length > 0 && weekShifts.every((s) => s.published);

  function runAutoBuild() {
    const result = autoSchedule(state, siteId, week);
    dispatch({ type: 'setShifts', shifts: result.shifts });
    setUnfilled(result.unfilled);
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>P</span>
          <div>
            <div className="brand-name">Preshift</div>
            <div className="brand-sub">Rota by Preshift and Williams, Stanley &amp; Co.</div>
          </div>
        </div>
        <div className="controls">
          <select value={siteId} onChange={(e) => setSiteId(e.target.value)} aria-label="Site">
            {state.sites.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <div className="week-nav">
            <button onClick={() => setWeek(addDays(week, -7))} aria-label="Previous week">&lsaquo;</button>
            <span>w/c {dayLabel(week).date}</span>
            <button onClick={() => setWeek(addDays(week, 7))} aria-label="Next week">&rsaquo;</button>
          </div>
        </div>
      </header>

      <KpiBar metrics={metrics} issues={issues} />

      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
        <div className="tab-actions">
          <button onClick={runAutoBuild} className="primary">Build from forecast</button>
          <button onClick={() => { dispatch({ type: 'clearWeek', siteId, weekStart: week }); setUnfilled(null); }}>Clear week</button>
          <button
            disabled={blocks > 0 || weekShifts.length === 0 || published}
            title={blocks > 0 ? 'Resolve blocking issues before publishing' : undefined}
            onClick={() => dispatch({ type: 'publishWeek', siteId, weekStart: week })}
          >
            {published ? 'Published' : 'Publish'}
          </button>
        </div>
      </nav>

      {unfilled && unfilled.length > 0 && (
        <div className="notice">
          <strong>{unfilled.length} gaps could not be filled legally with the current team.</strong>{' '}
          That is a hiring or cross-training signal, not a rota problem.
          <ul>
            {unfilled.slice(0, 6).map((g, i) => (
              <li key={i}>
                {dayLabel(g.date).short} {state.roles.find((r) => r.id === g.roleId)?.name}{' '}
                {String(g.fromHour).padStart(2, '0')}:00 to {String(g.toHour % 24).padStart(2, '0')}:00
              </li>
            ))}
            {unfilled.length > 6 && <li>and {unfilled.length - 6} more</li>}
          </ul>
          <button className="link" onClick={() => setUnfilled(null)}>Dismiss</button>
        </div>
      )}

      <main>
        {tab === 'rota' && (
          <RotaGrid
            state={state}
            site={site}
            dates={dates}
            metrics={metrics}
            issues={issues}
            onEdit={setEditing}
          />
        )}
        {tab === 'demand' && <DemandView state={state} siteId={siteId} dates={dates} />}
        {tab === 'team' && <TeamView state={state} siteId={siteId} metrics={metrics} issues={issues} />}
        {tab === 'today' && <LiveView state={state} siteId={siteId} today={today} initialMinute={DEMO_MINUTE} dispatch={dispatch} />}
        {tab === 'actuals' && <ActualsView state={state} siteId={siteId} week={week} asOf={today} dispatch={dispatch} />}
        {tab === 'tronc' && <TroncView state={state} siteId={siteId} week={week} asOf={today} dispatch={dispatch} />}
        {tab === 'risk' && <RiskView state={state} siteId={siteId} week={week} asOf={today} />}
        {tab === 'retention' && <RetentionView state={state} siteId={siteId} asOf={today} />}
        {tab === 'benchmark' && <BenchmarkView state={state} siteId={siteId} week={week} asOf={today} />}
        {tab === 'close' && <CloseView state={state} week={week} asOf={today} />}
      </main>

      <footer className="foot">
        <span>UK rates 2026/27. Demo data is held in this browser only.</span>
        <button className="link" onClick={() => { if (confirm('Reset to demo data?')) dispatch({ type: 'reset' }); }}>
          Reset demo
        </button>
      </footer>

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
  );
}
