// The engine under every report, standard or built by hand. A dataset is a list of rows that
// declares what can be grouped by (dimensions) and what can be totalled (measures), and the
// permission each needs. A report is only a definition: which dataset, grouped how, totalling
// what, filtered how. One engine runs them all, so every report keeps the same access rules.

import type { Permission } from './access';
import { addDays, weekStart } from './time';

export type DimensionType = 'text' | 'date';
export type MeasureFormat = 'number' | 'money' | 'hours' | 'days' | 'percent' | 'minutes';
export type Aggregation = 'sum' | 'count' | 'average' | 'distinct' | 'perMonth' | 'max' | 'min';

export interface Dimension<R> {
  id: string;
  label: string;
  type?: DimensionType;
  value: (row: R) => string | undefined;
  /** Needed on top of the dataset's own permission, any one of them, at the row's site. */
  permission?: Permission | Permission[];
}

export interface Measure<R> {
  id: string;
  label: string;
  format: MeasureFormat;
  aggregation: Aggregation;
  /** The row's number to aggregate. Count needs none; distinct counts the key. */
  value?: (row: R) => number | null | undefined;
  key?: (row: R) => string | undefined;
  /** A rate worked out after grouping: numerator over denominator, both other measures' ids. */
  ratio?: { numerator: string; denominator: string; scale?: number };
  permission?: Permission | Permission[];
  /** One line for the builder, so nobody has to guess what a figure means. */
  help?: string;
}

export type ReportArea = 'people' | 'time' | 'rota' | 'labour' | 'payroll' | 'guests' | 'organisation';

export const AREA_LABEL: Record<ReportArea, string> = {
  people: 'People',
  time: 'Time and attendance',
  rota: 'Rota and compliance',
  labour: 'Labour and sales',
  payroll: 'Payroll and pay',
  guests: 'Guests and bookings',
  organisation: 'Access and organisation',
};

export interface Dataset<R> {
  id: string;
  label: string;
  area: ReportArea;
  description: string;
  /** Needed to read the dataset at all, any one of them, at the row's site (or anywhere, for rows with no site). */
  permission: Permission | Permission[];
  /** What the date filter and the day, week and month columns use. */
  dateLabel: string;
  date: (row: R) => string | undefined;
  site: (row: R) => string | undefined;
  dimensions: Dimension<R>[];
  measures: Measure<R>[];
}

export type FilterOp = 'is' | 'isNot';

export interface ReportFilter {
  field: string;
  op: FilterOp;
  values: string[];
}

export interface ReportDefinition {
  dataset: string;
  groupBy: string[];
  measures: string[];
  filters?: ReportFilter[];
  /** A named range, worked out as at the day the report runs, so a saved report stays current. */
  range?: RangeToken;
  from?: string;
  to?: string;
  sort?: { by: string; direction: 'asc' | 'desc' };
  limit?: number;
}

export interface ReportColumn {
  id: string;
  label: string;
  kind: 'dimension' | 'measure';
  format?: MeasureFormat;
}

export interface ReportResult {
  columns: ReportColumn[];
  rows: (string | number | null)[][];
  totals: (number | null)[];
  /** Rows before the limit was applied. */
  rowCount: number;
  truncated: boolean;
  /** Fields the definition asked for that the caller may not see; left out rather than refused. */
  withheld: string[];
}

/** Whether the caller holds a permission, at a site or anywhere. */
export type Can = (permission: Permission, siteId?: string) => boolean;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Day, week, month, quarter and year, built from the dataset's date, so every dataset can be cut by time. */
export function timeDimensions<R>(date: (row: R) => string | undefined): Dimension<R>[] {
  return [
    { id: 'day', label: 'Day', type: 'date', value: (r) => date(r) },
    { id: 'week', label: 'Week commencing', type: 'date', value: (r) => (date(r) ? weekStart(date(r)!) : undefined) },
    { id: 'month', label: 'Month', type: 'date', value: (r) => date(r)?.slice(0, 7) },
    {
      id: 'quarter',
      label: 'Quarter',
      type: 'text',
      value: (r) => {
        const d = date(r);
        return d ? `${d.slice(0, 4)} Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}` : undefined;
      },
    },
    { id: 'year', label: 'Year', type: 'text', value: (r) => date(r)?.slice(0, 4) },
  ];
}

/** A month as people read it, for headings: 2026-10 is Oct 2026. */
export const monthLabel = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

/** Every dimension of a dataset, its own and the time ones. */
export function allDimensions<R>(ds: Dataset<R>): Dimension<R>[] {
  return [...timeDimensions(ds.date), ...ds.dimensions];
}

const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;

function aggregate<R>(m: Measure<R>, rows: R[], month: (r: R) => string | undefined): number | null {
  switch (m.aggregation) {
    case 'count':
      return rows.length;
    case 'distinct':
      return new Set(rows.map((r) => (m.key ?? ((x: R) => String(m.value?.(x))))(r)).filter((k) => k !== undefined)).size;
    case 'perMonth': {
      // A stock over time, such as headcount: the monthly figure averaged over the months in the group.
      const months = new Set(rows.map(month).filter(Boolean));
      if (months.size === 0) return null;
      return round(rows.reduce((s, r) => s + (m.value?.(r) ?? 0), 0) / months.size);
    }
    default: {
      const values = rows.map((r) => m.value?.(r)).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
      if (values.length === 0) return m.aggregation === 'sum' ? 0 : null;
      if (m.aggregation === 'sum') return round(values.reduce((a, b) => a + b, 0));
      if (m.aggregation === 'average') return round(values.reduce((a, b) => a + b, 0) / values.length);
      if (m.aggregation === 'max') return Math.max(...values);
      return Math.min(...values);
    }
  }
}

/** Whether the caller holds any one of the permissions, at a site or anywhere. */
const holdsAny = (can: Can, p: Permission | Permission[] | undefined, siteId?: string) => !p || (Array.isArray(p) ? p : [p]).some((x) => can(x, siteId));

/** Whether the caller may read the dataset, at a site or anywhere. */
export function canDataset<R>(ds: Dataset<R>, can: Can, siteId?: string): boolean {
  return holdsAny(can, ds.permission, siteId);
}

/** What the caller may see of a dataset: the fields, with the ones they lack permission for left out. */
export function visibleFields<R>(ds: Dataset<R>, can: Can) {
  const allowed = (p?: Permission | Permission[]) => holdsAny(can, p);
  return {
    dimensions: allDimensions(ds).filter((d) => allowed(d.permission)),
    measures: ds.measures.filter((m) => allowed(m.permission) && (!m.ratio || [m.ratio.numerator, m.ratio.denominator].every((id) => allowed(ds.measures.find((x) => x.id === id)?.permission)))),
  };
}

/**
 * Runs a report. Rows are kept only at sites where the caller holds the dataset's permission;
 * a field needing more than that is left out (and named in `withheld`) unless the caller holds
 * it at every site in the result, so a total never mixes figures they may and may not see.
 */
export function runReport<R>(ds: Dataset<R>, rows: R[], def: ReportDefinition, can: Can): ReportResult {
  const dims = allDimensions(ds);
  const withheld: string[] = [];
  const reach = (row: R) => canDataset(ds, can, ds.site(row));
  const inRange = (row: R) => {
    if (!def.from && !def.to) return true;
    const d = ds.date(row);
    if (!d) return false;
    return (!def.from || d >= def.from) && (!def.to || d <= def.to);
  };
  const dimOf = (id: string) => dims.find((d) => d.id === id);
  const base = rows.filter((r) => reach(r) && inRange(r));

  // A field with its own permission must hold at every site in the result, or it is withheld. The
  // result's sites are those left after the filters on open fields (a site filter above all).
  const matches = (r: R, f: ReportFilter) => {
    const v = dimOf(f.field)?.value(r) ?? '';
    return f.op === 'is' ? f.values.includes(v) : !f.values.includes(v);
  };
  const open = (def.filters ?? []).filter((f) => dimOf(f.field) && !dimOf(f.field)!.permission);
  const sites = [...new Set(base.filter((r) => open.every((f) => matches(r, f))).map(ds.site).filter((s): s is string => !!s))];
  const holds = (p?: Permission | Permission[]) => !p || (sites.length ? sites.every((s) => holdsAny(can, p, s)) : holdsAny(can, p));
  const groupBy = def.groupBy.map(dimOf).filter((d): d is Dimension<R> => !!d && (holds(d.permission) || (withheld.push(d.id), false)));
  // A filter on a field the caller may not see would reveal it by elimination, so it is dropped too.
  const filters = (def.filters ?? []).filter((f) => {
    const d = dimOf(f.field);
    if (!d) return false;
    if (holds(d.permission)) return true;
    withheld.push(f.field);
    return false;
  });
  const kept = base.filter((r) => filters.every((f) => matches(r, f)));
  const measureOf = (id: string) => ds.measures.find((m) => m.id === id);
  const measures = def.measures
    .map(measureOf)
    .filter((m): m is Measure<R> => {
      if (!m) return false;
      const needs = [m.permission, ...(m.ratio ? [measureOf(m.ratio.numerator)?.permission, measureOf(m.ratio.denominator)?.permission] : [])];
      if (needs.every(holds)) return true;
      withheld.push(m.id);
      return false;
    });

  const month = (r: R) => ds.date(r)?.slice(0, 7);
  const figure = (m: Measure<R>, group: R[]): number | null => {
    if (!m.ratio) return aggregate(m, group, month);
    const num = measureOf(m.ratio.numerator);
    const den = measureOf(m.ratio.denominator);
    const a = num ? figure(num, group) : null;
    const b = den ? figure(den, group) : null;
    return a === null || b === null || b === 0 ? null : round((a / b) * (m.ratio.scale ?? 1), 4);
  };

  const groups = new Map<string, { keys: string[]; rows: R[] }>();
  for (const r of kept) {
    const keys = groupBy.map((d) => d.value(r) ?? '');
    const k = JSON.stringify(keys);
    const g = groups.get(k) ?? { keys, rows: [] };
    g.rows.push(r);
    groups.set(k, g);
  }
  let out: (string | number | null)[][] = [...groups.values()].map((g) => [...g.keys, ...measures.map((m) => figure(m, g.rows))]);

  const columns: ReportColumn[] = [
    ...groupBy.map((d) => ({ id: d.id, label: d.label, kind: 'dimension' as const })),
    ...measures.map((m) => ({ id: m.id, label: m.label, kind: 'measure' as const, format: m.format })),
  ];
  const sortIndex = def.sort ? columns.findIndex((c) => c.id === def.sort!.by) : -1;
  const dir = def.sort?.direction === 'desc' ? -1 : 1;
  out.sort((a, b) => {
    if (sortIndex >= 0) {
      const x = a[sortIndex];
      const y = b[sortIndex];
      if (x !== y) return (x === null ? -1 : y === null ? 1 : x < y ? -1 : 1) * dir;
    }
    // Otherwise in order of the grouping, oldest date first.
    for (let i = 0; i < groupBy.length; i++) if (a[i] !== b[i]) return String(a[i]) < String(b[i]) ? -1 : 1;
    return 0;
  });
  const rowCount = out.length;
  const limit = Math.min(Math.max(def.limit ?? 5000, 1), 5000);
  if (out.length > limit) out = out.slice(0, limit);
  return {
    columns,
    rows: out,
    totals: measures.map((m) => figure(m, kept)),
    rowCount,
    truncated: rowCount > limit,
    withheld: [...new Set(withheld)],
  };
}

/** A report as CSV, with a totals line, figures to two places. */
export function reportCsv(result: ReportResult): string {
  const cell = (v: string | number | null) => (v === null ? '' : typeof v === 'number' ? String(round(v, 4)) : `"${v.replace(/"/g, '""')}"`);
  const dimCount = result.columns.filter((c) => c.kind === 'dimension').length;
  const lines = [result.columns.map((c) => cell(c.label)).join(','), ...result.rows.map((r) => r.map(cell).join(','))];
  if (result.totals.length) lines.push([...Array.from({ length: dimCount }, (_, i) => (i === 0 ? '"Total"' : '')), ...result.totals.map(cell)].join(','));
  return lines.join('\n');
}

/** The months from one date to another, as YYYY-MM-01, for datasets built month by month. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = `${from.slice(0, 7)}-01`; d <= to; d = addDays(`${d.slice(0, 7)}-28`, 4).slice(0, 7) + '-01') out.push(d);
  return out;
}

export type RangeToken = 'last-4-weeks' | 'last-13-weeks' | 'last-12-months' | 'this-month' | 'last-month' | 'this-year' | 'next-4-weeks';

export const RANGE_LABEL: Record<RangeToken, string> = {
  'last-4-weeks': 'Last 4 weeks',
  'last-13-weeks': 'Last 13 weeks',
  'last-12-months': 'Last 12 months',
  'this-month': 'This month',
  'last-month': 'Last month',
  'this-year': 'This year',
  'next-4-weeks': 'Next 4 weeks',
};

/** A named range as dates, as at today. Weeks run Monday to Sunday and end with the week just finished. */
export function resolveRange(token: RangeToken, today: string): { from: string; to: string } {
  const lastSunday = addDays(weekStart(today), -1);
  const monthStart = `${today.slice(0, 7)}-01`;
  switch (token) {
    case 'last-4-weeks':
      return { from: addDays(lastSunday, -27), to: lastSunday };
    case 'last-13-weeks':
      return { from: addDays(lastSunday, -90), to: lastSunday };
    case 'last-12-months':
      return { from: `${String(Number(today.slice(0, 4)) - 1)}${today.slice(4, 7)}-01`, to: today };
    case 'this-month':
      return { from: monthStart, to: today };
    case 'last-month': {
      const end = addDays(monthStart, -1);
      return { from: `${end.slice(0, 7)}-01`, to: end };
    }
    case 'this-year':
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
    case 'next-4-weeks':
      return { from: today, to: addDays(today, 27) };
  }
}
