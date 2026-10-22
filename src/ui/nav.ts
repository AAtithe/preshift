// The management bar: its sections, what each is scoped by, who is offered it, and where you are
// in the address. App renders it; this file decides it.
import { weekStart } from '../engine/time';
import type { Allow } from './permissions';

export type Tab = 'sites' | 'rota' | 'clock' | 'demand' | 'team' | 'people' | 'holiday' | 'payroll' | 'close' | 'reports' | 'hr' | 'absence' | 'training' | 'reviews' | 'cases' | 'setup' | 'integrations' | 'privacy' | 'access' | 'settings' | 'howto';

/** Holds the permission at every site in scope: what an action over the scope needs. */
export type AtAll = Allow;
export type Offered = (atAll: AtAll, allow: Allow) => boolean;

// The management bar groups the work the way a GM runs the week: plan it, staff it, pay it, close it, review it.
// Every item shown is clickable, so the map never changes. A site-only item opened across several
// sites asks which site. An item is shown only to someone who can use it across the scope; the screen
// still asks the server.
// Each section says what it is scoped by, so the header only shows controls that change what is on screen:
// week sections get the scope, the week and the P&L rail; people sections get the scope; organisation
// sections get neither. Only the planning sections carry the build and clear actions.
export type Scope = 'week' | 'people' | 'org';
// title heads an organisation section; it defaults to Organisation.
export type NavItem = { id: Tab; label: string; scope: Scope; title?: string; siteOnly?: boolean; plans?: boolean; offered?: Offered };
export const NAV: { heading: string; items: NavItem[] }[] = [
  // Side by side labour cost by site: for those who see cost everywhere in scope.
  { heading: 'Overview', items: [{ id: 'sites', label: 'Sites', scope: 'week', plans: true, offered: (all) => all('costs.view') }] },
  {
    heading: 'Scheduling',
    items: [
      { id: 'rota', label: 'Rota', scope: 'week', siteOnly: true, plans: true },
      { id: 'demand', label: 'Demand', scope: 'week', siteOnly: true, plans: true },
      { id: 'clock', label: 'Clock in', scope: 'people', siteOnly: true, offered: (all) => all('time.record') },
    ],
  },
  {
    heading: 'People',
    items: [
      // Personnel files go by site, as the rest of the team's records do; cases are confidential.
      { id: 'hr', label: 'HR overview', scope: 'people', offered: (all) => all('hr.view') },
      { id: 'people', label: 'Staff', scope: 'people', siteOnly: true, offered: (all) => all('team.manage') || all('costs.view') },
      // Balances are the team's records; the provision in pounds shows only with cost.
      { id: 'holiday', label: 'Holiday', scope: 'people', offered: (all) => all('team.manage') || all('costs.view') },
      { id: 'absence', label: 'Absence', scope: 'people', offered: (all) => all('hr.view') },
      { id: 'training', label: 'Training', scope: 'people', offered: (all) => all('hr.view') },
      { id: 'reviews', label: 'Probation and reviews', scope: 'people', offered: (all) => all('hr.view') },
      { id: 'cases', label: 'Cases', scope: 'people', offered: (_all, a) => a('hr.cases') },
    ],
  },
  {
    heading: 'Finance',
    items: [
      { id: 'team', label: 'Labour cost', scope: 'week' },
      { id: 'payroll', label: 'Payroll', scope: 'week', siteOnly: true, offered: (all, a) => all('time.record') || all('time.approve') || a('payroll.view') },
      { id: 'close', label: 'Close', scope: 'week', offered: (_all, a) => a('close.export') },
    ],
  },
  // Labour cost against takings and payroll accuracy: money throughout, for those who see cost.
  { heading: 'Reporting', items: [{ id: 'reports', label: 'Reports', scope: 'week', offered: (all) => all('costs.view') }] },
  {
    heading: 'Organisation',
    items: [
      // Companies, sites, roles and the trading week the rota runs on.
      { id: 'setup', label: 'Set-up', scope: 'org', offered: (_all, a) => a('settings.manage') },
      { id: 'integrations', label: 'Integrations', scope: 'org', offered: (_all, a) => a('settings.manage') || a('payroll.view') },
      { id: 'privacy', label: 'GDPR', scope: 'org', offered: (_all, a) => a('privacy.manage') },
      { id: 'access', label: 'Access', scope: 'org', offered: (all, a) => a('users.manage') || all('users.sites') || a('audit.view') },
      // Everyone who signs in can change their own password there.
      { id: 'settings', label: 'Settings', scope: 'org' },
    ],
  },
  { heading: 'Help', items: [{ id: 'howto', label: 'How to', scope: 'org', title: 'Help' }] },
];
export const NAV_ITEMS = NAV.flatMap((g) => g.items);
export const ALL = '';

// Where you are lives in the address, so Back, refresh and a shared link all land on the same screen.
export type Place = { tab: Tab; entityId: string; siteId: string; week: string };
export function readPlace(fallbackWeek: string): Place {
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
export function placeQuery(p: Place) {
  const q = new URLSearchParams();
  if (p.tab !== 'sites') q.set('view', p.tab);
  if (p.entityId) q.set('entity', p.entityId);
  if (p.siteId) q.set('site', p.siteId);
  q.set('week', p.week);
  return `?${q}`;
}
