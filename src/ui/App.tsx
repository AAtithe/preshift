import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { UnfilledGap } from '../engine/autoschedule';
import { checkWeek } from '../engine/compliance';
import { scopeMetrics } from '../engine/metrics';
import { addDays, toISODate, weekDates, weekStart } from '../engine/time';
import { newEmployee } from '../engine/employees';
import type { Employee, Shift } from '../engine/types';
import { CloseView } from './CloseView';
import { DemandView } from './DemandView';
import { AccessView } from './access/AccessView';
import type { Me } from './access/model';
import { api, signInAsDemo } from './api';
import { GroupView } from './GroupView';
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

type Tab = 'sites' | 'rota' | 'demand' | 'team' | 'people' | 'payroll' | 'close' | 'access';

/** Holds the permission at every site in scope: what an action over the scope needs. */
type AtAll = Allow;
type Offered = (atAll: AtAll, allow: Allow) => boolean;

// A tab is offered only where the person can use it across the scope; the screen still asks the server.
const ACCESS: Offered = (all, a) => a('users.manage') || all('users.sites') || a('audit.view');
// One site gets the rota and demand detail; several get the side-by-side view.
const SITE_TABS: { id: Tab; label: string; offered: Offered }[] = [
  { id: 'rota', label: 'Rota', offered: () => true },
  { id: 'demand', label: 'Demand', offered: () => true },
  { id: 'team', label: 'Team', offered: () => true },
  { id: 'people', label: 'People', offered: (all) => all('team.manage') || all('costs.view') },
  { id: 'payroll', label: 'Payroll', offered: (all, a) => all('time.record') || all('time.approve') || a('payroll.view') },
  { id: 'close', label: 'Close', offered: (_all, a) => a('close.export') },
  { id: 'access', label: 'Access', offered: ACCESS },
];
const GROUP_TABS: { id: Tab; label: string; offered: Offered }[] = [
  // Side by side labour cost by site: for those who see cost everywhere in scope.
  { id: 'sites', label: 'Sites', offered: (all) => all('costs.view') },
  { id: 'team', label: 'Team', offered: () => true },
  { id: 'close', label: 'Close', offered: (_all, a) => a('close.export') },
  { id: 'access', label: 'Access', offered: ACCESS },
];
const ALL = '';

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
  // Scope: an entity (or the whole group), then one site or all of that entity's sites.
  const [entityId, setEntityId] = useState(ALL);
  const [siteId, setSiteId] = useState(ALL);
  const [week, setWeek] = useState(weekStart(toISODate(new Date())));
  const [tab, setTab] = useState<Tab>('sites');
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

  const scopeSites = state.sites.filter((s) => !entityId || s.entityId === entityId);
  const site = state.sites.find((s) => s.id === siteId);
  const siteIds = useMemo(
    () => (siteId ? [siteId] : state.sites.filter((s) => !entityId || s.entityId === entityId).map((s) => s.id)),
    [state.sites, entityId, siteId],
  );
  const entityIds = entityId ? [entityId] : site ? [site.entityId] : state.entities.map((e) => e.id);
  const single = siteIds.length === 1 ? state.sites.find((s) => s.id === siteIds[0])! : null;
  const allow = useMemo(() => allowFor(me), [me]);
  const atAll: AtAll = (p) => siteIds.every((s) => allow(p, s));
  const showCost = atAll('costs.view');
  const canEdit = atAll('rota.edit');
  const canPublish = atAll('rota.publish');
  const tabs = (single ? SITE_TABS : GROUP_TABS).filter((t) => t.offered(atAll, allow));
  const activeTab = tabs.some((t) => t.id === tab) ? tab : tabs[0].id;

  const metrics = useMemo(() => scopeMetrics(state, siteIds, week), [state, siteIds, week]);
  const issues = useMemo(() => checkWeek(state, week, siteIds), [state, siteIds, week]);
  const dates = weekDates(week);
  const blocks = issues.filter((i) => i.severity === 'block').length;
  const weekShifts = state.shifts.filter((s) => siteIds.includes(s.siteId) && dates.includes(s.date));
  const published = weekShifts.length > 0 && weekShifts.every((s) => s.published);
  const siteName = (id: string) => state.sites.find((s) => s.id === id)?.name;

  function chooseEntity(id: string) {
    setEntityId(id);
    if (site && id && site.entityId !== id) setSiteId(ALL);
    setUnfilled(null);
  }

  function chooseSite(id: string) {
    setSiteId(id);
    setUnfilled(null);
    if (id) setTab('rota');
  }

  async function runAutoBuild() {
    const gaps = await actions.build(siteIds, week);
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
          <select value={entityId} onChange={(e) => chooseEntity(e.target.value)} aria-label="Entity">
            <option value={ALL}>All entities</option>
            {state.entities.map((e) => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
          <select value={site?.id ?? ALL} onChange={(e) => chooseSite(e.target.value)} aria-label="Site">
            <option value={ALL}>{entityId ? 'All sites in entity' : 'All sites'}</option>
            {scopeSites.map((s) => (
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
          <button key={t.id} className={activeTab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
        <div className="tab-actions">
          {/* The assistant drafts one site's week, so it is offered when one site is in scope. */}
          {single && <button onClick={() => setAssistantOpen(true)} className="primary" disabled={!canEdit} title={canEdit ? undefined : NOT_YOURS}>Ask the assistant</button>}
          <button onClick={runAutoBuild} className={single ? '' : 'primary'} disabled={!canEdit} title={canEdit ? undefined : NOT_YOURS}>
            {single ? 'Build from forecast' : `Build ${siteIds.length} sites from forecast`}
          </button>
          <button disabled={!canEdit} title={canEdit ? undefined : NOT_YOURS} onClick={() => { void actions.clear(siteIds, week); setUnfilled(null); }}>Clear week</button>
          <button
            disabled={blocks > 0 || weekShifts.length === 0 || published || !canPublish}
            title={!canPublish ? NOT_YOURS : blocks > 0 ? 'Resolve blocking issues before publishing' : undefined}
            onClick={() => void actions.publish(siteIds, week)}
          >
            {published ? 'Published' : single ? 'Publish' : 'Publish all'}
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
                {single ? '' : `${siteName(g.siteId)}: `}
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
        {activeTab === 'sites' && (
          <GroupView state={state} dates={dates} metrics={metrics} issues={issues} onOpenSite={chooseSite} />
        )}
        {activeTab === 'rota' && single && (
          <RotaGrid
            state={state}
            site={single}
            dates={dates}
            metrics={metrics}
            issues={issues}
            showCost={showCost}
            onEdit={canEdit ? setEditing : undefined}
          />
        )}
        {activeTab === 'demand' && single && <DemandView state={state} siteId={single.id} dates={dates} />}
        {activeTab === 'team' && <TeamView state={state} siteIds={siteIds} metrics={metrics} issues={issues} dates={dates} showCost={showCost} />}
        {activeTab === 'people' && single && (
          <PeopleView
            state={state}
            siteId={single.id}
            today={today}
            onEdit={setEditingPerson}
            onAdd={allow('team.manage', single.id) ? () => setEditingPerson(newEmployee(single.id, single.entityId, state.roles[0].id, today)) : undefined}
          />
        )}
        {activeTab === 'payroll' && single && <PayrollView state={state} siteId={single.id} week={week} allow={allow} onChanged={actions.refreshShifts} />}
        {activeTab === 'close' && <CloseView state={state} week={week} entityIds={entityIds} />}
        {activeTab === 'access' && <AccessView state={state} />}
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

      {assistantOpen && single && (
        <Suspense fallback={null}>
          <AssistantPanel
            state={state}
            siteId={single.id}
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
