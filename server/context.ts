import type { FastifyRequest } from 'fastify';
import type { PayrollProvider } from './integrations/payroll/provider';
import type { TeamPaySimulator } from './integrations/payroll/simulator';
import type { OutboxDispatcher } from './outbox';
import type { MemoryStore, OrgData } from './store';

export interface AppContext {
  store: MemoryStore;
  dispatcher: OutboxDispatcher;
  providerFor: (orgId: string) => PayrollProvider;
  /** Present when no TeamPay keys are configured. */
  simulator?: TeamPaySimulator;
  /** Deliver outbox items straight after a change. Off in tests, which drive delivery explicitly. */
  autoDispatch: boolean;
}

export function orgOf(ctx: AppContext, req: FastifyRequest): OrgData {
  return ctx.store.org(req.principal.orgId);
}

export function kick(ctx: AppContext) {
  if (ctx.autoDispatch) void ctx.dispatcher.processDue();
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
