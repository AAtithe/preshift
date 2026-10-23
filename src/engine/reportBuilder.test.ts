import { describe, expect, it } from 'vitest';
import type { Permission } from './access';
import { monthsBetween, reportCsv, runReport, visibleFields, type Dataset } from './reportBuilder';

interface Row {
  date: string;
  siteId: string;
  person: string;
  hours: number;
  pay: number;
  left: number;
  employed: number;
}

const rows: Row[] = [
  { date: '2026-09-07', siteId: 'mar', person: 'a', hours: 8, pay: 100, left: 0, employed: 1 },
  { date: '2026-09-08', siteId: 'mar', person: 'b', hours: 6, pay: 72, left: 1, employed: 1 },
  { date: '2026-10-05', siteId: 'mar', person: 'a', hours: 4, pay: 50, left: 0, employed: 1 },
  { date: '2026-10-06', siteId: 'shd', person: 'c', hours: 10, pay: 130, left: 0, employed: 1 },
];

const ds: Dataset<Row> = {
  id: 'toy',
  label: 'Toy',
  area: 'people',
  description: '',
  permission: 'rota.view',
  dateLabel: 'Date',
  date: (r) => r.date,
  site: (r) => r.siteId,
  dimensions: [
    { id: 'site', label: 'Site', value: (r) => r.siteId },
    { id: 'person', label: 'Person', value: (r) => r.person, permission: 'hr.view' },
  ],
  measures: [
    { id: 'rows', label: 'Rows', format: 'number', aggregation: 'count' },
    { id: 'hours', label: 'Hours', format: 'hours', aggregation: 'sum', value: (r) => r.hours },
    { id: 'avgHours', label: 'Average hours', format: 'hours', aggregation: 'average', value: (r) => r.hours },
    { id: 'people', label: 'People', format: 'number', aggregation: 'distinct', key: (r) => r.person },
    { id: 'pay', label: 'Pay', format: 'money', aggregation: 'sum', value: (r) => r.pay, permission: 'costs.view' },
    { id: 'headcount', label: 'Average headcount', format: 'number', aggregation: 'perMonth', value: (r) => r.employed },
    { id: 'leavers', label: 'Leavers', format: 'number', aggregation: 'sum', value: (r) => r.left },
    { id: 'turnover', label: 'Turnover', format: 'percent', aggregation: 'sum', ratio: { numerator: 'leavers', denominator: 'headcount' } },
  ],
};

const everyone = () => true;
const only = (held: Permission[], sites?: string[]) => (p: Permission, site?: string) => held.includes(p) && (!site || !sites || sites.includes(site));

describe('report engine', () => {
  it('groups, totals and sorts', () => {
    const r = runReport(ds, rows, { dataset: 'toy', groupBy: ['site'], measures: ['rows', 'hours', 'avgHours', 'people'] }, everyone);
    expect(r.columns.map((c) => c.id)).toEqual(['site', 'rows', 'hours', 'avgHours', 'people']);
    expect(r.rows).toEqual([
      ['mar', 3, 18, 6, 2],
      ['shd', 1, 10, 10, 1],
    ]);
    expect(r.totals).toEqual([4, 28, 7, 3]);
    const sorted = runReport(ds, rows, { dataset: 'toy', groupBy: ['site'], measures: ['hours'], sort: { by: 'hours', direction: 'desc' } }, everyone);
    expect(sorted.rows[0]).toEqual(['mar', 18]);
  });

  it('cuts any dataset by month, and works rates after grouping', () => {
    const r = runReport(ds, rows, { dataset: 'toy', groupBy: ['month'], measures: ['headcount', 'leavers', 'turnover'] }, everyone);
    // September: two employed rows in one month, one leaver: 50%.
    expect(r.rows).toEqual([
      ['2026-09', 2, 1, 0.5],
      ['2026-10', 2, 0, 0],
    ]);
    // Over both months: average headcount 2, one leaver.
    expect(r.totals).toEqual([2, 1, 0.5]);
  });

  it('filters by dates and field values', () => {
    const r = runReport(ds, rows, { dataset: 'toy', groupBy: [], measures: ['hours'], from: '2026-10-01', to: '2026-10-31', filters: [{ field: 'site', op: 'isNot', values: ['shd'] }] }, everyone);
    expect(r.totals).toEqual([4]);
  });

  it("keeps to the sites the caller may see, and withholds fields they lack, filters included", () => {
    const gm = only(['rota.view'], ['mar']);
    const r = runReport(ds, rows, { dataset: 'toy', groupBy: ['person'], measures: ['hours', 'pay'], filters: [{ field: 'person', op: 'is', values: ['a'] }] }, gm);
    expect(r.withheld.sort()).toEqual(['pay', 'person']);
    // The person filter is dropped, not applied, so nobody learns about people by elimination.
    expect(r.totals).toEqual([18]);
    expect(r.rows).toEqual([[18]]);
    expect(visibleFields(ds, gm).measures.map((m) => m.id)).not.toContain('pay');
  });

  it('withholds a field held at only some of the sites in the result', () => {
    const can = (p: Permission, site?: string) => p === 'rota.view' || (p === 'costs.view' && site === 'mar');
    expect(runReport(ds, rows, { dataset: 'toy', groupBy: [], measures: ['pay'] }, can).withheld).toEqual(['pay']);
    // Filtered to the site where they may see pay, they see it.
    const mar = runReport(ds, rows, { dataset: 'toy', groupBy: [], measures: ['pay'], filters: [{ field: 'site', op: 'is', values: ['mar'] }] }, can);
    expect(mar).toMatchObject({ withheld: [], totals: [222] });
  });

  it('caps rows and says so, and writes CSV with a totals line', () => {
    const r = runReport(ds, rows, { dataset: 'toy', groupBy: ['day'], measures: ['hours'], limit: 2 }, everyone);
    expect(r).toMatchObject({ rowCount: 4, truncated: true });
    expect(r.rows).toHaveLength(2);
    expect(reportCsv(r).split('\n')).toEqual(['"Day","Hours"', '"2026-09-07",8', '"2026-09-08",6', '"Total",28']);
  });

  it('lists the months in a range', () => {
    expect(monthsBetween('2025-11-15', '2026-02-03')).toEqual(['2025-11-01', '2025-12-01', '2026-01-01', '2026-02-01']);
  });
});
