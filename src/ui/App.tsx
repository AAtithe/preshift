import { useEffect, useMemo, useState } from 'react';
import { autoSchedule, type UnfilledGap } from '../engine/autoschedule';
import { checkWeek } from '../engine/compliance';
import { weekMetrics } from '../engine/metrics';
import { addDays, toISODate, weekDates, weekStart } from '../engine/time';
import { DEMO_MINUTE } from '../engine/simulate';
import type { RotaState, Shift } from '../engine/types';
import type { Command } from '../shared/commands';
import { AccessView } from './AccessView';
import { ActualsView } from './ActualsView';
import { api, boot, type Boot, type Me } from './api';
import { BenchmarkView } from './BenchmarkView';
import { CloseView } from './CloseView';
import { DemandView } from './DemandView';
import { dayLabel } from './format';
import { KpiBar } from './KpiBar';
import { LiveView } from './LiveView';
import { PrimeView } from './PrimeView';
import { RetentionView } from './RetentionView';
import { RiskView } from './RiskView';
import { RotaGrid } from './RotaGrid';
import { ShiftEditor } from './ShiftEditor';
import { SignIn } from './SignIn';
import { useRotaStore } from './store';
import { TeamView } from './TeamView';
import { TroncView } from './TroncView';

type Tab = 'rota' | 'demand' | 'team' | 'today' | 'actuals' | 'prime' | 'tronc' | 'risk' | 'retention' | 'benchmark' | 'close' | 'access';

const TABS: { id: Tab; label: string }[] = [
  { id: 'rota', label: 'Rota' },
  { id: 'demand', label: 'Demand' },
  { id: 'team', label: 'Team' },
  { id: 'today', label: 'Today' },
  { id: 'actuals', label: 'Actuals' },
  { id: 'prime', label: 'Prime cost' },
  { id: 'tronc', label: 'Tronc' },
  { id: 'risk', label: 'Risk' },
  { id: 'retention', label: 'Retention' },
  { id: 'benchmark', label: 'Benchmark' },
  { id: 'close', label: 'Close' },
  { id: 'access', label: 'Access' },
];

/** Tabs for people who do not see the whole business: their rota and the clock, and the tronc for a troncmaster. */
function tabsFor(me: Me | null): Tab[] {
  if (!me) return TABS.filter((t) => t.id !== 'access').map((t) => t.id);
  const has = (p: string) => me.permissions.includes(p);
  if (has('view.all')) return TABS.filter((t) => t.id !== 'access' || has('org.invite')).map((t) => t.id);
  return ['rota', 'today', ...(has('tronc.edit') ? (['tronc'] as Tab[]) : [])];
}

/** Starts the app: the offline demo when there is no server, sign in when there is, then the workspace. */
export function Root() {
  const [mode, setMode] = useState<Boot | null>(null);
  const restart = () => {
    setMode(null);
    boot().then(setMode);
  };
  useEffect(restart, []);
  if (!mode) return <div className="signin muted">Loading</div>;
  if (mode.mode === 'signin') return <SignIn onDone={restart} />;
  return <Workspace key={mode.mode === 'server' ? mode.me.organisation.id : 'demo'} me={mode.mode === 'server' ? mode.me : null} onRestart={restart} />;
}

function Workspace({ me, onRestart }: { me: Me | null; onRestart: () => void }) {
  const store = useRotaStore(me ? 'server' : 'demo');
  if (!store.state) {
    return <div className="signin muted">{store.error ?? 'Loading'}</div>;
  }
  if (store.state.sites.length === 0) {
    return <Empty me={me} run={store.run} error={store.error} onRestart={onRestart} />;
  }
  return <App state={store.state} run={store.run} error={store.error} clearError={store.clearError} me={me} onRestart={onRestart} />;
}

/** A new organisation with nothing in it yet. */
function Empty({ me, run, error, onRestart }: { me: Me | null; run: (c: Command) => Promise<boolean>; error: string | null; onRestart: () => void }) {
  return (
    <div className="signin">
      <div className="panel signin-card">
        <h2>{me?.organisation.name}</h2>
        <p className="muted">No sites set up yet. Williams, Stanley &amp; Co. onboarding loads your sites, team and forecast.</p>
        {me?.permissions.includes('org.seedDemo') && <button className="primary" onClick={() => run({ type: 'seedDemo' })}>Load the demo to explore</button>}
        {error && <div className="notice bad small">{error}</div>}
        <button className="link" onClick={() => api.logout().then(onRestart)}>Sign out</button>
      </div>
    </div>
  );
}

interface AppProps {
  state: RotaState;
  run: (cmd: Command) => Promise<boolean>;
  error: string | null;
  clearError: () => void;
  me: Me | null;
  onRestart: () => void;
}

export function App({ state, run, error, clearError, me, onRestart }: AppProps) {
  const can = (p: string) => !me || me.permissions.includes(p);
  const tabs = tabsFor(me);
  const [siteId, setSiteId] = useState(state.sites[0].id);
  const today = toISODate(new Date());
  const [week, setWeek] = useState(weekStart(today));
  const [tab, setTab] = useState<Tab>(tabs[0]);
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
    run({ type: 'replaceWeek', siteId, weekStart: week, shifts: result.shifts.filter((s) => s.siteId === siteId && dates.includes(s.date)) });
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
          {me && (
            <div className="whoami">
              {me.organisations.length > 1 ? (
                <select
                  value={me.organisation.id}
                  aria-label="Organisation"
                  onChange={(e) => api.switchOrganisation(e.target.value).then(onRestart)}
                >
                  {me.organisations.map((o) => (
                    <option key={o.organisationId} value={o.organisationId}>{o.name}</option>
                  ))}
                </select>
              ) : (
                <span>{me.organisation.name}</span>
              )}
              <span>
                {me.user.name}, {me.membership.role}
              </span>
              <button className="link" onClick={() => api.logout().then(onRestart)}>Sign out</button>
            </div>
          )}
        </div>
      </header>

      {error && (
        <div className="error-bar" role="alert">
          <span>{error}</span>
          <button className="link" onClick={clearError}>Dismiss</button>
        </div>
      )}

      {can('view.all') && <KpiBar metrics={metrics} issues={issues} />}

      <nav className="tabs">
        {TABS.filter((t) => tabs.includes(t.id)).map((t) => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
        {can('rota.edit') && (
          <div className="tab-actions">
            <button onClick={runAutoBuild} className="primary">Build from forecast</button>
            <button onClick={() => { run({ type: 'clearWeek', siteId, weekStart: week }); setUnfilled(null); }}>Clear week</button>
            <button
              disabled={blocks > 0 || weekShifts.length === 0 || published}
              title={blocks > 0 ? 'Resolve blocking issues before publishing' : undefined}
              onClick={() => run({ type: 'publishWeek', siteId, weekStart: week })}
            >
              {published ? 'Published' : 'Publish'}
            </button>
          </div>
        )}
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
            onEdit={can('rota.edit') ? setEditing : () => undefined}
          />
        )}
        {tab === 'demand' && <DemandView state={state} siteId={siteId} dates={dates} />}
        {tab === 'team' && <TeamView state={state} siteId={siteId} metrics={metrics} issues={issues} />}
        {tab === 'today' && <LiveView state={state} siteId={siteId} today={today} initialMinute={DEMO_MINUTE} run={run} canManage={can('cut.apply')} />}
        {tab === 'actuals' && <ActualsView state={state} siteId={siteId} week={week} asOf={today} run={run} />}
        {tab === 'prime' && <PrimeView state={state} siteId={siteId} week={week} asOf={today} />}
        {tab === 'tronc' && <TroncView state={state} siteId={siteId} week={week} asOf={today} run={run} canAllocate={!me || can('tronc.edit')} canSetPolicy={can('tronc.policy')} />}
        {tab === 'risk' && <RiskView state={state} siteId={siteId} week={week} asOf={today} />}
        {tab === 'retention' && <RetentionView state={state} siteId={siteId} asOf={today} />}
        {tab === 'benchmark' && <BenchmarkView state={state} siteId={siteId} week={week} asOf={today} />}
        {tab === 'close' && <CloseView state={state} week={week} asOf={today} />}
        {tab === 'access' && <AccessView state={state} />}
      </main>

      <footer className="foot">
        <span>UK rates 2026/27. {me ? `Held for ${me.organisation.name} on the Preshift server; every change is recorded.` : 'Demo data is held in this browser only.'}</span>
        {can('org.seedDemo') && (
          <button className="link" onClick={() => { if (confirm(me ? 'Replace this organisation’s data with the demo?' : 'Reset to demo data?')) run({ type: 'seedDemo' }); }}>
            {me ? 'Load demo data' : 'Reset demo'}
          </button>
        )}
      </footer>

      {editing && (
        <ShiftEditor
          state={state}
          shift={editing}
          onSave={(shift) => { run({ type: 'upsertShift', shift }); setEditing(null); }}
          onDelete={(id) => { run({ type: 'deleteShift', id }); setEditing(null); }}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
