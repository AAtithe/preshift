// The management bar: its sections, what each is scoped by, who is offered it, and where you are
// in the address. App renders it; this file decides it.
import { weekStart } from '../engine/time';
import type { Audience, Permission } from '../engine/access';
import type { Allow } from './permissions';

export type Tab = 'sites' | 'rota' | 'coach' | 'forecast' | 'calendar' | 'programme' | 'clock' | 'demand' | 'team' | 'people' | 'holiday' | 'payroll' | 'pay' | 'close' | 'reports' | 'hr' | 'absence' | 'training' | 'reviews' | 'cases' | 'setup' | 'integrations' | 'privacy' | 'access' | 'settings' | 'profile' | 'howto' | 'onboarding' | 'clients' | 'billing' | 'requests';

/** Holds the permission at every site in scope: what an action over the scope needs. */
export type AtAll = Allow;

/**
 * Who is offered a section. Every section must say: there is no default, so a new section cannot
 * appear to everyone by omission. `scope` permissions go site by site: the section shows if one is
 * held at any site in scope, and only at those sites (the site chooser offers no others, and the API
 * sends no others). `org` permissions count wherever they are held. Holding any one listed
 * permission is enough. 'everyone' is for what every signed-in person needs. `audience` narrows a
 * section to one side as well: Clients is for Williams, Stanley & Co. people only.
 */
export type Access = 'everyone' | { scope?: Permission[]; org?: Permission[]; audience?: Audience };

// The management bar groups the work the way a GM runs the week: plan it, run the hours and pay,
// look after the team, then the money and the organisation behind it. Groups collapse; the one you
// are in stays open.
// Every item shown is clickable, so the map never changes. A site-only item opened across several
// sites asks which site. An item is shown only to someone it is offered to; the API still decides
// what they get, so hiding an item is a courtesy, not the control.
// Each section says what it is scoped by, so the header only shows controls that change what is on screen:
// week sections get the scope, the week and the P&L rail; people sections get the scope; organisation
// sections get neither. Only the planning sections carry the build and clear actions.
export type Scope = 'week' | 'people' | 'org';
// title heads an organisation section; it defaults to Organisation.
export type NavItem = { id: Tab; label: string; scope: Scope; access: Access; title?: string; siteOnly?: boolean; plans?: boolean };
export type NavGroup = { id: string; heading: string; items: NavItem[] };

export const NAV: NavGroup[] = [
  {
    id: 'overview',
    heading: 'Overview',
    // Side by side labour cost by site: for those who see cost everywhere in scope.
    items: [{ id: 'sites', label: 'Sites', scope: 'week', plans: true, access: { scope: ['costs.view'] } }],
  },
  {
    id: 'planning',
    heading: 'Planning',
    items: [
      { id: 'rota', label: 'Rota', scope: 'week', siteOnly: true, plans: true, access: { scope: ['rota.view'] } },
      // What staff ask for in the staff app: holiday, time off, sickness, availability, swaps and open shifts.
      { id: 'requests', label: 'Staff requests', scope: 'people', access: { scope: ['rota.publish', 'team.manage', 'hr.manage'] } },
      // Takings drive the forecast, so it is for those who plan from it or see the money.
      { id: 'forecast', label: 'Forecast', scope: 'week', siteOnly: true, access: { scope: ['demand.manage', 'costs.view'] } },
      { id: 'demand', label: 'Demand', scope: 'week', siteOnly: true, plans: true, access: { scope: ['demand.manage', 'costs.view'] } },
      // Occasions, weather, events, bookings and school holidays ahead, with what the forecast allows for.
      { id: 'calendar', label: 'Calendar', scope: 'people', siteOnly: true, access: { scope: ['rota.view'] } },
      // The three moves a week: each one changes the rota.
      { id: 'coach', label: 'Coach', scope: 'week', siteOnly: true, access: { scope: ['rota.edit'] } },
    ],
  },
  {
    id: 'hours',
    heading: 'Hours and pay',
    items: [
      { id: 'clock', label: 'Clock in', scope: 'people', siteOnly: true, access: { scope: ['time.record'] } },
      { id: 'payroll', label: 'Payroll', scope: 'week', siteOnly: true, access: { scope: ['time.record', 'time.approve'], org: ['payroll.view'] } },
      // Proposals from whoever sets pay, decided by finance.
      { id: 'pay', label: 'Pay approvals', scope: 'people', access: { org: ['pay.approve', 'pay.edit'] } },
    ],
  },
  {
    id: 'people',
    heading: 'People',
    items: [
      // Personnel files go by site, as the rest of the team's records do; cases are confidential.
      { id: 'hr', label: 'HR overview', scope: 'people', access: { scope: ['hr.view'] } },
      { id: 'people', label: 'Staff', scope: 'people', siteOnly: true, access: { scope: ['team.manage', 'costs.view'] } },
      // Each new person's first weeks as one checklist: legal steps before day one, the rest after.
      { id: 'onboarding', label: 'Onboarding', scope: 'people', access: { scope: ['team.manage', 'hr.view'] } },
      // Balances are the team's records; the provision in pounds shows only with cost.
      { id: 'holiday', label: 'Holiday', scope: 'people', access: { scope: ['team.manage', 'costs.view'] } },
      { id: 'absence', label: 'Absence', scope: 'people', access: { scope: ['hr.view'] } },
      { id: 'training', label: 'Training', scope: 'people', access: { scope: ['hr.view'] } },
      { id: 'reviews', label: 'Probation and reviews', scope: 'people', access: { scope: ['hr.view'] } },
      { id: 'cases', label: 'Cases', scope: 'people', access: { org: ['hr.cases'] } },
    ],
  },
  {
    id: 'finance',
    heading: 'Finance',
    // Money throughout: for those who see cost.
    items: [
      { id: 'team', label: 'Labour cost', scope: 'week', access: { scope: ['costs.view'] } },
      { id: 'close', label: 'Close', scope: 'week', access: { org: ['close.export'] } },
      // Labour cost against takings and payroll accuracy.
      { id: 'reports', label: 'Reports', scope: 'week', access: { scope: ['costs.view'] } },
      // The labour programme: the ladder, milestones and the verified saving, in money.
      { id: 'programme', label: 'Programme', scope: 'week', access: { scope: ['costs.view'] } },
    ],
  },
  {
    id: 'organisation',
    heading: 'Organisation',
    items: [
      // Companies, sites, roles and the trading week the rota runs on.
      { id: 'setup', label: 'Set-up', scope: 'org', access: { org: ['settings.manage'] } },
      { id: 'access', label: 'Access', scope: 'org', access: { scope: ['users.sites'], org: ['users.manage', 'audit.view'] } },
      { id: 'integrations', label: 'Integrations', scope: 'org', access: { org: ['settings.manage', 'payroll.view'] } },
      { id: 'privacy', label: 'GDPR', scope: 'org', access: { org: ['privacy.manage'] } },
      // Every client they hold a role in, and adding a new one. The API lists only the caller's own.
      { id: 'clients', label: 'Clients', scope: 'org', title: 'Williams, Stanley & Co.', access: { org: ['costs.view'], audience: 'ws' } },
      { id: 'settings', label: 'Settings', scope: 'org', access: { org: ['settings.manage'] } },
      // The trial, the subscription and the sites paid for. Paying is a settings decision.
      { id: 'billing', label: 'Billing', scope: 'org', access: { org: ['settings.manage'] } },
    ],
  },
  // Everyone who signs in keeps their own details, password and authenticator here.
  { id: 'you', heading: 'You', items: [{ id: 'profile', label: 'Your profile', scope: 'org', title: 'You', access: 'everyone' }] },
  { id: 'help', heading: 'Help', items: [{ id: 'howto', label: 'How to', scope: 'org', title: 'Help', access: 'everyone' }] },
];
export const NAV_ITEMS = NAV.flatMap((g) => g.items);
export const ALL = '';

/** The sites, of those given, where the person is offered the section. */
export function sitesFor(item: NavItem, allow: Allow, siteIds: string[]): string[] {
  if (item.access === 'everyone') return siteIds;
  const { scope = [], org = [] } = item.access;
  return siteIds.filter((s) => scope.some((p) => allow(p, s)) || org.some((p) => allow(p, s)));
}

/** Whether the person is offered the section anywhere in scope. `audience` is the side they are on, if they have a record. */
export function offered(item: NavItem, allow: Allow, siteIds: string[], audience?: Audience): boolean {
  if (item.access === 'everyone') return true;
  const { org = [] } = item.access;
  if (item.access.audience && item.access.audience !== audience) return false;
  return org.some((p) => allow(p)) || sitesFor(item, allow, siteIds).length > 0;
}

/** The bar as this person sees it: only what they are offered, and no empty groups. */
export function visibleNav(allow: Allow, siteIds: string[], audience?: Audience): NavGroup[] {
  return NAV.map((g) => ({ ...g, items: g.items.filter((t) => offered(t, allow, siteIds, audience)) })).filter((g) => g.items.length > 0);
}

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
