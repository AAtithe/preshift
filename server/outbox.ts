import { randomUUID } from 'node:crypto';
import type { PayrollHoursBatch } from '../src/engine/timesheet';
import type { Employee } from '../src/engine/types';
import { candidates, differences } from '../src/engine/payrollMatch';
import { PayrollError, type PayrollEmployee, type PayrollProvider, type PayrollRecord } from './integrations/payroll/provider';
import { employerFor, type EmployerConfig } from './payrollEmployers';
import { audit, type OrgData, type Store } from './store';

export type OutboxItem = {
  id: string;
  idempotencyKey: string;
  attempts: number;
  status: 'pending' | 'delivered' | 'failed';
  lastError?: string;
  /** Set when an item stopped for a reason a person resolves, rather than a fault. */
  reason?: 'possible_match' | 'ambiguous_match';
  nextAttemptAt: number;
  createdAt: number;
  deliveredAt?: number;
} & (
  // confirmedNew: someone has said this starter is not any record already on the payroll.
  | { type: 'employee.upsert'; payload: { employeeId: string; confirmedNew?: boolean } }
  | { type: 'employee.leaver'; payload: { employeeId: string } }
  // entityId is absent on items queued before per-scheme payroll; they belong to the only company.
  | { type: 'hours.submit'; payload: { submissionId: string; batch: PayrollHoursBatch; entityId?: string } }
);

type NewItem = Pick<OutboxItem, 'type' | 'payload'> & { idempotencyKey: string };

const MAX_ATTEMPTS = 8;
const backoffMs = (attempt: number) => Math.min(30_000 * 2 ** (attempt - 1), 3_600_000);

export function enqueue(org: OrgData, item: NewItem) {
  const now = Date.now();
  const full = { id: randomUUID(), attempts: 0, status: 'pending', nextAttemptAt: now, createdAt: now, ...item } as OutboxItem;
  org.outbox.push(full);
  return full;
}

export function toPayrollEmployee(e: Employee): PayrollEmployee {
  return {
    externalRef: e.id,
    name: e.name,
    dateOfBirth: e.dateOfBirth,
    siteId: e.siteId,
    payBasis: e.payBasis,
    hourlyRate: e.hourlyRate,
    annualSalary: e.annualSalary,
    contractedHours: e.contractedHours,
    irregularHours: e.irregularHours,
    pensionEnrolled: e.pensionEnrolled,
  };
}

/**
 * Delivers queued changes to payroll in the order they happened, retrying
 * with backoff. Changes are written to the outbox in the same step as the
 * data change, so a payroll outage delays a starter or a batch of hours but
 * never loses it. Failed items stay visible until someone retries them.
 */
export class OutboxDispatcher {
  private running: Promise<void> | null = null;

  constructor(
    private readonly store: Store,
    private readonly providerFor: (orgId: string) => PayrollProvider,
    private readonly employers: EmployerConfig,
  ) {}

  /** Processes everything due now across all organisations. Concurrent calls share one run. */
  processDue(now = Date.now()): Promise<void> {
    if (!this.running) {
      this.running = this.run(now).finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async run(now: number) {
    for (const orgId of await this.store.orgIds()) {
      const org = await this.store.load(orgId);
      if (!org.outbox.some((i) => i.status === 'pending' && i.nextAttemptAt <= now)) continue;
      await this.processOrg(org, now);
      try {
        await this.store.save(org);
      } catch {
        // A request changed this organisation meanwhile; its own dispatch or the next run picks this up.
      }
    }
  }

  /** Delivers one organisation's due items. The caller saves the organisation afterwards. */
  async processOrg(org: OrgData, now = Date.now()) {
    {
      const provider = this.providerFor(org.orgId);
      const due = org.outbox
        .filter((i) => i.status === 'pending' && i.nextAttemptAt <= now)
        .sort((a, b) => a.createdAt - b.createdAt);
      // Each employer's existing payroll is read once a run, however many starters it checks.
      const rosters = new Map<string, Promise<PayrollRecord[]>>();
      for (const item of due) {
        try {
          await this.deliver(org, provider, item, rosters);
          item.status = 'delivered';
          item.deliveredAt = Date.now();
          item.lastError = undefined;
        } catch (err) {
          item.attempts++;
          item.lastError = (err as Error).message;
          item.reason = err instanceof PayrollError ? err.reason : undefined;
          const retryable = err instanceof PayrollError ? err.retryable : true;
          if (!retryable || item.attempts >= MAX_ATTEMPTS) {
            item.status = 'failed';
            if (item.type === 'hours.submit') markSubmission(org, item.payload.submissionId, 'failed');
            audit(org, 'system', 'payroll.delivery_failed', { item: item.id, type: item.type, error: item.lastError });
          } else {
            item.nextAttemptAt = now + backoffMs(item.attempts);
          }
        }
      }
    }
  }

  private async deliver(org: OrgData, provider: PayrollProvider, item: OutboxItem, rosters: Map<string, Promise<PayrollRecord[]>> = new Map()) {
    const findEmployee = (id: string) => {
      const e = org.state.employees.find((x) => x.id === id);
      if (!e) throw new PayrollError(`Employee ${id} no longer exists`, false);
      return e;
    };
    // Resolved at send time, so setting a missing employer and retrying is enough to recover.
    const employerOf = (entityId: string) => employerFor(org, entityId, this.employers);
    switch (item.type) {
      case 'employee.upsert': {
        const e = findEmployee(item.payload.employeeId);
        // Once set up, a person stays on the scheme that holds their record; moving schemes is a leaver and a starter.
        const employerId = e.payrollId && e.payrollEmployerId ? e.payrollEmployerId : employerOf(e.entityId);
        // Held while someone decides whether Preshift or payroll is right: sending now would settle it for them.
        if (e.payrollReview) return;
        if (!e.payrollId && (await linkExisting(org, provider, employerId, e, rosters, item.payload.confirmedNew === true))) return;
        const { payrollId } = await provider.upsertEmployee(employerId, toPayrollEmployee(e), e.payrollId, item.idempotencyKey);
        rosters.delete(employerId);
        e.payrollId = payrollId;
        e.payrollEmployerId = employerId;
        return;
      }
      case 'employee.leaver': {
        const e = findEmployee(item.payload.employeeId);
        if (!e.payrollId) throw new PayrollError(`${e.name} is not set up in payroll yet`, true);
        const employerId = e.payrollEmployerId ?? employerOf(e.entityId);
        await provider.markLeaver(employerId, e.payrollId, e.leaveDate ?? new Date().toISOString().slice(0, 10), item.idempotencyKey);
        return;
      }
      case 'hours.submit': {
        // Payroll ids are resolved at send time: a starter queued just before may have been set up since.
        const batch: PayrollHoursBatch = {
          ...item.payload.batch,
          lines: item.payload.batch.lines.map((l) => ({
            ...l,
            payrollId: org.state.employees.find((e) => e.id === l.employeeId)?.payrollId,
          })),
          ...(item.payload.batch.tronc
            ? { tronc: item.payload.batch.tronc.map((t) => ({ ...t, payrollId: org.state.employees.find((e) => e.id === t.employeeId)?.payrollId })) }
            : {}),
        };
        const entityId = item.payload.entityId ?? org.state.entities[0]?.id ?? '';
        const employerId = employerOf(entityId);
        const { submissionId } = await provider.submitHours(employerId, batch, item.idempotencyKey);
        const sub = org.submissions.find((s) => s.id === item.payload.submissionId);
        if (sub) {
          sub.status = 'sent';
          sub.providerSubmissionId = submissionId;
          sub.employerId = employerId;
        }
        return;
      }
    }
  }
}

/**
 * Before a starter is created, looks for them already on the employer's payroll. Preshift's own
 * reference, or exactly one record with the same name and date of birth, is the same person:
 * linked, not created a second time. Where the two disagree nothing is overwritten either way;
 * the differences wait for someone to decide. Two equally good matches stop the starter until a
 * person links them by hand. A payroll that cannot be read stops it too, rather than risk a duplicate.
 */
async function linkExisting(
  org: OrgData,
  provider: PayrollProvider,
  employerId: string,
  e: Employee,
  rosters: Map<string, Promise<PayrollRecord[]>>,
  confirmedNew: boolean,
): Promise<boolean> {
  if (!rosters.has(employerId)) rosters.set(employerId, provider.listEmployees(employerId));
  const records = await rosters.get(employerId)!;
  const linked = new Set(org.state.employees.filter((x) => x.id !== e.id && x.payrollId).map((x) => x.payrollId!));
  const own = records.find((r) => r.externalRef === e.id && !linked.has(r.payrollId));
  const found = own ? [] : candidates(e, records, linked);
  const exact = own ? [own] : found.filter((m) => m.level === 'exact').map((m) => m.record);
  if (exact.length > 1) {
    throw new PayrollError(`${exact.length} people on TeamPay share ${e.name}'s name and date of birth. Link the right one by hand in Payroll.`, false, undefined, 'ambiguous_match');
  }
  const record = exact[0];
  if (!record) {
    // "Jon" on TeamPay and "Jonathan" here is the usual case: a near match is held for a person to
    // link or to confirm as new, never created as a second record on a guess.
    if (found.length && !confirmedNew) {
      const names = found.map((m) => m.record.name).join(', ');
      throw new PayrollError(`TeamPay may already hold ${e.name} (${names}). Link them, or confirm they are new, in Payroll.`, false, undefined, 'possible_match');
    }
    return false;
  }
  e.payrollId = record.payrollId;
  e.payrollEmployerId = employerId;
  const diffs = own ? [] : differences(e, record);
  if (diffs.length) e.payrollReview = { linkedAt: new Date().toISOString(), how: 'auto', differences: diffs };
  audit(org, 'system', 'payroll.linked_existing', { employeeId: e.id, payrollId: record.payrollId, differences: diffs.map((d) => d.field) });
  return true;
}

function markSubmission(org: OrgData, id: string, status: 'failed') {
  const sub = org.submissions.find((s) => s.id === id);
  if (sub) sub.status = status;
}
