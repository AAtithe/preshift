import { randomUUID } from 'node:crypto';
import { UK_RATES_2026_27 } from '../../../src/engine/ukRates';
import { weekOnCosts } from '../../../src/engine/cost';
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
  readonly employees = new Map<string, PayrollEmployee & { payrollId: string; employerId: string; leaveDate?: string }>();
  readonly submissions: { id: string; employerId: string; batch: PayrollHoursBatch }[] = [];
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

  // Idempotency keys are scoped to an employer, as they are in TeamPay.
  async upsertEmployee(employerId: string, e: PayrollEmployee, payrollId: string | undefined, key: string) {
    return this.once(`${employerId}:${key}`, () => {
      const known = payrollId ? this.employees.get(payrollId) : undefined;
      if (known && known.employerId !== employerId) {
        throw new PayrollError(`${payrollId} belongs to employer ${known.employerId}, not ${employerId}`, false, 404);
      }
      const id = payrollId ?? `tp_emp_${randomUUID().slice(0, 8)}`;
      this.employees.set(id, { ...e, payrollId: id, employerId });
      return { payrollId: id };
    });
  }

  async markLeaver(employerId: string, payrollId: string, leaveDate: string, key: string) {
    this.once(`${employerId}:${key}`, () => {
      const e = this.employees.get(payrollId);
      if (e && e.employerId === employerId) e.leaveDate = leaveDate;
    });
  }

  async submitHours(employerId: string, batch: PayrollHoursBatch, key: string) {
    return this.once(`${employerId}:${key}`, () => {
      // Lenient on ids it has not seen: on serverless a fresh instance starts with an empty simulator.
      const unknown = batch.lines.filter((l) => !l.payrollId);
      if (unknown.length) throw new PayrollError(`${unknown.length} line(s) for people not set up`, true, 422);
      // An id it has seen under another employer is a real fault: those hours would be paid by the wrong company.
      const foreign = batch.lines.filter((l) => {
        const known = this.employees.get(l.payrollId!);
        return known && known.employerId !== employerId;
      });
      if (foreign.length) throw new PayrollError(`${foreign.length} line(s) for people on another employer's payroll`, false, 422);
      const id = `tp_sub_${randomUUID().slice(0, 8)}`;
      this.submissions.push({ id, employerId, batch });
      return { submissionId: id };
    });
  }

  async getPayRun(employerId: string, id: string) {
    const run = this.payRuns.get(id);
    if (!run || run.employerId !== employerId) throw new PayrollError(`Unknown pay run ${id}`, false, 404);
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
  runPayroll(employerId: string, periodStart: string, periodEnd: string, people: Employee[], batch: PayrollHoursBatch) {
    // TeamPay pays each line at the rate it was sent with, so travel at its own rate is paid at that rate.
    const hoursByEmployee = new Map<string, number>();
    const payByEmployee = new Map<string, number>();
    for (const l of batch.lines) {
      hoursByEmployee.set(l.employeeId, (hoursByEmployee.get(l.employeeId) ?? 0) + l.hours);
      payByEmployee.set(l.employeeId, (payByEmployee.get(l.employeeId) ?? 0) + l.hours * l.rate);
    }
    // SSP at the flat rate over the days a week the person works, as a payroll does with a
    // fixed pattern. It knows nothing of 80% of earnings, so a low earner's SSP comes back too high,
    // which is what the check on each pay run is there to catch.
    const sspByEmployee = new Map((batch.sickness ?? []).map((s) => [s.employeeId, Math.round(s.dates.length * (UK_RATES_2026_27.ssp.weeklyRate / s.qualifyingDaysPerWeek) * 100) / 100]));
    const employees: PayRun['employees'] = [];
    for (const person of people) {
      if (!person.payrollId) continue;
      const hours = hoursByEmployee.get(person.id) ?? 0;
      const ssp = sspByEmployee.get(person.id) ?? 0;
      if (person.payBasis === 'hourly' && hours === 0 && person.contractedHours === 0 && ssp === 0) continue;
      // Salary is paid as salary; hourly pay is the lines, topped up to any guaranteed hours.
      const gross =
        person.payBasis === 'salaried'
          ? person.annualSalary / 52
          : Math.max(payByEmployee.get(person.id) ?? 0, person.contractedHours * person.hourlyRate);
      // Price on-costs with the same statutory model; a real payroll's rounding differs slightly.
      const cost = weekOnCosts(person, gross);
      employees.push({
        payrollId: person.payrollId,
        employeeId: person.id,
        gross: cost.gross,
        holidayPay: cost.holiday,
        employerNi: cost.employerNi,
        employerPension: cost.pension,
        ssp,
      });
    }
    const run: PayRun = { id: `tp_run_${randomUUID().slice(0, 8)}`, periodStart, periodEnd, status: 'completed', employerId, employees };
    this.payRuns.set(run.id, run);
    const body = JSON.stringify({
      id: `evt_${randomUUID().slice(0, 8)}`,
      type: 'payroll.run.completed',
      created_at: new Date().toISOString(),
      data: { pay_run_id: run.id, employer_id: employerId, period_start: periodStart, period_end: periodEnd },
    });
    return { run, body, signature: signHmac(this.webhookSecret, body) };
  }
}
