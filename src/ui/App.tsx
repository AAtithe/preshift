import { lazy, Suspense, useEffect, useMemo, useState, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react';
import type { UnfilledGap } from '../engine/autoschedule';
import { checkWeek } from '../engine/compliance';
import { hiddenTabs } from '../engine/features';
import { newEmployee } from '../engine/employees';
import { scopeMetrics } from '../engine/metrics';
import { formatMinute, londonParts, toISODate, weekDates, weekStart } from '../engine/time';
import type { Employee, Shift } from '../engine/types';
import type { Opening } from './assign';
import { RemindersBanner } from './CalendarView';
import { AuthenticatorBar } from './access/Authenticator';
import type { Me } from './access/model';
import { dayLabel } from './format';
import { DemoBanner, DemoPicker } from './DemoPicker';
import { OrgPicker } from './OrgPicker';
import { ScopePicker } from './ScopePicker';
import { WeekPicker } from './WeekPicker';
import type { HrSection } from './HrFile';
import { PnlRail } from './PnlRail';
import { BillingBanner } from './BillingView';
import { RestBreaches } from './RestBreaches';
import type { Account } from './SettingsView';
import { ALL, NAV_ITEMS, offered, placeQuery, readPlace, sitesFor, visibleNav, type AtAll, type NavItem, type Tab } from './nav';
import { allowFor, NOT_YOURS } from './permissions';
import type { ProposalDeps } from './proposals';
import type { AgentView } from './useAppAgent';
import { SideNav } from './SideNav';
import { useHrRecords, useRotaStore } from './store';
import { Walkthrough, WhatsNewNotice } from './Walkthrough';
import { markSeen, releasesOut, seenWeek, stepsFor, type WalkStep } from './walkthrough';

// Every screen is its own chunk, so the first paint waits on the shell alone. The section being opened
// is asked for alongside the data; the rest follow once the app is up, before anyone opens them.
const screens: { load: () => Promise<unknown>; tabs: Tab[] }[] = [];
function screen<K extends string, M extends Record<K, ComponentType<any>>>(load: () => Promise<M>, name: K, tabs: Tab[] = []): LazyExoticComponent<M[K]> {
  screens.push({ load, tabs });
  return lazy(() => load().then((m) => ({ default: m[name] })));
}
/** Fetches the chunks for one section, or for all of them; each is fetched once however often this runs. */
function prefetchScreens(tab?: Tab) {
  for (const s of screens) if (!tab || s.tabs.includes(tab)) void s.load().catch(() => undefined);
}

const AbsenceView = screen(() => import('./AbsenceView'), 'AbsenceView', ['absence']);
const AccessView = screen(() => import('./access/AccessView'), 'AccessView', ['access']);
const ActualsView = screen(() => import('./ActualsView'), 'ActualsView', ['actuals']);
const AssignPanel = screen(() => import('./AssignPanel'), 'AssignPanel');
const BillingView = screen(() => import('./BillingView'), 'BillingView', ['billing']);
const CalendarView = screen(() => import('./CalendarView'), 'CalendarView', ['calendar']);
const CasesView = screen(() => import('./ReviewsView'), 'CasesView', ['cases']);
const ClientsView = screen(() => import('./ClientsView'), 'ClientsView', ['clients']);
const CustomersView = screen(() => import('./CustomersView'), 'CustomersView', ['customers']);
const ClockView = screen(() => import('./ClockView'), 'ClockView', ['clock']);
const CloseView = screen(() => import('./CloseView'), 'CloseView', ['close']);
const CoachView = screen(() => import('./CoachView'), 'CoachView', ['coach']);
const CutCallView = screen(() => import('./CutCallView'), 'CutCallView', ['cutcall']);
const DemandView = screen(() => import('./DemandView'), 'DemandView', ['demand']);
const EmployeeEditor = screen(() => import('./EmployeeEditor'), 'EmployeeEditor');
const ForecastView = screen(() => import('./ForecastView'), 'ForecastView', ['forecast']);
const GroupView = screen(() => import('./GroupView'), 'GroupView', ['sites']);
const HolidayView = screen(() => import('./HolidayView'), 'HolidayView', ['holiday']);
const HowToView = screen(() => import('./HowToView'), 'HowToView', ['howto']);
const HrFile = screen(() => import('./HrFile'), 'HrFile');
const HrOverview = screen(() => import('./HrOverview'), 'HrOverview', ['hr']);
const IntegrationsView = screen(() => import('./IntegrationsView'), 'IntegrationsView', ['integrations']);
const OnboardingView = screen(() => import('./OnboardingView'), 'OnboardingView', ['onboarding']);
const MessagesView = screen(() => import('./MessagesView'), 'MessagesView', ['messages']);
const PayApprovalsView = screen(() => import('./PayApprovalsView'), 'PayApprovalsView', ['pay']);
const PayrollView = screen(() => import('./PayrollView'), 'PayrollView', ['payroll']);
const PayPeriodsView = screen(() => import('./PayPeriodsView'), 'PayPeriodsView', ['periods']);
const PeopleView = screen(() => import('./PeopleView'), 'PeopleView', ['people']);
const PrimeView = screen(() => import('./PrimeView'), 'PrimeView', ['prime']);
const PrivacyView = screen(() => import('./PrivacyView'), 'PrivacyView', ['privacy']);
const ProfileView = screen(() => import('./ProfileView'), 'ProfileView', ['profile']);
const ProgrammeView = screen(() => import('./ProgrammeView'), 'ProgrammeView', ['programme']);
const RequestsView = screen(() => import('./RequestsView'), 'RequestsView', ['requests']);
const AdoptionView = screen(() => import('./AdoptionView'), 'AdoptionView', ['adoption']);
const ReportsView = screen(() => import('./ReportsView'), 'ReportsView', ['reports']);
const RetentionView = screen(() => import('./RetentionView'), 'RetentionView', ['retention']);
const ReviewsView = screen(() => import('./ReviewsView'), 'ReviewsView', ['reviews']);
const PremiumsPanel = screen(() => import('./PremiumsPanel'), 'PremiumsPanel', ['pay']);
const RiskView = screen(() => import('./RiskView'), 'RiskView', ['risk']);
const RotaGrid = screen(() => import('./RotaGrid'), 'RotaGrid', ['rota']);
const ChangesView = screen(() => import('./RotaLenses'), 'ChangesView', ['rota']);
const CostView = screen(() => import('./RotaLenses'), 'CostView', ['rota']);
const CoverMap = screen(() => import('./RotaLenses'), 'CoverMap', ['rota']);
const FairnessView = screen(() => import('./RotaLenses'), 'FairnessView', ['rota']);
const RestView = screen(() => import('./RotaLenses'), 'RestView', ['rota']);
const StationView = screen(() => import('./RotaLenses'), 'StationView', ['rota']);
const SettingsView = screen(() => import('./SettingsView'), 'SettingsView', ['settings']);
const SetupView = screen(() => import('./SetupView'), 'SetupView', ['setup']);
const ShiftEditor = screen(() => import('./ShiftEditor'), 'ShiftEditor');
const SupportView = screen(() => import('./SupportView'), 'SupportView', ['support']);
const TeamView = screen(() => import('./TeamView'), 'TeamView', ['team']);
const Timeline = screen(() => import('./Timeline'), 'Timeline', ['rota']);
const TrainingView = screen(() => import('./TrainingView'), 'TrainingView', ['training']);
const TravelPanel = screen(() => import('./TravelPanel'), 'TravelPanel', ['sites']);
const TroncView = screen(() => import('./TroncView'), 'TroncView', ['tronc']);
const WelfareView = screen(() => import('./WelfareView'), 'WelfareView', ['welfare']);
const FeaturesView = screen(() => import('./FeaturesView'), 'FeaturesView', ['features']);
const EmploymentRightsView = screen(() => import('./EmploymentRightsView'), 'EmploymentRightsView', ['rights']);
const CashView = screen(() => import('./CashView'), 'CashView', ['cash']);

// Loaded on first use so the Claude SDK stays out of the main bundle.
const AssistantPanel = lazy(() => import('./AssistantPanel').then((m) => ({ default: m.AssistantPanel })));
const Shifty = lazy(() => import('./Shifty').then((m) => ({ default: m.Shifty })));
const CommandBar = lazy(() => import('./CommandBar').then((m) => ({ default: m.CommandBar })));

type RotaView = 'timeline' | 'people' | 'cover' | 'rest' | 'stations' | 'cost' | 'changes' | 'fairness';
const VIEW_KEY = 'preshift.rota.view';

/** Every way of looking at the week, with what each is for. Cost is offered only to those who may see pay. */
const ROTA_VIEWS: { id: RotaView; label: string; help: string; cost?: boolean }[] = [
  { id: 'timeline', label: 'Service timeline', help: 'Each day over its sales curve, with hours short or over in the strip beneath. Drag a bar to move it or its ends to change the hours. Drag across a day, or click a red hour, to add a shift.' },
  { id: 'people', label: 'By person', help: 'Every person across the week. Drag a shift to another person or day.' },
  { id: 'cover', label: 'Cover map', help: 'The whole week against demand in one grid: where to add or cut the next hour. Click a short hour to fill it.' },
  { id: 'rest', label: 'Rest', help: 'Last week and this as one line per person, so a close before an open, or a long run of days, shows before it becomes a breach.' },
  { id: 'stations', label: 'Positions', help: 'One day by position: who is on the bar, the pass, the door, hour by hour, and where a needed position is empty.' },
  { id: 'cost', label: 'Shift cost', help: 'Each shift at its loaded cost against the day target: which shift to cut when labour runs over.', cost: true },
  { id: 'changes', label: 'Changes', help: 'Who the next publish will tell, and what, before anyone is told.' },
  { id: 'fairness', label: 'Fairness', help: 'Four weeks of weekends, closes, late finishes and hours under contract: who keeps getting the hard shifts.' },
];

function savedView(): RotaView {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return ROTA_VIEWS.find((x) => x.id === v)?.id ?? 'timeline';
  } catch {
    return 'timeline';
  }
}


export function App() {
  const { state, me, error, setError, actions } = useRotaStore();
  // Set when the first save of set-up gives the organisation its first site: the workspace then
  // opens on set-up's team step instead of dropping the person on an empty overview.
  const [continueSetup, setContinueSetup] = useState(false);
  useEffect(() => prefetchScreens(readPlace('').tab), []);
  const loaded = state !== null;
  useEffect(() => {
    if (!loaded) return;
    const later = window.requestIdleCallback ?? ((fn: () => void) => window.setTimeout(fn, 500));
    later(() => prefetchScreens());
  }, [loaded]);
  if (!state) {
    return (
      <Splash>
        {error && (
          <>
            <p className="splash-error" role="alert">Cannot reach Preshift: {error}</p>
            <button className="primary" onClick={() => void actions.reload()}>Try again</button>
          </>
        )}
      </Splash>
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
        <Suspense fallback={<ScreenLoading />}>
          <SetupView state={state} isAdmin onSaved={async () => { setContinueSetup(true); await actions.reload(); }} />
        </Suspense>
        <p className="small muted"><a className="link" href="/auth/logout">Sign out</a></p>
      </div>
    );
  }
  if (state.sites.length === 0) {
    return (
      <div className="shell">
        <DemoBanner me={me} />
        <p className="muted">Your roles do not reach any site yet. Ask whoever manages access to grant you one.</p>
        <div className="demo-standalone"><DemoPicker me={me} /></div>
      </div>
    );
  }
  return (
    <Suspense fallback={<Splash />}>
      <Workspace state={state} me={me} error={error} setError={setError} actions={actions} continueSetup={continueSetup} />
    </Suspense>
  );
}

/**
 * The opening screen, drawn the same as the one in index.html so the hand-over from the page to
 * the app is seamless. With children (a failed load) the progress bar gives way to them.
 */
function Splash({ children }: { children?: ReactNode }) {
  return (
    <div className="splash" aria-busy={!children} aria-live="polite">
      <div className="splash-mark" aria-hidden="true">
        <svg viewBox="0 0 32 32"><rect width="32" height="32" rx="8" /><path d="M11 23V9h6.2a4.6 4.6 0 0 1 0 9.2H11" /></svg>
      </div>
      <div className="splash-word">Preshift<span>with Williams, Stanley &amp; Co.</span></div>
      {children ?? <div className="splash-bar" role="progressbar" aria-label="Loading Preshift"><span /></div>}
    </div>
  );
}

/** Held in place of a screen for the moment its chunk is still arriving. */
function ScreenLoading() {
  return <div className="screen-loading" role="progressbar" aria-label="Loading"><span /></div>;
}

type Store = ReturnType<typeof useRotaStore>;

function Workspace({ state, me, error, setError, actions, continueSetup }: { state: NonNullable<Store['state']>; me: Me | null; error: string | null; setError: Store['setError']; actions: Store['actions']; continueSetup: boolean }) {
  // Scope: an entity (or the whole group), then one site or all of that entity's sites.
  const [initial] = useState(() => readPlace(weekStart(toISODate(new Date()))));
  const [entityId, setEntityId] = useState(state.entities.some((e) => e.id === initial.entityId) ? initial.entityId : ALL);
  const [siteId, setSiteId] = useState(state.sites.some((s) => s.id === initial.siteId) ? initial.siteId : ALL);
  const [week, setWeek] = useState(initial.week);
  const [tab, setTab] = useState<Tab>(continueSetup ? 'setup' : initial.tab);
  // A shift sent from the editor to ask cover for, opened on Messages.
  const [coverShift, setCoverShift] = useState<string | null>(null);
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
  // Sections of features the organisation has switched off are offered to nobody, so they leave the bar,
  // the address, Go to and the walkthrough alike.
  const hidden = useMemo(() => hiddenTabs(me?.featuresOff), [me?.featuresOff]);
  const nav = visibleNav(allow, allSiteIds, me?.user?.audience, hidden);
  const fallback = nav[0]?.items[0]?.id ?? 'profile';
  const activeTab = NAV_ITEMS.some((t) => t.id === tab && offered(t, allow, allSiteIds, me?.user?.audience, hidden)) ? tab : fallback;
  const section = NAV_ITEMS.find((t) => t.id === activeTab)!;
  const offeredTab = (t: Tab) => NAV_ITEMS.some((i) => i.id === t && offered(i, allow, allSiteIds, me?.user?.audience, hidden));

  // What's new: this week's release is offered once to each person, and can be walked again from the bar.
  const released = useMemo(() => releasesOut(today), [today]);
  const release = released[0];
  const seenBy = me?.user?.id ?? 'you';
  const [walking, setWalking] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const newSteps = release ? stepsFor(release, offeredTab).length : 0;
  const unseen = !!release && !dismissed && newSteps > 0 && seenWeek(seenBy) !== release.week;
  function finishWalk() {
    setWalking(false);
    setDismissed(true);
    if (release) markSeen(seenBy, release.week);
  }
  function walkTo(step: WalkStep) {
    const item = NAV_ITEMS.find((i) => i.id === step.tab);
    if (!item) return;
    // A site-only screen opens at the first site the person is offered it at, rather than asking.
    if (item.siteOnly && !single) {
      const first = sitesFor(item, allow, allSiteIds)[0];
      if (first) setSiteId(first);
    }
    if (step.lens) chooseView(step.lens);
    setTab(item.id);
  }
  // Within the scope, the section reaches only the sites it is offered at.
  const sectionSites = sitesFor(section, allow, siteIds);
  const notHere = section.access !== 'everyone' && !offered(section, allow, siteIds, me?.user?.audience, hidden);
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

  // Changing scope keeps you in the section you are in. Only the Sites overview drops into a site's rota.
  function chooseScope(entity: string, id: string) {
    setEntityId(entity);
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

  const views = ROTA_VIEWS.filter((v) => !v.cost || showCost);
  // A saved choice of a view this person is not offered falls back to the timeline.
  const shownView = views.some((v) => v.id === rotaView) ? rotaView : 'timeline';

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
        <OrgPicker account={account} />
        <DemoPicker me={me} />
        <SideNav groups={nav} active={activeTab} onOpen={openSection} />
        <div className="side-foot">
          {released.length > 0 && <button className="link" onClick={() => setWalking(true)}>What's new</button>}
          <a className="link" href="/docs" target="_blank" rel="noreferrer">API docs</a>
          {account && !account.demo && (
            <>
              <a className="link" href="/oauth/connections" title="Claude and other apps you have let act as you, with a disconnect button">Connected apps</a>
              <button className="link small" onClick={() => setTab('profile')} title="Your profile">Signed in as {me?.user?.name ?? account.email}</button>
              <a className="link" href="/auth/logout">Sign out</a>
            </>
          )}
        </div>
      </aside>

      <div className="content">
        <DemoBanner me={me} />
        <header className="mast">
          <div className="mast-top">
            <span className="eyebrow">{section.label}</span>
          </div>
          <div className="mast-title">
            {section.scope === 'org'
              ? <h1>{scopeName}</h1>
              : <ScopePicker entities={state.entities} sites={state.sites} entityId={entityId} siteId={site?.id ?? ALL} onChoose={chooseScope} />}
            {section.scope === 'week' && (
              <div className="mast-meta">
                <WeekPicker week={week} onChange={setWeek} />
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
            {activeTab !== 'billing' && <BillingBanner billing={account?.billing} canSettings={allow('settings.manage')} onOpen={() => setTab('billing')} />}
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

            {unseen && !walking && activeTab !== 'setup' && (
              <WhatsNewNotice count={newSteps} onStart={() => setWalking(true)} onDismiss={finishWalk} />
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
              <Suspense fallback={<ScreenLoading />}>
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
                  <div className="toggle rota-views" role="tablist" aria-label="Rota view">
                    {views.map((v) => (
                      <button key={v.id} role="tab" aria-selected={shownView === v.id} className={shownView === v.id ? 'active' : ''} onClick={() => chooseView(v.id)}>
                        {v.label}
                      </button>
                    ))}
                  </div>
                  <span className="muted small">{views.find((v) => v.id === shownView)?.help}</span>
                </div>
              )}
              {shown === 'rota' && single && shownView === 'cover' && (
                <CoverMap state={view} site={single} dates={dates} onOpen={canEdit ? setOpening : undefined} />
              )}
              {shown === 'rota' && single && shownView === 'rest' && <RestView state={view} site={single} week={week} />}
              {shown === 'rota' && single && shownView === 'stations' && <StationView state={view} site={single} dates={dates} />}
              {shown === 'rota' && single && shownView === 'cost' && <CostView state={view} site={single} dates={dates} metrics={metrics} />}
              {shown === 'rota' && single && shownView === 'changes' && <ChangesView state={state} site={single} week={week} />}
              {shown === 'rota' && single && shownView === 'fairness' && <FairnessView state={view} site={single} week={week} />}
              {shown === 'rota' && single && shownView === 'timeline' && (
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
              {shown === 'rota' && single && shownView === 'people' && (
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
              {shown === 'cash' && <CashView canSettings={allow('settings.manage')} />}
              {shown === 'programme' && <ProgrammeView state={state} siteIds={siteIds} today={today} lead={!!me?.user && allow('programme.lead')} canShare={allow('settings.manage')} onOpenSite={(id) => chooseScope(entityId, id)} />}
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
              {shown === 'messages' && (
                <MessagesView
                  state={state}
                  siteIds={sectionSites}
                  canAnnounce={(id) => allow('rota.publish', id)}
                  openThread={new URLSearchParams(window.location.search).get('thread') ?? undefined}
                />
              )}
              {shown === 'welfare' && <WelfareView key={sectionSites.join(',')} state={state} siteIds={sectionSites} today={today} allow={allow} onOpenHr={openHr} />}
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
              {shown === 'adoption' && <AdoptionView state={state} siteIds={siteIds} />}
              {shown === 'requests' && <RequestsView key={coverShift ?? 'requests'} state={state} siteIds={siteIds} today={today} allow={allow} onChanged={actions.reload} coverShiftId={coverShift ?? undefined} />}
              {shown === 'hr' && <HrOverview state={state} siteIds={siteIds} today={today} hr={hr} onOpen={openHr} />}
              {shown === 'absence' && (
                <AbsenceView state={state} siteIds={siteIds} today={today} onOpen={openHr} onSaveAbsence={actions.saveAbsence} />
              )}
              {shown === 'training' && <TrainingView state={state} siteIds={siteIds} today={today} hr={hr} onOpen={openHr} />}
              {shown === 'reviews' && <ReviewsView state={state} siteIds={siteIds} today={today} hr={hr} onOpen={openHr} />}
              {shown === 'cases' && allow('hr.cases') && <CasesView state={state} siteIds={siteIds} today={today} hr={hr} onOpen={openHr} />}
              {shown === 'payroll' && single && <PayrollView state={state} siteId={single.id} week={week} allow={allow} simulator={!!me?.simulator} onChanged={actions.refreshShifts} onOpenGuide={openGuide} />}
              {shown === 'periods' && <PayPeriodsView state={state} today={today} allow={allow} onChanged={actions.refreshShifts} />}
              {shown === 'actuals' && single && <ActualsView state={state} siteId={single.id} week={week} asOf={today} onOpenPayroll={() => setTab('payroll')} />}
              {shown === 'tronc' && single && <TroncView state={state} siteId={single.id} week={week} asOf={today} canEdit={allow('payroll.send') || allow('pay.approve')} canRecord={(allow('time.approve', single.id) && allow('costs.view', single.id)) || allow('payroll.send') || allow('pay.approve')} />}
              {shown === 'prime' && single && <PrimeView state={state} siteId={single.id} week={week} asOf={today} />}
              {shown === 'risk' && single && <RiskView state={state} siteId={single.id} week={week} asOf={today} />}
              {shown === 'retention' && single && <RetentionView state={state} siteId={single.id} asOf={today} />}
              {shown === 'rights' && single && (
                <EmploymentRightsView state={state} siteId={single.id} showCost={allow('costs.view', single.id)} onChanged={() => void actions.reload()} />
              )}
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
              {shown === 'pay' && (
                <PremiumsPanel
                  entities={state.entities.filter((e) => entityIds.includes(e.id))}
                  roles={state.roles}
                  onSave={allow('pay.approve') ? actions.setPremiums : undefined}
                />
              )}
              {shown === 'close' && <CloseView state={state} week={week} entityIds={entityIds} canSettings={allow('settings.manage')} />}
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
              {shown === 'customers' && <CustomersView />}
              {shown === 'billing' && <BillingView canSettings={allow('settings.manage')} />}
              {shown === 'features' && <FeaturesView state={state} onChanged={actions.reload} onOpen={setTab} />}
              {shown === 'settings' && <SettingsView account={account} canSettings={allow('settings.manage')} sites={state.sites} onSalesChanged={() => void actions.refreshSales()} />}
              {shown === 'profile' && <ProfileView me={me} account={account} state={state} onSaved={actions.reload} />}
              {shown === 'howto' && <HowToView guideId={guide} onOpen={setGuide} />}
              {shown === 'support' && <SupportView me={me?.user?.name ?? null} context={{ siteId: single?.id, week }} onOpen={(t) => setTab(t as Tab)} />}
              </Suspense>
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

      <Suspense fallback={null}>
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
          onSave={async (employee, payReason, payFrom) => {
            const isNew = !state.employees.some((e) => e.id === employee.id);
            const withPay = allow('pay.edit', employee.siteId) && me?.user?.employeeId !== employee.id;
            // A person's pay change is a proposal: save the rest, then send the pay to finance with its reason.
            if (withPay && me?.user && payReason !== undefined) {
              // The basis is pay too: it goes with the proposal, never ahead of it.
              const original = state.employees.find((e) => e.id === employee.id);
              const saved = await actions.saveEmployee(original ? { ...employee, payBasis: original.payBasis } : employee, isNew, false);
              if (!saved) return;
              const { payBasis, hourlyRate, annualSalary } = employee;
              if (await actions.proposePay(saved.id, { payBasis, hourlyRate, annualSalary }, payReason, payFrom)) setEditingPerson(null);
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

      {walking && released.length > 0 && <Walkthrough releases={released} offeredTab={offeredTab} onGo={walkTo} onClose={finishWalk} />}

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
          onAskCover={allow('rota.publish', editing.siteId) ? (id) => { setEditing(null); setCoverShift(id); setSiteId(editing.siteId); setTab('requests'); } : undefined}
        />
      )}
      </Suspense>
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

