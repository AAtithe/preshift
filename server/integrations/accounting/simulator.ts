import { randomUUID } from 'node:crypto';
import { DEFAULT_ACCOUNTS } from '../../../src/engine/journal';
import type { LedgerAccount, LedgerTracking, ManualJournal } from '../../../src/engine/ledger';
import type { RotaState } from '../../../src/engine/types';
import { AccountingError, type AccountingProvider, type JournalStatus, type XeroTenant } from './provider';

export interface SimulatedJournal {
  id: string;
  tenantId: string;
  journal: ManualJournal;
  status: JournalStatus | 'VOIDED' | 'DELETED';
}

/** Journals the simulated ledgers hold, by organisation, kept for the life of the process. */
const books = new Map<string, SimulatedJournal[]>();
const keys = new Map<string, string>();
/** Each simulated ledger's chart and tracking, as first read: the books do not follow later changes in Preshift. */
const charts = new Map<string, { accounts: LedgerAccount[]; tracking: LedgerTracking[] }>();

/**
 * A Xero stand-in for the demo and development: one set of books per company, with a chart that holds
 * every code the group's journal uses and a Site category with an option for every site. Journals are
 * kept in memory, so the demo shows them posted, replaced and voided without reaching Xero.
 */
export class AccountingSimulator implements AccountingProvider {
  readonly name = 'Xero (simulated)';

  constructor(
    private readonly orgId: string,
    private readonly state: Pick<RotaState, 'entities' | 'sites' | 'roles'>,
  ) {}

  static tenants(state: Pick<RotaState, 'entities'>): XeroTenant[] {
    return state.entities.map((e) => ({ tenantId: `sim-${e.id}`, name: e.name }));
  }

  /** What the simulated ledgers hold for the organisation: for tests and the demo. */
  static journals(orgId: string): SimulatedJournal[] {
    return books.get(orgId) ?? [];
  }

  /** Empties the organisation's simulated books: a fresh start for each test. */
  static reset(orgId: string) {
    books.delete(orgId);
    for (const map of [keys, charts]) for (const k of [...map.keys()]) if (k.startsWith(`${orgId}|`)) map.delete(k);
  }

  private known(tenantId: string) {
    if (!this.state.entities.some((e) => `sim-${e.id}` === tenantId)) throw new AccountingError('The simulated ledger has no such organisation.', false, 403);
  }

  /** The ledger as it was set up: from the group's codes and sites when first read, then left as it is. */
  private books(tenantId: string) {
    this.known(tenantId);
    const key = `${this.orgId}|${tenantId}`;
    if (!charts.has(key)) charts.set(key, { accounts: this.chart(), tracking: [{ name: 'Site', options: this.state.sites.map((s) => s.trackingCode) }] });
    return charts.get(key)!;
  }

  async accounts(tenantId: string): Promise<LedgerAccount[]> {
    return this.books(tenantId).accounts;
  }

  async tracking(tenantId: string): Promise<LedgerTracking[]> {
    return this.books(tenantId).tracking;
  }

  /** Every code the group's journal uses. */
  chart(): LedgerAccount[] {
    const codes = new Map<string, string>([
      [DEFAULT_ACCOUNTS.employerNi, "Employer's NI"],
      [DEFAULT_ACCOUNTS.pension, 'Employer pension'],
      [DEFAULT_ACCOUNTS.holiday, 'Holiday pay accrual'],
      [DEFAULT_ACCOUNTS.wagesAccrual, 'Wages accrual'],
    ]);
    for (const r of this.state.roles) codes.set(r.nominalCode, `Wages - ${r.name}`);
    for (const e of this.state.entities) codes.set(e.intercompanyCode, `Intercompany - ${e.name}`);
    return [...codes].map(([code, name]) => ({ code, name, status: 'ACTIVE' as const }));
  }

  async postJournal(tenantId: string, journal: ManualJournal, status: JournalStatus, idempotencyKey: string) {
    this.known(tenantId);
    const seen = keys.get(`${this.orgId}|${idempotencyKey}`);
    if (seen) return { journalId: seen };
    const id = randomUUID();
    books.set(this.orgId, [...(books.get(this.orgId) ?? []), { id, tenantId, journal, status }]);
    keys.set(`${this.orgId}|${idempotencyKey}`, id);
    return { journalId: id };
  }

  async removeJournal(tenantId: string, journalId: string) {
    this.known(tenantId);
    const j = (books.get(this.orgId) ?? []).find((x) => x.id === journalId && x.tenantId === tenantId);
    if (!j) throw new AccountingError('The simulated ledger has no such journal.', false, 404);
    j.status = j.status === 'POSTED' ? 'VOIDED' : 'DELETED';
  }
}
