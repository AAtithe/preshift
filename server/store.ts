import { randomBytes } from 'node:crypto';
import { seedState } from '../src/engine/seed';
import type { PayrollVariance } from '../src/engine/timesheet';
import type { RotaState, TimeEntry } from '../src/engine/types';
import { HttpError } from './context';
import type { OutboxItem } from './outbox';

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

export interface OrgData {
  orgId: string;
  state: RotaState;
  timeEntries: TimeEntry[];
  submissions: PayrollSubmission[];
  payRuns: PayRunRecord[];
  outbox: OutboxItem[];
  processedWebhookIds: Set<string>;
  audit: AuditEvent[];
  /** Row version for optimistic locking in persistent stores. */
  version?: number;
}

export type UserRole = 'admin' | 'member';

/** A person who signs in to the web app. Passwords are held only as scrypt salt and hash. */
export interface UserRecord {
  email: string;
  orgId: string;
  role: UserRole;
  salt: string;
  hash: string;
  createdAt: string;
  /** Sessions issued before this (epoch milliseconds) are refused: set on a password change or reset. */
  sessionsValidFrom: number;
  failedAttempts: number;
  /** Epoch seconds; sign-in is refused until then after repeated failures. */
  lockedUntil: number;
}

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
  /** Adds the person; false if the email is taken. With onlyIfFirst, also false once anyone exists. */
  createUser(user: UserRecord, options?: { onlyIfFirst?: boolean }): Promise<boolean>;
  updateUser(email: string, patch: Partial<Omit<UserRecord, 'email' | 'createdAt'>>): Promise<void>;
  deleteUser(email: string): Promise<void>;
  /** Secrets and settings kept apart from organisation data, so no data endpoint can return them. */
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string | null): Promise<void>;
}

/**
 * Tenancy boundary: every request loads exactly one organisation, works on it,
 * and saves it once at the end. A save that finds the organisation changed
 * underneath it is refused rather than overwriting someone else's work.
 */
export interface Store extends UserStore {
  load(orgId: string): Promise<OrgData>;
  save(org: OrgData): Promise<void>;
  orgIds(): Promise<string[]>;
  /** Removes the organisation's data for good. Used only to clear away expired demo sandboxes. */
  deleteOrg(orgId: string): Promise<void>;
}

const newSecret = () => randomBytes(32).toString('hex');

function newOrg(orgId: string, seeded: boolean, today?: string): OrgData {
  return {
    orgId,
    state: seeded ? seedState(today) : { entities: [], sites: [], roles: [], employees: [], shifts: [], forecast: [], demandRules: [] },
    timeEntries: [],
    submissions: [],
    payRuns: [],
    outbox: [],
    processedWebhookIds: new Set(),
    audit: [],
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
  return { ...state, entities, sites, employees };
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

  async orgIds() {
    return [...this.orgs.keys()];
  }

  async deleteOrg(orgId: string) {
    this.orgs.delete(orgId);
  }

  async sessionSecret() {
    return this.secret;
  }

  async getUser(email: string) {
    const user = this.users.get(email);
    return user ? { ...user } : null;
  }

  async listUsers(orgId: string) {
    return [...this.users.values()].filter((u) => u.orgId === orgId).map((u) => ({ ...u }));
  }

  async hasUsers() {
    return this.users.size > 0;
  }

  async createUser(user: UserRecord, options: { onlyIfFirst?: boolean } = {}) {
    if (this.users.has(user.email) || (options.onlyIfFirst && this.users.size > 0)) return false;
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

  private readonly settings = new Map<string, string>();

  async getSetting(key: string) {
    return this.settings.get(key) ?? null;
  }

  async setSetting(key: string, value: string | null) {
    if (value === null) this.settings.delete(key);
    else this.settings.set(key, value);
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

  async orgIds() {
    await this.init();
    const rows = await this.query('select org_id from preshift.orgs', []);
    return rows.map((r) => String(r.org_id));
  }

  async deleteOrg(orgId: string) {
    await this.init();
    await this.query('delete from preshift.orgs where org_id = $1', [orgId]);
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
    const rows = await this.query('select data from preshift.users where org_id = $1 order by created_at', [orgId]);
    return rows.map((r) => userFrom(r.data));
  }

  async hasUsers() {
    await this.init();
    return (await this.query('select 1 from preshift.users limit 1', [])).length > 0;
  }

  async createUser(user: UserRecord, options: { onlyIfFirst?: boolean } = {}) {
    await this.init();
    // One statement, so two people racing to create the first account cannot both succeed.
    const rows = await this.query(
      `insert into preshift.users (email, org_id, data)
       select $1, $2, $3 where not $4 or not exists (select 1 from preshift.users)
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

  async getSetting(key: string) {
    await this.init();
    const rows = await this.query('select value from preshift.settings where key = $1', [key]);
    return rows.length ? String(rows[0].value) : null;
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

function userFrom(data: unknown): UserRecord {
  return (typeof data === 'string' ? JSON.parse(data) : data) as UserRecord;
}

function serialise(org: OrgData): string {
  const { version: _version, processedWebhookIds, ...rest } = org;
  return JSON.stringify({ ...rest, processedWebhookIds: [...processedWebhookIds] });
}

function deserialise(data: unknown, version: number): OrgData {
  const raw = (typeof data === 'string' ? JSON.parse(data) : data) as Omit<OrgData, 'processedWebhookIds'> & { processedWebhookIds: string[] };
  return { ...raw, state: upgradeState(raw.state), processedWebhookIds: new Set(raw.processedWebhookIds), version };
}

export function audit(org: OrgData, actor: string, action: string, detail?: Record<string, unknown>) {
  org.audit.push({ at: new Date().toISOString(), actor, action, detail });
  if (org.audit.length > 5000) org.audit.splice(0, org.audit.length - 5000);
}
