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
  /** The simulator an organisation's payroll runs on, if any: always one for a demo sandbox. */
  simulatorFor: (orgId: string) => TeamPaySimulator | undefined;
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
    /** Set when a read changed the organisation (an invitation accepted on sign-in), so it is saved too. */
    orgChanged?: boolean;
    /** Set when a read only refreshed someone's last seen: saved if it can be, never at the read's expense. */
    orgTouched?: boolean;
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

// Shared with the browser, where the rota assistant needs the same idea of now.
export { londonParts } from '../src/engine/time';
