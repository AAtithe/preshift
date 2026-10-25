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

/** A person as the payroll holds them, for matching to Preshift's own records. */
export interface PayrollRecord {
  payrollId: string;
  /** Preshift's employee id, when Preshift created the record. */
  externalRef?: string;
  name: string;
  dateOfBirth?: string;
  payBasis?: 'hourly' | 'salaried';
  hourlyRate?: number;
  annualSalary?: number;
  contractedHours?: number;
  startDate?: string;
  leaveDate?: string;
}

export interface PayRun {
  id: string;
  periodStart: string;
  periodEnd: string;
  status: 'draft' | 'approved' | 'completed';
  /** The payroll employer (PAYE scheme) the run belongs to. */
  employerId: string;
  employees: (PayRunEmployee & { payrollId: string })[];
}

/**
 * A payslip or P60 as the payroll holds it, for the person's own phone. Fetched when they ask and
 * never stored by Preshift: the payroll is where pay records live.
 */
export interface PayDocument {
  id: string;
  kind: 'payslip' | 'p60';
  /** Payslips: the period paid and the day it was paid. */
  periodStart?: string;
  periodEnd?: string;
  payDate?: string;
  /** P60s: the tax year, such as 2025-26. */
  taxYear?: string;
  gross: number;
  tax: number;
  employeeNi: number;
  pension?: number;
  net?: number;
  /** Whether the payroll has the document itself to download. */
  hasPdf: boolean;
  /** Set where the figures are made up, as the simulator's are. */
  sample?: boolean;
}

/**
 * The contract between Preshift and a payroll. TeamPay is the native
 * implementation; anything else (BrightPay, Staffology) would implement the
 * same interface, so nothing above this line knows which payroll it talks to.
 */
export interface PayrollProvider {
  readonly name: string;
  // Every call names the payroll employer it is for. One TeamPay account can hold several
  // employers, one per PAYE scheme, and each company in a group runs its own payroll.
  /** Creates the person if new, updates them if not. Returns the payroll's id for them. */
  upsertEmployee(employerId: string, employee: PayrollEmployee, payrollId: string | undefined, idempotencyKey: string): Promise<{ payrollId: string }>;
  /** Everyone the employer's payroll holds, leavers included, so existing staff can be linked rather than duplicated. */
  listEmployees(employerId: string): Promise<PayrollRecord[]>;
  markLeaver(employerId: string, payrollId: string, leaveDate: string, idempotencyKey: string): Promise<void>;
  submitHours(employerId: string, batch: PayrollHoursBatch, idempotencyKey: string): Promise<{ submissionId: string }>;
  getPayRun(employerId: string, id: string): Promise<PayRun>;
  /** The person's payslips and P60s, newest first. A payroll that cannot provide them leaves these out. */
  listPayDocuments?(employerId: string, payrollId: string): Promise<PayDocument[]>;
  /** One payslip or P60 as a PDF, or null where the payroll has none. */
  payDocumentPdf?(employerId: string, payrollId: string, document: PayDocument): Promise<Buffer | null>;
  /**
   * Pays a person part of their earned pay before payday, to the bank account payroll holds for
   * them, to be taken off that payday's net pay. A payroll that cannot pay early leaves this out.
   */
  payEarnedPay?(employerId: string, payment: EarnedPayPayment, idempotencyKey: string): Promise<{ paymentId: string; status: 'paid' | 'pending' }>;
  /** Checks an inbound webhook really came from the payroll. */
  verifyWebhook(rawBody: string, signature: string | undefined): boolean;
}

/** An early payment of earned pay, as sent to payroll. */
export interface EarnedPayPayment {
  payrollId: string;
  amount: number;
  /** The draw, so payroll pays it once and deducts it once. */
  reference: string;
  /** The payday it comes off. */
  payDate: string;
  description: string;
}

export class PayrollError extends Error {
  constructor(
    message: string,
    /** Whether trying again later could succeed (network, 5xx, 429) or not (4xx validation). */
    readonly retryable: boolean,
    readonly status?: number,
    /** Why, where a screen acts on it: 'possible_match' is a starter held because payroll may already hold them. */
    readonly reason?: 'possible_match' | 'ambiguous_match',
  ) {
    super(message);
  }
}
