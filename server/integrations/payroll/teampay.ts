import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PayrollHoursBatch } from '../../../src/engine/timesheet';
import { PayrollError, type PayRun, type PayrollEmployee, type PayrollProvider, type PayrollRecord } from './provider';

export interface TeamPayConfig {
  baseUrl: string; // e.g. https://api.team-pay.co.uk/v1 (sandbox and production keys come from the TeamPay dashboard)
  apiKey: string;
  webhookSecret: string;
  /**
   * TeamPay employer for an organisation with one company. A group sets an
   * employer on each company instead; this is never used for more than one.
   */
  employerId: string;
  fetchImpl?: typeof fetch;
}

/**
 * Native TeamPay client. Every path and payload field that TeamPay defines
 * lives in this file and nowhere else, so aligning with the published TeamPay
 * API reference is a change to this file only.
 */
export class TeamPayProvider implements PayrollProvider {
  readonly name = 'TeamPay';
  private readonly fetch: typeof fetch;

  constructor(private readonly config: TeamPayConfig) {
    this.fetch = config.fetchImpl ?? fetch;
  }

  async upsertEmployee(employerId: string, e: PayrollEmployee, payrollId: string | undefined, idempotencyKey: string) {
    const body = {
      external_ref: e.externalRef,
      name: e.name,
      date_of_birth: e.dateOfBirth,
      cost_centre: e.siteId,
      pay_basis: e.payBasis,
      hourly_rate: e.hourlyRate,
      annual_salary: e.annualSalary,
      contracted_hours: e.contractedHours,
      irregular_hours: e.irregularHours,
      pension_enrolled: e.pensionEnrolled,
      start_date: e.startDate,
    };
    const res = payrollId
      ? await this.request<{ id: string }>(employerId, 'PATCH', `/employees/${encodeURIComponent(payrollId)}`, body, idempotencyKey)
      : await this.request<{ id: string }>(employerId, 'POST', '/employees', body, idempotencyKey);
    return { payrollId: res.id };
  }

  async listEmployees(employerId: string): Promise<PayrollRecord[]> {
    type Row = {
      id: string;
      external_ref?: string | null;
      name: string;
      date_of_birth?: string | null;
      pay_basis?: 'hourly' | 'salaried';
      hourly_rate?: number | null;
      annual_salary?: number | null;
      contracted_hours?: number | null;
      start_date?: string | null;
      leave_date?: string | null;
    };
    const out: PayrollRecord[] = [];
    // Paged until TeamPay says there is no next page; the cap stops a misbehaving API looping for ever.
    for (let page = 1; page <= 200; page++) {
      const res = await this.request<{ employees: Row[]; next_page?: number | null }>(employerId, 'GET', `/employees?include_leavers=true&page=${page}&per_page=100`);
      for (const r of res.employees) {
        out.push({
          payrollId: r.id,
          externalRef: r.external_ref ?? undefined,
          name: r.name,
          dateOfBirth: r.date_of_birth ?? undefined,
          payBasis: r.pay_basis,
          hourlyRate: r.hourly_rate ?? undefined,
          annualSalary: r.annual_salary ?? undefined,
          contractedHours: r.contracted_hours ?? undefined,
          startDate: r.start_date ?? undefined,
          leaveDate: r.leave_date ?? undefined,
        });
      }
      if (!res.next_page) return out;
    }
    throw new PayrollError('TeamPay returned more than 200 pages of employees', false);
  }

  async markLeaver(employerId: string, payrollId: string, leaveDate: string, idempotencyKey: string) {
    await this.request(employerId, 'POST', `/employees/${encodeURIComponent(payrollId)}/leaver`, { leave_date: leaveDate }, idempotencyKey);
  }

  async submitHours(employerId: string, batch: PayrollHoursBatch, idempotencyKey: string) {
    const missing = batch.lines.filter((l) => !l.payrollId);
    if (missing.length) {
      // Retryable: the starter sync for these people is queued ahead of this batch.
      throw new PayrollError(`${missing.length} line(s) for people not yet set up in TeamPay`, true);
    }
    const res = await this.request<{ id: string }>(
      employerId,
      'POST',
      '/hours',
      {
        period_start: batch.periodStart,
        period_end: batch.periodEnd,
        source: 'preshift',
        lines: batch.lines.map((l) => ({
          employee_id: l.payrollId,
          cost_centre: l.siteId,
          role: l.roleId,
          hours: l.hours,
          rate: l.rate,
          // A premium is an uplift paid on top of hours already on a normal line, as its own pay element.
          ...(l.premium ? { pay_element: 'premium', premium_code: l.premium.ruleId } : {}),
          // Travel and premiums at their own rates are lines of their own; the reference names them so the
          // payslip and the payroll team can tell them from the hours worked in the same role.
          reference: l.premium
            ? `${l.premium.name} premium: ${l.entryIds.join(',')}`
            : l.travel
              ? `Travel between sites: ${l.entryIds.join(',')}`
              : l.entryIds.join(','),
        })),
        // Sick days go only for people TeamPay knows; SSP is TeamPay's to pay, our estimate is for its checks.
        sickness: (batch.sickness ?? []).filter((s) => s.payrollId).map((s) => ({
          employee_id: s.payrollId,
          dates: s.dates,
          qualifying_days_per_week: s.qualifyingDaysPerWeek,
          ssp_estimate: s.sspEstimate,
        })),
        adjustments: (batch.adjustments ?? []).filter((a) => a.payrollId).map((a) => ({
          employee_id: a.payrollId,
          amount: a.amount,
          description: a.description,
          reference: a.reference,
        })),
      },
      idempotencyKey,
    );
    return { submissionId: res.id };
  }

  async getPayRun(employerId: string, id: string): Promise<PayRun> {
    const r = await this.request<{
      id: string;
      period_start: string;
      period_end: string;
      status: PayRun['status'];
      employees: {
        employee_id: string;
        external_ref: string;
        gross: number;
        holiday_pay: number;
        employer_ni: number;
        employer_pension: number;
        ssp?: number;
      }[];
    }>(employerId, 'GET', `/pay-runs/${encodeURIComponent(id)}`);
    return {
      id: r.id,
      employerId,
      periodStart: r.period_start,
      periodEnd: r.period_end,
      status: r.status,
      employees: r.employees.map((e) => ({
        payrollId: e.employee_id,
        employeeId: e.external_ref,
        gross: e.gross,
        holidayPay: e.holiday_pay,
        employerNi: e.employer_ni,
        employerPension: e.employer_pension,
        ...(e.ssp !== undefined ? { ssp: e.ssp } : {}),
      })),
    };
  }

  verifyWebhook(rawBody: string, signature: string | undefined): boolean {
    return verifyHmac(this.config.webhookSecret, rawBody, signature);
  }

  private async request<T = unknown>(employerId: string, method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    if (!employerId) throw new PayrollError('No TeamPay employer given for this call', false);
    let res: Response;
    try {
      res = await this.fetch(`${this.config.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          'content-type': 'application/json',
          'x-teampay-employer': employerId,
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new PayrollError(`TeamPay unreachable: ${(err as Error).message}`, true);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const retryable = res.status === 429 || res.status >= 500;
      throw new PayrollError(`TeamPay ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`, retryable, res.status);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }
}

export function signHmac(secret: string, rawBody: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

export function verifyHmac(secret: string, rawBody: string, signature: string | undefined): boolean {
  if (!signature || !secret) return false;
  const expected = Buffer.from(signHmac(secret, rawBody));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
