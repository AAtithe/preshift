import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { UnfilledGap } from '../engine/autoschedule';
import { checkWeek } from '../engine/compliance';
import { weekMetrics } from '../engine/metrics';
import { addDays, toISODate, weekDates, weekStart } from '../engine/time';
import { newEmployee } from '../engine/employees';
import type { Employee, Shift } from '../engine/types';
import { CloseView } from './CloseView';
import { DemandView } from './DemandView';
import { EmployeeEditor } from './EmployeeEditor';
import { dayLabel } from './format';
import { KpiBar } from './KpiBar';
import { PayrollView } from './PayrollView';
import { PeopleView } from './PeopleView';
import { RotaGrid } from './RotaGrid';
import { SettingsView, type Me } from './SettingsView';
import { ShiftEditor } from './ShiftEditor';
import { useRotaStore } from './store';
import { TeamView } from './TeamView';

// Loaded on first use so the Claude SDK stays out of the main bundle.
const AssistantPanel = lazy(() => import('./AssistantPanel').then((m) => ({ default: m.AssistantPanel })));

type Tab = 'rota' | 'demand' | 'team' | 'people' | 'payroll' | 'close' | 'settings';

const TABS: { id: Tab; label: string }[] = [
  { id: 'rota', label: 'Rota' },
  { id: 'demand', label: 'Demand' },
  { id: 'team', label: 'Team' },
  { id: 'people', label: 'People' },
  { id: 'payroll', label: 'Payroll' },
  { id: 'close', label: 'Close' },
  { id: 'settings', label: 'Settings' },
];

export function App() {
  const { state, error, setError, actions } = useRotaStore();
  if (!state) {
    return (
      <div className="app">
        <p className="muted">{error ? `Cannot reach the Preshift API: ${error}` : 'Loading'}</p>
        {error && <button onClick={() => void actions.reload()}>Try again</button>}
      </div>
    );
  }
  return <Workspace state={state} error={error} clearError={() => setError(null)} actions={actions} />;
}

type Store = ReturnType<typeof useRotaStore>;

function Workspace({ state, error, clearError, actions }: { state: NonNullable<Store['state']>; error: string | null; clearError: () => void; actions: Store['actions'] }) {
  const [siteId, setSiteId] = useState(state.sites[0]?.id ?? '');
  const [week, setWeek] = useState(weekStart(toISODate(new Date())));
  const [tab, setTab] = useState<Tab>('rota');
  const [editing, setEditing] = useState<Shift | null>(null);
  const [unfilled, setUnfilled] = useState<UnfilledGap[] | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [editingPerson, setEditingPerson] = useState<Employee | null>(null);
  const today = toISODate(new Date());
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    fetch('/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((body: Me | null) => setMe(body))
      .catch(() => setMe(null));
  }, []);

  const site = state.sites.find((s) => s.id === siteId)!;
  const metrics = useMemo(() => weekMetrics(state, siteId, week), [state, siteId, week]);
  const issues = useMemo(() => checkWeek(state, week, siteId), [state, siteId, week]);
  const dates = weekDates(week);
  const blocks = issues.filter((i) => i.severity === 'block').length;
  const weekShifts = state.shifts.filter((s) => s.siteId === siteId && dates.includes(s.date));
  const published = weekShifts.length > 0 && weekShifts.every((s) => s.published);

  async function runAutoBuild() {
    const gaps = await actions.build(siteId, week);
    if (gaps) setUnfilled(gaps);
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
          <button onClick={() => setAssistantOpen(true)} className="primary">Ask the assistant</button>
          <button onClick={runAutoBuild}>Build from forecast</button>
          <button onClick={() => { void actions.clear(siteId, week); setUnfilled(null); }}>Clear week</button>
          <button
            disabled={blocks > 0 || weekShifts.length === 0 || published}
            title={blocks > 0 ? 'Resolve blocking issues before publishing' : undefined}
            onClick={() => void actions.publish(siteId, week)}
          >
            {published ? 'Published' : 'Publish'}
          </button>
        </div>
      </nav>

      {error && (
        <div className="notice error">
          {error} <button className="link" onClick={clearError}>Dismiss</button>
        </div>
      )}

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
        {tab === 'team' && <TeamView state={state} siteId={siteId} metrics={metrics} issues={issues} dates={dates} />}
        {tab === 'people' && (
          <PeopleView
            state={state}
            siteId={siteId}
            today={today}
            onEdit={setEditingPerson}
            onAdd={() => setEditingPerson(newEmployee(siteId, state.roles[0].id, today))}
          />
        )}
        {tab === 'payroll' && <PayrollView state={state} siteId={siteId} week={week} onChanged={actions.refreshShifts} />}
        {tab === 'close' && <CloseView week={week} />}
        {tab === 'settings' && me && <SettingsView me={me} />}
      </main>

      <footer className="foot">
        <span>UK rates 2026/27. Running on the Preshift API.</span>
        <span>
          <a className="link" href="/docs" target="_blank" rel="noreferrer">API docs</a>
          {me && (
            <>
              {' '}Signed in as {me.email}{' '}
              <a className="link" href="/auth/logout">Sign out</a>
            </>
          )}
        </span>
      </footer>

      {assistantOpen && (
        <Suspense fallback={null}>
          <AssistantPanel
            state={state}
            siteId={siteId}
            week={week}
            onApply={(shifts) => { void actions.applyDraft(state.shifts, shifts); setUnfilled(null); setAssistantOpen(false); }}
            onClose={() => setAssistantOpen(false)}
          />
        </Suspense>
      )}

      {editingPerson && (
        <EmployeeEditor
          state={state}
          employee={editingPerson}
          today={today}
          onSave={async (employee) => {
            const isNew = !state.employees.some((e) => e.id === employee.id);
            if (await actions.saveEmployee(employee, isNew)) setEditingPerson(null);
          }}
          onLeaver={async (id, leaveDate) => { if (await actions.markLeaver(id, leaveDate)) setEditingPerson(null); }}
          onClose={() => setEditingPerson(null)}
        />
      )}

      {editing && (
        <ShiftEditor
          state={state}
          shift={editing}
          onSave={async (shift) => {
            const isNew = !state.shifts.some((s) => s.id === shift.id);
            if (await actions.saveShift(shift, isNew)) setEditing(null);
          }}
          onDelete={async (id) => { await actions.deleteShift(id); setEditing(null); }}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
