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
}

export interface PayRunRecord {
  id: string;
  periodStart: string;
  periodEnd: string;
  receivedAt: string;
  variance: PayrollVariance;
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

/**
 * Tenancy boundary: every request loads exactly one organisation, works on it,
 * and saves it once at the end. A save that finds the organisation changed
 * underneath it is refused rather than overwriting someone else's work.
 */
export interface Store {
  load(orgId: string): Promise<OrgData>;
  save(org: OrgData): Promise<void>;
  orgIds(): Promise<string[]>;
}

function newOrg(orgId: string, seeded: boolean, today?: string): OrgData {
  return {
    orgId,
    state: seeded ? seedState(today) : { sites: [], roles: [], employees: [], shifts: [], forecast: [], demandRules: [] },
    timeEntries: [],
    submissions: [],
    payRuns: [],
    outbox: [],
    processedWebhookIds: new Set(),
    audit: [],
  };
}

export class MemoryStore implements Store {
  private readonly orgs = new Map<string, OrgData>();

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
}

function serialise(org: OrgData): string {
  const { version: _version, processedWebhookIds, ...rest } = org;
  return JSON.stringify({ ...rest, processedWebhookIds: [...processedWebhookIds] });
}

function deserialise(data: unknown, version: number): OrgData {
  const raw = (typeof data === 'string' ? JSON.parse(data) : data) as Omit<OrgData, 'processedWebhookIds'> & { processedWebhookIds: string[] };
  return { ...raw, processedWebhookIds: new Set(raw.processedWebhookIds), version };
}

export function audit(org: OrgData, actor: string, action: string, detail?: Record<string, unknown>) {
  org.audit.push({ at: new Date().toISOString(), actor, action, detail });
  if (org.audit.length > 5000) org.audit.splice(0, org.audit.length - 5000);
}
