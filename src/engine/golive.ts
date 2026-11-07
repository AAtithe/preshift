// Go-live: the path a new customer walks from sign-up to running their week on Preshift, as one plan.
//
// Every step is proved by the customer's own data, never ticked by hand, so the plan cannot say a
// business is live when it is not. Each step has a day it is due by, counted from the day the
// organisation started, so the plan reads as a programme with a pace, not a to-do list: a self
// sign-up has a 14 day trial, and by the end of it the owner should have published a rota, seen
// takings come in against it, and decided to subscribe.
//
// The same plan is read three ways: by the owner on Getting started, by Shifty when asked "what do I
// do next", and by the morning nudge that emails the owner when a step has gone late. Counts only:
// nothing here names a member of staff or carries pay.

export type GoLivePhase = 'secure' | 'business' | 'team' | 'rota' | 'run' | 'commit';

/** Where the business is with paying for Preshift, as the plan needs to know it. */
export type GoLiveBilling = 'trial' | 'paying' | 'engagement' | 'lapsed';

/** What the plan is worked from. Counts and flags only. */
export interface GoLiveFacts {
  /** The London date the organisation started: sign-up, or the first thing on its audit trail. */
  startedOn: string;
  today: string;
  billing: GoLiveBilling;
  /** The last day of a free trial, where there is one. */
  trialEndsOn: string | null;
  /** The owner has an authenticator set up and confirmed. */
  ownerAuthenticator: boolean;
  /** Still showing the sample group rather than the business's own. */
  sample: boolean;
  companies: number;
  /** Companies with both a company number and a PAYE reference. */
  companiesComplete: number;
  sites: number;
  /** Sites with a loaded labour target above nought. */
  sitesWithTarget: number;
  /** Sites with a typical trading week entered, so the forecast and the build have something to work from. */
  sitesWithTradingWeek: number;
  roles: number;
  /** Staffing rules: covers or sales per person per hour, by role and site. */
  staffingRules: number;
  /** Current people, leavers and anonymised records left out. */
  people: number;
  /** Current people with something that stops them being rostered: no right to work check, pay below the legal minimum, no date of birth. */
  peopleBlocked: number;
  /** Current people already working before go-live (no start date, or one before today): their holiday position must be carried in. */
  holidayDue: number;
  /** Of those, the ones with an opening holiday position recorded: carried over, accrued or taken before Preshift. */
  holidayOpened: number;
  /** Current people with a right to work check recorded, and of those, how many have a copy of the documents held. */
  rtwChecked: number;
  rtwCopies: number;
  /** Current people with a written statement recorded as issued (a day one right). */
  statementsIssued: number;
  /** Current people whose roles require training, and of those, how many hold all of it in date. */
  trainingNeeded: number;
  trainingHeld: number;
  /** Other people with a manager's sign-in, active or invited. */
  managers: number;
  emailReady: boolean;
  /** Current people with an active staff app login. */
  onStaffApp: number;
  /** Shifts in this week or later. */
  shiftsAhead: number;
  /** Weeks published, at any site. */
  published: number;
  /** Days with takings, keyed or from the till, in the last 14. */
  takingsDays: number;
  /** Clock records of the business's own, by phone, kiosk or entered. */
  clocked: number;
  /** Current people set up in payroll. */
  inPayroll: number;
}

export type GoLiveStatus = 'done' | 'late' | 'due' | 'waiting' | 'upcoming';

export interface GoLiveStep {
  code: string;
  phase: GoLivePhase;
  label: string;
  /** Why it matters, in a line: the reason a busy owner should do it today rather than next week. */
  why: string;
  /** How to do it, in a line, naming the screen as the app does. */
  how: string;
  /** The screen it is done on. */
  screen: string;
  /** Day of the plan it is due by, counted from the start (day 0). */
  dueDay: number;
  dueOn: string;
  /** Not every business needs it: never counted as late, and never holds back going live. */
  optional: boolean;
  done: boolean;
  status: GoLiveStatus;
  /** Steps that must be done first. */
  after: string[];
  /** What the data shows now, such as "3 of 12 people have a blocker". */
  progress: string | null;
}

export interface GoLivePlan {
  startedOn: string;
  /** Days since the start: 0 on the day. */
  day: number;
  /** How long the plan runs: the trial, or 14 days. */
  length: number;
  billing: GoLiveBilling;
  trialEndsOn: string | null;
  steps: GoLiveStep[];
  /** Required steps done, of the required steps. */
  done: number;
  of: number;
  pct: number;
  /** Every required step done. */
  live: boolean;
  /** The one step to do now: the earliest required step not done whose prerequisites are, else an optional one. */
  next: GoLiveStep | null;
  /** Required steps past their day. */
  late: GoLiveStep[];
  /** One plain sentence for the top of the screen and the subject of a nudge. */
  headline: string;
}

export const PHASES: { id: GoLivePhase; label: string; days: string }[] = [
  { id: 'secure', label: 'Secure the account', days: 'Day 0' },
  { id: 'business', label: 'Set up the business', days: 'Days 1 to 2' },
  { id: 'team', label: 'Bring in the team', days: 'Days 3 to 5' },
  { id: 'rota', label: 'First rota', days: 'Days 5 to 7' },
  { id: 'run', label: 'Run the week on it', days: 'Days 8 to 12' },
  { id: 'commit', label: 'Decide', days: 'By the end of the trial' },
];

/** The plan's length where there is no trial to set it. */
export const PLAN_DAYS = 14;
/** A step due within this many days reads as due rather than upcoming. */
const DUE_SOON_DAYS = 1;

const dayMs = 86_400_000;
const parse = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const plus = (d: string, days: number) => new Date(parse(d) + days * dayMs).toISOString().slice(0, 10);
const between = (a: string, b: string) => Math.round((parse(b) - parse(a)) / dayMs);
const of = (n: number, d: number, what: string) => `${n} of ${d} ${what}`;

interface StepSpec {
  code: string;
  phase: GoLivePhase;
  label: string;
  why: string;
  how: string;
  screen: string;
  dueDay: number;
  optional?: boolean;
  after?: string[];
  applies?: (f: GoLiveFacts) => boolean;
  done: (f: GoLiveFacts) => boolean;
  progress?: (f: GoLiveFacts) => string | null;
}

const realSites = (f: GoLiveFacts) => (f.sample ? 0 : f.sites);

const STEPS: StepSpec[] = [
  {
    code: 'authenticator',
    phase: 'secure',
    label: 'Set up your authenticator',
    why: 'The owner can change pay, payroll and who has access. A code from your phone keeps that yours alone.',
    how: 'Profile, then Authenticator: scan the QR code, type the code it shows, keep the recovery codes safe.',
    screen: 'profile',
    dueDay: 0,
    done: (f) => f.ownerAuthenticator,
  },
  {
    code: 'companies',
    phase: 'business',
    label: 'Companies with company number and PAYE reference',
    why: 'Payroll, the labour journal and the cost of every shift are worked by company. A missing PAYE reference sends hours nowhere.',
    how: 'Set-up, Companies: the registered name, company number and PAYE reference for each trading company.',
    screen: 'setup',
    dueDay: 1,
    after: ['authenticator'],
    done: (f) => !f.sample && f.companies > 0 && f.companiesComplete === f.companies,
    progress: (f) => (f.sample || f.companies === 0 ? null : of(f.companiesComplete, f.companies, 'companies complete')),
  },
  {
    code: 'sites',
    phase: 'business',
    label: 'Sites with opening hours and a labour target',
    why: 'The labour target is the line every rota is judged against. Without it Preshift can cost a week but cannot tell you it is too dear.',
    how: 'Set-up, Sites: opening hours and the loaded labour target as a share of net sales, for each site.',
    screen: 'setup',
    dueDay: 1,
    after: ['authenticator'],
    done: (f) => realSites(f) > 0 && f.sitesWithTarget === f.sites,
    progress: (f) => (realSites(f) ? of(f.sitesWithTarget, f.sites, 'sites with a target') : null),
  },
  {
    code: 'trading',
    phase: 'business',
    label: 'A typical trading week and staffing rules',
    why: 'The rota is built from demand. A typical week of sales and how many covers each role serves an hour is what the build fills against.',
    how: 'Set-up, Trading and staffing: net sales by day and average spend for each site, then covers or sales per person per hour for each role.',
    screen: 'setup',
    dueDay: 2,
    after: ['sites'],
    done: (f) => realSites(f) > 0 && f.sitesWithTradingWeek === f.sites && f.staffingRules > 0,
    progress: (f) => (realSites(f) ? of(f.sitesWithTradingWeek, f.sites, 'sites with a typical week') : null),
  },
  {
    code: 'team',
    phase: 'team',
    label: 'Load your team',
    why: 'Nobody can be rostered until they are on Preshift. Pasting the team in from a payroll export takes minutes, not an afternoon.',
    how: 'Set-up, Import: upload the Excel template or an export from your old system, and Shifty maps the columns. Or Set-up, Team: paste a list.',
    screen: 'setup',
    dueDay: 3,
    after: ['sites'],
    done: (f) => !f.sample && f.people > 0,
    progress: (f) => (f.sample || !f.people ? null : `${f.people} ${f.people === 1 ? 'person' : 'people'} loaded`),
  },
  {
    code: 'records',
    phase: 'team',
    label: 'Every record clear to roster',
    why: 'Anyone without a right to work check, or paid below the minimum for their age, is held off the rota. That is the law doing its job: an illegal worker carries a civil penalty of up to £60,000.',
    how: 'Set-up, Import, Right to work: bring the checks across with their dates, then upload a copy of what was seen on each person\'s file. Correct date of birth or pay in Staff.',
    screen: 'people',
    dueDay: 4,
    after: ['team'],
    done: (f) => !f.sample && f.people > 0 && f.peopleBlocked === 0,
    progress: (f) => (f.sample || !f.people ? null : f.peopleBlocked ? `${f.peopleBlocked} of ${f.people} held back` : 'Everyone clear'),
  },
  {
    code: 'rtwcopies',
    phase: 'team',
    label: 'Right to work copies held',
    why: 'A check is only a statutory excuse with a clear copy of each document seen, kept for the whole employment and two years after. Without the copy, the date proves nothing.',
    how: 'Staff: open each person, Right to work, and upload a copy of what was seen. Phone photos are fine if every page is clear.',
    screen: 'people',
    dueDay: 5,
    after: ['records'],
    done: (f) => !f.sample && f.rtwChecked > 0 && f.rtwCopies >= f.rtwChecked,
    progress: (f) => (f.sample || !f.rtwChecked ? null : of(f.rtwCopies, f.rtwChecked, 'copies held')),
  },
  {
    code: 'statements',
    phase: 'team',
    label: 'Written statements issued',
    why: 'Every worker is owed a written statement of their terms on or before their first day. Missing ones cost up to four weeks\' pay each at a tribunal.',
    how: 'HR file for each person: record the statement issued and signed, or send it to sign in the staff app. Bring dates across under Set-up, Import, HR file.',
    screen: 'hr',
    dueDay: 5,
    after: ['team'],
    done: (f) => !f.sample && f.people > 0 && f.statementsIssued >= f.people,
    progress: (f) => (f.sample || !f.people ? null : of(f.statementsIssued, f.people, 'issued')),
  },
  {
    code: 'training',
    phase: 'run',
    label: 'Required training held',
    why: 'Food hygiene, allergen and licensing training are what an environmental health officer or licensing officer asks to see first. A gap is a finding on the inspection report.',
    how: 'Training: each role\'s required courses, with dates and expiry. Bring certificates across under Set-up, Import, Training.',
    screen: 'training',
    dueDay: 12,
    after: ['team'],
    applies: (f) => f.trainingNeeded > 0 || f.people === 0,
    done: (f) => !f.sample && f.people > 0 && f.trainingHeld >= f.trainingNeeded,
    progress: (f) => (f.sample || !f.trainingNeeded ? null : of(f.trainingHeld, f.trainingNeeded, 'fully trained')),
  },
  {
    code: 'holiday',
    phase: 'team',
    label: 'Holiday balances carried in',
    why: 'Holiday is a liability on the balance sheet. Without each person\'s position at go-live, balances start from nought, people are told the wrong figure, and the holiday pay accrual is understated.',
    how: 'Set-up, Import, Holiday balances: upload the balances from your old system or the template, in hours or days.',
    screen: 'setup',
    dueDay: 5,
    after: ['team'],
    applies: (f) => f.holidayDue > 0 || f.people === 0,
    done: (f) => !f.sample && f.people > 0 && f.holidayOpened >= f.holidayDue,
    progress: (f) => (f.sample || !f.holidayDue ? null : of(f.holidayOpened, f.holidayDue, 'balances in')),
  },
  {
    code: 'email',
    phase: 'team',
    label: 'Email set up for invitations and resets',
    why: 'Staff app invitations, password resets and rota notices go out by email from your own address. Without it nobody can be invited.',
    how: 'Settings, Email: your Resend key and the address mail comes from.',
    screen: 'settings',
    dueDay: 4,
    after: ['authenticator'],
    done: (f) => f.emailReady,
  },
  {
    code: 'managers',
    phase: 'team',
    label: 'Invite your managers',
    why: 'The rota belongs to the person who runs the floor. A GM with their own sign-in builds it; an owner who builds every rota is the bottleneck.',
    how: 'Access, Invite: their email, the role (general manager, for one site) and the sites they run.',
    screen: 'access',
    dueDay: 4,
    optional: true,
    after: ['sites'],
    done: (f) => f.managers > 0,
    progress: (f) => (f.managers ? `${f.managers} invited` : null),
  },
  {
    code: 'staffapp',
    phase: 'team',
    label: 'Half the team on the staff app',
    why: 'A published rota only works if people see it. On the app they get their shifts, swap, ask for holiday and clock in, without a WhatsApp group.',
    how: 'Clock in, Phone logins: Email an invite to everyone not yet on the app, in one go, from each site. Each link lasts 7 days.',
    screen: 'clock',
    dueDay: 5,
    after: ['team', 'email'],
    done: (f) => !f.sample && f.people > 0 && f.onStaffApp * 2 >= f.people,
    progress: (f) => (f.sample || !f.people ? null : of(f.onStaffApp, f.people, 'on the app')),
  },
  {
    code: 'build',
    phase: 'rota',
    label: 'Build your first rota',
    why: 'This is the moment the product earns its keep: the week built from forecast demand, every shift costed as payroll will cost it, and anything illegal stopped.',
    how: 'Rota, next week: Build from the forecast, then move what you know better than the forecast. Watch labour % against the target as you go. Rotas already planned in your old system come across under Set-up, Import, Rota.',
    screen: 'rota',
    dueDay: 5,
    after: ['trading', 'team'],
    done: (f) => !f.sample && (f.shiftsAhead > 0 || f.published > 0),
    progress: (f) => (!f.sample && f.shiftsAhead ? `${f.shiftsAhead} shifts drafted` : null),
  },
  {
    code: 'publish',
    phase: 'rota',
    label: 'Publish it',
    why: 'Publishing tells each person their week, logs the notice you gave, and is the line from which changes are counted. A rota nobody has seen is a draft.',
    how: 'Rota: clear any blocking issue, then Publish. Each person whose week changed is told on the app or by email.',
    screen: 'rota',
    dueDay: 7,
    after: ['build', 'records'],
    done: (f) => !f.sample && f.published > 0,
  },
  {
    code: 'takings',
    phase: 'run',
    label: 'Takings coming in',
    why: 'Labour % is only true against real sales. Takings also teach the forecast how each site trades, so next week is built on fact, not the typical week.',
    how: 'Integrations: connect the till (Square), or Reports, Takings: key each day in. Either way, daily.',
    screen: 'integrations',
    dueDay: 10,
    after: ['publish'],
    done: (f) => f.takingsDays >= 3,
    progress: (f) => (f.takingsDays ? `${f.takingsDays} days in the last 14` : null),
  },
  {
    code: 'clocking',
    phase: 'run',
    label: 'Clock in against the rota',
    why: 'The rota is the plan; clocked hours are what you pay. The gap between them is where labour budgets go to die, and you can only see it once people clock.',
    how: 'Clock in: pair an iPad as a kiosk, put tags on the wall, or switch on clocking by phone for the site.',
    screen: 'clock',
    dueDay: 10,
    after: ['publish'],
    done: (f) => f.clocked > 0,
  },
  {
    code: 'payroll',
    phase: 'run',
    label: 'Everyone set up in payroll',
    why: 'Approved hours go to payroll without re-keying, and the rota reconciles to the payslip. Only where payroll runs through TeamPay.',
    how: 'Payroll: set up each person in TeamPay, or link them to the record already there.',
    screen: 'payroll',
    dueDay: 12,
    optional: true,
    after: ['team'],
    done: (f) => !f.sample && f.people > 0 && f.inPayroll === f.people,
    progress: (f) => (f.sample || !f.people ? null : of(f.inPayroll, f.people, 'in payroll')),
  },
  {
    code: 'subscribe',
    phase: 'commit',
    label: 'Choose your plan',
    why: 'Trial days left carry over, so subscribing early costs nothing and nothing pauses when the trial ends.',
    how: 'Organisation, Billing: monthly or yearly, priced per site, paid by card through Stripe.',
    screen: 'billing',
    dueDay: PLAN_DAYS - 1,
    applies: (f) => f.billing === 'trial' || f.billing === 'lapsed' || f.billing === 'paying',
    after: ['publish'],
    done: (f) => f.billing === 'paying',
  },
];

/** The plan for one business, today. */
export function goLivePlan(f: GoLiveFacts): GoLivePlan {
  const day = Math.max(0, between(f.startedOn, f.today));
  const length = f.trialEndsOn ? Math.max(PLAN_DAYS, between(f.startedOn, f.trialEndsOn)) : PLAN_DAYS;
  const specs = STEPS.filter((s) => !s.applies || s.applies(f));
  const doneCodes = new Set(specs.filter((s) => s.done(f)).map((s) => s.code));
  const steps: GoLiveStep[] = specs.map((s) => {
    // The decision is due the day before the trial ends, however long the trial.
    const dueDay = s.code === 'subscribe' ? Math.max(0, length - 1) : s.dueDay;
    const dueOn = plus(f.startedOn, dueDay);
    const done = doneCodes.has(s.code);
    const after = (s.after ?? []).filter((c) => specs.some((x) => x.code === c));
    const waiting = after.some((c) => !doneCodes.has(c));
    const status: GoLiveStatus = done
      ? 'done'
      : !s.optional && f.today > dueOn
        ? 'late'
        : waiting
          ? 'waiting'
          : between(f.today, dueOn) <= DUE_SOON_DAYS
            ? 'due'
            : 'upcoming';
    return {
      code: s.code,
      phase: s.phase,
      label: s.label,
      why: s.why,
      how: s.how,
      screen: s.screen,
      dueDay,
      dueOn,
      optional: !!s.optional,
      done,
      status,
      after,
      progress: s.progress?.(f) ?? null,
    };
  });
  const required = steps.filter((s) => !s.optional);
  const done = required.filter((s) => s.done).length;
  const ready = (s: GoLiveStep) => !s.done && s.after.every((c) => doneCodes.has(c));
  const next = required.find(ready) ?? steps.find(ready) ?? null;
  const late = required.filter((s) => s.status === 'late');
  const live = done === required.length;
  return {
    startedOn: f.startedOn,
    day,
    length,
    billing: f.billing,
    trialEndsOn: f.trialEndsOn,
    steps,
    done,
    of: required.length,
    pct: required.length ? Math.round((done / required.length) * 100) : 100,
    live,
    next,
    late,
    headline: headlineOf(day, length, done, required.length, live, next, late),
  };
}

function headlineOf(day: number, length: number, done: number, total: number, live: boolean, next: GoLiveStep | null, late: GoLiveStep[]): string {
  if (live) return 'You are live: the week is built, published, clocked and measured on Preshift.';
  const when = day < length ? `Day ${day} of ${length}` : `Day ${day}`;
  const pace = late.length ? ` ${late.length} ${late.length === 1 ? 'step is' : 'steps are'} behind the plan.` : ' On plan.';
  return `${when}. ${done} of ${total} steps done.${pace}${next ? ` Next: ${next.label.charAt(0).toLowerCase()}${next.label.slice(1)}.` : ''}`;
}

/** The phases with their steps, in order, for the screen. */
export function byPhase(plan: GoLivePlan) {
  return PHASES.map((p) => ({ ...p, steps: plan.steps.filter((s) => s.phase === p.id) })).filter((p) => p.steps.length > 0);
}

export const GO_LIVE_STEP_CODES = STEPS.map((s) => s.code);
