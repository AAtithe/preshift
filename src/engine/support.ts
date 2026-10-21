/**
 * Front line support. Three things a customer needs from the people who build their rota: an
 * answer to a question without waiting for anyone, a way to report something broken that tells us
 * enough to fix it first time, and a say in what gets built next. Most questions are answered by
 * the help library before a ticket is raised; what is left is triaged by what it stops the
 * operator doing, because a bug that stops payroll on a Monday morning is not the same as a
 * misaligned label, and each kind carries a first response target the support desk is held to.
 */

export type TicketKind = 'question' | 'bug' | 'feature';

/** What a bug stops the operator doing. Severity, and so the response target, follows from this. */
export type BugImpact = 'payroll' | 'publish' | 'clocking' | 'signin' | 'workaround' | 'cosmetic';

export type Severity = 'blocking' | 'major' | 'minor';

export type TicketStatus = 'new' | 'acknowledged' | 'investigating' | 'planned' | 'resolved' | 'declined';

export interface TicketComment {
  at: string;
  author: string;
  /** True for a reply from the Preshift support desk rather than someone in the organisation. */
  fromSupport: boolean;
  body: string;
}

/** Where the person was when they raised it, so a bug can be reproduced without a back and forth. */
export interface TicketContext {
  tab?: string;
  siteId?: string;
  week?: string;
  userAgent?: string;
}

export interface SupportTicket {
  id: string;
  kind: TicketKind;
  title: string;
  detail: string;
  status: TicketStatus;
  raisedAt: string;
  raisedBy: string;
  /** Bugs: what it stops them doing, which sets severity. */
  impact?: BugImpact;
  severity?: Severity;
  /** Bugs: how to make it happen again. */
  steps?: string;
  /** Features: hours a week it would save across the organisation, the operator's own estimate. */
  hoursSavedPerWeek?: number;
  /** Features: who in the organisation wants it. One vote each. */
  votes?: string[];
  context?: TicketContext;
  comments: TicketComment[];
  /** When the support desk first replied or moved it on. The response target is measured to this. */
  firstResponseAt?: string;
  resolvedAt?: string;
}

export const KIND_LABEL: Record<TicketKind, string> = {
  question: 'Question',
  bug: 'Something is wrong',
  feature: 'Feature idea',
};

export const IMPACTS: Record<BugImpact, { label: string; severity: Severity }> = {
  payroll: { label: 'Paying staff or sending hours to payroll', severity: 'blocking' },
  publish: { label: 'Building or publishing the rota', severity: 'blocking' },
  clocking: { label: 'Staff clocking in or out', severity: 'blocking' },
  signin: { label: 'Signing in', severity: 'blocking' },
  workaround: { label: 'Slows us down, but there is a way round it', severity: 'major' },
  cosmetic: { label: 'Looks wrong, nothing stops', severity: 'minor' },
};

export const STATUS_LABEL: Record<TicketStatus, string> = {
  new: 'New',
  acknowledged: 'Acknowledged',
  investigating: 'Investigating',
  planned: 'Planned',
  resolved: 'Resolved',
  declined: 'Not doing',
};

export const CLOSED: TicketStatus[] = ['resolved', 'declined'];
export const isOpen = (t: Pick<SupportTicket, 'status'>) => !CLOSED.includes(t.status);

/**
 * First response targets. Blocking bugs are measured on the clock, any day, because restaurants
 * trade at weekends and payroll does not wait. Everything else is measured in working days.
 */
export const RESPONSE_TARGET: Record<Severity | 'question' | 'feature', { hours?: number; workingDays?: number; label: string }> = {
  blocking: { hours: 4, label: '4 hours, any day' },
  major: { workingDays: 1, label: '1 working day' },
  minor: { workingDays: 3, label: '3 working days' },
  question: { workingDays: 1, label: '1 working day' },
  feature: { workingDays: 5, label: '5 working days' },
};

export function targetFor(t: Pick<SupportTicket, 'kind' | 'severity'>) {
  if (t.kind === 'bug') return RESPONSE_TARGET[t.severity ?? 'major'];
  return RESPONSE_TARGET[t.kind];
}

/** Adds working days (Monday to Friday) to an instant, keeping the time of day. */
export function addWorkingDays(at: Date, days: number): Date {
  const d = new Date(at.getTime());
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return d;
}

export function responseDueAt(t: Pick<SupportTicket, 'kind' | 'severity' | 'raisedAt'>): string {
  const target = targetFor(t);
  const raised = new Date(t.raisedAt);
  const due = target.hours ? new Date(raised.getTime() + target.hours * 3_600_000) : addWorkingDays(raised, target.workingDays ?? 1);
  return due.toISOString();
}

/** Still waiting for a first response after its target has passed. */
export function responseOverdue(t: SupportTicket, now: Date): boolean {
  return isOpen(t) && !t.firstResponseAt && now.getTime() > new Date(responseDueAt(t)).getTime();
}

/** Open first, blocking before everything, then oldest first so nothing waits behind newer noise. */
export function ticketOrder(a: SupportTicket, b: SupportTicket): number {
  const rank = (t: SupportTicket) => (isOpen(t) ? 0 : 10) + (t.severity === 'blocking' ? 0 : t.kind === 'bug' ? 1 : t.kind === 'question' ? 2 : 3);
  return rank(a) - rank(b) || (isOpen(a) ? a.raisedAt.localeCompare(b.raisedAt) : b.raisedAt.localeCompare(a.raisedAt));
}

/**
 * Feature ideas ranked the way a finance team would rank spend: by how many people want it and
 * what it is worth. Votes count first; the hours estimate breaks ties.
 */
export function featureOrder(a: SupportTicket, b: SupportTicket): number {
  return (b.votes?.length ?? 0) - (a.votes?.length ?? 0) || (b.hoursSavedPerWeek ?? 0) - (a.hoursSavedPerWeek ?? 0) || a.raisedAt.localeCompare(b.raisedAt);
}

/** Tickets one organisation may raise in a day, so a stuck script cannot flood the support desk. */
export const DAILY_TICKET_LIMIT = 30;

export interface HelpArticle {
  id: string;
  title: string;
  /** Words people use when they have this problem, not the words the product uses. */
  keywords: string[];
  body: string;
  /** The tab that fixes it, when there is one. */
  tab?: string;
}

/**
 * The first line. Each answer is written for the question as a GM would ask it at 4pm on a
 * Friday, and says where in the app to fix it.
 */
export const HELP_ARTICLES: HelpArticle[] = [
  {
    id: 'publish-blocked',
    title: 'Publish is greyed out',
    keywords: ['publish', 'greyed', 'blocked', 'cannot publish', 'sign off', 'red', 'compliance', 'block'],
    body:
      'The rota cannot be published while it has a blocking compliance issue: a missed break, under 11 hours rest between shifts, ' +
      'a young worker over their limits, pay below minimum wage, a double booking or someone on leave. The P&L rail lists each one. ' +
      'Click it to open the shift, change it, and Publish comes back once the count is zero.',
    tab: 'rota',
  },
  {
    id: 'labour-percent',
    title: 'Labour % looks higher than I expected',
    keywords: ['labour', 'percent', '%', 'high', 'cost', 'wrong', 'expensive', 'ni', 'national insurance', 'pension', 'holiday', 'on-cost'],
    body:
      'Preshift costs labour the way payroll will: gross pay plus 12.07% holiday accrual, 15% employer NI above £96 a week, and ' +
      'auto-enrolment pension on qualifying earnings. A naive rate times hours leaves those out, which is why other tools look cheaper ' +
      'and then the P&L disagrees. Check the forecast on the Demand tab too: labour % is against forecast sales, so a low forecast ' +
      'reads as high labour.',
    tab: 'demand',
  },
  {
    id: 'cannot-clock',
    title: 'Staff cannot clock in on their phone',
    keywords: ['clock', 'clock in', 'clocking', 'phone', 'location', 'geofence', 'gps', 'outside', 'staff app', 'sign in'],
    body:
      'Phone clocking needs the site to have a geofence, and the phone has to be inside it with location allowed for the browser. ' +
      'Set the geofence on Clock in, and widen it if the building sits on the edge. Breaks are not location checked. ' +
      'At the entrance tablet, staff can tap their RFID card instead.',
    tab: 'clock',
  },
  {
    id: 'invite-expired',
    title: 'A staff invite link has expired or a password is forgotten',
    keywords: ['invite', 'link', 'expired', 'staff', 'password', 'forgot', 'reset', 'login'],
    body:
      'Staff invite links last 7 days. Send a new one from Clock in setup: it also resets a forgotten staff password. ' +
      'Managers who forget their password use "Forgot your password?" on the sign-in page; if email is not set up yet, an admin makes ' +
      'a reset link under Settings.',
    tab: 'clock',
  },
  {
    id: 'hours-to-payroll',
    title: 'Hours have not reached payroll',
    keywords: ['payroll', 'teampay', 'hours', 'send', 'sent', 'not arrived', 'missing', 'pay run', 'paid'],
    body:
      'Only approved hours are sent, one batch per employing company, and nothing goes until every company with hours has a TeamPay ' +
      'employer set up. Check the Payroll tab: unapproved entries and any flagged short breaks are listed there. Anything TeamPay has ' +
      'not confirmed is retried automatically every day. Integrations shows whether each scheme is connected.',
    tab: 'payroll',
  },
  {
    id: 'break-flag',
    title: 'Shifts are flagged for short breaks',
    keywords: ['break', 'rest', 'short break', 'flag', '20 minutes', 'working time'],
    body:
      'Anyone working over 6 hours is entitled to a 20 minute unbroken break (30 minutes over 4.5 hours for under 18s). If the break ' +
      'was taken but not recorded, enter it on the Payroll tab before approval. Approval is never blocked, but it is recorded against ' +
      'the flagged shifts, so it is visible if the hours are ever disputed.',
    tab: 'payroll',
  },
  {
    id: 'journal',
    title: 'Where is the labour accrual journal',
    keywords: ['journal', 'accrual', 'xero', 'close', 'month end', 'export', 'nominal', 'posting'],
    body:
      'Close builds the labour accrual by role nominal and site tracking category, one journal per company, from approved actuals ' +
      'where they exist and the rota otherwise. Export it in Xero manual journal format. Intercompany recharges post on both sides and ' +
      'are checked to agree before you post.',
    tab: 'close',
  },
  {
    id: 'holiday-balance',
    title: 'A holiday balance looks wrong',
    keywords: ['holiday', 'leave', 'balance', 'entitlement', 'annual leave', 'carry over', 'accrual', '12.07'],
    body:
      'Fixed hours staff earn 5.6 weeks (or their contract) evenly through the leave year; irregular hours staff earn 12.07% of hours ' +
      'worked. Check the leave year start, any opening balance entered at go-live, and that approved clocked hours exist: without them ' +
      'the rota is used instead. Change the person on the Holiday tab.',
    tab: 'holiday',
  },
  {
    id: 'borrow',
    title: 'Someone from another site does not show in the picker',
    keywords: ['borrow', 'other site', 'cover', 'sister site', 'picker', 'cross site', 'not showing'],
    body:
      'People only appear to cover a site they have agreed to work. Open them in People and tick the site under cover sites. ' +
      'Anyone employed by a different company is marked as an intercompany recharge.',
    tab: 'people',
  },
  {
    id: 'assistant-off',
    title: 'The rota assistant is not available',
    keywords: ['assistant', 'ai', 'claude', 'not working', 'missing', 'key', 'draft'],
    body:
      'The assistant needs one site chosen in the top bar, and an admin to save the organisation’s Claude API key under Settings. ' +
      'Every shift it proposes is costed and checked, and anything with a blocking issue is refused.',
    tab: 'settings',
  },
  {
    id: 'reset-email',
    title: 'Password reset emails are not arriving',
    keywords: ['email', 'reset', 'not arriving', 'resend', 'spam', 'password'],
    body:
      'Reset emails go through Resend once an admin saves a Resend key, a from address on a verified domain, and the app’s address ' +
      'under Settings. One account gets at most three an hour. Until it is set up, an admin can hand over a 24 hour reset link.',
    tab: 'settings',
  },
  {
    id: 'minimum-wage',
    title: 'Someone is flagged below minimum wage',
    keywords: ['minimum wage', 'nlw', 'living wage', 'birthday', 'age', 'rate', 'below', 'salary'],
    body:
      'The legal minimum moves with age, so a birthday can move someone up a band mid-year. Salaried staff are checked at their ' +
      'maximum hours. Update the rate in People; the rota will not publish a shift paid below the minimum.',
    tab: 'people',
  },
  {
    id: 'gdpr-request',
    title: 'A member of staff asked for their data',
    keywords: ['gdpr', 'data', 'subject access', 'sar', 'erase', 'delete', 'privacy', 'personal'],
    body:
      'Log it on the GDPR tab the day it arrives: the reply is due one calendar month later. Export everything held on the person from ' +
      'there. Erasure is for leavers only, and pay and right to work records stay until their retention date.',
    tab: 'privacy',
  },
];

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9%.\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);

/**
 * Help articles that may answer what someone is typing, best first. A keyword phrase found whole
 * counts most; single words count a little; the title counts too, so "publish greyed" finds
 * "Publish is greyed out".
 */
export function suggestArticles(text: string, articles: HelpArticle[] = HELP_ARTICLES, limit = 3): HelpArticle[] {
  const lower = ` ${text.toLowerCase()} `;
  const typed = new Set(words(text));
  if (typed.size === 0) return [];
  const scored = articles.map((a) => {
    let score = 0;
    for (const k of a.keywords) {
      if (k.includes(' ') ? lower.includes(k) : typed.has(k)) score += k.includes(' ') ? 3 : 2;
    }
    for (const w of words(a.title)) if (typed.has(w)) score += 1;
    return { a, score };
  });
  return scored
    .filter((s) => s.score >= 2)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit)
    .map((s) => s.a);
}

/** Why a ticket cannot be raised as given, or null. */
export function ticketProblem(t: { kind: TicketKind; title: string; detail: string; impact?: BugImpact }): string | null {
  if (t.title.trim().length < 5) return 'Give it a title of a few words, so it can be found again.';
  if (t.detail.trim().length < 10) return 'Say a little more: what you expected, and what happened instead.';
  if (t.kind === 'bug' && !t.impact) return 'Say what it stops you doing, so it is answered in the right order.';
  return null;
}
