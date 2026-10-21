import { seedState } from '../src/engine/seed';
import type { PayrollVariance } from '../src/engine/timesheet';
import type { RotaState, TimeEntry } from '../src/engine/types';
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
}

/**
 * Tenancy boundary: every request works on exactly one organisation's data.
 * In memory for now; the interface is what a Postgres implementation will
 * provide, with each OrgData collection becoming a table keyed by org_id.
 */
export class MemoryStore {
  private readonly orgs = new Map<string, OrgData>();

  constructor(private readonly seedOrgIds: string[] = ['demo'], private readonly today?: string) {}

  org(orgId: string): OrgData {
    let data = this.orgs.get(orgId);
    if (!data) {
      data = {
        orgId,
        state: this.seedOrgIds.includes(orgId) ? seedState(this.today) : emptyState(),
        timeEntries: [],
        submissions: [],
        payRuns: [],
        outbox: [],
        processedWebhookIds: new Set(),
        audit: [],
      };
      this.orgs.set(orgId, data);
    }
    return data;
  }

  all(): OrgData[] {
    return [...this.orgs.values()];
  }
}

function emptyState(): RotaState {
  return { sites: [], roles: [], employees: [], shifts: [], forecast: [], demandRules: [] };
}

export function audit(org: OrgData, actor: string, action: string, detail?: Record<string, unknown>) {
  org.audit.push({ at: new Date().toISOString(), actor, action, detail });
  if (org.audit.length > 5000) org.audit.splice(0, org.audit.length - 5000);
}
