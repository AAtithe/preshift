import type { PayRunEmployee, PayrollHoursBatch } from '../../../src/engine/timesheet';

/** What Preshift sends payroll about a person. Payroll owns tax codes, NI numbers and bank details. */
export interface PayrollEmployee {
  externalRef: string; // our employee id
  name: string;
  dateOfBirth: string;
  siteId: string;
  payBasis: 'hourly' | 'salaried';
  hourlyRate: number;
  annualSalary: number;
  contractedHours: number;
  irregularHours: boolean;
  pensionEnrolled: boolean;
  startDate?: string;
}

export interface PayRun {
  id: string;
  periodStart: string;
  periodEnd: string;
  status: 'draft' | 'approved' | 'completed';
  employees: (PayRunEmployee & { payrollId: string })[];
}

/**
 * The contract between Preshift and a payroll. TeamPay is the native
 * implementation; anything else (BrightPay, Staffology) would implement the
 * same interface, so nothing above this line knows which payroll it talks to.
 */
export interface PayrollProvider {
  readonly name: string;
  /** Creates the person if new, updates them if not. Returns the payroll's id for them. */
  upsertEmployee(employee: PayrollEmployee, payrollId: string | undefined, idempotencyKey: string): Promise<{ payrollId: string }>;
  markLeaver(payrollId: string, leaveDate: string, idempotencyKey: string): Promise<void>;
  submitHours(batch: PayrollHoursBatch, idempotencyKey: string): Promise<{ submissionId: string }>;
  getPayRun(id: string): Promise<PayRun>;
  /** Checks an inbound webhook really came from the payroll. */
  verifyWebhook(rawBody: string, signature: string | undefined): boolean;
}

export class PayrollError extends Error {
  constructor(
    message: string,
    /** Whether trying again later could succeed (network, 5xx, 429) or not (4xx validation). */
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
  }
}
