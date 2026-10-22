import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { UnfilledGap } from '../engine/autoschedule';
import { checkWeek } from '../engine/compliance';
import { newEmployee } from '../engine/employees';
import { scopeMetrics } from '../engine/metrics';
import { addDays, formatMinute, toISODate, weekDates, weekStart } from '../engine/time';
import type { Employee, Shift } from '../engine/types';
import type { Opening } from './assign';
import { AssignPanel } from './AssignPanel';
import { AccessView } from './access/AccessView';
import { AuthenticatorBar } from './access/Authenticator';
import type { Me } from './access/model';
import { actingAsDemo, canSwitchDemo, demoPeople, signInAsDemo } from './api';
import { ClockView } from './ClockView';
import { CloseView } from './CloseView';
import { DemandView } from './DemandView';
import { EmployeeEditor } from './EmployeeEditor';
import { dayLabel, isoWeek } from './format';
import { GroupView } from './GroupView';
import { HolidayView } from './HolidayView';
import { HowToView } from './HowToView';
import { AbsenceView } from './AbsenceView';
import { HrFile, type HrSection } from './HrFile';
import { HrOverview } from './HrOverview';
import { CasesView, ReviewsView } from './ReviewsView';
import { TrainingView } from './TrainingView';
import { IntegrationsView } from './IntegrationsView';
import { PayrollView } from './PayrollView';
import { PeopleView } from './PeopleView';
import { PnlRail } from './PnlRail';
import { PrivacyView } from './PrivacyView';
import { ReportsView } from './ReportsView';
import { RotaGrid } from './RotaGrid';
import { SettingsView, type Account } from './SettingsView';
import { allowFor, NOT_YOURS, type Allow } from './permissions';
import { ShiftEditor } from './ShiftEditor';
import { useHrRecords, useRotaStore } from './store';
import { TeamView } from './TeamView';
import { Timeline } from './Timeline';
import { TravelPanel } from './TravelPanel';

// Loaded on first use so the Claude SDK stays out of the main bundle.
const AssistantPanel = lazy(() => import('./AssistantPanel').then((m) => ({ default: m.AssistantPanel })));

type Tab = 'sites' | 'rota' | 'clock' | 'demand' | 'team' | 'people' | 'holiday' | 'payroll' | 'close' | 'reports' | 'hr' | 'absence' | 'training' | 'reviews' | 'cases' | 'integrations' | 'privacy' | 'access' | 'settings' | 'howto';

/** Holds the permission at every site in scope: what an action over the scope needs. */
type AtAll = Allow;
type Offered = (atAll: AtAll, allow: Allow) => boolean;

// The management bar groups the work the way a GM runs the week: plan it, staff it, pay it, close it, review it.
// Site-only sections stay visible across a group so the map never changes; they ask for one site.
// An item is shown only to someone who can use it across the scope; the screen still asks the server.
type NavItem = { id: Tab; label: string; siteOnly?: boolean; groupOnly?: boolean; offered?: Offered };
const NAV: { heading: string; items: NavItem[] }[] = [
  // Side by side labour cost by site: for those who see cost everywhere in scope.
  { heading: 'Overview', items: [{ id: 'sites', label: 'Sites', groupOnly: true, offered: (all) => all('costs.view') }] },
  {
    heading: 'Scheduling',
    items: [
      { id: 'rota', label: 'Rota', siteOnly: true },
      { id: 'demand', label: 'Demand', siteOnly: true },
      { id: 'clock', label: 'Clock in', siteOnly: true, offered: (all) => all('time.record') },
    ],
  },
  {
    heading: 'People',
    items: [
      { id: 'team', label: 'Team' },
      { id: 'people', label: 'People', siteOnly: true, offered: (all) => all('team.manage') || all('costs.view') },
      // Balances are the team's records; the provision in pounds shows only with cost.
      { id: 'holiday', label: 'Holiday', offered: (all) => all('team.manage') || all('costs.view') },
    ],
  },
  {
    heading: 'HR',
    items: [
      // Personnel files go by site, as the rest of the team's records do; cases are confidential.
      { id: 'hr', label: 'HR overview', offered: (all) => all('hr.view') },
      { id: 'absence', label: 'Absence', offered: (all) => all('hr.view') },
      { id: 'training', label: 'Training', offered: (all) => all('hr.view') },
      { id: 'reviews', label: 'Probation and reviews', offered: (all) => all('hr.view') },
      { id: 'cases', label: 'Cases', offered: (_all, a) => a('hr.cases') },
    ],
  },
  {
    heading: 'Finance',
    items: [
      { id: 'payroll', label: 'Payroll', siteOnly: true, offered: (all, a) => all('time.record') || all('time.approve') || a('payroll.view') },
      { id: 'close', label: 'Close', offered: (_all, a) => a('close.export') },
    ],
  },
  // Labour cost against takings and payroll accuracy: money throughout, for those who see cost.
  { heading: 'Reporting', items: [{ id: 'reports', label: 'Reports', offered: (all) => all('costs.view') }] },
  {
    heading: 'Admin',
    items: [
      { id: 'integrations', label: 'Integrations', offered: (_all, a) => a('settings.manage') || a('payroll.view') },
      { id: 'privacy', label: 'GDPR', offered: (_all, a) => a('privacy.manage') },
      { id: 'access', label: 'Access', offered: (all, a) => a('users.manage') || all('users.sites') || a('audit.view') },
      // Everyone who signs in can change their own password there.
      { id: 'settings', label: 'Settings' },
    ],
  },
  { heading: 'Help', items: [{ id: 'howto', label: 'How to' }] },
];
const NAV_ITEMS = NAV.flatMap((g) => g.items);
const ALL = '';

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
  const { state, me, error, setError, actions } = useRotaStore();
  if (!state) {
    return (
      <div className="shell">
        <p className="muted">{error ? `Cannot reach the Preshift API: ${error}` : 'Loading'}</p>
        {error && <button onClick={() => void actions.reload()}>Try again</button>}
      </div>
    );
  }
  if (state.sites.length === 0) {
    return (
      <div className="shell">
        <p className="muted">Your roles do not reach any site yet. Ask whoever manages access to grant you one.</p>
        <DemoSwitch me={me} />
      </div>
    );
  }
  return <Workspace state={state} me={me} error={error} setError={setError} actions={actions} />;
}

type Store = ReturnType<typeof useRotaStore>;

function Workspace({ state, me, error, setError, actions }: { state: NonNullable<Store['state']>; me: Me | null; error: string | null; setError: Store['setError']; actions: Store['actions'] }) {
  // Scope: an entity (or the whole group), then one site or all of that entity's sites.
  const [entityId, setEntityId] = useState(ALL);
  const [siteId, setSiteId] = useState(ALL);
  const [week, setWeek] = useState(weekStart(toISODate(new Date())));
  const [tab, setTab] = useState<Tab>('sites');
  const [guide, setGuide] = useState<string | null>(null);
  const openGuide = (id: string) => { setGuide(id); setTab('howto'); };
  const [editing, setEditing] = useState<Shift | null>(null);
  const [unfilled, setUnfilled] = useState<UnfilledGap[] | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [editingPerson, setEditingPerson] = useState<Employee | null>(null);
  const [preview, setPreview] = useState<Shift | null>(null);
  const [lastChange, setLastChange] = useState<{ before: Shift | null; after: Shift } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [opening, setOpening] = useState<Opening | null>(null);
  const [rotaView, setRotaView] = useState<RotaView>(savedView);
  const today = toISODate(new Date());
  // The signed-in account (sign-in), as against `me`, the access record and what it allows.
  const [account, setAccount] = useState<Account | null>(null);
  const [hrPerson, setHrPerson] = useState<{ id: string; section?: HrSection } | null>(null);
  const hr = useHrRecords(setError);
  const openHr = (e: Employee, section?: HrSection) => setHrPerson({ id: e.id, section });

  useEffect(() => {
    fetch('/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((body: Account | null) => setAccount(body))
      .catch(() => setAccount(null));
  }, []);

  // While a shift is being dragged, or a name is hovered in the picker, every figure on the
  // page is worked from the previewed rota. A shift not yet in the rota previews as an addition.
  const view = useMemo(() => {
    if (!preview) return state;
    const exists = state.shifts.some((s) => s.id === preview.id);
    return { ...state, shifts: exists ? state.shifts.map((s) => (s.id === preview.id ? preview : s)) : [...state.shifts, preview] };
  }, [state, preview]);

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
  const offered = (t: NavItem) => !t.offered || t.offered(atAll, allow);
  const nav = NAV.map((g) => ({ ...g, items: g.items.filter(offered) })).filter((g) => g.items.length > 0);
  const available = (t: NavItem) => (single ? !t.groupOnly : !t.siteOnly);
  const fallback = nav.flatMap((g) => g.items).find(available)?.id ?? 'settings';
  const activeTab = NAV_ITEMS.some((t) => t.id === tab && available(t) && offered(t)) ? tab : single ? 'rota' : fallback;

  const baseMetrics = useMemo(() => scopeMetrics(state, siteIds, week), [state, siteIds, week]);
  const metrics = useMemo(() => (preview ? scopeMetrics(view, siteIds, week) : baseMetrics), [view, preview, baseMetrics, siteIds, week]);
  const issues = useMemo(() => checkWeek(view, week, siteIds), [view, siteIds, week]);
  const dates = weekDates(week);
  const blocks = issues.filter((i) => i.severity === 'block').length;
  const weekShifts = state.shifts.filter((s) => siteIds.includes(s.siteId) && dates.includes(s.date));
  const published = weekShifts.length > 0 && weekShifts.every((s) => s.published);
  const siteName = (id: string) => state.sites.find((s) => s.id === id)?.name;
  const scopeName = single ? single.name : entityId ? state.entities.find((e) => e.id === entityId)?.name : 'All sites';

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

  function chooseView(v: RotaView) {
    setRotaView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // Not remembered in private mode; the choice still applies now.
    }
  }

  async function runAutoBuild() {
    const gaps = await actions.build(siteIds, week);
    if (gaps) setUnfilled(gaps);
  }

  async function commitChange(after: Shift, before: Shift) {
    if (await actions.saveShift(after, false)) {
      setLastChange({ before, after });
      setRefusal(null);
    }
  }

  async function addShift(shift: Shift) {
    setPreview(null);
    setOpening(null);
    if (await actions.saveShift(shift, true)) {
      setLastChange({ before: null, after: shift });
      setRefusal(null);
    }
  }

  async function undo(change: { before: Shift | null; after: Shift }) {
    setLastChange(null);
    if (change.before) await actions.saveShift(change.before, false);
    else await actions.deleteShift(change.after.id);
  }

  function refuse(message: string) {
    setRefusal(message);
    setLastChange(null);
  }

  const status = blocks > 0 ? 'blocked' : published ? 'published' : 'draft';
  const statusLabel = blocks > 0 ? `${blocks} blocking issue${blocks > 1 ? 's' : ''}` : published ? 'Published to team' : weekShifts.length ? 'Draft' : 'Not started';
  const gapGroups = unfilled
    ? Array.from(
        unfilled.reduce((m, g) => {
          const name = `${single ? '' : `${siteName(g.siteId)}: `}${state.roles.find((r) => r.id === g.roleId)?.name ?? g.roleId}`;
          m.set(name, [...(m.get(name) ?? []), g]);
          return m;
        }, new Map<string, UnfilledGap[]>()),
      )
    : [];
  const clock = (h: number) => `${String(h % 24).padStart(2, '0')}:00`;
  const range = `${new Date(`${week}T00:00:00Z`).getUTCDate()} to ${new Date(`${dates[6]}T00:00:00Z`).getUTCDate()} ${MONTH(dates[6])}`;

  return (
    <div className="workspace">
      <aside className="sidebar">
        <div className="wordmark">
          Preshift<span className="wordmark-with">with Williams, Stanley &amp; Co.</span>
        </div>
        <nav className="side-nav" aria-label="Management">
          {nav.map((group) => (
            <div key={group.heading} className="nav-group">
              <div className="nav-heading">{group.heading}</div>
              {group.items.map((t) => (
                <button
                  key={t.id}
                  className={activeTab === t.id ? 'active' : ''}
                  aria-current={activeTab === t.id ? 'page' : undefined}
                  disabled={!available(t)}
                  title={available(t) ? undefined : t.siteOnly ? 'Choose one site to open this' : 'Shown across several sites'}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="side-foot">
          <a className="link" href="/docs" target="_blank" rel="noreferrer">API docs</a>
          {account && !account.demo && (
            <>
              <span className="small">Signed in as {account.email}</span>
              <a className="link" href="/auth/logout">Sign out</a>
            </>
          )}
        </div>
      </aside>

      <div className="content">
        <header className="mast">
          <div className="mast-top">
            <span className="eyebrow">{NAV_ITEMS.find((t) => t.id === activeTab)?.label}</span>
            <div className="mast-controls">
              <DemoSwitch me={me} />
              <OrgSwitch account={account} />
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
              <div className="weeknav">
                <button onClick={() => setWeek(addDays(week, -7))} aria-label="Previous week">&larr;</button>
                <span className="tnum">{range}</span>
                <button onClick={() => setWeek(addDays(week, 7))} aria-label="Next week">&rarr;</button>
              </div>
            </div>
          </div>
          <div className="mast-title">
            <h1>{scopeName}</h1>
            <div className="mast-meta">
              <span className="eyebrow">Week {isoWeek(week)} · {dayLabel(week).date} to {dayLabel(dates[6]).date}</span>
              <span className={`stamp ${status}`}>{statusLabel}</span>
            </div>
          </div>
          {/* How to is for reading: no week actions and no P&L beside it, so the guide gets the width. */}
          {activeTab !== 'howto' && <div className="sections">
            <div className="section-actions">
              {/* The assistant drafts one site's week, so it is offered when one site is in scope. */}
              {single && <button onClick={() => setAssistantOpen(true)} disabled={!canEdit} title={canEdit ? undefined : NOT_YOURS}>Ask the assistant</button>}
              <button className="ghost" disabled={!canEdit} title={canEdit ? undefined : NOT_YOURS} onClick={() => { void actions.clear(siteIds, week); setUnfilled(null); }}>
                Clear week
              </button>
              <button onClick={runAutoBuild} className="primary" disabled={!canEdit} title={canEdit ? undefined : NOT_YOURS}>
                {single ? 'Build from forecast' : `Build ${siteIds.length} sites from forecast`}
              </button>
            </div>
          </div>}
        </header>

        <AuthenticatorBar me={me} />

        <div className={`shell${activeTab === 'howto' ? ' no-rail' : ''}`}>
          <div className="main">
            {account?.demo && (
              <div className="notice demo-banner">
                <span>
                  <strong>Live demo.</strong> This is your own copy of a sample group of three London sites, so change anything:
                  build the week, edit shifts, add people, run payroll against the TeamPay simulator, post the accrual. Nobody
                  else sees it, and it is deleted after a day.
                </span>
                <span className="demo-actions">
                  <a className="link" href="/demo?fresh=1">Start again</a>
                  <a className="button primary" href="mailto:hello@preshift.co.uk?subject=Preshift%20Rota%20demo">Book a demo</a>
                </span>
              </div>
            )}

            {error && (
              <div className="notice error">
                {error} <button className="link" onClick={() => setError(null)}>Dismiss</button>
              </div>
            )}

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
              {activeTab === 'sites' && (
                <GroupView state={state} dates={dates} metrics={metrics} issues={issues} onOpenSite={chooseSite} />
              )}
              {/* Travel times between sites are a settings change: offered only to those who can make it. */}
              {activeTab === 'sites' && scopeSites.length > 1 && allow('settings.manage') && (
                <TravelPanel
                  sites={scopeSites}
                  onSetLocation={actions.setSiteLocation}
                  onRefresh={actions.refreshTravel}
                  onSetTravel={actions.setTravel}
                />
              )}
              {activeTab === 'rota' && single && (
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
                      ? 'Each day over its sales curve, with hours short or over in the strip beneath. Drag a bar to move it or its ends to change the hours. Drag across a day, or click a red hour, to add a shift.'
                      : 'Every person across the week. Drag a shift to another person or day.'}
                  </span>
                </div>
              )}
              {activeTab === 'rota' && single && rotaView === 'timeline' && (
                <Timeline
                  state={view}
                  base={state}
                  site={single}
                  dates={dates}
                  metrics={metrics}
                  issues={issues}
                  onEdit={canEdit ? setEditing : () => refuse(NOT_YOURS)}
                  onPreview={canEdit ? setPreview : () => undefined}
                  onCommit={canEdit ? commitChange : () => refuse(NOT_YOURS)}
                  onBlocked={refuse}
                  onOpen={canEdit ? setOpening : () => refuse(NOT_YOURS)}
                  baseLabourCost={baseMetrics.labourCost}
                  showCost={showCost}
                />
              )}
              {activeTab === 'rota' && single && rotaView === 'people' && (
                <RotaGrid
                  state={view}
                  site={single}
                  dates={dates}
                  metrics={metrics}
                  issues={issues}
                  showCost={showCost}
                  onEdit={canEdit ? setEditing : undefined}
                  onPreview={canEdit ? setPreview : () => undefined}
                  onCommit={canEdit ? commitChange : () => refuse(NOT_YOURS)}
                  onBlocked={refuse}
                  baseLabourCost={baseMetrics.labourCost}
                />
              )}
              {activeTab === 'clock' && single && (
                <ClockView
                  state={state}
                  siteId={single.id}
                  today={today}
                  onSetGeofence={actions.setGeofence}
                  onSetBadge={actions.setBadge}
                  canSetFence={allow('settings.manage')}
                  canEnrolCards={allow('team.manage', single.id)}
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
              {activeTab === 'holiday' && (
                <HolidayView
                  state={state}
                  siteIds={siteIds}
                  today={today}
                  onEdit={setEditingPerson}
                  onSetLeaveYear={allow('settings.manage') ? actions.setLeaveYearStart : undefined}
                  showCost={showCost}
                />
              )}
              {activeTab === 'hr' && <HrOverview state={state} siteIds={siteIds} today={today} hr={hr} onOpen={openHr} />}
              {activeTab === 'absence' && (
                <AbsenceView state={state} siteIds={siteIds} today={today} onOpen={openHr} onSaveAbsence={actions.saveAbsence} />
              )}
              {activeTab === 'training' && <TrainingView state={state} siteIds={siteIds} today={today} hr={hr} onOpen={openHr} />}
              {activeTab === 'reviews' && <ReviewsView state={state} siteIds={siteIds} today={today} hr={hr} onOpen={openHr} />}
              {activeTab === 'cases' && allow('hr.cases') && <CasesView state={state} siteIds={siteIds} today={today} hr={hr} onOpen={openHr} />}
              {activeTab === 'payroll' && single && <PayrollView state={state} siteId={single.id} week={week} allow={allow} simulator={!!me?.simulator} onChanged={actions.refreshShifts} onOpenGuide={openGuide} />}
              {activeTab === 'close' && <CloseView state={state} week={week} entityIds={entityIds} />}
              {activeTab === 'reports' && (
                <ReportsView
                  state={state}
                  siteIds={siteIds}
                  entityIds={entityIds}
                  week={week}
                  today={today}
                  onSaveSales={actions.saveSales}
                  payrollAccess={allow('payroll.view')}
                  scopeName={single ? single.name : entityId ? state.entities.find((e) => e.id === entityId)?.name ?? 'entity' : 'group'}
                />
              )}
              {activeTab === 'integrations' && (
                <IntegrationsView state={state} account={account} canSettings={allow('settings.manage')} singleSite={!!single} today={today} onOpen={setTab} />
              )}
              {activeTab === 'privacy' && <PrivacyView state={state} canManage={allow('privacy.manage')} today={today} onChanged={actions.reload} />}
              {activeTab === 'access' && <AccessView state={state} />}
              {activeTab === 'settings' && <SettingsView account={account} canSettings={allow('settings.manage')} />}
              {activeTab === 'howto' && <HowToView guideId={guide} onOpen={setGuide} />}
            </main>

            <footer className="foot">
              <span>UK rates 2026/27. Running on the Preshift API.</span>
            </footer>
          </div>
          {activeTab !== 'howto' && <PnlRail
            state={view}
            metrics={metrics}
            issues={issues}
            canPublish={blocks === 0 && weekShifts.length > 0 && !published}
            publishRefused={canPublish ? undefined : NOT_YOURS}
            published={published}
            blocks={blocks}
            onPublish={() => void actions.publish(siteIds, week)}
            showCost={showCost}
          />}
        </div>
      </div>

      {refusal && (
        <div className="toast refused" role="alert">
          <span>{refusal}</span>
          <button className="ghost" onClick={() => setRefusal(null)}>Close</button>
        </div>
      )}

      {lastChange && (
        <div className="toast" role="status">
          <span>{describeChange(lastChange.before, lastChange.after, state)}</span>
          <button className="ghost" onClick={() => void undo(lastChange)}>Undo</button>
        </div>
      )}

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

      {opening && (
        <AssignPanel state={state} opening={opening} onPreview={setPreview} onAdd={(s) => void addShift(s)} onClose={() => setOpening(null)} />
      )}

      {hrPerson && state.employees.some((e) => e.id === hrPerson.id) && (
        <HrFile
          key={hrPerson.id}
          state={state}
          employee={state.employees.find((e) => e.id === hrPerson.id)!}
          hr={hr}
          today={today}
          isAdmin={allow('hr.cases')}
          initialSection={hrPerson.section}
          onSaveProfile={actions.saveHrProfile}
          onSaveAbsence={actions.saveAbsence}
          onDeleteAbsence={actions.deleteAbsence}
          onClose={() => setHrPerson(null)}
        />
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
          onAddDocument={actions.addRightToWorkDocument}
          onDeleteDocument={allow('privacy.manage') ? actions.deleteRightToWorkDocument : undefined}
          onDocumentHistory={allow('privacy.manage') ? actions.rightToWorkDocumentHistory : undefined}
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

function describeChange(before: Shift | null, after: Shift, state: { employees: { id: string; name: string }[] }) {
  const name = (id: string) => state.employees.find((e) => e.id === id)?.name.split(' ')[0] ?? '';
  const when = (s: Shift) => `${dayLabel(s.date).short} ${formatMinute(s.startMinute)}-${formatMinute(s.endMinute)}`;
  if (!before) return `Added ${name(after.employeeId)}, ${when(after)}`;
  if (before.employeeId !== after.employeeId) return `Moved ${name(before.employeeId)}'s shift to ${name(after.employeeId)}, ${when(after)}`;
  if (before.date !== after.date) return `Moved ${name(after.employeeId)} to ${when(after)}`;
  return `${name(after.employeeId)} now ${when(after)}`;
}

interface DemoPerson { id: string; name: string; jobTitle?: string; status: string }

/**
 * For someone who works in more than one organisation: moves the session to another, then
 * starts the app again there, as everything on screen belongs to the one it came from.
 */
function OrgSwitch({ account }: { account: Account | null }) {
  const [error, setError] = useState<string | null>(null);
  const orgs = account?.organisations ?? [];
  if (orgs.length < 2 || actingAsDemo) return null;
  async function choose(orgId: string) {
    setError(null);
    const res = await fetch('/auth/switch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orgId }) }).catch(() => null);
    if (res?.ok) return location.reload();
    setError((await res?.json().catch(() => null))?.message ?? 'Could not switch. Check your connection and try again.');
  }
  return (
    <label className="demo-switch">
      <span className="muted small">Organisation</span>
      <select value={account!.orgId} onChange={(e) => void choose(e.target.value)} aria-label="Organisation">
        {orgs.map((o) => (
          <option key={o.orgId} value={o.orgId}>{o.name}</option>
        ))}
      </select>
      {error && <span className="small bad-text" role="alert">{error}</span>}
    </label>
  );
}

/** Demo only: sign in as any seeded person to see what their roles allow. Absent outside the demo. */
function DemoSwitch({ me }: { me: Me | null }) {
  const [people, setPeople] = useState<DemoPerson[] | null>(null);
  useEffect(() => {
    if (canSwitchDemo) void demoPeople<DemoPerson[]>().then(setPeople).catch(() => setPeople(null));
  }, []);
  if (!people) return null;
  return (
    <label className="demo-switch">
      <span className="muted small">Demo: acting as</span>
      <select value={actingAsDemo ? me?.user?.id ?? '' : ''} onChange={(e) => signInAsDemo(e.target.value || null)}>
        <option value="">My own sign-in</option>
        {people.filter((p) => p.status === 'active').map((p) => (
          <option key={p.id} value={p.id}>{p.name}{p.jobTitle ? `, ${p.jobTitle}` : ''}</option>
        ))}
      </select>
    </label>
  );
}
