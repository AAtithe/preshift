// The parts of Preshift an organisation can switch off. Shared by the API, which keeps the list an
// organisation has switched off and refuses an unknown or core one, and the browser, which hides
// the sections behind a switched-off feature from everyone.
//
// A switch is a product choice, not access control. Turning a feature off takes its sections out of
// the bar for every person in the organisation, whatever their roles; turning it on gives them back
// to whoever their roles already offer them to. Nothing is deleted either way, and nobody gains a
// right they did not hold.

export type FeatureGroup = 'Overview' | 'Planning' | 'Hours and pay' | 'People' | 'Finance';

export interface FeatureDef {
  id: string;
  label: string;
  group: FeatureGroup;
  /** What it does, in a sentence an owner can decide on. */
  about: string;
  /** The sections of the management bar it hides when off. Kept in step with Tab in src/ui/nav.ts. */
  tabs: string[];
  /** What a team loses when it is off, said on the switch so nobody turns off more than they meant. */
  offMeans?: string;
}

export const FEATURES: FeatureDef[] = [
  {
    id: 'adoption', label: 'Staff app adoption', group: 'Overview', tabs: ['adoption'],
    about: "Whether each site's team is on the staff app, hears about changes and gets answers.",
  },
  {
    id: 'requests', label: 'Staff requests', group: 'Planning', tabs: ['requests'],
    about: 'Holiday, time off, sickness, availability, swaps and open shifts asked for in the staff app, decided in one queue.',
    offMeans: 'Managers lose the queue. Requests already made stay on record.',
  },
  {
    id: 'forecast', label: 'Sales forecast', group: 'Planning', tabs: ['forecast'],
    about: 'The week ahead forecast from past takings, by day and hour, that the rota is built against.',
    offMeans: 'Demand and the rota keep the forecast already saved; nobody can review or change it here.',
  },
  {
    id: 'calendar', label: 'Calendar', group: 'Planning', tabs: ['calendar'],
    about: 'Occasions, weather, local events, bookings and school holidays ahead, with what the forecast allows for.',
  },
  {
    id: 'rotaai', label: 'AI rota writing', group: 'Planning', tabs: [],
    about: 'The rota assistant drafts or reshapes a week from a request, and Claude can build one through the Preshift connector.',
    offMeans: 'Managers write the rota themselves. Build from forecast and single shift changes still work; no AI draft can be saved.',
  },
  {
    id: 'coach', label: 'Coach', group: 'Planning', tabs: ['coach'],
    about: 'The three moves a week that would bring labour back to target, each one a change to the rota.',
  },
  {
    id: 'cutcall', label: 'Cut call', group: 'Hours and pay', tabs: ['cutcall'],
    about: "Today's trading pace against the rota: who to send home, and what it saves on the week.",
  },
  {
    id: 'actuals', label: 'Clocked vs rota', group: 'Hours and pay', tabs: ['actuals'],
    about: 'Clocked hours against the rota by cause, before they are approved, and the week\'s labour flash.',
  },
  {
    id: 'tronc', label: 'Tronc', group: 'Hours and pay', tabs: ['tronc'],
    about: 'Tips and service charge shared out by the tronc run, ready for payroll.',
    offMeans: 'Only for a business that does not run a tronc through Preshift. Tips law still applies.',
  },
  {
    id: 'pay', label: 'Pay approvals', group: 'Hours and pay', tabs: ['pay'],
    about: 'Pay rate changes proposed by whoever sets pay and decided by finance, with premiums.',
    offMeans: 'Proposals still need approving before they take effect; finance loses the screen to approve them on.',
  },
  {
    id: 'hr', label: 'HR files', group: 'People', tabs: ['hr', 'absence', 'training', 'reviews', 'cases'],
    about: 'Personnel files, absence, training, probation and reviews, and confidential cases.',
    offMeans: 'Hides HR overview, Absence, Training, Probation and reviews, and Cases. Records are kept for retention as before.',
  },
  {
    id: 'messages', label: 'Messages', group: 'People', tabs: ['messages'],
    about: 'One thread per person, announcements and rota notices, with the team on the staff app.',
    offMeans: 'Managers lose the inbox and announcements here. Messages already sent stay on record.',
  },
  {
    id: 'onboarding', label: 'Onboarding', group: 'People', tabs: ['onboarding'],
    about: "Each new person's first weeks as one checklist: the legal steps before day one, the rest after.",
  },
  {
    id: 'welfare', label: 'Wellbeing', group: 'People', tabs: ['welfare'],
    about: 'Who needs a conversation, a safe way home, recognition, the team pulse and Hospitality Rewards.',
  },
  {
    id: 'holiday', label: 'Holiday', group: 'People', tabs: ['holiday'],
    about: 'Holiday balances and the holiday pay provision.',
    offMeans: 'Balances still accrue and requests still draw on them; nobody sees them here.',
  },
  {
    id: 'retention', label: 'Retention', group: 'People', tabs: ['retention'],
    about: 'Who may leave, read from clocked hours, and what replacing them costs.',
  },
  {
    id: 'rights', label: 'Employment rights', group: 'People', tabs: ['rights'],
    about: 'Employment Rights Act: short notice pay owed, guaranteed hours offers, and the settings they run on.',
    offMeans: 'The law applies whether the screen is on or not.',
  },
  {
    id: 'reports', label: 'Reports', group: 'Finance', tabs: ['reports'],
    about: 'GM scorecards, labour against takings and payroll accuracy, by site and week.',
  },
  {
    id: 'programme', label: 'Labour programme', group: 'Finance', tabs: ['programme'],
    about: 'The labour programme with your accounting partner: the ladder, milestones, the verified saving and benchmarks.',
  },
  {
    id: 'prime', label: 'Prime cost', group: 'Finance', tabs: ['prime'],
    about: 'Labour and cost of sales together against takings for a site, from dish sales, invoices and the weekly stock count, with menu engineering.',
  },
  {
    id: 'risk', label: 'Compliance risk', group: 'Finance', tabs: ['risk'],
    about: 'Minimum wage, right to work, Working Time and tips, priced as a regulator would.',
  },
  {
    id: 'cash', label: 'Labour cash', group: 'Finance', tabs: ['cash'],
    about: 'Net pay, HMRC and pensions by date and company.',
  },
  {
    id: 'close', label: 'Close', group: 'Finance', tabs: ['close'],
    about: 'The labour accrual journal for the month-end close, ready to post.',
    offMeans: 'Only where labour is accrued another way. Your accounting partner runs the 3-day close from this.',
  },
];

/**
 * Sections that are never switched off: the rota itself and what runs it, pay, and what an owner
 * needs to stay in control of the organisation and meet the law (access, GDPR, set-up, billing).
 */
export const CORE_TABS = [
  'sites', 'rota', 'demand', 'clock', 'payroll', 'periods', 'people', 'team', 'setup', 'access', 'integrations', 'privacy', 'settings',
  'features', 'billing', 'clients', 'customers', 'profile', 'howto', 'support',
];

export const FEATURE_IDS = FEATURES.map((f) => f.id);
const byId = new Map(FEATURES.map((f) => [f.id, f]));
export const featureOf = (id: string) => byId.get(id);

/** Whether the organisation has the feature on. Everything is on until an owner switches it off. */
export const featureOn = (off: readonly string[] | undefined, id: string) => !(off ?? []).includes(id);

/** The sections hidden by the features switched off. */
export function hiddenTabs(off: readonly string[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const id of off ?? []) featureOf(id)?.tabs.forEach((t) => out.add(t));
  return out;
}

/** The list as saved: known features only, each once, in catalogue order. Unknown ids are reported, not kept. */
export function normaliseOff(ids: readonly string[]): { off: string[]; unknown: string[] } {
  const asked = new Set(ids);
  return { off: FEATURE_IDS.filter((id) => asked.has(id)), unknown: [...asked].filter((id) => !byId.has(id)) };
}
