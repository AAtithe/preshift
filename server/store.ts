import { randomBytes } from 'node:crypto';
import type { AccessReview, User } from '../src/engine/access';
import { seedHrRecords, seedState } from '../src/engine/seed';
import type { RetentionPolicy, SubjectRequest } from '../src/engine/gdpr';
import { toISODate } from '../src/engine/time';
import type { PayrollVariance } from '../src/engine/timesheet';
import type { HrRecord, RotaState, TimeEntry } from '../src/engine/types';
import { HttpError } from './context';
import { isSandbox, SANDBOX_PREFIX } from './sandbox';
import type { OutboxItem } from './outbox';
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
  sentAt: string;
  /** Who sent it: a person's name, or the sign-in page for "Forgot your password?". */
  by: string;
  /** Kept as reported, oldest first; the status is read from them (maillog.statusOf), never stored. */
  events: { id: string; type: MailEventType; at: string; detail?: string }[];
}

export interface OrgData {
  orgId: string;
  state: RotaState;
  timeEntries: TimeEntry[];
  submissions: PayrollSubmission[];
  payRuns: PayRunRecord[];
  outbox: OutboxItem[];
  processedWebhookIds: Set<string>;
  audit: AuditEvent[];
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
  /** UK GDPR: the organisation's retention periods and its log of requests from staff about their data. */
  privacy?: { policy?: RetentionPolicy; requests: SubjectRequest[] };
  /** Row version for optimistic locking in persistent stores. */
  version?: number;
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
}

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
  via: 'session' | 'api key';
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
export interface Store extends UserStore, StaffStore, DocumentStore {
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
   * Deletes a demo sandbox for good: its data, its visitor account, staff logins and documents. Refuses
   * anything that is not a sandbox id, in code and again in the database statement itself, so no
   * fault in the caller can delete a customer.
   */
  deleteSandbox(orgId: string): Promise<void>;
}

function assertSandbox(orgId: string) {
  if (!isSandbox(orgId)) throw new Error(`Refusing to delete ${orgId}: only demo sandboxes can be deleted`);
}

const newSecret = () => randomBytes(32).toString('hex');

function newOrg(orgId: string, seeded: boolean, today?: string): OrgData {
  // The demo's fictional people never go into a deployment: there they would sit on the real Access tab
  // and count as administrators, so the last real one could be removed. Local and test only.
  const deployed = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';
  const people = seeded && !deployed ? seedUsers(today ?? toISODate(new Date())) : { users: [], reviews: [] };
  return {
    orgId,
    // A copy each: the seed's objects are shared, and one organisation's change must not show in another's.
    state: seeded ? structuredClone(seedState(today)) : { entities: [], sites: [], roles: [], employees: [], shifts: [], forecast: [], demandRules: [], sales: [] },
    timeEntries: [],
    submissions: [],
    payRuns: [],
    outbox: [],
    processedWebhookIds: new Set(),
    audit: [],
    users: people.users,
    accessReviews: people.reviews,
    inviteTokens: {},
    inviteSends: {},
    mail: {},
    authenticators: seeded ? demoAuthenticators(people.users) : {},
    hrRecords: seeded ? seedHrRecords(today) : [],
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
  return { ...state, entities, sites, employees, sales: state.sales ?? [] };
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
    state: upgradeState(raw.state),
    users: raw.users ?? [],
    accessReviews: raw.accessReviews ?? [],
    inviteTokens: raw.inviteTokens ?? {},
    inviteSends: raw.inviteSends ?? {},
    mail: raw.mail ?? {},
    authenticators: raw.authenticators ?? {},
    processedWebhookIds: new Set(raw.processedWebhookIds),
    version,
  };
}

export function audit(org: OrgData, actor: string, action: string, detail?: Record<string, unknown>) {
  org.audit.push({ at: new Date().toISOString(), actor, action, detail });
  if (org.audit.length > 5000) org.audit.splice(0, org.audit.length - 5000);
}
