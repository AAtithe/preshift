import { describe, expect, it } from 'vitest';
import type { JournalLine } from './journal';
import { journalDebits, journalFingerprint, ledgerProblems, manualJournal, reversal, type LedgerAccount, type LedgerTracking } from './ledger';

const line = (accountCode: string, amount: number, extra: Partial<JournalLine> = {}): JournalLine => ({
  entityId: 'wdl', date: '2026-10-25', narration: 'Preshift labour accrual w/e 2026-10-25', description: accountCode === '2210' ? 'Wages accrual' : 'Wages - Server',
  accountCode, amount, trackingName: 'Site', trackingOption: 'MAR', ...extra,
});
const journal = [line('5000', 1000), line('7006', 120.5), line('2210', -1120.5)];
const chart: LedgerAccount[] = [
  { code: '5000', name: 'Wages - Server', status: 'ACTIVE' },
  { code: '7006', name: "Employer's NI", status: 'ACTIVE' },
  { code: '2210', name: 'Wages accrual', status: 'ACTIVE' },
];
const sites: LedgerTracking[] = [{ name: 'Site', options: ['MAR', 'SHD'] }];

describe('the journal as the ledger takes it', () => {
  it('carries each line with its site, and reverses it on the Monday after', () => {
    const j = manualJournal(journal);
    expect(j).toMatchObject({ narration: 'Preshift labour accrual w/e 2026-10-25', date: '2026-10-25' });
    expect(j.lines[0]).toEqual({ accountCode: '5000', description: 'Wages - Server', amount: 1000, tracking: { name: 'Site', option: 'MAR' } });
    const back = reversal(j);
    expect(back).toMatchObject({ narration: 'Reversal: Preshift labour accrual w/e 2026-10-25', date: '2026-10-26' });
    expect(back.lines.map((l) => l.amount)).toEqual([-1000, -120.5, 1120.5]);
    expect(journalDebits(journal)).toBe(1120.5);
  });

  it('leaves the site off lines that have none', () => {
    expect(manualJournal([line('1351', 50, { trackingName: '', trackingOption: '' })]).lines[0].tracking).toBeUndefined();
  });

  it('fingerprints the lines, so a changed journal is told from the one posted', () => {
    expect(journalFingerprint(journal)).toBe(journalFingerprint([...journal]));
    expect(journalFingerprint(journal)).not.toBe(journalFingerprint([line('5000', 1000.01), line('7006', 120.5), line('2210', -1120.51)]));
  });
});

describe('checks against the ledger before posting', () => {
  it('passes a balanced journal whose accounts and sites the ledger holds', () => {
    expect(ledgerProblems(journal, chart, sites)).toEqual([]);
  });

  it('refuses a journal that does not balance, or that has nothing in it', () => {
    expect(ledgerProblems([line('5000', 1000), line('2210', -999.99)], chart, sites)[0].message).toMatch(/does not balance: debits and credits differ by £0.01/);
    expect(ledgerProblems([], chart, sites)[0].message).toMatch(/nothing to post/);
  });

  it('names an account the chart does not hold, or has archived', () => {
    const problems = ledgerProblems(journal, [chart[0], { ...chart[1], status: 'ARCHIVED' }], sites).map((p) => p.message);
    expect(problems).toEqual([
      "Account 7006 (Employer's NI) is archived. Restore it in the ledger, or change the code in Preshift.",
      'Account 2210 (Wages accrual) is not in the chart of accounts. Add it in the ledger, or change the code in Preshift.',
    ]);
  });

  it('names a missing tracking category, or a site with no option in it', () => {
    expect(ledgerProblems(journal, chart, [])[0].message).toMatch(/no tracking category called "Site"/);
    const shd = journal.map((l) => ({ ...l, trackingOption: 'FITZ' }));
    expect(ledgerProblems(shd, chart, sites)[0].message).toBe('"Site" has no option for FITZ. Add it in the ledger, named as each site\'s tracking code in Preshift.');
    // Matched as the ledger matches names: without regard to case.
    expect(ledgerProblems(journal, chart, [{ name: 'site', options: ['mar'] }])).toEqual([]);
  });

  it('notes, without stopping, lines that carry no site', () => {
    const lines = [...journal, line('1351', 10, { trackingName: '', trackingOption: '' }), line('2210', -10, { trackingName: '', trackingOption: '' })];
    expect(ledgerProblems(lines, [...chart, { code: '1351', name: 'Intercompany', status: 'ACTIVE' }], sites)).toEqual([expect.objectContaining({ severity: 'warn' })]);
  });
});
