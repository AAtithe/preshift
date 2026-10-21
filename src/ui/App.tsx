import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { UnfilledGap } from '../engine/autoschedule';
import { checkWeek } from '../engine/compliance';
import { weekMetrics } from '../engine/metrics';
import { addDays, toISODate, weekDates, weekStart } from '../engine/time';
import { newEmployee } from '../engine/employees';
import type { Employee, Shift } from '../engine/types';
import { CloseView } from './CloseView';
import { DemandView } from './DemandView';
import { AccessView } from './access/AccessView';
import type { Me } from './access/model';
import { api, signInAsDemo } from './api';
import { EmployeeEditor } from './EmployeeEditor';
import { dayLabel } from './format';
import { KpiBar } from './KpiBar';
import { PayrollView } from './PayrollView';
import { PeopleView } from './PeopleView';
import { RotaGrid } from './RotaGrid';
import { ShiftEditor } from './ShiftEditor';
import { allowFor, NOT_YOURS, type Allow } from './permissions';
import { useRotaStore } from './store';
import { TeamView } from './TeamView';

// Loaded on first use so the Claude SDK stays out of the main bundle.
const AssistantPanel = lazy(() => import('./AssistantPanel').then((m) => ({ default: m.AssistantPanel })));

type Tab = 'rota' | 'demand' | 'team' | 'people' | 'payroll' | 'close' | 'access';

// A tab is offered only where the person can use it at this site; the screen still asks the server.
const TABS: { id: Tab; label: string; offered: (allow: Allow, siteId: string) => boolean }[] = [
  { id: 'rota', label: 'Rota', offered: () => true },
  { id: 'demand', label: 'Demand', offered: () => true },
  { id: 'team', label: 'Team', offered: () => true },
  { id: 'people', label: 'People', offered: (a, s) => a('team.manage', s) || a('costs.view', s) },
  { id: 'payroll', label: 'Payroll', offered: (a, s) => a('time.record', s) || a('time.approve', s) || a('payroll.view') },
  { id: 'close', label: 'Close', offered: (a) => a('close.export') },
  { id: 'access', label: 'Access', offered: (a, s) => a('users.manage') || a('users.sites', s) || a('audit.view') },
];

export function App() {
  const { state, me, error, setError, actions } = useRotaStore();
  if (!state) {
    return (
      <div className="app">
        <p className="muted">{error ? `Cannot reach the Preshift API: ${error}` : 'Loading'}</p>
        {error && <button onClick={() => void actions.reload()}>Try again</button>}
      </div>
    );
  }
  if (state.sites.length === 0) {
    return (
      <div className="app">
        <p className="muted">Your roles do not reach any site yet. Ask whoever manages access to grant you one.</p>
        <DemoSwitch me={me} />
      </div>
    );
  }
  return <Workspace state={state} me={me} error={error} clearError={() => setError(null)} actions={actions} />;
}

type Store = ReturnType<typeof useRotaStore>;

function Workspace({ state, me, error, clearError, actions }: { state: NonNullable<Store['state']>; me: Me | null; error: string | null; clearError: () => void; actions: Store['actions'] }) {
  const [siteId, setSiteId] = useState(state.sites[0]?.id ?? '');
  const [week, setWeek] = useState(weekStart(toISODate(new Date())));
  const [tab, setTab] = useState<Tab>('rota');
  const [editing, setEditing] = useState<Shift | null>(null);
  const [unfilled, setUnfilled] = useState<UnfilledGap[] | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [editingPerson, setEditingPerson] = useState<Employee | null>(null);
  const today = toISODate(new Date());
  const [user, setUser] = useState<string | null>(null);

  useEffect(() => {
    // No session endpoint (sign-in off locally) simply leaves the footer without a user.
    fetch('/api/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { email?: string } | null) => setUser(body?.email ?? null))
      .catch(() => setUser(null));
  }, []);

  const site = state.sites.find((s) => s.id === siteId)!;
  const allow = useMemo(() => allowFor(me), [me]);
  const showCost = allow('costs.view', siteId);
  const canEdit = allow('rota.edit', siteId);
  const canTeam = allow('team.manage', siteId);
  const tabs = TABS.filter((t) => t.offered(allow, siteId));
  const current = tabs.some((t) => t.id === tab) ? tab : 'rota';
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
          <DemoSwitch me={me} />
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

      <KpiBar metrics={metrics} issues={issues} showCost={showCost} />

      <nav className="tabs">
        {tabs.map((t) => (
          <button key={t.id} className={current === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
        <div className="tab-actions">
          <button onClick={() => setAssistantOpen(true)} className="primary" disabled={!canEdit} title={canEdit ? undefined : NOT_YOURS}>Ask the assistant</button>
          <button onClick={runAutoBuild} disabled={!canEdit} title={canEdit ? undefined : NOT_YOURS}>Build from forecast</button>
          <button disabled={!canEdit} title={canEdit ? undefined : NOT_YOURS} onClick={() => { void actions.clear(siteId, week); setUnfilled(null); }}>Clear week</button>
          <button
            disabled={blocks > 0 || weekShifts.length === 0 || published || !allow('rota.publish', siteId)}
            title={!allow('rota.publish', siteId) ? NOT_YOURS : blocks > 0 ? 'Resolve blocking issues before publishing' : undefined}
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
        {current === 'rota' && (
          <RotaGrid
            state={state}
            site={site}
            dates={dates}
            metrics={metrics}
            issues={issues}
            showCost={showCost}
            onEdit={canEdit ? setEditing : undefined}
          />
        )}
        {current === 'demand' && <DemandView state={state} siteId={siteId} dates={dates} />}
        {current === 'team' && <TeamView state={state} siteId={siteId} metrics={metrics} issues={issues} dates={dates} showCost={showCost} />}
        {current === 'people' && (
          <PeopleView
            state={state}
            siteId={siteId}
            today={today}
            onEdit={setEditingPerson}
            onAdd={canTeam ? () => setEditingPerson(newEmployee(siteId, state.roles[0].id, today)) : undefined}
          />
        )}
        {current === 'payroll' && <PayrollView state={state} siteId={siteId} week={week} allow={allow} onChanged={actions.refreshShifts} />}
        {current === 'close' && <CloseView week={week} />}
        {current === 'access' && <AccessView state={state} />}
      </main>

      <footer className="foot">
        <span>UK rates 2026/27. Running on the Preshift API.</span>
        <span>
          <a className="link" href="/docs" target="_blank" rel="noreferrer">API docs</a>
          {user && (
            <>
              {' '}Signed in as {user}{' '}
              <a className="link" href="/api/auth/logout">Sign out</a>
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
          canEditPay={allow('pay.edit', editingPerson.siteId) && me?.user?.employeeId !== editingPerson.id}
          today={today}
          onSave={async (employee) => {
            const isNew = !state.employees.some((e) => e.id === employee.id);
            const withPay = allow('pay.edit', employee.siteId) && me?.user?.employeeId !== employee.id;
            if (await actions.saveEmployee(employee, isNew, withPay)) setEditingPerson(null);
          }}
          onLeaver={async (id, leaveDate) => { if (await actions.markLeaver(id, leaveDate)) setEditingPerson(null); }}
          onClose={() => setEditingPerson(null)}
        />
      )}

      {editing && (
        <ShiftEditor
          state={state}
          shift={editing}
          showCost={showCost}
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

interface DemoPerson { id: string; name: string; jobTitle?: string; status: string }

/** Demo only: sign in as any seeded person to see what their roles allow. Absent outside the demo. */
function DemoSwitch({ me }: { me: Me | null }) {
  const [people, setPeople] = useState<DemoPerson[] | null>(null);
  useEffect(() => {
    void api.get<DemoPerson[]>('/v1/dev/people').then(setPeople).catch(() => setPeople(null));
  }, []);
  if (!people || !me?.user) return null;
  return (
    <label className="demo-switch">
      <span className="muted small">Demo: signed in as</span>
      <select value={me.user.id} onChange={(e) => signInAsDemo(e.target.value === 'usr_owner' ? null : e.target.value)}>
        {people.filter((p) => p.status === 'active').map((p) => (
          <option key={p.id} value={p.id}>{p.name}{p.jobTitle ? `, ${p.jobTitle}` : ''}</option>
        ))}
      </select>
    </label>
  );
}
