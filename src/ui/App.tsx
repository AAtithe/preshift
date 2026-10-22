import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { UnfilledGap } from '../engine/autoschedule';
import { checkWeek } from '../engine/compliance';
import { newEmployee } from '../engine/employees';
import { scopeMetrics } from '../engine/metrics';
import { addDays, formatMinute, londonParts, toISODate, weekDates, weekStart } from '../engine/time';
import type { Employee, Shift } from '../engine/types';
import type { Opening } from './assign';
import { AssignPanel } from './AssignPanel';
import { CalendarView, RemindersBanner } from './CalendarView';
import { CoachView } from './CoachView';
import { AccessView } from './access/AccessView';
import { AuthenticatorBar } from './access/Authenticator';
import type { Me } from './access/model';
import { actingAsDemo, canSwitchDemo, demoPeople, signInAsDemo } from './api';
import { ClockView } from './ClockView';
import { CloseView } from './CloseView';
import { DemandView } from './DemandView';
import { EmployeeEditor } from './EmployeeEditor';
import { ForecastView } from './ForecastView';
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
import { PayApprovalsView } from './PayApprovalsView';
import { PayrollView } from './PayrollView';
import { ActualsView } from './ActualsView';
import { CutCallView } from './CutCallView';
import { PrimeView } from './PrimeView';
import { RetentionView } from './RetentionView';
import { RiskView } from './RiskView';
import { TroncView } from './TroncView';
import { PeopleView } from './PeopleView';
import { PnlRail } from './PnlRail';
import { PrivacyView } from './PrivacyView';
import { OnboardingView } from './OnboardingView';
import { ClientsView } from './ClientsView';
import { ProgrammeView } from './ProgrammeView';
import { ReportsView } from './ReportsView';
import { RotaGrid } from './RotaGrid';
import { ProfileView } from './ProfileView';
import { RestBreaches } from './RestBreaches';
import { SettingsView, type Account } from './SettingsView';
import { SetupView } from './SetupView';
import { ALL, NAV_ITEMS, offered, placeQuery, readPlace, sitesFor, visibleNav, type AtAll, type NavItem, type Tab } from './nav';
import { allowFor, NOT_YOURS } from './permissions';
import type { ProposalDeps } from './proposals';
import type { AgentView } from './useAppAgent';
import { ShiftEditor } from './ShiftEditor';
import { SideNav } from './SideNav';
import { useHrRecords, useRotaStore } from './store';
import { TeamView } from './TeamView';
import { Timeline } from './Timeline';
import { TravelPanel } from './TravelPanel';

// Loaded on first use so the Claude SDK stays out of the main bundle.
const AssistantPanel = lazy(() => import('./AssistantPanel').then((m) => ({ default: m.AssistantPanel })));
const Shifty = lazy(() => import('./Shifty').then((m) => ({ default: m.Shifty })));
const CommandBar = lazy(() => import('./CommandBar').then((m) => ({ default: m.CommandBar })));

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
  // Set when the first save of set-up gives the organisation its first site: the workspace then
  // opens on set-up's team step instead of dropping the person on an empty overview.
  const [continueSetup, setContinueSetup] = useState(false);
  if (!state) {
    return (
      <div className="shell">
        <p className="muted">{error ? `Cannot reach the Preshift API: ${error}` : 'Loading'}</p>
        {error && <button onClick={() => void actions.reload()}>Try again</button>}
      </div>
    );
  }
  // No sites for someone who may change them organisation-wide means none exist yet: set-up is the
  // only useful screen. Anyone else with no sites simply has no site role.
  if (state.sites.length === 0 && allowFor(me)('settings.manage')) {
    return (
      <div className="first-run">
        <div className="wordmark">
          Preshift<span className="wordmark-with">with Williams, Stanley &amp; Co.</span>
        </div>
        <SetupView state={state} isAdmin onSaved={async () => { setContinueSetup(true); await actions.reload(); }} />
        <p className="small muted"><a className="link" href="/auth/logout">Sign out</a></p>
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
  return <Workspace state={state} me={me} error={error} setError={setError} actions={actions} continueSetup={continueSetup} />;
}

type Store = ReturnType<typeof useRotaStore>;

function Workspace({ state, me, error, setError, actions, continueSetup }: { state: NonNullable<Store['state']>; me: Me | null; error: string | null; setError: Store['setError']; actions: Store['actions']; continueSetup: boolean }) {
  // Scope: an entity (or the whole group), then one site or all of that entity's sites.
  const [initial] = useState(() => readPlace(weekStart(toISODate(new Date()))));
  const [entityId, setEntityId] = useState(state.entities.some((e) => e.id === initial.entityId) ? initial.entityId : ALL);
  const [siteId, setSiteId] = useState(state.sites.some((s) => s.id === initial.siteId) ? initial.siteId : ALL);
  const [week, setWeek] = useState(initial.week);
  const [tab, setTab] = useState<Tab>(continueSetup ? 'setup' : initial.tab);
  const [guide, setGuide] = useState<string | null>(null);
  const openGuide = (id: string) => { setGuide(id); setTab('howto'); };
  const [editing, setEditing] = useState<Shift | null>(null);
  const [unfilled, setUnfilled] = useState<UnfilledGap[] | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  // A request handed over from Shifty or the command bar, to start the rota assistant with.
  const [assistantInstruction, setAssistantInstruction] = useState('');
  const [editingPerson, setEditingPerson] = useState<Employee | null>(null);
  const [preview, setPreview] = useState<Shift | null>(null);
  const [lastChange, setLastChange] = useState<{ before: Shift | null; after: Shift } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
  const [sample, setSample] = useState(false);
  // Whoever may change the set-up is told when they are still looking at the sample group.
  useEffect(() => {
    if (!allow('settings.manage')) return;
    fetch('/v1/setup/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { sample?: boolean } | null) => setSample(Boolean(body?.sample)))
      .catch(() => setSample(false));
  }, [allow, state.sites]);
  const atAll: AtAll = (p) => siteIds.every((s) => allow(p, s));
  const showCost = atAll('costs.view');
  const canEdit = atAll('rota.edit');
  const canPublish = atAll('rota.publish');
  // The bar is worked out over every site the person can see, so it keeps its shape as the scope changes.
  const allSiteIds = useMemo(() => state.sites.map((s) => s.id), [state.sites]);
  const nav = visibleNav(allow, allSiteIds, me?.user?.audience);
  const fallback = nav[0]?.items[0]?.id ?? 'profile';
  const activeTab = NAV_ITEMS.some((t) => t.id === tab && offered(t, allow, allSiteIds, me?.user?.audience)) ? tab : fallback;
  const section = NAV_ITEMS.find((t) => t.id === activeTab)!;
  // Within the scope, the section reaches only the sites it is offered at.
  const sectionSites = sitesFor(section, allow, siteIds);
  const notHere = section.access !== 'everyone' && !offered(section, allow, siteIds, me?.user?.audience);
  // A site-only section opened across several sites shows the site chooser instead.
  const needsSite = !notHere && !!section.siteOnly && !single;
  const shown = notHere || needsSite ? null : activeTab;

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
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(t);
  }, [notice]);

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

  async function forecastWeek() {
    const res = await actions.forecastFromTakings(siteIds, week);
    if (!res) return;
    const none = res.days.filter((d) => d.basis === 'none').length;
    setNotice(`Forecast ${res.filled} ${res.filled === 1 ? 'day' : 'days'} from past takings.${none ? ` ${none} had no takings to work from.` : ''}`);
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

  // Shifty and the command bar read what the manager is looking at, and act only through these.
  const agentDeps: ProposalDeps = {
    actions,
    goTo: (screen) => setTab(screen as Tab),
    openAssistant: (instruction) => {
      setAssistantInstruction(instruction);
      setAssistantOpen(true);
    },
    reviewStarter: (employee) => setEditingPerson(employee),
  };
  const scopeLabel = single ? single.name : siteIds.length === state.sites.length ? 'all sites' : `${siteIds.length} sites`;
  const agentView = (): AgentView => ({
    ctx: { state, siteIds, week, now: londonParts(new Date()) },
    where: { screen: activeTab, scope: scopeLabel, user: account?.email ?? 'The manager' },
  });

  return (
    <div className="workspace">
      <aside className="sidebar">
        <div className="wordmark">
          Preshift<span className="wordmark-with">with Williams, Stanley &amp; Co.</span>
        </div>
        <SideNav groups={nav} active={activeTab} onOpen={openSection} />
        <div className="side-foot">
          <a className="link" href="/docs" target="_blank" rel="noreferrer">API docs</a>
          {account && !account.demo && (
            <>
              <button className="link small" onClick={() => setTab('profile')} title="Your profile">Signed in as {me?.user?.name ?? account.email}</button>
              <a className="link" href="/auth/logout">Sign out</a>
            </>
          )}
        </div>
      </aside>

      <div className="content">
        <header className="mast">
          <div className="mast-top">
            <span className="eyebrow">{section.label}</span>
            <div className="mast-controls">
              <DemoSwitch me={me} />
              <OrgSwitch account={account} />
              {section.scope !== 'org' && <>
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
              </>}
            </div>
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
            {section.plans && canEdit && !needsSite && !notHere && <div className="section-actions">
              {/* The assistant drafts one site's week, so it is offered when one site is in scope. */}
              {siteIds.length > 0 && <button onClick={() => setAssistantOpen(true)} disabled={!canEdit} title={canEdit ? undefined : NOT_YOURS}>Ask the assistant</button>}
              <button className="ghost" disabled={!canEdit} title={canEdit ? undefined : NOT_YOURS} onClick={() => { void actions.clear(siteIds, week); setUnfilled(null); }}>
                Clear week
              </button>
              <button onClick={runAutoBuild} className="primary" disabled={!canEdit} title={canEdit ? undefined : NOT_YOURS}>
                {single ? 'Build from forecast' : `Build ${siteIds.length} sites from forecast`}
              </button>
            </div>}
          </div>
        </header>

        <AuthenticatorBar me={me} />

        <div className={section.scope === 'week' ? 'shell' : 'shell no-rail'}>
          <div className="main">
            {sample && !account?.demo && activeTab !== 'setup' && (
              <div className="notice">
                You are looking at the sample group, not your business.{' '}
                <button className="link" onClick={() => setTab('setup')}>Set up your own</button>
              </div>
            )}
            {account?.demo && (
              <div className="notice demo-banner">
                <span>
                  <strong>Live demo.</strong> This is your own copy of a sample group of three London sites, so change anything:
                  build the week, edit shifts, add people, run payroll against the TeamPay simulator, post the accrual. Nobody
                  else sees it, and it is wiped at midnight UK time.
                </span>
                <span className="demo-actions">
                  <form method="post" action="/demo/start">
                    <input type="hidden" name="fresh" value="1" />
                    <button type="submit" className="link">Start again</button>
                  </form>
                  <a className="button primary" href="mailto:hello@preshift.co.uk?subject=Preshift%20Rota%20demo">Book a demo</a>
                </span>
              </div>
            )}

            {section.scope !== 'org' ? (
              <RemindersBanner key={`${siteIds.join()}:${activeTab}`} siteIds={siteIds} sites={state.sites} today={today} onOpen={(id) => { setSiteId(id); setTab('calendar'); }} />
            ) : null}

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

            {(shown === 'rota' || shown === 'sites') && (
              <RestBreaches
                state={state}
                issues={issues}
                canOverride={(siteId) => allow('rota.publish', siteId)}
                onOverride={(key, reason) => actions.overrideRest(week, key, reason)}
                onWithdraw={actions.withdrawOverride}
              />
            )}

            <main>
              {(needsSite || notHere) && (
                <div className="panel site-chooser">
                  <h2>{notHere ? `${section.label} is not yours at ${scopeName}` : `${section.label} is run one site at a time`}</h2>
                  <p className="muted">{notHere ? 'Your roles reach it at these sites.' : 'Choose the site to open.'}</p>
                  <div className="site-choices">
                    {state.sites.filter((s) => (notHere ? sitesFor(section, allow, allSiteIds) : sectionSites).includes(s.id)).map((s) => (
                      <button key={s.id} onClick={() => { if (notHere) setEntityId(ALL); setSiteId(s.id); }}>
                        <span className="strong">{s.name}</span>
                        <span className="muted small">{state.entities.find((e) => e.id === s.entityId)?.name}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {shown === 'sites' && (
                <GroupView state={state} dates={dates} metrics={metrics} issues={issues} onOpenSite={(id) => { setSiteId(id); setUnfilled(null); setTab('rota'); }} />
              )}
              {/* Travel times between sites are a settings change: offered only to those who can make it. */}
              {shown === 'sites' && scopeSites.length > 1 && allow('settings.manage') && (
                <TravelPanel
                  sites={scopeSites}
                  entities={state.entities.filter((e) => scopeSites.some((x) => x.entityId === e.id))}
                  onSetTravelPay={allow('settings.manage') ? actions.setTravelPay : undefined}
                  onSetLocation={actions.setSiteLocation}
                  onRefresh={actions.refreshTravel}
                  onSetTravel={actions.setTravel}
                />
              )}
              {shown === 'rota' && single && (
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
              {shown === 'rota' && single && rotaView === 'timeline' && (
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
              {shown === 'rota' && single && rotaView === 'people' && (
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
              {shown === 'clock' && single && (
                <ClockView
                  state={state}
                  siteId={single.id}
                  today={today}
                  onSetGeofence={actions.setGeofence}
                  onSetBadge={actions.setBadge}
                  canSetFence={allow('settings.manage')}
                  canEnrolCards={allow('team.manage', single.id)}
                  demo={account?.demo}
                />
              )}
              {shown === 'demand' && single && (
                <DemandView
                  state={state}
                  siteId={single.id}
                  dates={dates}
                  onForecast={allow('demand.manage', single.id) ? (replace) => actions.forecastFromTakings([single.id], week, replace) : undefined}
                />
              )}
              {shown === 'coach' && single && <CoachView state={state} siteId={single.id} week={week} onChanged={actions.refreshShifts} />}
              {shown === 'forecast' && single && <ForecastView state={state} siteId={single.id} week={week} onChanged={actions.reload} />}
              {shown === 'calendar' && single && <CalendarView key={single.id} state={state} site={single} today={today} onChanged={actions.reload} />}
              {shown === 'programme' && <ProgrammeView state={state} siteIds={siteIds} today={today} lead={!!me?.user && allow('programme.lead')} canShare={allow('settings.manage')} onOpenSite={chooseSite} />}
              {shown === 'team' && <TeamView state={state} siteIds={siteIds} metrics={metrics} issues={issues} dates={dates} showCost={showCost} />}
              {shown === 'people' && single && (
                <PeopleView
                  state={state}
                  siteId={single.id}
                  today={today}
                  onEdit={setEditingPerson}
                  onAdd={allow('team.manage', single.id) ? () => setEditingPerson(newEmployee(single.id, single.entityId, state.roles[0].id, today)) : undefined}
                />
              )}
              {shown === 'onboarding' && (
                <OnboardingView
                  state={state}
                  siteIds={sectionSites}
                  today={today}
                  hr={hr}
                  allow={allow}
                  onEdit={setEditingPerson}
                  onOpenHr={openHr}
                  onOpenSite={(id, t) => { setSiteId(id); setTab(t); }}
                />
              )}
              {shown === 'holiday' && (
                <HolidayView
                  state={state}
                  siteIds={siteIds}
                  today={today}
                  onEdit={setEditingPerson}
                  onSetLeaveYear={allow('settings.manage') ? actions.setLeaveYearStart : undefined}
                  showCost={showCost}
                />
              )}
              {shown === 'hr' && <HrOverview state={state} siteIds={siteIds} today={today} hr={hr} onOpen={openHr} />}
              {shown === 'absence' && (
                <AbsenceView state={state} siteIds={siteIds} today={today} onOpen={openHr} onSaveAbsence={actions.saveAbsence} />
              )}
              {shown === 'training' && <TrainingView state={state} siteIds={siteIds} today={today} hr={hr} onOpen={openHr} />}
              {shown === 'reviews' && <ReviewsView state={state} siteIds={siteIds} today={today} hr={hr} onOpen={openHr} />}
              {shown === 'cases' && allow('hr.cases') && <CasesView state={state} siteIds={siteIds} today={today} hr={hr} onOpen={openHr} />}
              {shown === 'payroll' && single && <PayrollView state={state} siteId={single.id} week={week} allow={allow} simulator={!!me?.simulator} onChanged={actions.refreshShifts} onOpenGuide={openGuide} />}
              {shown === 'actuals' && single && <ActualsView state={state} siteId={single.id} week={week} asOf={today} onOpenPayroll={() => setTab('payroll')} />}
              {shown === 'tronc' && single && <TroncView state={state} siteId={single.id} week={week} asOf={today} canEdit={allow('payroll.send') || allow('pay.approve')} canRecord={(allow('time.approve', single.id) && allow('costs.view', single.id)) || allow('payroll.send') || allow('pay.approve')} />}
              {shown === 'prime' && single && <PrimeView state={state} siteId={single.id} week={week} asOf={today} />}
              {shown === 'risk' && single && <RiskView state={state} siteId={single.id} week={week} asOf={today} />}
              {shown === 'retention' && single && <RetentionView state={state} siteId={single.id} asOf={today} />}
              {shown === 'cutcall' && single && (
                <CutCallView
                  state={state}
                  site={single}
                  today={londonParts(new Date()).date}
                  now={londonParts(new Date()).minute}
                  onApply={allow('rota.edit', single.id) ? (shift) => actions.saveShift(shift, false) : undefined}
                />
              )}
              {shown === 'pay' && (
                <PayApprovalsView
                  state={state}
                  siteIds={siteIds}
                  today={today}
                  allow={allow}
                  meId={me?.user?.id}
                  meEmployeeId={me?.user?.employeeId}
                  onChanged={actions.refreshEmployee}
                />
              )}
              {shown === 'close' && <CloseView state={state} week={week} entityIds={entityIds} />}
              {shown === 'reports' && (
                <ReportsView
                  state={state}
                  siteIds={siteIds}
                  entityIds={entityIds}
                  week={week}
                  today={today}
                  onSaveSales={actions.saveSales}
                  onSalesChanged={() => void actions.refreshSales()}
                  payrollAccess={allow('payroll.view')}
                  scopeName={single ? single.name : entityId ? state.entities.find((e) => e.id === entityId)?.name ?? 'entity' : 'group'}
                />
              )}
              {shown === 'setup' && <SetupView state={state} isAdmin={allow('settings.manage')} onSaved={actions.reload} startOnTeam={continueSetup} />}
              {shown === 'integrations' && (
                <IntegrationsView state={state} account={account} canSettings={allow('settings.manage')} today={today} onOpen={setTab} />
              )}
              {shown === 'privacy' && <PrivacyView state={state} canManage={allow('privacy.manage')} today={today} onChanged={actions.reload} />}
              {shown === 'access' && <AccessView state={state} />}
              {shown === 'clients' && <ClientsView />}
              {shown === 'settings' && <SettingsView account={account} canSettings={allow('settings.manage')} onSalesChanged={() => void actions.refreshSales()} />}
              {shown === 'profile' && <ProfileView me={me} account={account} state={state} onSaved={actions.reload} />}
              {shown === 'howto' && <HowToView guideId={guide} onOpen={setGuide} />}
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
            publishRefused={canPublish ? undefined : NOT_YOURS}
            published={published}
            blocks={blocks}
            onPublish={() => void actions.publish(siteIds, week)}
            showCost={showCost}
            onForecast={siteIds.length > 0 && siteIds.every((id) => allow('demand.manage', id)) ? () => void forecastWeek() : undefined}
          />}
        </div>
      </div>

      {refusal && (
        <div className="toast refused" role="alert">
          <span>{refusal}</span>
          <button className="ghost" onClick={() => setRefusal(null)}>Close</button>
        </div>
      )}

      {notice && (
        <div className="toast" role="status">
          <span>{notice}</span>
          <button className="ghost" onClick={() => setNotice(null)}>Close</button>
        </div>
      )}

      {lastChange && (
        <div className="toast" role="status">
          <span>{describeChange(lastChange.before, lastChange.after, state)}</span>
          <button className="ghost" onClick={() => void undo(lastChange)}>Undo</button>
        </div>
      )}

      {assistantOpen && siteIds.length > 0 && (
        <Suspense fallback={null}>
          <AssistantPanel
            state={state}
            siteIds={siteIds}
            initialInstruction={assistantInstruction}
            week={week}
            onApply={async (shifts, baselines, instructions) => {
              // Close only once saved; a refused save (someone else edited the week) stays open to redraft.
              const problem = await actions.applyDraft(week, shifts, baselines, instructions);
              if (!problem) {
                setUnfilled(null);
                setAssistantOpen(false);
                setAssistantInstruction('');
              }
              return problem;
            }}
            onClose={() => { setAssistantOpen(false); setAssistantInstruction(''); }}
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
          payNeedsApproval={!!me?.user}
          onSave={async (employee, payReason) => {
            const isNew = !state.employees.some((e) => e.id === employee.id);
            const withPay = allow('pay.edit', employee.siteId) && me?.user?.employeeId !== employee.id;
            // A person's pay change is a proposal: save the rest, then send the pay to finance with its reason.
            if (withPay && me?.user && payReason !== undefined) {
              // The basis is pay too: it goes with the proposal, never ahead of it.
              const original = state.employees.find((e) => e.id === employee.id);
              const saved = await actions.saveEmployee(original ? { ...employee, payBasis: original.payBasis } : employee, isNew, false);
              if (!saved) return;
              const { payBasis, hourlyRate, annualSalary } = employee;
              if (await actions.proposePay(saved.id, { payBasis, hourlyRate, annualSalary }, payReason)) setEditingPerson(null);
              return;
            }
            if (await actions.saveEmployee(employee, isNew, withPay)) setEditingPerson(null);
          }}
          onLeaver={async (id, leaveDate) => { if (await actions.markLeaver(id, leaveDate)) setEditingPerson(null); }}
          onAddDocument={actions.addRightToWorkDocument}
          onDeleteDocument={allow('privacy.manage') ? actions.deleteRightToWorkDocument : undefined}
          onDocumentHistory={allow('privacy.manage') ? actions.rightToWorkDocumentHistory : undefined}
          onClose={() => setEditingPerson(null)}
        />
      )}

      <Suspense fallback={null}>
        <CommandBar view={agentView} deps={agentDeps} />
        <Shifty view={agentView} deps={agentDeps} />
      </Suspense>

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
