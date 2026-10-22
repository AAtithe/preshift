import type { FastifyRequest } from 'fastify';
import type { PayrollProvider } from './integrations/payroll/provider';
import type { TeamPaySimulator } from './integrations/payroll/simulator';
import type { DocumentCipher } from './documentCrypto';
import type { OutboxDispatcher } from './outbox';
import type { EmployerConfig } from './payrollEmployers';
import type { OrgData, Store } from './store';

export interface AppContext {
  store: Store;
  dispatcher: OutboxDispatcher;
  providerFor: (orgId: string) => PayrollProvider;
  /** Which payroll employer (PAYE scheme) each company is paid through. */
  employers: EmployerConfig;
  /** Present when no TeamPay keys are configured. */
  simulator?: TeamPaySimulator;
  /** Deliver outbox items straight after a change. Off in tests, which drive delivery explicitly. */
  autoDispatch: boolean;
  /** Encrypts stored files. Null when a database is in use and no valid key is set: files are then refused. */
  documentCipher: DocumentCipher | null;
  /** Outbound HTTP for postcode lookups and TfL journey times. Replaced in tests. */
  fetch: typeof fetch;
  /** Optional TfL app key; the journey planner works without one at low volume. */
  tflAppKey?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    org?: OrgData;
  }
}

/** The organisation loaded for this request. Saved once when a successful write completes. */
export function orgOf(req: FastifyRequest): OrgData {
  if (!req.org) throw new HttpError(500, 'internal', 'Organisation not loaded');
  return req.org;
}

/** Delivers this organisation's queued payroll changes inside the request, so they persist with it. */
export async function kick(ctx: AppContext, org: OrgData) {
  if (ctx.autoDispatch) await ctx.dispatcher.processOrg(org);
}

export class HttpError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found`);

/** Local date and minute in London for an instant: clocking is always UK wall-clock time. */
export function londonParts(at: Date): { date: string; minute: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}
