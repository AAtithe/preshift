// Posting the labour accrual into a company's accounting ledger: the journal as the ledger takes it,
// the reversal that clears it when payroll posts, and the checks made against the ledger's own chart
// of accounts and tracking before anything is sent. Pure, shared by the API, the screen and the tests.

import type { JournalLine } from './journal';
import { addDays } from './time';

/** An account in the ledger's chart, as the ledger reports it. */
export interface LedgerAccount {
  code: string;
  name: string;
  status: 'ACTIVE' | 'ARCHIVED';
}

/** A tracking category and its active options, matched by name as the ledger does. */
export interface LedgerTracking {
  name: string;
  options: string[];
}

export interface ManualJournalLine {
  accountCode: string;
  description: string;
  /** Debit positive, credit negative, as the ledger takes it. */
  amount: number;
  tracking?: { name: string; option: string };
}

export interface ManualJournal {
  narration: string;
  date: string;
  lines: ManualJournalLine[];
}

export interface LedgerProblem {
  severity: 'block' | 'warn';
  message: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** One company's accrual lines as a manual journal. */
export function manualJournal(lines: JournalLine[]): ManualJournal {
  return {
    narration: lines[0]?.narration ?? '',
    date: lines[0]?.date ?? '',
    lines: lines.map((l) => ({
      accountCode: l.accountCode,
      description: l.description,
      amount: l.amount,
      ...(l.trackingName && l.trackingOption ? { tracking: { name: l.trackingName, option: l.trackingOption } } : {}),
    })),
  };
}

/**
 * The accrual taken back out on the first day of the next week. Payroll's own journal then carries
 * the real cost when it posts, and the two never count the same wages twice.
 */
export function reversal(journal: ManualJournal): ManualJournal {
  return {
    narration: `Reversal: ${journal.narration}`,
    date: addDays(journal.date, 1),
    lines: journal.lines.map((l) => ({ ...l, amount: -l.amount })),
  };
}

/** Total debits: the size of the journal, as an accountant reads it. */
export const journalDebits = (lines: { amount: number }[]) => round2(lines.reduce((s, l) => s + (l.amount > 0 ? l.amount : 0), 0));

/**
 * A short fingerprint of the lines, so a posting can tell whether the journal has changed since
 * (approved actuals replacing the rota, a late shift). Not for security: two different journals
 * sharing one is vanishingly unlikely at this size.
 */
export function journalFingerprint(lines: JournalLine[]): string {
  const text = lines.map((l) => [l.date, l.accountCode, l.trackingOption, l.description, l.amount.toFixed(2)].join('|')).join('\n');
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * What stops the journal posting as it stands, checked against the ledger it is going to. A journal
 * that does not balance, an account the chart does not hold or has archived, or a site the tracking
 * does not list would be refused by the ledger, or worse, accepted into the wrong place.
 */
export function ledgerProblems(lines: JournalLine[], accounts: LedgerAccount[], tracking: LedgerTracking[]): LedgerProblem[] {
  const problems: LedgerProblem[] = [];
  if (lines.length === 0) return [{ severity: 'block', message: 'There is no labour in this week for this company, so there is nothing to post.' }];
  const net = round2(lines.reduce((s, l) => s + l.amount, 0));
  if (net !== 0) problems.push({ severity: 'block', message: `The journal does not balance: debits and credits differ by £${Math.abs(net).toFixed(2)}.` });

  const chart = new Map(accounts.map((a) => [a.code, a]));
  for (const code of [...new Set(lines.map((l) => l.accountCode))]) {
    const account = chart.get(code);
    const used = lines.find((l) => l.accountCode === code)!.description;
    if (!account) problems.push({ severity: 'block', message: `Account ${code} (${used}) is not in the chart of accounts. Add it in the ledger, or change the code in Preshift.` });
    else if (account.status !== 'ACTIVE') problems.push({ severity: 'block', message: `Account ${code} (${account.name}) is archived. Restore it in the ledger, or change the code in Preshift.` });
  }

  const categories = new Map(tracking.map((t) => [t.name.toLowerCase(), t]));
  const tagged = lines.filter((l) => l.trackingName && l.trackingOption);
  for (const name of [...new Set(tagged.map((l) => l.trackingName))]) {
    const category = categories.get(name.toLowerCase());
    if (!category) {
      problems.push({ severity: 'block', message: `The ledger has no tracking category called "${name}". Add it, with an option for each site, so labour lands by site.` });
      continue;
    }
    const options = new Set(category.options.map((o) => o.toLowerCase()));
    const missing = [...new Set(tagged.filter((l) => l.trackingName === name && !options.has(l.trackingOption.toLowerCase())).map((l) => l.trackingOption))];
    if (missing.length) problems.push({ severity: 'block', message: `"${name}" has no option for ${missing.join(', ')}. Add ${missing.length === 1 ? 'it' : 'them'} in the ledger, named as each site's tracking code in Preshift.` });
  }
  if (tagged.length < lines.length && tagged.length > 0) {
    problems.push({ severity: 'warn', message: 'Some lines carry no site: intercompany recharges and Employment Allowance for a company without sites of its own. That is expected.' });
  }
  return problems;
}
