import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { UnfilledGap } from '../engine/autoschedule';
import { checkWeek } from '../engine/compliance';
import { newEmployee } from '../engine/employees';
import { scopeMetrics } from '../engine/metrics';
import { addDays, formatMinute, toISODate, weekDates, weekStart } from '../engine/time';
import type { Employee, Shift } from '../engine/types';
import type { Opening } from './assign';
import { AssignPanel } from './AssignPanel';
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
import { RotaGrid } from './RotaGrid';
import { SettingsView, type Me } from './SettingsView';
import { ShiftEditor } from './ShiftEditor';
import { useHrRecords, useRotaStore } from './store';
import { TeamView } from './TeamView';
import { Timeline } from './Timeline';
import { TravelPanel } from './TravelPanel';

// Loaded on first use so the Claude SDK stays out of the main bundle.
const AssistantPanel = lazy(() => import('./AssistantPanel').then((m) => ({ default: m.AssistantPanel })));

type Tab = 'sites' | 'rota' | 'clock' | 'demand' | 'team' | 'people' | 'holiday' | 'hr' | 'absence' | 'training' | 'reviews' | 'cases' | 'payroll' | 'close' | 'integrations' | 'privacy' | 'settings' | 'howto';

// The management bar groups the work the way a GM runs the week: plan it, staff it, pay it, close it.
// Every item is always clickable, so the map never changes. A site-only item opened across several
// sites asks which site; nothing is greyed out except Cases for non-admins.
// Each section says what it is scoped by, so the header only shows controls that change what is on screen:
// week sections get the scope, the week and the P&L rail; people sections get the scope; organisation
// sections get neither. Only the planning sections carry the build and clear actions.
type Scope = 'week' | 'people' | 'org';
// title heads an organisation section; it defaults to Organisation.
type NavItem = { id: Tab; label: string; scope: Scope; title?: string; siteOnly?: boolean; plans?: boolean; adminOnly?: boolean };
const NAV: { heading: string; items: NavItem[] }[] = [
  { heading: 'Overview', items: [{ id: 'sites', label: 'Sites', scope: 'week', plans: true }] },
  {
    heading: 'Scheduling',
    items: [
      { id: 'rota', label: 'Rota', scope: 'week', siteOnly: true, plans: true },
      { id: 'demand', label: 'Demand', scope: 'week', siteOnly: true, plans: true },
      { id: 'clock', label: 'Clock in', scope: 'people', siteOnly: true },
    ],
  },
  {
    heading: 'People',
    items: [
      { id: 'hr', label: 'HR overview', scope: 'people' },
      { id: 'people', label: 'Staff', scope: 'people', siteOnly: true },
      { id: 'holiday', label: 'Holiday', scope: 'people' },
      { id: 'absence', label: 'Absence', scope: 'people' },
      { id: 'training', label: 'Training', scope: 'people' },
      { id: 'reviews', label: 'Probation and reviews', scope: 'people' },
      { id: 'cases', label: 'Cases', scope: 'people', adminOnly: true },
    ],
  },
  {
    heading: 'Finance',
    items: [
      { id: 'team', label: 'Labour cost', scope: 'week' },
      { id: 'payroll', label: 'Payroll', scope: 'week', siteOnly: true },
      { id: 'close', label: 'Close', scope: 'week' },
    ],
  },
  {
    heading: 'Organisation',
    items: [
      { id: 'integrations', label: 'Integrations', scope: 'org' },
      { id: 'privacy', label: 'GDPR', scope: 'org' },
      { id: 'settings', label: 'Settings', scope: 'org' },
    ],
  },
  { heading: 'Help', items: [{ id: 'howto', label: 'How to', scope: 'org', title: 'Help' }] },
];
const NAV_ITEMS = NAV.flatMap((g) => g.items);
const ALL = '';

// Where you are lives in the address, so Back, refresh and a shared link all land on the same screen.
type Place = { tab: Tab; entityId: string; siteId: string; week: string };
function readPlace(fallbackWeek: string): Place {
  const q = new URLSearchParams(window.location.search);
  const tab = q.get('view') as Tab | null;
  const week = q.get('week');
  return {
    tab: tab && NAV_ITEMS.some((t) => t.id === tab) ? tab : 'sites',
    entityId: q.get('entity') ?? ALL,
    siteId: q.get('site') ?? ALL,
    week: week && /^\d{4}-\d{2}-\d{2}$/.test(week) ? weekStart(week) : fallbackWeek,
  };
}
function placeQuery(p: Place) {
  const q = new URLSearchParams();
  if (p.tab !== 'sites') q.set('view', p.tab);
  if (p.entityId) q.set('entity', p.entityId);
  if (p.siteId) q.set('site', p.siteId);
  q.set('week', p.week);
  return `?${q}`;
}

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
  const { state, error, setError, actions } = useRotaStore();
  if (!state) {
    return (
      <div className="shell">
        <p className="muted">{error ? `Cannot reach the Preshift API: ${error}` : 'Loading'}</p>
        {error && <button onClick={() => void actions.reload()}>Try again</button>}
      </div>
    );
  }
  return <Workspace state={state} error={error} setError={setError} actions={actions} />;
}

type Store = ReturnType<typeof useRotaStore>;

function Workspace({ state, error, setError, actions }: { state: NonNullable<Store['state']>; error: string | null; setError: Store['setError']; actions: Store['actions'] }) {
  // Scope: an entity (or the whole group), then one site or all of that entity's sites.
  const [initial] = useState(() => readPlace(weekStart(toISODate(new Date()))));
  const [entityId, setEntityId] = useState(state.entities.some((e) => e.id === initial.entityId) ? initial.entityId : ALL);
  const [siteId, setSiteId] = useState(state.sites.some((s) => s.id === initial.siteId) ? initial.siteId : ALL);
  const [week, setWeek] = useState(initial.week);
  const [tab, setTab] = useState<Tab>(initial.tab);
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
  const [me, setMe] = useState<Me | null>(null);
  const [hrPerson, setHrPerson] = useState<{ id: string; section?: HrSection } | null>(null);
  const hr = useHrRecords(setError);
  const isAdmin = me?.role === 'admin';
  const openHr = (e: Employee, section?: HrSection) => setHrPerson({ id: e.id, section });

  useEffect(() => {
    fetch('/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((body: Me | null) => setMe(body))
      .catch(() => setMe(null));
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
  const available = (t: NavItem) => !t.adminOnly || isAdmin;
  const activeTab = NAV_ITEMS.some((t) => t.id === tab && available(t)) ? tab : 'sites';
  const section = NAV_ITEMS.find((t) => t.id === activeTab)!;
  // A site-only section opened across several sites shows the site chooser instead.
  const needsSite = !!section.siteOnly && !single;

  const baseMetrics = useMemo(() => scopeMetrics(state, siteIds, week), [state, siteIds, week]);
  const metrics = useMemo(() => (preview ? scopeMetrics(view, siteIds, week) : baseMetrics), [view, preview, baseMetrics, siteIds, week]);
  const issues = useMemo(() => checkWeek(view, week, siteIds), [view, siteIds, week]);
  const dates = weekDates(week);
  const blocks = issues.filter((i) => i.severity === 'block').length;
  const weekShifts = state.shifts.filter((s) => siteIds.includes(s.siteId) && dates.includes(s.date));
  const published = weekShifts.length > 0 && weekShifts.every((s) => s.published);
  const siteName = (id: string) => state.sites.find((s) => s.id === id)?.name;
  const scopeName =
    section.scope === 'org' ? (section.title ?? 'Organisation') : single ? single.name : entityId ? state.entities.find((e) => e.id === entityId)?.name : 'All sites';

  // Section and scope changes are steps Back can undo; moving the week only updates the address.
  useEffect(() => {
    const next = placeQuery({ tab: activeTab, entityId, siteId, week });
    if (next === window.location.search) return;
    const prev = readPlace(week);
    const step = prev.tab !== activeTab || prev.entityId !== entityId || prev.siteId !== siteId;
    window.history[step ? 'pushState' : 'replaceState'](null, '', `${window.location.pathname}${next}`);
  }, [activeTab, entityId, siteId, week]);

  useEffect(() => {
    const onPop = () => {
      const p = readPlace(weekStart(toISODate(new Date())));
      setTab(p.tab);
      setEntityId(state.entities.some((e) => e.id === p.entityId) ? p.entityId : ALL);
      setSiteId(state.sites.some((s) => s.id === p.siteId) ? p.siteId : ALL);
      setWeek(p.week);
      setUnfilled(null);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [state.entities, state.sites]);

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

  // Changing site keeps you in the section you are in. Only the Sites overview drops into the rota.
  function chooseSite(id: string) {
    setSiteId(id);
    setUnfilled(null);
    if (id && activeTab === 'sites') setTab('rota');
  }

  function openSection(t: NavItem) {
    // Sites is the overview, so opening it from one site steps back out to every site in scope.
    if (t.id === 'sites') setSiteId(ALL);
    setTab(t.id);
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
          {NAV.map((group) => (
            <div key={group.heading} className="nav-group">
              <div className="nav-heading">{group.heading}</div>
              {group.items.map((t) => (
                <button
                  key={t.id}
                  className={activeTab === t.id ? 'active' : ''}
                  aria-current={activeTab === t.id ? 'page' : undefined}
                  disabled={!available(t)}
                  title={available(t) ? undefined : 'Admins only'}
                  onClick={() => openSection(t)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="side-foot">
          <a className="link" href="/docs" target="_blank" rel="noreferrer">API docs</a>
          {me && !me.demo && (
            <>
              <span className="small">Signed in as {me.email}</span>
              <a className="link" href="/auth/logout">Sign out</a>
            </>
          )}
        </div>
      </aside>

      <div className="content">
        <header className="mast">
          <div className="mast-top">
            <span className="eyebrow">{section.label}</span>
            {section.scope !== 'org' && <div className="mast-controls">
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
              {section.scope === 'week' && (
                <div className="weeknav">
                  <button onClick={() => setWeek(addDays(week, -7))} aria-label="Previous week">&larr;</button>
                  <span className="tnum">{range}</span>
                  <button onClick={() => setWeek(addDays(week, 7))} aria-label="Next week">&rarr;</button>
                </div>
              )}
            </div>}
          </div>
          <div className="mast-title">
            <h1>{scopeName}</h1>
            {section.scope === 'week' && (
              <div className="mast-meta">
                <span className="eyebrow">Week {isoWeek(week)} · {dayLabel(week).date} to {dayLabel(dates[6]).date}</span>
                <span className={`stamp ${status}`}>{statusLabel}</span>
              </div>
            )}
          </div>
          <div className="sections">
            {section.plans && !needsSite && <div className="section-actions">
              {/* The assistant drafts one site's week, so it is offered when one site is in scope. */}
              {single && <button onClick={() => setAssistantOpen(true)}>Ask the assistant</button>}
              <button className="ghost" onClick={() => { void actions.clear(siteIds, week); setUnfilled(null); }}>
                Clear week
              </button>
              <button onClick={runAutoBuild} className="primary">
                {single ? 'Build from forecast' : `Build ${siteIds.length} sites from forecast`}
              </button>
            </div>}
          </div>
        </header>

        <div className={section.scope === 'week' ? 'shell' : 'shell no-rail'}>
          <div className="main">
            {me?.demo && (
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
              {needsSite && (
                <div className="panel site-chooser">
                  <h2>{section.label} is run one site at a time</h2>
                  <p className="muted">Choose the site to open.</p>
                  <div className="site-choices">
                    {scopeSites.map((s) => (
                      <button key={s.id} onClick={() => setSiteId(s.id)}>
                        <span className="strong">{s.name}</span>
                        <span className="muted small">{state.entities.find((e) => e.id === s.entityId)?.name}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {activeTab === 'sites' && (
                <GroupView state={state} dates={dates} metrics={metrics} issues={issues} onOpenSite={(id) => { setSiteId(id); setUnfilled(null); setTab('rota'); }} />
              )}
              {activeTab === 'sites' && scopeSites.length > 1 && (
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
                  onEdit={setEditing}
                  onPreview={setPreview}
                  onCommit={commitChange}
                  onBlocked={refuse}
                  onOpen={setOpening}
                  baseLabourCost={baseMetrics.labourCost}
                />
              )}
              {activeTab === 'rota' && single && rotaView === 'people' && (
                <RotaGrid
                  state={view}
                  site={single}
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
              {activeTab === 'clock' && single && (
                <ClockView
                  state={state}
                  siteId={single.id}
                  today={today}
                  onSetGeofence={actions.setGeofence}
                  onSetBadge={actions.setBadge}
                />
              )}
              {activeTab === 'demand' && single && <DemandView state={state} siteId={single.id} dates={dates} />}
              {activeTab === 'team' && <TeamView state={state} siteIds={siteIds} metrics={metrics} issues={issues} dates={dates} />}
              {activeTab === 'people' && single && (
                <PeopleView
                  state={state}
                  siteId={single.id}
                  today={today}
                  onEdit={setEditingPerson}
                  onAdd={() => setEditingPerson(newEmployee(single.id, single.entityId, state.roles[0].id, today))}
                />
              )}
              {activeTab === 'holiday' && (
                <HolidayView
                  state={state}
                  siteIds={siteIds}
                  today={today}
                  onEdit={setEditingPerson}
                  onSetLeaveYear={actions.setLeaveYearStart}
                />
              )}
              {activeTab === 'hr' && <HrOverview state={state} siteIds={siteIds} today={today} hr={hr} onOpen={openHr} />}
              {activeTab === 'absence' && (
                <AbsenceView state={state} siteIds={siteIds} today={today} onOpen={openHr} onSaveAbsence={actions.saveAbsence} />
              )}
              {activeTab === 'training' && <TrainingView state={state} siteIds={siteIds} today={today} hr={hr} onOpen={openHr} />}
              {activeTab === 'reviews' && <ReviewsView state={state} siteIds={siteIds} today={today} hr={hr} onOpen={openHr} />}
              {activeTab === 'cases' && isAdmin && <CasesView state={state} siteIds={siteIds} today={today} hr={hr} onOpen={openHr} />}
              {activeTab === 'payroll' && single && <PayrollView state={state} siteId={single.id} week={week} onChanged={actions.refreshShifts} onOpenGuide={openGuide} />}
              {activeTab === 'close' && <CloseView state={state} week={week} entityIds={entityIds} />}
              {activeTab === 'integrations' && (
                <IntegrationsView state={state} me={me} singleSite={!!single} today={today} onOpen={setTab} />
              )}
              {activeTab === 'privacy' && <PrivacyView state={state} me={me} today={today} onChanged={actions.reload} />}
              {activeTab === 'settings' && me && <SettingsView me={me} />}
              {activeTab === 'howto' && <HowToView guideId={guide} onOpen={setGuide} />}
            </main>

            <footer className="foot">
              <span>UK rates 2026/27. Running on the Preshift API.</span>
            </footer>
          </div>
          {section.scope === 'week' && <PnlRail
            state={view}
            metrics={metrics}
            issues={issues}
            canPublish={blocks === 0 && weekShifts.length > 0 && !published}
            published={published}
            blocks={blocks}
            onPublish={() => void actions.publish(siteIds, week)}
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
          isAdmin={isAdmin}
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

function describeChange(before: Shift | null, after: Shift, state: { employees: { id: string; name: string }[] }) {
  const name = (id: string) => state.employees.find((e) => e.id === id)?.name.split(' ')[0] ?? '';
  const when = (s: Shift) => `${dayLabel(s.date).short} ${formatMinute(s.startMinute)}-${formatMinute(s.endMinute)}`;
  if (!before) return `Added ${name(after.employeeId)}, ${when(after)}`;
  if (before.employeeId !== after.employeeId) return `Moved ${name(before.employeeId)}'s shift to ${name(after.employeeId)}, ${when(after)}`;
  if (before.date !== after.date) return `Moved ${name(after.employeeId)} to ${when(after)}`;
  return `${name(after.employeeId)} now ${when(after)}`;
}
