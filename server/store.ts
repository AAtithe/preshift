import type { PayPolicy } from '../src/engine/payPolicy';
import { randomBytes } from 'node:crypto';
import type { AccessReview, User } from '../src/engine/access';
import type { LoginCaseReview, StaffLoginEvent } from '../src/engine/loginreview';
import type { SupportTicket } from '../src/engine/support';
import { seedHrRecords, seedState } from '../src/engine/seed';
import type { PolicyDocument, RetentionPolicy, SubjectRequest } from '../src/engine/gdpr';
import { addDays, toISODate } from '../src/engine/time';
import type { MoveRecord } from '../src/engine/coach';
import type { Programme } from '../src/engine/programme';
import type { EventFeed } from './integrations/feeds';
import type { Publication } from '../src/engine/scorecard';
import type { SspCheckLine } from '../src/engine/ssp';
import type { PayrollVariance } from '../src/engine/timesheet';
import type { HrRecord, OpenShift, PayChange, RotaState, StaffNotification, StaffRequest, TimeEntry } from '../src/engine/types';
import { HttpError } from './context';
import type { PushDevice } from './push';
import type { ShiftAlertRecord } from '../src/engine/reminders';
import { isSandbox, SANDBOX_PREFIX } from './sandbox';
import type { EposConnection } from './integrations/epos/provider';
import type { MessagingData } from '../src/engine/messaging';
import type { RewardsConnection } from './integrations/rewards/provider';
import type { ChatRequest, PulseResponse, Recognition, WelfarePolicy } from '../src/engine/welfare';
import type { OutboxItem } from './outbox';
import { queueEvent, type WebhookDelivery, type WebhookEndpoint } from './webhooks';
import { demoAuthenticators, seedUsers } from './seedUsers';

export interface PayrollSubmission {
  id: string;
  periodStart: string;
  periodEnd: string;
  version: number;
  status: 'queued' | 'sent' | 'failed' | 'superseded';
  providerSubmissionId?: string;
  totalHours: number;
  lineCount: number;
  createdAt: string;
  createdBy: string;
  /** Loaded labour per person accrued for this period when it was sent, to compare with the pay run. */
  accrued: Record<string, number>;
  /** The employing company: each PAYE scheme gets its own batch. Absent on records from before per-scheme payroll. */
  entityId?: string;
  /** The payroll employer the batch went to, once sent. */
  employerId?: string;
}

export interface PayRunRecord {
  id: string;
  periodStart: string;
  periodEnd: string;
  receivedAt: string;
  variance: PayrollVariance;
  /** SSP paid against SSP due, when the payroll reports it. */
  ssp?: SspCheckLine[];
  entityId?: string;
  employerId?: string;
}

export interface AuditEvent {
  at: string;
  actor: string;
  action: string;
  detail?: Record<string, unknown>;
}

/**
 * One person's authenticator. Kept apart from their access record so no response that
 * returns people can ever carry it. The secret is sealed; recovery codes are hashes.
 */
export interface AuthenticatorRecord {
  /** Changes on every enrolment: a session's proof names it, so a reset ends older proofs. */
  id: string;
  /** The confirmed secret, sealed. */
  secret?: string;
  /** A secret shown but not yet confirmed with a code, sealed. */
  pending?: string;
  enrolledAt?: string;
  /** The last time step accepted, so no code works twice. */
  lastStep: number;
  /** SHA-256 of each unused recovery code. */
  recovery: string[];
  /** Recent wrong codes, for the lockout. */
  failures: string[];
  lockedUntil?: string;
}

export type { MailKind } from '../src/engine/mail';
import type { MailKind, MailStatus } from '../src/engine/mail';
export type MailEventType = MailStatus;

export interface MailRecord {
  to: string;
  kind: MailKind;
  userId?: string;
  employeeId?: string;
  sentAt: string;
  /** Who sent it: a person's name, or the sign-in page for "Forgot your password?". */
  by: string;
  /** Kept as reported, oldest first; the status is read from them (maillog.statusOf), never stored. */
  events: { id: string; type: MailEventType; at: string; detail?: string }[];
}

/** A shared iPad paired as one site's clocking kiosk. Its credential is kept hashed in settings, not here. */
export interface Kiosk {
  id: string;
  siteId: string;
  name: string;
  pairedBy: string;
  pairedAt: string;
  lastSeenAt?: string;
}

export interface OrgData {
  orgId: string;
  state: RotaState;
  timeEntries: TimeEntry[];
  /** Paired clocking kiosks. Absent on organisations saved before kiosks existed. */
  kiosks?: Kiosk[];
  submissions: PayrollSubmission[];
  payRuns: PayRunRecord[];
  outbox: OutboxItem[];
  processedWebhookIds: Set<string>;
  audit: AuditEvent[];
  /** Every weekly move offered to a GM, and whether it was taken. */
  moves: MoveRecord[];
  /** When each site's week was published, for measuring notice. */
  publications: Publication[];
  /** The labour programme each site is on, if any. */
  programmes: Programme[];
  settings: OrgSettings;
  /** Where each site's local events come from. */
  eventFeeds: EventFeed[];
  /** Reminders someone has dealt with or set aside, so they stop showing. */
  reminderStates: ReminderState[];
  /** The London date weather and events were last fetched for this organisation by the daily run. */
  lastOutsideRefresh?: string;
  /** Partner systems told when something changes. Absent on organisations saved before webhooks. */
  webhooks?: WebhookEndpoint[];
  /** Holiday, time off, sickness, availability, swaps and open shift claims from the staff app. */
  requests?: StaffRequest[];
  /** Shifts posted for anyone eligible to claim. */
  openShifts?: OpenShift[];
  /** What each member of staff has been told, newest last. */
  notifications?: StaffNotification[];
  /** Each person's published week at a site as they were last told it, by `employeeId|siteId|weekStart`. */
  toldWeeks?: Record<string, string[]>;
  /** Reminders and no-show alerts sent per shift, kept a couple of days. */
  shiftAlerts?: Record<string, ShiftAlertRecord>;
  /** The London day the managers' morning digest last went out, so it goes once a day. */
  lastDigest?: string;
  /** Events waiting to reach, or recently sent to, those systems. */
  webhookDeliveries?: WebhookDelivery[];
  users: User[];
  accessReviews: AccessReview[];
  /** Invitation tokens by their SHA-256; the plain token is shown once, to whoever sent it. */
  inviteTokens: Record<string, { userId: string; expiresAt: string; kind?: 'invite' | 'reset' }>;
  /** When each person's invitation was last sent, to stop resend floods. */
  inviteSends: Record<string, string[]>;
  /** Authenticators by user id. */
  authenticators: Record<string, AuthenticatorRecord>;
  /** Emails sent through Resend, by Resend's id, with what Resend has reported since. Never their content. */
  mail: Record<string, MailRecord>;
  /** Personnel file entries: training, reviews, cases, documents and notes. Served only to HR scopes. */
  hrRecords: HrRecord[];
  /** Pay rate changes proposed, approved, rejected or withdrawn. Nothing is ever removed: it is the pay audit trail. */
  payChanges: PayChange[];
  /** How fast finance decides pay changes, and the day hours go to payroll. Defaults apply when absent. */
  payPolicy?: PayPolicy;
  /** The London date the daily pay run last ran: changes taking effect applied, finance reminded. */
  payDailyOn?: string;
  /** Questions, bug reports and feature ideas raised with the client's WS client partner, and questions the help answers closed. */
  support?: { tickets: SupportTicket[]; answeredByHelp: number };
  /** Every staff app invite, set-up and close, kept for good: the audit log is trimmed and this is what the close review reads. */
  staffLoginLog: StaffLoginEvent[];
  /** Sign-offs of staff logins closed and opened again. Never removed. */
  loginReviews: LoginCaseReview[];
  /** UK GDPR: the organisation's retention periods and its log of requests from staff about their data. */
  privacy?: { policy?: RetentionPolicy; requests: SubjectRequest[]; policyDocuments?: PolicyDocument[] };
  /** The till the organisation has connected, if any. Its access token lives in the settings store. */
  epos?: EposConnection;
  /** Messages between managers and staff, rota notices, and how each person wants to hear. Absent until first used. */
  messaging?: MessagingData;
  /** Looking after the team: the welfare policy, recognition, the pulse and Hospitality Rewards. Absent until first used. */
  welfare?: WelfareData;
  /**
   * Set when a WS client partner removed a client before its owner ever signed in. Nobody can reach
   * it after that; the row is kept, with its audit trail, rather than deleted.
   */
  closed?: { at: string; by: string };
  /** Row version for optimistic locking in persistent stores. */
  version?: number;
}

export interface WelfareData {
  /** Only what someone changed from the defaults (welfarePolicy fills the rest). */
  policy?: Partial<WelfarePolicy>;
  recognitions: Recognition[];
  /** Pulse answers, stored without who gave them and in no particular order. */
  pulses: PulseResponse[];
  /**
   * Who has answered which week, so nobody answers twice: a keyed hash of person and week, kept
   * apart from the answers with nothing to join them by.
   */
  pulseAnswered: string[];
  chats: ChatRequest[];
  /** People who asked not to be enrolled in Hospitality Rewards. */
  rewardsOptOut: string[];
  /** Who Hospitality Rewards has as a member, after the last sync: removed when no longer eligible. */
  rewardsEnrolled: string[];
  /** The benefits platform, if connected. Its API key lives in the settings store. */
  rewards?: RewardsConnection;
}

export const welfareOf = (org: OrgData): WelfareData =>
  (org.welfare ??= { recognitions: [], pulses: [], pulseAnswered: [], chats: [], rewardsOptOut: [], rewardsEnrolled: [] });

export interface ReminderState {
  key: string;
  siteId: string;
  status: 'done' | 'dismissed';
  at: string;
  by: string;
  note?: string;
}

export interface OrgSettings {
  /**
   * Shares this organisation's site figures, anonymised, with other operators who also share, and
   * in return sees the cohort's. Off until an admin turns it on: give to get.
   */
  benchmarking?: boolean;
  /** People (user ids) who have turned off the morning email of staff requests waiting for them. */
  digestOff?: string[];
}

export type UserRole = 'admin' | 'member';

/**
 * A person who signs in to the web app. Passwords are held only as scrypt salt and hash. One
 * account can hold access records in several organisations; it belongs to one, its home.
 */
export interface UserRecord {
  email: string;
  /**
   * The home organisation: where the account was made. Only its admins reset the password or the
   * authenticator, so no other organisation can take the account over.
   */
  orgId: string;
  /** Every organisation the account has joined, home included. Missing on older rows: just the home. */
  orgs?: string[];
  /** Where the person last worked, so sign-in returns them there. */
  lastOrgId?: string;
  /** The person's authenticator: one for every organisation, as the password is. */
  authenticator?: AuthenticatorRecord;
  role: UserRole;
  salt: string;
  hash: string;
  createdAt: string;
  /** Sessions issued before this (epoch milliseconds) are refused: set on a password change or reset. */
  sessionsValidFrom: number;
  failedAttempts: number;
  /** Epoch seconds; sign-in is refused until then after repeated failures. */
  lockedUntil: number;
  /** SHA-256 of the one outstanding reset link; a new link replaces it. Never the token itself. */
  resetTokenHash?: string;
  /** Epoch seconds the reset link stops working. */
  resetExpires?: number;
  /** Epoch seconds of recent reset emails, to cap how many one account can be sent. */
  resetRequests?: number[];
}

/** The organisations an account may sign in to, home first. */
export const orgsOfAccount = (a: Pick<UserRecord, 'orgId' | 'orgs'>) => [a.orgId, ...(a.orgs ?? []).filter((o) => o !== a.orgId)];

/** Whether the account holds access anywhere but here: then only its home may reset it. */
export const sharedAccount = (a: Pick<UserRecord, 'orgId' | 'orgs'>) => orgsOfAccount(a).length > 1;

/**
 * People and deployment settings, kept in the same database as the organisations so that
 * nothing about access is configured outside the app.
 */
export interface UserStore {
  /** The key that signs session cookies, created on first use and kept in the database. */
  sessionSecret(): Promise<string>;
  getUser(email: string): Promise<UserRecord | null>;
  listUsers(orgId: string): Promise<UserRecord[]>;
  hasUsers(): Promise<boolean>;
  /**
   * Adds the person; false if the email is taken. With onlyIfFirst, also false once anyone exists.
   * Demo visitors never count as anyone, here or in hasUsers, so the demo cannot block owner setup.
   */
  createUser(user: UserRecord, options?: { onlyIfFirst?: boolean }): Promise<boolean>;
  updateUser(email: string, patch: Partial<Omit<UserRecord, 'email' | 'createdAt'>>): Promise<void>;
  deleteUser(email: string): Promise<void>;
  /** The person whose reset link this is, while it is unused and in date. */
  findUserByResetToken(tokenHash: string, nowSeconds: number): Promise<UserRecord | null>;
  /**
   * Uses up the reset link and applies the patch in one step, so a link used twice at once
   * changes the password only once. Null when the link is used, expired or unknown.
   */
  claimPasswordReset(tokenHash: string, nowSeconds: number, patch: Partial<UserRecord>): Promise<UserRecord | null>;
  /** Secrets and settings kept apart from organisation data, so no data endpoint can return them. */
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string | null): Promise<void>;
  /** Adds to a running total kept as a setting, atomically, and returns the new total. */
  addToSetting(key: string, amount: number): Promise<number>;
  /** A setting written once and never overwritten: whoever writes first wins, and everyone reads that. */
  settingOnce(key: string, make: () => string): Promise<string>;
}

/**
 * A member of staff's own login, for clocking on their phone. Kept apart from UserRecord on
 * purpose: a staff login reaches the staff app and nothing else, so no role check elsewhere can
 * slip and hand payroll or settings to someone who only needs to clock in.
 */
export interface StaffLogin {
  orgId: string;
  employeeId: string;
  /** Set when they accept the invite. Unique across every organisation. */
  email?: string;
  salt?: string;
  hash?: string;
  /** SHA-256 of the one-time invite token. The token itself is only ever in the link. */
  inviteHash?: string;
  /** Epoch seconds. */
  inviteExpires?: number;
  invitedBy: string;
  createdAt: string;
  activatedAt?: string;
  lastSignInAt?: string;
  /** Staff sessions issued before this (epoch milliseconds) are refused. */
  sessionsValidFrom: number;
  failedAttempts: number;
  /** Epoch seconds. */
  lockedUntil: number;
  /** Phones the person turned notifications on for. Closing the login forgets them with it. */
  push?: PushDevice[];
  /** False when the person has turned off shift reminders. Not-clocked-in nudges still come. */
  reminders?: boolean;
}

/**
 * An API key an admin made in the app. Only its SHA-256 is kept; the key itself is shown once,
 * when it is made. Kept outside organisation data so no data endpoint can ever return it.
 */
export interface ApiKeyRecord {
  id: string;
  orgId: string;
  name: string;
  scopes: string[];
  /** SHA-256 of the key, hex. */
  hash: string;
  /** The last four characters, so people can tell keys apart. */
  endsWith: string;
  createdAt: string;
  createdBy: string;
  /** The person who made it: what they may not do for themselves, the key may not do for them. */
  createdById?: string;
  lastUsedAt?: string;
  /**
   * Set when revoked. A revoked key is kept, never deleted, so a later attempt to use it is still
   * recognised, refused and logged against it: the evidence a breach investigation needs.
   */
  revokedAt?: string;
  revokedBy?: string;
}

/** One request made with an API key. Kept 13 months for breach investigation. */
export interface ApiCall {
  orgId: string;
  /** The app key's id, or `env:<name>` for a key set by deployment. */
  keyId: string;
  at: string;
  method: string;
  /** Path and query as sent. */
  path: string;
  status: number;
  ip: string;
  ms: number;
  /** Set when the key was refused before reaching any data: revoked or rate limited. */
  refused?: 'revoked' | 'rate_limited';
}

export interface ApiKeyStore {
  getApiKeyByHash(hash: string): Promise<ApiKeyRecord | null>;
  /** Every key the organisation has made, revoked ones included. */
  listApiKeys(orgId: string): Promise<ApiKeyRecord[]>;
  /** Creates or replaces, by hash. */
  putApiKey(key: ApiKeyRecord): Promise<void>;
  /** Marks the key revoked; false if it is unknown or already revoked. */
  revokeApiKey(orgId: string, id: string, by: string): Promise<boolean>;
  logApiCall(call: ApiCall): Promise<void>;
  /** Newest first. */
  listApiCalls(orgId: string, keyId: string, options: { from?: string; to?: string; limit: number }): Promise<ApiCall[]>;
  /** Removes calls made before the given time; returns how many. */
  purgeApiCalls(before: string): Promise<number>;
}

/** How long API call records are kept: the partner's 12 months, plus a month to report on them. */
export const API_CALL_RETENTION_DAYS = 396;

export interface StaffStore {
  getStaffLogin(orgId: string, employeeId: string): Promise<StaffLogin | null>;
  getStaffLoginByEmail(email: string): Promise<StaffLogin | null>;
  listStaffLogins(orgId: string): Promise<StaffLogin[]>;
  /** Creates or replaces. False when another login already has the email. */
  putStaffLogin(login: StaffLogin): Promise<boolean>;
  deleteStaffLogin(orgId: string, employeeId: string): Promise<void>;
}

/** An uploaded file: its bytes and the type they were checked to be. */
export interface StoredFile {
  contentType: string;
  data: Buffer;
}

/** One touch of a stored file. Kept for good: the log outlives the file it describes. */
export interface DocumentAccess {
  orgId: string;
  documentId: string;
  employeeId: string;
  action: 'added' | 'viewed' | 'deleted';
  at: string;
  /** The signed-in person's email, or the API key's name. */
  actor: string;
  via: 'session' | 'api key' | 'staff app';
  ip?: string;
}

/**
 * Files such as right to work copies, kept apart from the organisation document so that loading
 * the rota never pulls scans of passports with it. The record that names a file lives in OrgData.
 * Files arrive here already encrypted; the store never sees the key.
 */
export interface DocumentStore {
  putDocument(orgId: string, id: string, file: StoredFile): Promise<void>;
  getDocument(orgId: string, id: string): Promise<StoredFile | null>;
  deleteDocument(orgId: string, id: string): Promise<void>;
  /** Append only: there is no way to change or remove an entry. */
  logDocumentAccess(entry: DocumentAccess): Promise<void>;
  /** Oldest first. */
  listDocumentAccess(orgId: string, documentId: string): Promise<DocumentAccess[]>;
}

/**
 * Tenancy boundary: every request loads exactly one organisation, works on it,
 * and saves it once at the end. A save that finds the organisation changed
 * underneath it is refused rather than overwriting someone else's work.
 */
export interface Store extends UserStore, StaffStore, ApiKeyStore, DocumentStore {
  load(orgId: string): Promise<OrgData>;
  /** Whether the organisation exists, without creating it as load() would. */
  has(orgId: string): Promise<boolean>;
  /** Today in this store's world: fixed in tests, real otherwise. */
  todayISO(): string;
  save(org: OrgData): Promise<void>;
  orgIds(): Promise<string[]>;
  /** The demo sandboxes only, never a customer organisation. */
  sandboxIds(): Promise<string[]>;
  /**
   * Deletes a demo sandbox for good: its data, its visitor account, staff logins, documents and API keys. Refuses
   * anything that is not a sandbox id, in code and again in the database statement itself, so no
   * fault in the caller can delete a customer.
   */
  deleteSandbox(orgId: string): Promise<void>;
}

function assertSandbox(orgId: string) {
  if (!isSandbox(orgId)) throw new Error(`Refusing to delete ${orgId}: only demo sandboxes can be deleted`);
}

const newSecret = () => randomBytes(32).toString('hex');

/** One rise waiting for finance in the demo, so the approvals screen has something on it. */
function seedPayChanges(today: string): PayChange[] {
  return [{
    id: 'pay_demo1',
    employeeId: 'mar-5',
    siteId: 'mar',
    before: { payBasis: 'hourly', hourlyRate: 12.71, annualSalary: 0 },
    after: { payBasis: 'hourly', hourlyRate: 13.25, annualSalary: 0 },
    reason: 'Six months in, signed off on the pass and covering prep. Brings him level with the other KPs on 30 hours.',
    status: 'pending',
    requestedBy: 'Kate Morgan',
    requestedById: 'usr_people',
    requestedAt: `${addDays(today, -2)}T10:15:00.000Z`,
  }];
}

function newOrg(orgId: string, seeded: boolean, today?: string): OrgData {
  // The demo's fictional people never go into a deployment: there they would sit on the real Access tab
  // and count as administrators, so the last real one could be removed. Local and test only.
  const deployed = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';
  const people = seeded && !deployed ? seedUsers(today ?? toISODate(new Date())) : { users: [], reviews: [] };
  return {
    orgId,
    // A copy each: the seed's objects are shared, and one organisation's change must not show in another's.
    state: seeded
      ? structuredClone(seedState(today))
      : { entities: [], sites: [], roles: [], employees: [], shifts: [], forecast: [], demandRules: [], sales: [], actuals: [], forecastAdjustments: [], weather: [], localEvents: [], bookings: [], bookingPace: [], schoolHolidays: [] },
    timeEntries: [],
    submissions: [],
    payRuns: [],
    outbox: [],
    processedWebhookIds: new Set(),
    audit: [],
    moves: [],
    publications: [],
    programmes: [],
    settings: {},
    eventFeeds: [],
    reminderStates: [],
    users: people.users,
    accessReviews: people.reviews,
    inviteTokens: {},
    inviteSends: {},
    mail: {},
    authenticators: seeded ? demoAuthenticators(people.users) : {},
    hrRecords: seeded ? seedHrRecords(today) : [],
    payChanges: seeded ? seedPayChanges(today ?? toISODate(new Date())) : [],
    staffLoginLog: [],
    loginReviews: [],
  };
}

/**
 * Organisations saved before entities existed have none. They get one company
 * that holds every site and employs everyone, which is how they were costed
 * before, so their journals do not change on upgrade.
 */
export function upgradeState(state: RotaState): RotaState {
  const entities = [...(state.entities ?? [])];
  if (entities.length === 0 && (state.sites.length > 0 || state.employees.length > 0)) {
    entities.push({ id: 'main', name: 'Main company', companyNumber: '', payeReference: '', intercompanyCode: '1350' });
  }
  const fallback = entities[0]?.id ?? '';
  const sites = state.sites.map((s) => (s.entityId ? s : { ...s, entityId: fallback }));
  const employees = state.employees.map((e) => ({
    ...e,
    entityId: e.entityId || sites.find((s) => s.id === e.siteId)?.entityId || fallback,
    coverSiteIds: e.coverSiteIds ?? [],
  }));
  return {
    ...state,
    entities,
    sites,
    employees,
    sales: state.sales ?? [],
    actuals: state.actuals ?? [],
    forecastAdjustments: state.forecastAdjustments ?? [],
    weather: state.weather ?? [],
    localEvents: state.localEvents ?? [],
    bookings: state.bookings ?? [],
    bookingPace: state.bookingPace ?? [],
    schoolHolidays: state.schoolHolidays ?? [],
  };
}

export class MemoryStore implements Store {
  private readonly orgs = new Map<string, OrgData>();
  private readonly users = new Map<string, UserRecord>();
  private readonly secret = newSecret();

  constructor(private readonly seedOrgIds: string[] = ['demo'], private readonly today?: string) {}

  async load(orgId: string) {
    let data = this.orgs.get(orgId);
    if (!data) {
      data = newOrg(orgId, this.seedOrgIds.includes(orgId), this.today);
      this.orgs.set(orgId, data);
    }
    return data;
  }

  async save() {
    // Requests work on the stored object directly.
  }

  async has(orgId: string) {
    return this.orgs.has(orgId) || this.seedOrgIds.includes(orgId);
  }

  todayISO() {
    return this.today ?? toISODate(new Date());
  }

  async orgIds() {
    return [...this.orgs.keys()];
  }

  async sandboxIds() {
    return [...this.orgs.keys()].filter(isSandbox);
  }

  async deleteSandbox(orgId: string) {
    assertSandbox(orgId);
    this.orgs.delete(orgId);
    for (const [email, user] of this.users) if (user.orgId === orgId) this.users.delete(email);
    for (const [key, login] of this.staff) if (login.orgId === orgId) this.staff.delete(key);
    for (const key of this.documents.keys()) if (key.startsWith(`${orgId}/`)) this.documents.delete(key);
    for (let i = this.documentAccess.length - 1; i >= 0; i--) if (this.documentAccess[i].orgId === orgId) this.documentAccess.splice(i, 1);
    for (const [hash, key] of this.apiKeys) if (key.orgId === orgId) this.apiKeys.delete(hash);
  }

  async sessionSecret() {
    return this.secret;
  }

  async getUser(email: string) {
    const user = this.users.get(email);
    return user ? { ...user } : null;
  }

  async listUsers(orgId: string) {
    return [...this.users.values()].filter((u) => orgsOfAccount(u).includes(orgId)).map((u) => ({ ...u }));
  }

  async hasUsers() {
    return [...this.users.values()].some((u) => !isSandbox(u.orgId));
  }

  async createUser(user: UserRecord, options: { onlyIfFirst?: boolean } = {}) {
    if (this.users.has(user.email) || (options.onlyIfFirst && (await this.hasUsers()))) return false;
    this.users.set(user.email, { ...user });
    return true;
  }

  async updateUser(email: string, patch: Partial<UserRecord>) {
    const user = this.users.get(email);
    if (user) this.users.set(email, { ...user, ...patch, email });
  }

  async deleteUser(email: string) {
    this.users.delete(email);
  }

  private readonly staff = new Map<string, StaffLogin>();
  private readonly staffKey = (orgId: string, employeeId: string) => `${orgId}/${employeeId}`;

  async getStaffLogin(orgId: string, employeeId: string) {
    const login = this.staff.get(this.staffKey(orgId, employeeId));
    return login ? { ...login } : null;
  }

  async getStaffLoginByEmail(email: string) {
    const login = [...this.staff.values()].find((l) => l.email === email);
    return login ? { ...login } : null;
  }

  async listStaffLogins(orgId: string) {
    return [...this.staff.values()].filter((l) => l.orgId === orgId).map((l) => ({ ...l }));
  }

  async putStaffLogin(login: StaffLogin) {
    const key = this.staffKey(login.orgId, login.employeeId);
    if (login.email && [...this.staff.entries()].some(([k, l]) => k !== key && l.email === login.email)) return false;
    this.staff.set(key, { ...login });
    return true;
  }

  async deleteStaffLogin(orgId: string, employeeId: string) {
    this.staff.delete(this.staffKey(orgId, employeeId));
  }

  async findUserByResetToken(tokenHash: string, nowSeconds: number) {
    const user = [...this.users.values()].find((u) => u.resetTokenHash === tokenHash && (u.resetExpires ?? 0) > nowSeconds);
    return user ? { ...user } : null;
  }

  async claimPasswordReset(tokenHash: string, nowSeconds: number, patch: Partial<UserRecord>) {
    const user = await this.findUserByResetToken(tokenHash, nowSeconds);
    if (!user) return null;
    const next = { ...user, ...patch, email: user.email, resetTokenHash: undefined, resetExpires: undefined };
    this.users.set(user.email, next);
    return { ...next };
  }

  private readonly apiKeys = new Map<string, ApiKeyRecord>();

  async getApiKeyByHash(hash: string) {
    const key = this.apiKeys.get(hash);
    return key ? { ...key } : null;
  }

  async listApiKeys(orgId: string) {
    return [...this.apiKeys.values()].filter((k) => k.orgId === orgId).map((k) => ({ ...k }));
  }

  async putApiKey(key: ApiKeyRecord) {
    this.apiKeys.set(key.hash, { ...key });
  }

  async revokeApiKey(orgId: string, id: string, by: string) {
    const found = [...this.apiKeys.values()].find((k) => k.orgId === orgId && k.id === id && !k.revokedAt);
    if (found) this.apiKeys.set(found.hash, { ...found, revokedAt: new Date().toISOString(), revokedBy: by });
    return !!found;
  }

  private apiCalls: ApiCall[] = [];

  async logApiCall(call: ApiCall) {
    this.apiCalls.push({ ...call });
    // Memory is for development and tests; keep it bounded.
    if (this.apiCalls.length > 100_000) this.apiCalls.splice(0, this.apiCalls.length - 100_000);
  }

  async listApiCalls(orgId: string, keyId: string, options: { from?: string; to?: string; limit: number }) {
    return this.apiCalls
      .filter((c) => c.orgId === orgId && c.keyId === keyId && (!options.from || c.at >= options.from) && (!options.to || c.at < options.to))
      .reverse()
      .slice(0, options.limit)
      .map((c) => ({ ...c }));
  }

  async purgeApiCalls(before: string) {
    const kept = this.apiCalls.filter((c) => c.at >= before);
    const removed = this.apiCalls.length - kept.length;
    this.apiCalls = kept;
    return removed;
  }

  private readonly documents = new Map<string, StoredFile>();

  async putDocument(orgId: string, id: string, file: StoredFile) {
    this.documents.set(`${orgId}/${id}`, { contentType: file.contentType, data: Buffer.from(file.data) });
  }

  async getDocument(orgId: string, id: string) {
    const file = this.documents.get(`${orgId}/${id}`);
    return file ? { contentType: file.contentType, data: Buffer.from(file.data) } : null;
  }

  async deleteDocument(orgId: string, id: string) {
    this.documents.delete(`${orgId}/${id}`);
  }

  private readonly documentAccess: DocumentAccess[] = [];

  async logDocumentAccess(entry: DocumentAccess) {
    this.documentAccess.push({ ...entry });
  }

  async listDocumentAccess(orgId: string, documentId: string) {
    return this.documentAccess.filter((a) => a.orgId === orgId && a.documentId === documentId).map((a) => ({ ...a }));
  }

  private readonly settings = new Map<string, string>();

  async getSetting(key: string) {
    return this.settings.get(key) ?? null;
  }

  async setSetting(key: string, value: string | null) {
    if (value === null) this.settings.delete(key);
    else this.settings.set(key, value);
  }

  async addToSetting(key: string, amount: number) {
    const total = Number(this.settings.get(key) ?? 0) + amount;
    this.settings.set(key, String(total));
    return total;
  }

  async settingOnce(key: string, make: () => string) {
    if (!this.settings.has(key)) this.settings.set(key, make());
    return this.settings.get(key)!;
  }
}

/** Runs one parameterised statement and returns its rows. Neon's HTTP driver and PGlite both fit. */
export type Query = (text: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

/**
 * Postgres store. Each organisation is one JSONB document with a version
 * number, in its own `preshift` schema. Right for this stage: one round trip
 * per request, no migrations while the model moves. Split into tables when
 * reporting across organisations needs SQL over shifts and hours.
 */
export class PgStore implements Store {
  private ready: Promise<void> | null = null;

  constructor(private readonly query: Query, private readonly seedOrgIds: string[] = ['demo'], private readonly today?: string) {}

  private init() {
    this.ready ??= (async () => {
      // Interlock: Preshift only ever runs in a database of its own. If this one already holds
      // another system's tables, refuse to touch it rather than write the JV's data alongside them.
      const foreign = await this.query(
        `select count(*)::int as n from information_schema.tables
         where table_schema not in ('information_schema', 'preshift', 'neon_auth') and table_schema not like 'pg\\_%'`,
        [],
      );
      if (Number(foreign[0].n) > 0) {
        throw new HttpError(
          503,
          'database_not_dedicated',
          'This database already belongs to another system, so Preshift will not use it. Give Preshift its own Neon database.',
        );
      }
      await this.query('create schema if not exists preshift', []);
      await this.query(
        `create table if not exists preshift.orgs (
           org_id text primary key,
           data jsonb not null,
           version integer not null default 1,
           updated_at timestamptz not null default now()
         )`,
        [],
      );
      await this.query(
        `create table if not exists preshift.users (
           email text primary key,
           org_id text not null,
           data jsonb not null,
           created_at timestamptz not null default now()
         )`,
        [],
      );
      await this.query('create index if not exists users_org_idx on preshift.users (org_id)', []);
      await this.query('create table if not exists preshift.settings (key text primary key, value text not null)', []);
      await this.query(
        `create table if not exists preshift.staff_logins (
           org_id text not null,
           employee_id text not null,
           email text unique,
           data jsonb not null,
           primary key (org_id, employee_id)
         )`,
        [],
      );
      await this.query(
        `create table if not exists preshift.api_keys (
           hash text primary key,
           org_id text not null,
           id text not null,
           data jsonb not null,
           created_at timestamptz not null default now()
         )`,
        [],
      );
      await this.query('create index if not exists api_keys_org_idx on preshift.api_keys (org_id)', []);
      await this.query(
        `create table if not exists preshift.api_calls (
           seq bigserial primary key,
           org_id text not null,
           key_id text not null,
           at timestamptz not null,
           data jsonb not null
         )`,
        [],
      );
      await this.query('create index if not exists api_calls_key_idx on preshift.api_calls (org_id, key_id, at)', []);
      await this.query('create index if not exists api_calls_at_idx on preshift.api_calls (at)', []);
      // Base64 text rather than bytea: Neon's HTTP driver and PGlite pass strings identically.
      await this.query(
        `create table if not exists preshift.documents (
           org_id text not null,
           id text not null,
           content_type text not null,
           data text not null,
           created_at timestamptz not null default now(),
           primary key (org_id, id)
         )`,
        [],
      );
      await this.query(
        `create table if not exists preshift.document_access (
           seq bigserial primary key,
           org_id text not null,
           document_id text not null,
           data jsonb not null,
           at timestamptz not null default now()
         )`,
        [],
      );
      await this.query('create index if not exists document_access_doc_idx on preshift.document_access (org_id, document_id)', []);
    })().catch((err) => {
      // Instances starting together can collide creating the schema; let the next request try again
      // rather than leave this instance failing every request until it is recycled.
      this.ready = null;
      throw err;
    });
    return this.ready;
  }

  async load(orgId: string): Promise<OrgData> {
    await this.init();
    let rows = await this.query('select data, version from preshift.orgs where org_id = $1', [orgId]);
    if (rows.length === 0) {
      const fresh = newOrg(orgId, this.seedOrgIds.includes(orgId), this.today);
      await this.query('insert into preshift.orgs (org_id, data) values ($1, $2) on conflict do nothing', [orgId, serialise(fresh)]);
      rows = await this.query('select data, version from preshift.orgs where org_id = $1', [orgId]);
    }
    return deserialise(rows[0].data, Number(rows[0].version));
  }

  async save(org: OrgData) {
    await this.init();
    const rows = await this.query(
      `update preshift.orgs set data = $2, version = version + 1, updated_at = now()
       where org_id = $1 and version = $3 returning version`,
      [org.orgId, serialise(org), org.version ?? 1],
    );
    if (rows.length === 0) {
      throw new HttpError(409, 'conflict', 'Someone else changed this organisation at the same time. Reload and try again.');
    }
    org.version = Number(rows[0].version);
  }

  /** Whether the database is reachable and Preshift's own; for the health check. */
  async status(): Promise<'ok' | string> {
    try {
      await this.init();
      return 'ok';
    } catch (err) {
      return err instanceof HttpError ? err.code : 'unreachable';
    }
  }

  async has(orgId: string) {
    await this.init();
    if (this.seedOrgIds.includes(orgId)) return true;
    return (await this.query('select 1 from preshift.orgs where org_id = $1', [orgId])).length > 0;
  }

  todayISO() {
    return this.today ?? toISODate(new Date());
  }

  async orgIds() {
    await this.init();
    const rows = await this.query('select org_id from preshift.orgs', []);
    return rows.map((r) => String(r.org_id));
  }

  async sandboxIds() {
    await this.init();
    const rows = await this.query(`select org_id from preshift.orgs where org_id like '${SANDBOX_PREFIX}%'`, []);
    return rows.map((r) => String(r.org_id));
  }

  async deleteSandbox(orgId: string) {
    assertSandbox(orgId);
    await this.init();
    // The prefix is repeated in each statement: even a wrong id from the caller cannot reach a customer row.
    const only = `and org_id like '${SANDBOX_PREFIX}%'`;
    await this.query(`delete from preshift.api_keys where org_id = $1 ${only}`, [orgId]);
    await this.query(`delete from preshift.document_access where org_id = $1 ${only}`, [orgId]);
    await this.query(`delete from preshift.documents where org_id = $1 ${only}`, [orgId]);
    await this.query(`delete from preshift.staff_logins where org_id = $1 ${only}`, [orgId]);
    await this.query(`delete from preshift.users where org_id = $1 ${only}`, [orgId]);
    await this.query(`delete from preshift.orgs where org_id = $1 ${only}`, [orgId]);
  }

  private secretCache: string | null = null;

  async sessionSecret() {
    if (this.secretCache) return this.secretCache;
    await this.init();
    // Instances racing on first start all keep whichever secret was written first.
    await this.query(`insert into preshift.settings (key, value) values ('session_secret', $1) on conflict do nothing`, [newSecret()]);
    const rows = await this.query(`select value from preshift.settings where key = 'session_secret'`, []);
    this.secretCache = String(rows[0].value);
    return this.secretCache;
  }

  async getUser(email: string) {
    await this.init();
    const rows = await this.query('select data from preshift.users where email = $1', [email]);
    return rows.length ? userFrom(rows[0].data) : null;
  }

  async listUsers(orgId: string) {
    await this.init();
    // Accounts at home here, and accounts from elsewhere that have joined.
    const rows = await this.query(
      `select data from preshift.users where org_id = $1 or coalesce(data->'orgs', '[]'::jsonb) @> jsonb_build_array($1::text) order by created_at`,
      [orgId],
    );
    return rows.map((r) => userFrom(r.data));
  }

  async hasUsers() {
    await this.init();
    return (await this.query(`select 1 from preshift.users where org_id not like '${SANDBOX_PREFIX}%' limit 1`, [])).length > 0;
  }

  async createUser(user: UserRecord, options: { onlyIfFirst?: boolean } = {}) {
    await this.init();
    // One statement, so two people racing to create the first account cannot both succeed.
    const rows = await this.query(
      `insert into preshift.users (email, org_id, data)
       select $1, $2, $3 where not $4 or not exists (select 1 from preshift.users where org_id not like '${SANDBOX_PREFIX}%')
       on conflict do nothing returning email`,
      [user.email, user.orgId, JSON.stringify(user), Boolean(options.onlyIfFirst)],
    );
    return rows.length > 0;
  }

  async updateUser(email: string, patch: Partial<UserRecord>) {
    const user = await this.getUser(email);
    if (!user) return;
    const next = { ...user, ...patch, email };
    await this.query('update preshift.users set org_id = $2, data = $3 where email = $1', [email, next.orgId, JSON.stringify(next)]);
  }

  async deleteUser(email: string) {
    await this.init();
    await this.query('delete from preshift.users where email = $1', [email]);
  }

  async getStaffLogin(orgId: string, employeeId: string) {
    await this.init();
    const rows = await this.query('select data from preshift.staff_logins where org_id = $1 and employee_id = $2', [orgId, employeeId]);
    return rows.length ? staffFrom(rows[0].data) : null;
  }

  async getStaffLoginByEmail(email: string) {
    await this.init();
    const rows = await this.query('select data from preshift.staff_logins where email = $1', [email]);
    return rows.length ? staffFrom(rows[0].data) : null;
  }

  async listStaffLogins(orgId: string) {
    await this.init();
    const rows = await this.query('select data from preshift.staff_logins where org_id = $1', [orgId]);
    return rows.map((r) => staffFrom(r.data));
  }

  async putStaffLogin(login: StaffLogin) {
    await this.init();
    // The unique email column decides a race between two people claiming one address.
    const rows = await this.query(
      `insert into preshift.staff_logins (org_id, employee_id, email, data) values ($1, $2, $3, $4)
       on conflict (org_id, employee_id) do update set email = excluded.email, data = excluded.data
       returning employee_id`,
      [login.orgId, login.employeeId, login.email ?? null, JSON.stringify(login)],
    ).catch((err: { code?: string }) => {
      if (err?.code === '23505') return [];
      throw err;
    });
    return rows.length > 0;
  }

  async deleteStaffLogin(orgId: string, employeeId: string) {
    await this.init();
    await this.query('delete from preshift.staff_logins where org_id = $1 and employee_id = $2', [orgId, employeeId]);
  }

  async findUserByResetToken(tokenHash: string, nowSeconds: number) {
    await this.init();
    const rows = await this.query(
      `select data from preshift.users where data->>'resetTokenHash' = $1 and (data->>'resetExpires')::bigint > $2`,
      [tokenHash, nowSeconds],
    );
    return rows.length ? userFrom(rows[0].data) : null;
  }

  async claimPasswordReset(tokenHash: string, nowSeconds: number, patch: Partial<UserRecord>) {
    await this.init();
    // One statement matches the unused link and clears it, so of two requests racing on the same
    // link only one finds it.
    const rows = await this.query(
      `update preshift.users set data = (data || $3::jsonb) - 'resetTokenHash' - 'resetExpires'
       where data->>'resetTokenHash' = $1 and (data->>'resetExpires')::bigint > $2
       returning data`,
      [tokenHash, nowSeconds, JSON.stringify(patch)],
    );
    return rows.length ? userFrom(rows[0].data) : null;
  }

  async getApiKeyByHash(hash: string) {
    await this.init();
    const rows = await this.query('select data from preshift.api_keys where hash = $1', [hash]);
    return rows.length ? jsonFrom<ApiKeyRecord>(rows[0].data) : null;
  }

  async listApiKeys(orgId: string) {
    await this.init();
    const rows = await this.query('select data from preshift.api_keys where org_id = $1 order by created_at', [orgId]);
    return rows.map((r) => jsonFrom<ApiKeyRecord>(r.data));
  }

  async putApiKey(key: ApiKeyRecord) {
    await this.init();
    await this.query(
      `insert into preshift.api_keys (hash, org_id, id, data) values ($1, $2, $3, $4)
       on conflict (hash) do update set data = excluded.data`,
      [key.hash, key.orgId, key.id, JSON.stringify(key)],
    );
  }

  async revokeApiKey(orgId: string, id: string, by: string) {
    await this.init();
    // One statement, so two people revoking at once both see the key revoked and only one records it.
    const rows = await this.query(
      `update preshift.api_keys set data = data || jsonb_build_object('revokedAt', $3::text, 'revokedBy', $4::text)
       where org_id = $1 and id = $2 and not (data ? 'revokedAt') returning id`,
      [orgId, id, new Date().toISOString(), by],
    );
    return rows.length > 0;
  }

  async logApiCall(call: ApiCall) {
    await this.init();
    await this.query('insert into preshift.api_calls (org_id, key_id, at, data) values ($1, $2, $3, $4)', [
      call.orgId,
      call.keyId,
      call.at,
      JSON.stringify(call),
    ]);
  }

  async listApiCalls(orgId: string, keyId: string, options: { from?: string; to?: string; limit: number }) {
    await this.init();
    const rows = await this.query(
      `select data from preshift.api_calls
       where org_id = $1 and key_id = $2 and ($3::timestamptz is null or at >= $3) and ($4::timestamptz is null or at < $4)
       order by at desc, seq desc limit $5`,
      [orgId, keyId, options.from ?? null, options.to ?? null, options.limit],
    );
    return rows.map((r) => jsonFrom<ApiCall>(r.data));
  }

  async purgeApiCalls(before: string) {
    await this.init();
    const rows = await this.query('with gone as (delete from preshift.api_calls where at < $1 returning 1) select count(*)::int as n from gone', [before]);
    return Number(rows[0].n);
  }

  async putDocument(orgId: string, id: string, file: StoredFile) {
    await this.init();
    await this.query(
      `insert into preshift.documents (org_id, id, content_type, data) values ($1, $2, $3, $4)
       on conflict (org_id, id) do update set content_type = excluded.content_type, data = excluded.data`,
      [orgId, id, file.contentType, file.data.toString('base64')],
    );
  }

  async getDocument(orgId: string, id: string) {
    await this.init();
    const rows = await this.query('select content_type, data from preshift.documents where org_id = $1 and id = $2', [orgId, id]);
    return rows.length ? { contentType: String(rows[0].content_type), data: Buffer.from(String(rows[0].data), 'base64') } : null;
  }

  async deleteDocument(orgId: string, id: string) {
    await this.init();
    await this.query('delete from preshift.documents where org_id = $1 and id = $2', [orgId, id]);
  }

  async logDocumentAccess(entry: DocumentAccess) {
    await this.init();
    await this.query('insert into preshift.document_access (org_id, document_id, data) values ($1, $2, $3)', [
      entry.orgId,
      entry.documentId,
      JSON.stringify(entry),
    ]);
  }

  async listDocumentAccess(orgId: string, documentId: string) {
    await this.init();
    const rows = await this.query('select data from preshift.document_access where org_id = $1 and document_id = $2 order by seq', [orgId, documentId]);
    return rows.map((r) => (typeof r.data === 'string' ? JSON.parse(r.data) : r.data) as DocumentAccess);
  }

  async getSetting(key: string) {
    await this.init();
    const rows = await this.query('select value from preshift.settings where key = $1', [key]);
    return rows.length ? String(rows[0].value) : null;
  }

  async settingOnce(key: string, make: () => string) {
    await this.init();
    // Instances racing on first use all keep whichever value was written first.
    await this.query('insert into preshift.settings (key, value) values ($1, $2) on conflict do nothing', [key, make()]);
    const rows = await this.query('select value from preshift.settings where key = $1', [key]);
    return String(rows[0].value);
  }

  async setSetting(key: string, value: string | null) {
    await this.init();
    if (value === null) await this.query('delete from preshift.settings where key = $1', [key]);
    else {
      await this.query(
        'insert into preshift.settings (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value',
        [key, value],
      );
    }
  }
  async addToSetting(key: string, amount: number) {
    await this.init();
    // One statement, so two requests finishing together both count.
    const rows = await this.query(
      `insert into preshift.settings (key, value) values ($1, $2::text)
       on conflict (key) do update set value = (preshift.settings.value::numeric + $2::numeric)::text
       returning value`,
      [key, String(amount)],
    );
    return Number(rows[0].value);
  }

}

function jsonFrom<T>(data: unknown): T {
  return (typeof data === 'string' ? JSON.parse(data) : data) as T;
}

function staffFrom(data: unknown): StaffLogin {
  return (typeof data === 'string' ? JSON.parse(data) : data) as StaffLogin;
}

function userFrom(data: unknown): UserRecord {
  return (typeof data === 'string' ? JSON.parse(data) : data) as UserRecord;
}

function serialise(org: OrgData): string {
  const { version: _version, processedWebhookIds, ...rest } = org;
  return JSON.stringify({ ...rest, processedWebhookIds: [...processedWebhookIds] });
}

function deserialise(data: unknown, version: number): OrgData {
  const raw = (typeof data === 'string' ? JSON.parse(data) : data) as Omit<OrgData, 'processedWebhookIds'> & { processedWebhookIds: string[] };
  // Organisations saved before access management load with nobody on record, not a failure.
  return {
    ...raw,
    hrRecords: raw.hrRecords ?? [],
    payChanges: raw.payChanges ?? [],
    // Organisations saved before the staff login review began their log empty.
    staffLoginLog: raw.staffLoginLog ?? [],
    loginReviews: raw.loginReviews ?? [],
    state: upgradeState(raw.state),
    users: raw.users ?? [],
    accessReviews: raw.accessReviews ?? [],
    inviteTokens: raw.inviteTokens ?? {},
    inviteSends: raw.inviteSends ?? {},
    mail: raw.mail ?? {},
    authenticators: raw.authenticators ?? {},
    processedWebhookIds: new Set(raw.processedWebhookIds),
    // Organisations saved before coaching and the programme existed.
    moves: raw.moves ?? [],
    publications: raw.publications ?? [],
    programmes: raw.programmes ?? [],
    settings: raw.settings ?? {},
    eventFeeds: raw.eventFeeds ?? [],
    reminderStates: raw.reminderStates ?? [],
    version,
  };
}

export function audit(org: OrgData, actor: string, action: string, detail?: Record<string, unknown>) {
  org.audit.push({ at: new Date().toISOString(), actor, action, detail });
  if (org.audit.length > 5000) org.audit.splice(0, org.audit.length - 5000);
  // Every change worth telling a partner about is already audited, so webhooks are raised here,
  // in the same save as the change.
  queueEvent(org, action, detail);
}
