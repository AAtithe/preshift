import { randomUUID } from 'node:crypto';
import type { PayrollHoursBatch } from '../src/engine/timesheet';
import type { Employee } from '../src/engine/types';
import { PayrollError, type PayrollEmployee, type PayrollProvider } from './integrations/payroll/provider';
import { audit, type OrgData, type Store } from './store';

export type OutboxItem = {
  id: string;
  idempotencyKey: string;
  attempts: number;
  status: 'pending' | 'delivered' | 'failed';
  lastError?: string;
  nextAttemptAt: number;
  createdAt: number;
  deliveredAt?: number;
} & (
  | { type: 'employee.upsert'; payload: { employeeId: string } }
  | { type: 'employee.leaver'; payload: { employeeId: string } }
  | { type: 'hours.submit'; payload: { submissionId: string; batch: PayrollHoursBatch } }
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
      for (const item of due) {
        try {
          await this.deliver(org, provider, item);
          item.status = 'delivered';
          item.deliveredAt = Date.now();
          item.lastError = undefined;
        } catch (err) {
          item.attempts++;
          item.lastError = (err as Error).message;
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

  private async deliver(org: OrgData, provider: PayrollProvider, item: OutboxItem) {
    const findEmployee = (id: string) => {
      const e = org.state.employees.find((x) => x.id === id);
      if (!e) throw new PayrollError(`Employee ${id} no longer exists`, false);
      return e;
    };
    switch (item.type) {
      case 'employee.upsert': {
        const e = findEmployee(item.payload.employeeId);
        const { payrollId } = await provider.upsertEmployee(toPayrollEmployee(e), e.payrollId, item.idempotencyKey);
        e.payrollId = payrollId;
        return;
      }
      case 'employee.leaver': {
        const e = findEmployee(item.payload.employeeId);
        if (!e.payrollId) throw new PayrollError(`${e.name} is not set up in payroll yet`, true);
        await provider.markLeaver(e.payrollId, e.leaveDate ?? new Date().toISOString().slice(0, 10), item.idempotencyKey);
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
        };
        const { submissionId } = await provider.submitHours(batch, item.idempotencyKey);
        const sub = org.submissions.find((s) => s.id === item.payload.submissionId);
        if (sub) {
          sub.status = 'sent';
          sub.providerSubmissionId = submissionId;
        }
        return;
      }
    }
  }
}

function markSubmission(org: OrgData, id: string, status: 'failed') {
  const sub = org.submissions.find((s) => s.id === id);
  if (sub) sub.status = status;
}
