import type { RotaState } from './types';
import { weekCost } from './cost';
import { addDays } from './time';

/** Nominal codes for on-costs and the balancing control account. */
export interface JournalAccounts {
  employerNi: string;
  pension: string;
  holiday: string;
  wagesAccrual: string;
}

export const DEFAULT_ACCOUNTS: JournalAccounts = {
  employerNi: '7006',
  pension: '7007',
  holiday: '7008',
  wagesAccrual: '2210',
};

export interface JournalLine {
  date: string;
  narration: string;
  description: string;
  accountCode: string;
  amount: number; // debit positive, credit negative
  trackingName: string;
  trackingOption: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Turns a week's rota into a labour cost accrual journal, so the P&L carries
 * true labour for the week before payroll has run. Wages post by role to each
 * role's nominal code, on-costs to their own codes, all tagged to the site's
 * tracking category, balanced against the wages accrual control account.
 * Reverse it when payroll posts the actuals.
 */
export function rotaJournal(
  state: RotaState,
  weekStartDate: string,
  accounts: JournalAccounts = DEFAULT_ACCOUNTS,
): JournalLine[] {
  const date = addDays(weekStartDate, 6);
  const narration = `Preshift labour accrual w/e ${date}`;
  const lines: JournalLine[] = [];

  for (const site of state.sites) {
    const cost = weekCost(state, weekStartDate, site.id);
    const byAccount = new Map<string, { description: string; amount: number }>();
    const add = (code: string, description: string, amount: number) => {
      const cur = byAccount.get(code) ?? { description, amount: 0 };
      cur.amount += amount;
      byAccount.set(code, cur);
    };

    for (const shift of state.shifts) {
      const sc = cost.shifts.get(shift.id);
      if (!sc) continue;
      const role = state.roles.find((r) => r.id === shift.roleId);
      if (!role) continue;
      add(role.nominalCode, `Wages - ${role.name}`, sc.gross);
      add(accounts.holiday, 'Holiday pay accrual', sc.holiday);
      add(accounts.employerNi, "Employer's NI", sc.employerNi);
      add(accounts.pension, 'Employer pension', sc.pension);
    }
    // Paid but not rostered: post to their primary role.
    for (const employee of state.employees) {
      const ec = cost.employees.get(employee.id);
      if (!ec || state.shifts.some((s) => s.employeeId === employee.id && cost.shifts.has(s.id))) continue;
      const role = state.roles.find((r) => r.id === employee.roleIds[0]);
      if (!role) continue;
      add(role.nominalCode, `Wages - ${role.name}`, ec.gross);
      add(accounts.holiday, 'Holiday pay accrual', ec.holiday);
      add(accounts.employerNi, "Employer's NI", ec.employerNi);
      add(accounts.pension, 'Employer pension', ec.pension);
    }

    let siteTotal = 0;
    for (const [code, { description, amount }] of byAccount) {
      const value = round2(amount);
      if (value === 0) continue;
      siteTotal += value;
      lines.push({
        date,
        narration,
        description,
        accountCode: code,
        amount: value,
        trackingName: 'Site',
        trackingOption: site.trackingCode,
      });
    }
    if (siteTotal !== 0) {
      lines.push({
        date,
        narration,
        description: 'Wages accrual',
        accountCode: accounts.wagesAccrual,
        amount: -round2(siteTotal),
        trackingName: 'Site',
        trackingOption: site.trackingCode,
      });
    }
  }
  return lines;
}

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Xero manual journal import format. */
export function toXeroCsv(lines: JournalLine[]): string {
  const header = ['*Narration', '*Date', 'Description', '*AccountCode', '*TaxRate', '*Amount', 'TrackingName1', 'TrackingOption1'];
  const rows = lines.map((l) => [
    l.narration,
    l.date.split('-').reverse().join('/'),
    l.description,
    l.accountCode,
    'No VAT',
    l.amount.toFixed(2),
    l.trackingName,
    l.trackingOption,
  ]);
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
}
