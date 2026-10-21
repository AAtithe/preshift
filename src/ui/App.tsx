import { useMemo, useState } from 'react';
import { autoSchedule, type UnfilledGap } from '../engine/autoschedule';
import { checkWeek } from '../engine/compliance';
import { weekMetrics } from '../engine/metrics';
import { addDays, toISODate, weekDates, weekStart } from '../engine/time';
import type { RotaState, Shift } from '../engine/types';
import { CloseView } from './CloseView';
import { DemandView } from './DemandView';
import { dayLabel } from './format';
import { KpiBar } from './KpiBar';
import { RotaGrid } from './RotaGrid';
import type { User } from './session';
import { ShiftEditor } from './ShiftEditor';
import { useRotaStore } from './store';
import { TeamView } from './TeamView';

type Tab = 'rota' | 'demand' | 'team' | 'close';

const TABS: { id: Tab; label: string }[] = [
  { id: 'rota', label: 'Rota' },
  { id: 'demand', label: 'Demand' },
  { id: 'team', label: 'Team' },
  { id: 'close', label: 'Close' },
];

export type SaveStatus =
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'failed'; message: string; conflict: boolean };

interface Props {
  mode: 'demo' | 'live';
  initial: RotaState;
  persist: (state: RotaState) => void;
  user?: User;
  saveStatus?: SaveStatus;
  onSignOut?: () => void;
}

export function App({ mode, initial, persist, user, saveStatus, onSignOut }: Props) {
  const [state, dispatch] = useRotaStore(initial, persist);
  const [siteId, setSiteId] = useState(state.sites[0].id);
  const [week, setWeek] = useState(weekStart(toISODate(new Date())));
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
          {mode === 'demo' && <span className="mode-tag">Demo</span>}
          {user && (
            <div className="account">
              <span title={user.email}>{user.name} &middot; {user.accountName}</span>
              <button className="link" onClick={onSignOut}>Sign out</button>
            </div>
          )}
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
        {tab === 'close' && <CloseView state={state} week={week} />}
      </main>

      {saveStatus?.kind === 'failed' && (
        <div className="notice notice-bad" role="alert">
          <strong>Not saved.</strong> {saveStatus.message}{' '}
          {saveStatus.conflict && <button className="link" onClick={() => window.location.reload()}>Reload</button>}
        </div>
      )}

      <footer className="foot">
        {mode === 'demo' ? (
          <>
            <span>UK rates 2026/27. Demo data is held in this browser only. <a href="/app/">Sign in</a> for the live rota.</span>
            <button className="link" onClick={() => { if (confirm('Reset to demo data?')) dispatch({ type: 'reset' }); }}>
              Reset demo
            </button>
          </>
        ) : (
          <span>UK rates 2026/27. {saveStatus?.kind === 'saving' ? 'Saving' : saveStatus?.kind === 'failed' ? 'Not saved' : 'All changes saved'}.</span>
        )}
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
