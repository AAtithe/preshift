import { randomUUID } from 'node:crypto';
import { employeeWeekCost } from '../../../src/engine/cost';
import type { Employee } from '../../../src/engine/types';
import type { PayrollHoursBatch } from '../../../src/engine/timesheet';
import { PayrollError, type PayRun, type PayrollEmployee, type PayrollProvider } from './provider';
import { signHmac, verifyHmac } from './teampay';

/**
 * An in-process stand-in for TeamPay, used in development, demos and tests
 * when no TeamPay keys are configured. It behaves like the real thing from
 * Preshift's side: it holds employees, takes hours, honours idempotency keys,
 * runs payroll and emits signed webhooks.
 */
export class TeamPaySimulator implements PayrollProvider {
  readonly name = 'TeamPay (simulator)';
  readonly employees = new Map<string, PayrollEmployee & { payrollId: string; leaveDate?: string }>();
  readonly submissions: { id: string; batch: PayrollHoursBatch }[] = [];
  readonly payRuns = new Map<string, PayRun>();
  private readonly seen = new Map<string, unknown>();
  /** Set to make the next N calls fail, to exercise retries. */
  failNext = 0;

  constructor(readonly webhookSecret = 'simulator-secret') {}

  private once<T>(key: string, fn: () => T): T {
    if (this.failNext > 0) {
      this.failNext--;
      throw new PayrollError('Simulated TeamPay outage', true, 503);
    }
    if (this.seen.has(key)) return this.seen.get(key) as T;
    const result = fn();
    this.seen.set(key, result);
    return result;
  }

  async upsertEmployee(e: PayrollEmployee, payrollId: string | undefined, key: string) {
    return this.once(key, () => {
      const id = payrollId ?? `tp_emp_${randomUUID().slice(0, 8)}`;
      this.employees.set(id, { ...e, payrollId: id });
      return { payrollId: id };
    });
  }

  async markLeaver(payrollId: string, leaveDate: string, key: string) {
    this.once(key, () => {
      const e = this.employees.get(payrollId);
      if (e) e.leaveDate = leaveDate;
    });
  }

  async submitHours(batch: PayrollHoursBatch, key: string) {
    return this.once(key, () => {
      // Lenient on ids it has not seen: on serverless a fresh instance starts with an empty simulator.
      const unknown = batch.lines.filter((l) => !l.payrollId);
      if (unknown.length) throw new PayrollError(`${unknown.length} line(s) for people not set up`, true, 422);
      const id = `tp_sub_${randomUUID().slice(0, 8)}`;
      this.submissions.push({ id, batch });
      return { submissionId: id };
    });
  }

  async getPayRun(id: string) {
    const run = this.payRuns.get(id);
    if (!run) throw new PayrollError(`Unknown pay run ${id}`, false, 404);
    return run;
  }

  verifyWebhook(rawBody: string, signature: string | undefined) {
    return verifyHmac(this.webhookSecret, rawBody, signature);
  }

  /**
   * Runs payroll for a period from the hours batch TeamPay holds for it, the
   * way TeamPay would, and returns the signed `payroll.run.completed` webhook.
   * The batch is passed in rather than remembered, so this works on a fresh
   * serverless instance.
   */
  runPayroll(periodStart: string, periodEnd: string, people: Employee[], batch: PayrollHoursBatch) {
    const hoursByEmployee = new Map<string, number>();
    for (const l of batch.lines) hoursByEmployee.set(l.employeeId, (hoursByEmployee.get(l.employeeId) ?? 0) + l.hours);
    const employees: PayRun['employees'] = [];
    for (const person of people) {
      if (!person.payrollId) continue;
      const hours = hoursByEmployee.get(person.id) ?? 0;
      if (person.payBasis === 'hourly' && hours === 0 && person.contractedHours === 0) continue;
      // Price the paid hours with the same statutory model; a real payroll's rounding differs slightly.
      const cost = employeeWeekCost(person, [
        { id: 'x', employeeId: person.id, roleId: '', siteId: person.siteId, date: periodStart, startMinute: 0, endMinute: Math.round(hours * 60), breakMinutes: 0 },
      ]);
      employees.push({
        payrollId: person.payrollId,
        employeeId: person.id,
        gross: cost.gross,
        holidayPay: cost.holiday,
        employerNi: cost.employerNi,
        employerPension: cost.pension,
      });
    }
    const run: PayRun = { id: `tp_run_${randomUUID().slice(0, 8)}`, periodStart, periodEnd, status: 'completed', employees };
    this.payRuns.set(run.id, run);
    const body = JSON.stringify({
      id: `evt_${randomUUID().slice(0, 8)}`,
      type: 'payroll.run.completed',
      created_at: new Date().toISOString(),
      data: { pay_run_id: run.id, period_start: periodStart, period_end: periodEnd },
    });
    return { run, body, signature: signHmac(this.webhookSecret, body) };
  }
}
