import type { Employee, RotaState, TimeEntry } from './types';
import { addDays, parseISODate, taxYearOf, toISODate } from './time';

/**
 * UK GDPR and the Data Protection Act 2018, applied to what Preshift actually holds about staff.
 * Three duties are built in: keep each kind of personal data no longer than its purpose needs
 * (Article 5(1)(e)), answer people's requests about their data within a month (Articles 12 to 22),
 * and keep a record of processing (Article 30). The law sets minimums in places (HMRC, the Home
 * Office, Working Time Regulations); the policy below meets them and goes no further.
 */

export interface RetentionPolicy {
  /** Months a clock's location fix is kept after the day it was made. Evidence for approval and disputes only. */
  locationMonths: number;
  /** Months after leaving that contact details, availability, the RFID card and the staff login are kept. Covers final pay and the P45. */
  contactMonthsAfterLeaving: number;
  /** Years after leaving that right to work check details are kept. The Home Office asks for two. */
  rightToWorkYearsAfterLeaving: number;
  /**
   * Years after the end of the tax year someone left in that their record stays identifiable.
   * HMRC needs three; six covers the Limitation Act period for contract and wage claims.
   */
  payrollYearsAfterTaxYear: number;
  /**
   * Months messages between staff and managers are kept. Thirteen covers the usual three month
   * tribunal window and a year of who was told what; six years covers contract claims.
   */
  messageMonths: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  locationMonths: 3,
  contactMonthsAfterLeaving: 3,
  rightToWorkYearsAfterLeaving: 2,
  payrollYearsAfterTaxYear: 6,
  messageMonths: 13,
};

/** The statutory floors a policy may not go below. */
export const RETENTION_FLOORS: RetentionPolicy = {
  locationMonths: 0,
  contactMonthsAfterLeaving: 0,
  rightToWorkYearsAfterLeaving: 2,
  payrollYearsAfterTaxYear: 3,
  messageMonths: 13,
};

/** Six years, the Limitation Act period for contract claims: no dispute needs messages older. */
export const MESSAGE_MONTHS_MAX = 72;

export function retentionPolicyProblem(policy: RetentionPolicy): string | null {
  if (policy.rightToWorkYearsAfterLeaving < RETENTION_FLOORS.rightToWorkYearsAfterLeaving) {
    return 'Right to work checks must be kept for at least two years after someone leaves, or the statutory excuse is lost.';
  }
  if (policy.payrollYearsAfterTaxYear < RETENTION_FLOORS.payrollYearsAfterTaxYear) {
    return 'HMRC requires payroll records for at least three years after the end of the tax year they relate to.';
  }
  if (policy.messageMonths < RETENTION_FLOORS.messageMonths) {
    return 'Messages are kept at least 13 months: the tribunal window and a year of who was told what.';
  }
  if (policy.messageMonths > MESSAGE_MONTHS_MAX) {
    return 'Messages are not needed for more than six years, the period for contract claims.';
  }
  if (policy.locationMonths > 24 || policy.contactMonthsAfterLeaving > 24) {
    return 'Location and contact details are not needed for more than two years. Keep the periods short.';
  }
  return null;
}

/** The same day n months later, or the month's last day when it is shorter (31 January plus one month is 28 or 29 February). */
export function addMonths(iso: string, months: number): string {
  const d = parseISODate(iso);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return toISODate(target);
}

/** 5 April that ends the tax year a date falls in. */
export function taxYearEnd(iso: string): string {
  return `${Number(taxYearOf(iso).slice(0, 4)) + 1}-04-05`;
}

export type RetentionCode = 'location' | 'contact' | 'right-to-work' | 'anonymise';

export interface RetentionItem {
  code: RetentionCode;
  employeeId: string;
  name: string;
  dueOn: string;
  /** True once dueOn has passed: the data should already be gone. */
  due: boolean;
  /** What will be removed, in plain words. */
  removes: string;
  reason: string;
  /** For location: the entries holding a fix. */
  entryIds?: string[];
}

/** Days ahead the retention schedule shows what is coming up. */
export const RETENTION_LOOKAHEAD_DAYS = 60;

const hasContact = (e: Employee) => Boolean(e.email || e.phone || e.badgeId || e.availability.length > 0);
const hasRightToWorkDetail = (e: Employee) =>
  Boolean(e.rightToWork?.evidence || e.rightToWork?.checkedOn || e.rightToWork?.expiry || e.rightToWork?.documents?.length);

/**
 * What personal data has reached, or is about to reach, the end of its retention period.
 * Only lists data still held, so applying an item takes it off the list.
 */
export function retentionSchedule(
  state: RotaState,
  entries: TimeEntry[],
  today: string,
  policy: RetentionPolicy = DEFAULT_RETENTION,
): RetentionItem[] {
  const horizon = addDays(today, RETENTION_LOOKAHEAD_DAYS);
  const items: RetentionItem[] = [];
  const push = (item: Omit<RetentionItem, 'due'>) => {
    if (item.dueOn <= horizon) items.push({ ...item, due: item.dueOn <= today });
  };

  // Location is grouped per person so a busy site does not list thousands of rows.
  const located = new Map<string, { ids: string[]; first: string }>();
  for (const t of entries) {
    if (!t.clockInLocation && !t.clockOutLocation) continue;
    const dueOn = addMonths(t.date, policy.locationMonths);
    if (dueOn > horizon) continue;
    const g = located.get(t.employeeId) ?? { ids: [], first: dueOn };
    g.ids.push(t.id);
    if (dueOn < g.first) g.first = dueOn;
    located.set(t.employeeId, g);
  }
  for (const [employeeId, g] of located) {
    const e = state.employees.find((x) => x.id === employeeId);
    push({
      code: 'location',
      employeeId,
      name: e?.name ?? employeeId,
      dueOn: g.first,
      removes: `Location on ${g.ids.length} clock${g.ids.length === 1 ? '' : 's'}`,
      reason: `Kept ${policy.locationMonths} months as evidence for approval and disputes. The times stay; only where they clocked goes.`,
      entryIds: g.ids,
    });
  }

  for (const e of state.employees) {
    if (!e.leaveDate || e.anonymisedOn) continue;
    if (hasContact(e)) {
      push({
        code: 'contact',
        employeeId: e.id,
        name: e.name,
        dueOn: addMonths(e.leaveDate, policy.contactMonthsAfterLeaving),
        removes: 'Email, phone, availability, RFID card and staff login',
        reason: `Needed to reach them about final pay and the P45. Kept ${policy.contactMonthsAfterLeaving} months after leaving.`,
      });
    }
    if (hasRightToWorkDetail(e)) {
      push({
        code: 'right-to-work',
        employeeId: e.id,
        name: e.name,
        dueOn: addMonths(e.leaveDate, policy.rightToWorkYearsAfterLeaving * 12),
        removes: 'Right to work evidence, check date, expiry and the stored document copies',
        reason: `The Home Office asks for checks to be kept ${policy.rightToWorkYearsAfterLeaving} years after employment ends, then destroyed.`,
      });
    }
    push({
      code: 'anonymise',
      employeeId: e.id,
      name: e.name,
      dueOn: addDays(addMonths(taxYearEnd(e.leaveDate), policy.payrollYearsAfterTaxYear * 12), 1),
      removes: 'Name and date of birth (year kept); shifts, hours and pay stay for the accounts',
      reason: `Payroll records are kept ${policy.payrollYearsAfterTaxYear} years after the tax year they left in, then the person is anonymised.`,
    });
  }
  return items.sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.name.localeCompare(b.name));
}

/** The name an anonymised person carries, so journals and history still tell people apart. */
export const anonymousName = (employeeId: string) => `Former employee ${employeeId.slice(-6)}`;

/** Clears what a contact item covers. Staff logins live outside the rota and are closed by the caller. */
export function stripContact(e: Employee): Employee {
  const { email: _email, phone: _phone, badgeId: _badge, ...rest } = e;
  if (!rest.hr) return { ...rest, availability: [] };
  const { address: _address, postcode: _postcode, emergencyContact: _contact, ...hr } = rest.hr;
  return { ...rest, hr, availability: [] };
}

export function stripRightToWork(e: Employee): Employee {
  return { ...e, rightToWork: e.rightToWork ? { checked: e.rightToWork.checked } : undefined };
}

/**
 * Leaves a record that still reconciles (id, employer, roles, pay, dates, shifts and hours) but no
 * longer identifies anyone. The birth year stays so historic minimum wage bands still cost correctly.
 */
export function anonymise(e: Employee, today: string): Employee {
  const plain = stripRightToWork(stripContact(e));
  // Absence dates stay with the pay record; why someone was off, and their NI number, do not.
  const { niNumber: _ni, ...hr } = plain.hr ?? {};
  return {
    ...plain,
    ...(plain.hr ? { hr } : {}),
    ...(plain.absences ? { absences: plain.absences.map(({ id, type, from, to }) => ({ id, type, from, to })) } : {}),
    name: anonymousName(e.id),
    dateOfBirth: e.dateOfBirth ? `${e.dateOfBirth.slice(0, 4)}-01-01` : '',
    anonymisedOn: today,
  };
}

export function stripLocation(t: TimeEntry): TimeEntry {
  const { clockInLocation: _in, clockOutLocation: _out, ...rest } = t;
  return rest;
}

export interface RetentionResult {
  employees: Employee[];
  timeEntries: TimeEntry[];
  /** People whose staff login must be closed. */
  closeLoginsFor: string[];
  applied: { code: RetentionCode; employeeId: string; count: number }[];
}

/** Applies the items that are due. Items not yet due are ignored, so the schedule can be passed straight in. */
export function applyRetention(
  employees: Employee[],
  timeEntries: TimeEntry[],
  items: RetentionItem[],
  today: string,
): RetentionResult {
  const due = items.filter((i) => i.due);
  const byPerson = new Map<string, Set<RetentionCode>>();
  for (const i of due) byPerson.set(i.employeeId, (byPerson.get(i.employeeId) ?? new Set()).add(i.code));
  const locationIds = new Set(due.filter((i) => i.code === 'location').flatMap((i) => i.entryIds ?? []));
  const applied: RetentionResult['applied'] = [];

  const nextEmployees = employees.map((e) => {
    const codes = byPerson.get(e.id);
    if (!codes) return e;
    let next = e;
    if (codes.has('anonymise')) {
      next = anonymise(next, today);
      applied.push({ code: 'anonymise', employeeId: e.id, count: 1 });
      return next;
    }
    if (codes.has('contact')) {
      next = stripContact(next);
      applied.push({ code: 'contact', employeeId: e.id, count: 1 });
    }
    if (codes.has('right-to-work')) {
      next = stripRightToWork(next);
      applied.push({ code: 'right-to-work', employeeId: e.id, count: 1 });
    }
    return next;
  });

  const located = new Map<string, number>();
  const nextEntries = timeEntries.map((t) => {
    if (!locationIds.has(t.id)) return t;
    located.set(t.employeeId, (located.get(t.employeeId) ?? 0) + 1);
    return stripLocation(t);
  });
  for (const [employeeId, count] of located) applied.push({ code: 'location', employeeId, count });

  const closeLoginsFor = [...byPerson].filter(([, c]) => c.has('contact') || c.has('anonymise')).map(([id]) => id);
  return { employees: nextEmployees, timeEntries: nextEntries, closeLoginsFor, applied };
}

/**
 * What can be erased on request now, ahead of the schedule. Article 17(3) keeps what the law
 * requires (payroll, right to work) and what defends a claim; everything else can go. Current staff
 * need their contact details and the clocking record to be employed and paid, so it is refused.
 */
export function erasureRefusal(e: Employee, today: string): string | null {
  if (!e.leaveDate || e.leaveDate >= today) {
    return `${e.name} still works here. Their record is needed to employ and pay them, so erasure does not apply (Article 17(3)(b)). Correct anything wrong instead, or record an objection.`;
  }
  return null;
}

export type SubjectRequestKind = 'access' | 'erasure' | 'rectification' | 'restriction' | 'objection' | 'portability';

export const REQUEST_KINDS: Record<SubjectRequestKind, { label: string; article: string }> = {
  access: { label: 'Access (subject access request)', article: 'Article 15' },
  rectification: { label: 'Rectification', article: 'Article 16' },
  erasure: { label: 'Erasure', article: 'Article 17' },
  restriction: { label: 'Restriction', article: 'Article 18' },
  portability: { label: 'Portability', article: 'Article 20' },
  objection: { label: 'Objection', article: 'Article 21' },
};

export interface SubjectRequest {
  id: string;
  kind: SubjectRequestKind;
  /** The person the request is about, when they are on the People records. */
  employeeId?: string;
  /** Who made it, as they gave their name. */
  subject: string;
  receivedOn: string;
  /** Set when the deadline is extended by two months for a complex or repeated request; tell the person within the first month. */
  extended?: boolean;
  status: 'open' | 'closed';
  closedOn?: string;
  notes?: string;
  loggedBy: string;
}

/** One calendar month from receipt, or three when extended (Article 12(3)). */
export function requestDueOn(request: Pick<SubjectRequest, 'receivedOn' | 'extended'>): string {
  return addMonths(request.receivedOn, request.extended ? 3 : 1);
}

export function requestOverdue(request: SubjectRequest, today: string): boolean {
  return request.status === 'open' && requestDueOn(request) < today;
}

export interface ProcessingFlags {
  /** A Claude API key is saved, so the rota assistant sends team details to Anthropic. */
  assistant: boolean;
  /** Resend is set up for password reset emails. */
  email: boolean;
  /** Payroll goes to the live TeamPay rather than the built-in simulator. */
  payrollLive: boolean;
  /** Messaging channels connected under Settings, and how many messages are held. */
  messaging?: { whatsapp: boolean; sms: boolean; slack: boolean; teams: boolean; messages: number; consents: number };
  /** Hospitality Rewards is connected to a live account rather than the simulator. */
  rewards?: boolean;
}

/** What the wellbeing features hold now, for the register's counts. */
export interface WelfareHeld {
  pulses: number;
  recognitions: number;
  chats: number;
  members: number;
}

export interface ProcessingActivity {
  activity: string;
  purpose: string;
  lawfulBasis: string;
  categories: string;
  recipients: string;
  retention: string;
  /** How many records of this kind are held now. */
  held: number;
}

export interface Processor {
  name: string;
  role: string;
  data: string;
  location: string;
  /** What must be in place for the transfer to be lawful. */
  safeguard: string;
  active: boolean;
}

/**
 * The Article 30 record of processing for staff data, built from what is actually held so it
 * cannot drift from the system. Every company in the group is a controller of its own staff's data.
 */
export function processingRegister(
  state: RotaState,
  entries: TimeEntry[],
  staffLogins: number,
  flags: ProcessingFlags,
  policy: RetentionPolicy = DEFAULT_RETENTION,
  supportTickets = 0,
  welfare: WelfareHeld = { pulses: 0, recognitions: 0, chats: 0, members: 0 },
): { activities: ProcessingActivity[]; processors: Processor[] } {
  const live = state.employees.filter((e) => !e.anonymisedOn);
  const payroll = `${flags.payrollLive ? 'TeamPay' : 'TeamPay (simulated)'}`;
  const activities: ProcessingActivity[] = [
    {
      activity: 'Employment records',
      purpose: 'Employing people: contracts, pay, age checks for minimum wage and young worker limits',
      lawfulBasis: 'Contract (6(1)(b)); legal obligation (6(1)(c)) for minimum wage and working time',
      categories: 'Name, date of birth, email, phone, employer, roles, pay, contracted hours, start and leave dates',
      recipients: payroll,
      retention: `${policy.payrollYearsAfterTaxYear} years after the tax year they leave, then anonymised; contact details ${policy.contactMonthsAfterLeaving} months after leaving`,
      held: live.length,
    },
    {
      activity: 'Right to work checks',
      purpose: 'Keeping the statutory excuse against illegal working penalties',
      lawfulBasis: 'Legal obligation (6(1)(c)), Immigration, Asylum and Nationality Act 2006',
      categories: 'Check date, evidence type seen, permission expiry, and copies of the documents checked (passport, visa, share code result), encrypted with every view logged',
      recipients: 'None',
      retention: `Employment plus ${policy.rightToWorkYearsAfterLeaving} years`,
      held: live.filter(hasRightToWorkDetail).length,
    },
    {
      activity: 'Personnel files',
      purpose: 'Managing employment: contracts, probation, reviews, training, disciplinary and grievance cases',
      lawfulBasis: 'Contract (6(1)(b)); legal obligation (6(1)(c)) for the written statement and NI number; legitimate interests (6(1)(f)) for reviews and cases',
      categories: 'NI number, address, emergency contact, line manager, contract dates, training certificates, reviews, cases and notes',
      recipients: 'None. Cases are visible to admins only',
      retention: `Contact details ${policy.contactMonthsAfterLeaving} months after leaving; the rest until the person is anonymised`,
      held: live.filter((e) => e.hr).length,
    },
    {
      activity: 'Sickness and absence',
      purpose: 'Managing attendance, fit notes, return to work and statutory sick pay',
      lawfulBasis:
        'Contract (6(1)(b)); health data under Article 9(2)(b) and DPA 2018 Schedule 1 paragraph 1 (employment law). ' +
        'Needs an appropriate policy document. Reasons are never shared with rota or payroll keys',
      categories: 'Absence dates and type, reason, fit note seen, return to work date',
      recipients: 'None',
      retention: `Dates with the payroll record; reasons removed when the person is anonymised`,
      held: live.reduce((n, e) => n + (e.absences?.length ?? 0), 0),
    },
    {
      activity: 'Rota and working time',
      purpose: 'Scheduling, Working Time Regulations limits and rest, holiday entitlement',
      lawfulBasis: 'Contract (6(1)(b)); legal obligation (6(1)(c)), Working Time Regulations 1998',
      categories: 'Shifts, availability, leave dates, 48 hour opt-out',
      recipients: 'None',
      retention: `With the payroll record (${policy.payrollYearsAfterTaxYear} years after the tax year)`,
      held: state.shifts.length,
    },
    {
      activity: 'Time and attendance',
      purpose: 'Paying people for the hours they worked',
      lawfulBasis: 'Contract (6(1)(b)); legal obligation (6(1)(c)) for pay records',
      categories: 'Clock in and out times, breaks, method, approver',
      recipients: payroll,
      retention: `With the payroll record (${policy.payrollYearsAfterTaxYear} years after the tax year)`,
      held: entries.length,
    },
    {
      activity: 'Clocking location',
      purpose: 'Confirming people are on site when they clock, to stop clocking from home',
      lawfulBasis: 'Legitimate interests (6(1)(f)). Needs a written legitimate interests assessment; taken only at the moment of clocking, never tracked',
      categories: 'Device position and accuracy at clock in and out, distance from the site',
      recipients: 'None',
      retention: `${policy.locationMonths} months from the clock`,
      held: entries.filter((t) => t.clockInLocation || t.clockOutLocation).length,
    },
    {
      activity: 'RFID cards',
      purpose: 'Clocking in by card at the site entrance',
      lawfulBasis: 'Legitimate interests (6(1)(f))',
      categories: 'Card serial number linked to the person',
      recipients: 'None',
      retention: `Until ${policy.contactMonthsAfterLeaving} months after leaving`,
      held: live.filter((e) => e.badgeId).length,
    },
    {
      activity: 'Staff app logins',
      purpose: 'Letting staff clock and see their own shifts on their phone',
      lawfulBasis: 'Contract (6(1)(b))',
      categories: 'Email, password hash, sign-in times',
      recipients: flags.email ? 'Resend (invite and reset emails)' : 'None',
      retention: 'Closed on leaving; removed with contact details',
      held: staffLogins,
    },
    {
      activity: 'Rota assistant',
      purpose: 'Drafting rotas from a manager’s instructions',
      lawfulBasis: 'Legitimate interests (6(1)(f))',
      categories: 'Names, roles, pay rate, age, availability, leave and hours for one site and week',
      recipients: flags.assistant ? 'Anthropic (Claude API)' : 'Not in use',
      retention: 'Not kept by Preshift. Check Anthropic’s API retention terms in the data processing addendum',
      held: flags.assistant ? live.length : 0,
    },
    {
      activity: 'Messages and rota notices',
      purpose: 'Telling staff their shifts and changes to them, and messages between staff and their managers',
      lawfulBasis:
        'Contract (6(1)(b)) for rota notices; legitimate interests (6(1)(f)) for messages. WhatsApp and text only with the person’s own consent, ' +
        'given and withdrawn in the staff app (PECR does not apply to messages that are not marketing, but consent is kept as the record of their choice)',
      categories: 'Message text, who sent it, when it was read, mobile number for WhatsApp or text, delivery reports. Team channels get a notice and a link, never what staff wrote',
      recipients: [
        flags.messaging?.whatsapp && 'Meta (WhatsApp)',
        flags.messaging?.sms && 'Twilio (text)',
        flags.email && 'Resend (email, for those who choose it)',
        flags.messaging?.slack && 'Slack (notices only)',
        flags.messaging?.teams && 'Microsoft (Teams notices only)',
      ].filter(Boolean).join(', ') || 'None: staff app only',
      retention: `${policy.messageMonths} months from the message; the number and choices removed on erasure`,
      held: flags.messaging?.messages ?? 0,
    },
    {
      activity: 'Recognition and staff benefits',
      purpose: 'Thanking people for good work, crediting recognition points, and giving staff discounts and wellbeing support through Hospitality Rewards',
      lawfulBasis: 'Legitimate interests (6(1)(f)). Anyone can opt out of the benefits platform from the staff app; a thank you is still recorded',
      categories: 'Name, work email, site, company, start date; recognition messages, points and who gave them',
      recipients: flags.rewards ? 'Hospitality Rewards' : 'None',
      retention: 'Recognitions until the person is anonymised; platform membership ends at the first sync after leaving or opting out',
      held: welfare.recognitions + welfare.members,
    },
    {
      activity: 'Wellbeing pulse and chat requests',
      purpose: 'Understanding how each team is doing, and offering a private conversation to anyone who asks for one',
      lawfulBasis:
        'Legitimate interests (6(1)(f)); answering is voluntary. Treated as possibly revealing health: answers are stored without the person’s id, ' +
        'no free text is taken, and a site’s week is shown only once five people have answered',
      categories: 'A weekly score of 1 to 5 with site and week; for a chat request, the person’s name, site and when they asked',
      recipients: 'None',
      retention: 'Pulse answers 13 months; chat requests until the person is anonymised',
      held: welfare.pulses + welfare.chats,
    },
    {
      activity: 'Manager accounts and audit log',
      purpose: 'Securing access and showing who changed what',
      lawfulBasis: 'Legitimate interests (6(1)(f)); security of processing (Article 32)',
      categories: 'Manager email, password hash, actions taken with time',
      recipients: 'None',
      retention: 'Accounts until removed; the last 5,000 audit events',
      held: 0,
    },
    {
      activity: 'Support tickets',
      purpose: 'Answering questions and fixing problems reported to Williams, Stanley & Co.',
      lawfulBasis: 'Contract (6(1)(b))',
      categories: 'Name of the manager who raised it, what they wrote, the screen, site and week it was raised from, replies',
      recipients: "The client's WS client partner (notified by email through Resend)",
      retention: 'Two years after the ticket is closed, then deleted',
      held: supportTickets,
    },
  ];

  const processors: Processor[] = [
    {
      name: 'TeamPay',
      role: 'Payroll bureau',
      data: 'Employment records and approved hours',
      location: 'UK',
      safeguard: 'Article 28 contract',
      active: flags.payrollLive,
    },
    {
      name: 'Anthropic',
      role: 'Rota assistant model',
      data: 'Team details for the site and week being drafted',
      location: 'United States',
      safeguard: 'Article 28 contract and the UK addendum to the EU standard contractual clauses (or the IDTA), with a transfer risk assessment',
      active: flags.assistant,
    },
    {
      name: 'Resend',
      role: 'Email delivery',
      data: 'Manager and staff email addresses, reset and invite links',
      location: 'United States',
      safeguard: 'Article 28 contract and the UK addendum or IDTA, with a transfer risk assessment',
      active: flags.email,
    },
    {
      name: 'Meta (WhatsApp Business)',
      role: 'Messages to staff who chose WhatsApp, and their replies',
      data: 'Mobile number and message text',
      location: 'United States and elsewhere',
      safeguard: 'Meta’s WhatsApp Business data processing terms with the UK addendum or IDTA, and a transfer risk assessment',
      active: !!flags.messaging?.whatsapp,
    },
    {
      name: 'Twilio',
      role: 'Text messages to staff who chose them',
      data: 'Mobile number and message text',
      location: 'United States',
      safeguard: 'Article 28 contract and the UK addendum or IDTA, with a transfer risk assessment',
      active: !!flags.messaging?.sms,
    },
    {
      name: 'Slack and Microsoft Teams',
      role: 'Notices to managers’ team channels',
      data: 'Names of staff who sent a message or were told of a rota, with a link; never what staff wrote',
      location: 'As the workspace is set up',
      safeguard: 'The organisation’s own contract with Slack or Microsoft for its workspace',
      active: !!flags.messaging?.slack || !!flags.messaging?.teams,
    },
    {
      name: 'Hospitality Rewards',
      role: 'Employee benefits and recognition',
      data: 'Name, work email, site, company, start date, recognition points and messages',
      location: 'UK (confirm in the contract)',
      safeguard: 'Article 28 contract for enrolment. Check whether it acts as a controller once a member signs up, and say so in the staff privacy notice',
      active: !!flags.rewards,
    },
    {
      name: 'Vercel and Neon',
      role: 'Hosting and database',
      data: 'Everything Preshift holds',
      location: 'Region as deployed; check both are set to London or the EU',
      safeguard: 'Article 28 contract; UK addendum or IDTA for any US access',
      active: true,
    },
  ];
  return { activities, processors };
}

/**
 * The appropriate policy document an employer must keep to hold health data such as sickness
 * (DPA 2018 Schedule 1 Part 4): how it complies with the principles and how long it keeps the data.
 * It must exist, be signed off and be reviewed. One per employing company, since each is a controller.
 */
export interface PolicyDocument {
  entityId: string;
  title: string;
  /** Where the document lives, for anyone asked to show it. */
  url?: string;
  /** Legal review before sign-off. */
  reviewedBy?: string;
  reviewedOn?: string;
  /** The director who signed it for the company. */
  signedBy?: string;
  signedOn?: string;
  /** When it is next reviewed. A year after signing unless set. */
  reviewDue?: string;
  updatedBy: string;
  updatedAt: string;
}

export const POLICY_REVIEW_MONTHS = 12;

export interface PolicyDocumentCheck {
  entityId: string;
  severity: 'block' | 'warn' | 'ok';
  message: string;
}

/** The review date in force: the one set, or a year after signing. */
export function policyReviewDue(doc: Pick<PolicyDocument, 'signedOn' | 'reviewDue'>): string | undefined {
  if (doc.reviewDue) return doc.reviewDue;
  if (!doc.signedOn) return undefined;
  const [y, m, d] = doc.signedOn.split('-');
  return `${Number(y) + POLICY_REVIEW_MONTHS / 12}-${m}-${d}`;
}

/**
 * Where each employing company stands: no document while sickness is held is the gap an ICO
 * inspection asks about first; a document not reviewed by counsel or not signed is a draft; one
 * past its review date is out of date.
 */
export function policyDocumentChecks(entities: { id: string; name: string }[], docs: PolicyDocument[], holdsHealthData: boolean, today: string): PolicyDocumentCheck[] {
  return entities.map((entity) => {
    const doc = docs.find((d) => d.entityId === entity.id);
    const at = (severity: PolicyDocumentCheck['severity'], message: string) => ({ entityId: entity.id, severity, message });
    if (!doc) {
      return holdsHealthData
        ? at('block', `${entity.name} holds sickness records with no appropriate policy document on record. Have it reviewed and signed by a director.`)
        : at('warn', `${entity.name} has no appropriate policy document. One is needed before any sickness is recorded.`);
    }
    if (!doc.reviewedOn) return at('warn', `${entity.name}'s appropriate policy document has not been reviewed by counsel.`);
    if (!doc.signedOn || !doc.signedBy) return at('warn', `${entity.name}'s appropriate policy document is reviewed but not signed by a director.`);
    const due = policyReviewDue(doc)!;
    if (due < today) return at('warn', `${entity.name}'s appropriate policy document was due for review on ${due}.`);
    return at('ok', `Signed by ${doc.signedBy} on ${doc.signedOn}. Next review ${due}.`);
  });
}
