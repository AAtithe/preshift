import type { LedgerAccount, LedgerTracking, ManualJournal } from '../../../src/engine/ledger';

/**
 * The contract between Preshift and an accounting ledger. Xero is the first implementation; QuickBooks
 * or Sage would implement the same calls, so nothing above this line knows which ledger it posts to.
 * A tenant is one set of books: in Xero, one organisation, which is one company.
 */
export interface AccountingProvider {
  readonly name: string;
  accounts(tenantId: string): Promise<LedgerAccount[]>;
  tracking(tenantId: string): Promise<LedgerTracking[]>;
  /** Posts a manual journal. `idempotencyKey` is Preshift's, so a retry never posts twice. */
  postJournal(tenantId: string, journal: ManualJournal, status: JournalStatus, idempotencyKey: string): Promise<{ journalId: string }>;
  /** Takes a journal back out: voided if posted, deleted if still a draft. */
  removeJournal(tenantId: string, journalId: string, status: JournalStatus): Promise<void>;
}

/** Draft waits for someone to approve it in the ledger; posted goes straight into the books. */
export type JournalStatus = 'DRAFT' | 'POSTED';

export class AccountingError extends Error {
  constructor(
    message: string,
    /** Whether trying again later could succeed (network, 5xx, 429) or not (validation, a refused connection). */
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
  }
}

export type XeroEnvironment = 'production' | 'simulator';

export interface XeroTenant {
  tenantId: string;
  name: string;
  /** Xero's id for the link between the app and this organisation, used to disconnect it. */
  connectionId?: string;
}

/** What the organisation has connected. The tokens are kept apart, in the settings store. */
export interface XeroConnection {
  environment: XeroEnvironment;
  connectedAt: string;
  connectedBy: string;
  /** The Xero organisations the person who connected allowed Preshift into. */
  tenants: XeroTenant[];
}

/** How one company posts: into which Xero organisation, as draft or posted, and whether to reverse. */
export interface LedgerSettings {
  tenantId: string;
  status: JournalStatus;
  /** Post the reversal on the first day of the next week, so payroll's journal carries the real cost. */
  reverse: boolean;
}

/** One week's accrual as posted for one company, kept so it is never posted twice by accident. */
export interface JournalPosting {
  id: string;
  entityId: string;
  tenantId: string;
  tenantName: string;
  weekStart: string;
  date: string;
  basis: 'rota' | 'actual';
  status: JournalStatus;
  journalId: string;
  reversalId?: string;
  reversalDate?: string;
  debits: number;
  lineCount: number;
  /** The lines it was posted from, to tell when the journal has changed since. */
  fingerprint: string;
  postedAt: string;
  postedBy: string;
  /** Set when it was taken back out of the ledger, by hand or to post a newer version. */
  removedAt?: string;
  removedBy?: string;
  replacedBy?: string;
}

export interface AccountingData {
  xero?: XeroConnection;
  ledgers: Record<string, LedgerSettings>;
  postings: JournalPosting[];
}
