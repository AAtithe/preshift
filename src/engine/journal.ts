import type { RotaState } from './types';
import { employmentAllowanceWeek } from './allowance';
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
  /** The ledger this line posts to. Each entity is its own set of books. */
  entityId: string;
  date: string;
  narration: string;
  description: string;
  accountCode: string;
  amount: number; // debit positive, credit negative
  trackingName: string;
  trackingOption: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Cost of one site's labour supplied by one employing entity, by account. */
type Bucket = Map<string, { description: string; amount: number }>;

/**
 * Turns a week's rota into labour cost accrual journals, one per entity, so the
 * P&L carries true labour for the week before payroll has run.
 *
 * Cost lands in the entity whose site the work was done at, by role nominal and
 * site tracking category. The wages accrual sits with the employing entity,
 * because that is whose PAYE scheme will pay it. When the two differ (a central
 * employing company, or someone covering a sister company's site) the cost is
 * recharged: the site's entity owes the employer, the employer is owed by the
 * site's entity, and both sides post to each other's intercompany code so the
 * group eliminates cleanly on consolidation. Reverse it when payroll posts.
 */
export function rotaJournal(
  state: RotaState,
  weekStartDate: string,
  accounts: JournalAccounts = DEFAULT_ACCOUNTS,
): JournalLine[] {
  const date = addDays(weekStartDate, 6);
  const narration = `Preshift labour accrual w/e ${date}`;
  const lines: JournalLine[] = [];
  const entityOf = (id: string) => state.entities.find((e) => e.id === id);

  for (const site of state.sites) {
    const cost = weekCost(state, weekStartDate, site.id);
    // Keyed by employing entity, so each employer's share can be recharged on its own.
    const byEmployer = new Map<string, Bucket>();
    const add = (employerId: string, code: string, description: string, amount: number) => {
      const bucket = byEmployer.get(employerId) ?? new Map();
      const cur = bucket.get(code) ?? { description, amount: 0 };
      cur.amount += amount;
      bucket.set(code, cur);
      byEmployer.set(employerId, bucket);
    };
    const post = (employerId: string, roleId: string, c: { gross: number; holiday: number; employerNi: number; pension: number }) => {
      const role = state.roles.find((r) => r.id === roleId);
      if (!role) return;
      add(employerId, role.nominalCode, `Wages - ${role.name}`, c.gross);
      add(employerId, accounts.holiday, 'Holiday pay accrual', c.holiday);
      add(employerId, accounts.employerNi, "Employer's NI", c.employerNi);
      add(employerId, accounts.pension, 'Employer pension', c.pension);
    };

    for (const shift of state.shifts) {
      const sc = cost.shifts.get(shift.id);
      const employee = state.employees.find((e) => e.id === shift.employeeId);
      if (sc && employee) post(employee.entityId, shift.roleId, sc);
    }
    // Paid but not rostered: post to their primary role at their home site.
    for (const employee of state.employees) {
      const ec = cost.employees.get(employee.id);
      if (!ec || state.shifts.some((s) => s.employeeId === employee.id && cost.shifts.has(s.id))) continue;
      post(employee.entityId, employee.roleIds[0], ec);
    }

    // Round per employer first, so each recharge equals exactly what the site's books carry for it.
    const debits = new Map<string, { description: string; amount: number }>();
    const credits: JournalLine[] = [];
    const tag = { trackingName: 'Site', trackingOption: site.trackingCode };
    for (const [employerId, bucket] of byEmployer) {
      let total = 0;
      for (const [code, { description, amount }] of bucket) {
        const value = round2(amount);
        if (value === 0) continue;
        total = round2(total + value);
        const cur = debits.get(code) ?? { description, amount: 0 };
        cur.amount = round2(cur.amount + value);
        debits.set(code, cur);
      }
      if (total === 0) continue;
      if (employerId === site.entityId) {
        credits.push({ entityId: site.entityId, date, narration, description: 'Wages accrual', accountCode: accounts.wagesAccrual, amount: -total, ...tag });
        continue;
      }
      const employer = entityOf(employerId);
      const siteEntity = entityOf(site.entityId);
      if (!employer || !siteEntity) continue;
      credits.push({
        entityId: site.entityId,
        date,
        narration,
        description: `Labour recharge due to ${employer.name}`,
        accountCode: employer.intercompanyCode,
        amount: -total,
        ...tag,
      });
      // The employer's books do not carry the other company's site categories, so the site goes in the description.
      const untracked = { trackingName: '', trackingOption: '' };
      lines.push(
        { entityId: employerId, date, narration, description: `Labour recharge due from ${siteEntity.name} (${site.name})`, accountCode: siteEntity.intercompanyCode, amount: total, ...untracked },
        { entityId: employerId, date, narration, description: `Wages accrual (${site.name})`, accountCode: accounts.wagesAccrual, amount: -total, ...untracked },
      );
    }
    for (const [code, { description, amount }] of debits) {
      if (amount !== 0) lines.push({ entityId: site.entityId, date, narration, description, accountCode: code, amount, ...tag });
    }
    lines.push(...credits);
  }
  lines.push(...allowanceLines(state, weekStartDate, lines, accounts, date, narration));
  // Keep each entity's journal together, in the order the entities are listed.
  const order = new Map(state.entities.map((e, i) => [e.id, i]));
  return lines
    .map((l, i) => ({ l, i }))
    .sort((a, b) => (order.get(a.l.entityId) ?? 0) - (order.get(b.l.entityId) ?? 0) || a.i - b.i)
    .map(({ l }) => l);
}

/**
 * Employment Allowance used this week, in the claiming company's books only: it
 * is that company's relief against its own PAYE bill. It reduces employer NI
 * and the amount payroll will owe HMRC, so Cr employer NI, Dr wages accrual.
 * Split across the company's sites by their share of the NI it carries; a
 * company with no sites of its own (a central employer) takes it untracked.
 * Recharges to sister companies stay gross: the relief belongs to the claimant.
 */
function allowanceLines(
  state: RotaState,
  weekStartDate: string,
  lines: JournalLine[],
  accounts: JournalAccounts,
  date: string,
  narration: string,
): JournalLine[] {
  const ea = employmentAllowanceWeek(state, weekStartDate);
  if (!ea || ea.used <= 0) return [];
  const ni = new Map<string, number>();
  for (const l of lines) {
    if (l.entityId === ea.entityId && l.accountCode === accounts.employerNi && l.trackingOption) {
      ni.set(l.trackingOption, (ni.get(l.trackingOption) ?? 0) + l.amount);
    }
  }
  const totalNi = [...ni.values()].reduce((s, v) => s + v, 0);
  const shares: [string, number][] = totalNi > 0 ? [...ni.entries()].map(([tag, v]) => [tag, v / totalNi]) : [['', 1]];
  // When the allowance covers the whole week, clear each site's NI exactly rather than leave
  // pennies of per-shift rounding behind; the difference to payroll's figure is a few pence.
  const absorbsAll = totalNi > 0 && ea.used >= ea.employerNi;
  const out: JournalLine[] = [];
  let left = ea.used;
  shares.forEach(([tag, share], i) => {
    // Otherwise the last site takes the rounding, so the split adds back to the allowance exactly.
    const amount = absorbsAll ? round2(ni.get(tag)!) : i === shares.length - 1 ? round2(left) : round2(ea.used * share);
    left = round2(left - amount);
    const tracking = { trackingName: tag ? 'Site' : '', trackingOption: tag };
    out.push(
      { entityId: ea.entityId, date, narration, description: 'Employment Allowance', accountCode: accounts.employerNi, amount: -amount, ...tracking },
      { entityId: ea.entityId, date, narration, description: 'Employment Allowance', accountCode: accounts.wagesAccrual, amount, ...tracking },
    );
  });
  return out;
}

export interface IntercompanyBalance {
  entityId: string;
  counterpartyId: string;
  /** Net balance in the entity's books with the counterparty; positive means it is owed. */
  inOwnBooks: number;
  /** The same balance as the counterparty books it, sign flipped. Matches when the journal is sound. */
  inCounterpartyBooks: number;
}

/** Both sides of every intercompany balance the journal creates, so the group can see they agree before posting. */
export function intercompanyBalances(state: RotaState, lines: JournalLine[]): IntercompanyBalance[] {
  const balance = (entityId: string, code: string) =>
    round2(lines.filter((l) => l.entityId === entityId && l.accountCode === code).reduce((s, l) => s + l.amount, 0));
  const out: IntercompanyBalance[] = [];
  state.entities.forEach((a, i) => {
    for (const b of state.entities.slice(i + 1)) {
      const inOwnBooks = balance(a.id, b.intercompanyCode);
      const inCounterpartyBooks = -balance(b.id, a.intercompanyCode);
      if (inOwnBooks === 0 && inCounterpartyBooks === 0) continue;
      // Report from the side that is owed, which is how people read an intercompany schedule.
      out.push(
        inOwnBooks >= 0
          ? { entityId: a.id, counterpartyId: b.id, inOwnBooks, inCounterpartyBooks }
          : { entityId: b.id, counterpartyId: a.id, inOwnBooks: -inOwnBooks, inCounterpartyBooks: -inCounterpartyBooks },
      );
    }
  });
  return out;
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
