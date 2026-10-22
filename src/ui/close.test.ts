import { describe, expect, it } from 'vitest';
import { rotaJournal } from '../engine/journal';
import { seedState } from '../engine/seed';
import { crossSite } from './CloseView';

describe('cross-site labour', () => {
  it('schedules borrowed shifts by site pair and keeps them in the host site journal', () => {
    const s = seedState('2026-10-19');
    const borrowed = s.employees.find((e) => e.siteId === 'shd' && e.payBasis === 'hourly')!;
    s.shifts = [{ id: 'b1', employeeId: borrowed.id, roleId: borrowed.roleIds[0], siteId: 'mar', date: '2026-10-20', startMinute: 12 * 60, endMinute: 16 * 60, breakMinutes: 0 }];
    const rows = crossSite(s, '2026-10-19');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workedAt: 'Marylebone', home: 'Shoreditch', people: [borrowed.name], hours: 4 });
    expect(rows[0].cost).toBeGreaterThan(0);
    const journal = rotaJournal(s, '2026-10-19');
    const marDebits = journal.filter((l) => l.trackingOption === 'Marylebone' && l.amount > 0).reduce((a, l) => a + l.amount, 0);
    // The borrowed shift's cost is in Marylebone's accrual, alongside Marylebone's own unrostered pay.
    expect(marDebits).toBeGreaterThanOrEqual(rows[0].cost - 0.01);
  });
});
