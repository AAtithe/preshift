import type { FastifyRequest } from 'fastify';
import type { PayrollProvider } from './integrations/payroll/provider';
import type { TeamPaySimulator } from './integrations/payroll/simulator';
import type { FeedConfig, Fetch } from './integrations/feeds';
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
  /** Outbound HTTP for postcode lookups, TfL journey times and the till. Replaced in tests. */
  fetch: typeof fetch;
  /** Outbound HTTP for weather, event and school feeds, whose addresses people type in: public https addresses only. */
  feedFetch: Fetch;
  feeds: FeedConfig;
  /** Optional TfL app key; the journey planner works without one at low volume. */
  tflAppKey?: string;
  /** The clock, so tests can fix today. */
  now: () => Date;
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
import { londonParts } from '../src/engine/time';
export { londonParts };

/** Today's date in London. */
export const londonToday = (ctx: AppContext) => londonParts(ctx.now()).date;
