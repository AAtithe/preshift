import type { RotaState } from '../src/engine/types';
import type { Tx } from './db';

type Kind = 'text' | 'num' | 'bool' | 'json' | 'date' | 'texts';

/** [field on the engine object, column in the table, kind]. */
type Column = [string, string, Kind];

interface TableSpec {
  key: keyof Omit<RotaState, never>;
  table: string;
  /** Columns that identify a row within an organisation. */
  primary: string[];
  columns: Column[];
}

const c = (field: string, kind: Kind = 'text'): Column => [field, field.replace(/[A-Z0-9]+/g, (m) => `_${m.toLowerCase()}`), kind];

/**
 * Every collection in the engine's state and the table it lives in. Loading
 * and saving are written once against this list, so adding a field to the
 * engine is one line here and one column in a migration.
 */
export const TABLES: TableSpec[] = [
  {
    key: 'sites',
    table: 'sites',
    primary: ['id'],
    columns: [c('id'), c('name'), c('labourTargetPct', 'num'), c('trackingCode'), c('openMinute', 'num'), c('closeMinute', 'num'), c('location', 'json'), c('geofenceMetres', 'num'), c('foodCostTargetPct', 'num'), c('drinkCostTargetPct', 'num'), c('concept'), c('region')],
  },
  { key: 'roles', table: 'roles', primary: ['id'], columns: [c('id'), c('name'), c('department'), c('nominalCode')] },
  {
    key: 'employees',
    table: 'employees',
    primary: ['id'],
    columns: [
      c('id'), c('name'), c('siteId'), c('roleIds', 'texts'), c('payBasis'), c('hourlyRate', 'num'), c('annualSalary', 'num'),
      c('dateOfBirth', 'date'), c('contractedHours', 'num'), c('maxWeeklyHours', 'num'), ['optedOutOf48', 'opted_out_of_48', 'bool'],
      c('irregularHours', 'bool'), c('pensionEnrolled', 'bool'), c('availability', 'json'), c('leave', 'json'), c('rightToWork', 'json'),
      c('nmwReducingDeductionsWeekly', 'num'), c('startedOn', 'date'), c('payFrequency'),
    ],
  },
  {
    key: 'shifts',
    table: 'shifts',
    primary: ['id'],
    columns: [c('id'), c('employeeId'), c('roleId'), c('siteId'), c('date', 'date'), c('startMinute', 'num'), c('endMinute', 'num'), c('breakMinutes', 'num'), c('published', 'bool')],
  },
  {
    key: 'clocks',
    table: 'clocks',
    primary: ['id'],
    columns: [c('id'), c('employeeId'), c('siteId'), c('roleId'), c('shiftId'), c('date', 'date'), c('clockIn', 'num'), c('clockOut', 'num'), c('breakMinutes', 'num'), c('approved', 'bool'), c('source')],
  },
  { key: 'forecast', table: 'forecast', primary: ['site_id', 'date', 'hour'], columns: [c('siteId'), c('date', 'date'), c('hour', 'num'), c('sales', 'num'), c('covers', 'num')] },
  { key: 'actuals', table: 'actuals', primary: ['site_id', 'date', 'hour'], columns: [c('siteId'), c('date', 'date'), c('hour', 'num'), c('sales', 'num'), c('covers', 'num')] },
  {
    key: 'demandRules',
    table: 'demand_rules',
    primary: ['site_id', 'role_id'],
    columns: [c('siteId'), c('roleId'), c('salesPerLabourHour', 'num'), c('coversPerHour', 'num'), c('minimumWhileOpen', 'num'), c('maximum', 'num')],
  },
  { key: 'tips', table: 'tips', primary: ['id'], columns: [c('id'), c('siteId'), c('date', 'date'), c('source'), c('amount', 'num'), c('paidOn', 'date')] },
  {
    key: 'troncSchemes',
    table: 'tronc_schemes',
    primary: ['site_id'],
    columns: [c('siteId'), c('troncmaster'), c('independent', 'bool'), c('pointsPerHour', 'json'), c('departmentShares', 'json'), c('serviceCharge'), c('policyPublishedOn', 'date'), c('lastReviewedOn', 'date')],
  },
  { key: 'dishes', table: 'dishes', primary: ['id'], columns: [c('id'), c('siteId'), c('name'), c('category'), c('price', 'num'), c('recipeCost', 'num')] },
  { key: 'dishSales', table: 'dish_sales', primary: ['site_id', 'date', 'dish_id'], columns: [c('siteId'), c('date', 'date'), c('dishId'), c('units', 'num')] },
  { key: 'purchases', table: 'purchases', primary: ['id'], columns: [c('id'), c('siteId'), c('date', 'date'), c('supplier'), c('category'), c('amount', 'num')] },
  { key: 'stockCounts', table: 'stock_counts', primary: ['site_id', 'date', 'category'], columns: [c('siteId'), c('date', 'date'), c('category'), c('value', 'num')] },
];

const spec = (key: keyof RotaState) => TABLES.find((t) => t.key === key)!;

function toRow(columns: Column[], item: Record<string, unknown>): unknown[] {
  return columns.map(([field, , kind]) => {
    const v = item[field];
    if (v === undefined || v === null) return kind === 'json' && (field === 'availability' || field === 'leave') ? '[]' : null;
    return kind === 'json' ? JSON.stringify(v) : v;
  });
}

function fromRow(columns: Column[], row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, column] of columns) {
    const v = row[column];
    // Optional engine fields are absent rather than null, so state round-trips exactly.
    if (v !== null && v !== undefined) out[field] = v;
  }
  return out;
}

/** Everything an organisation holds, as the engine's state. Row level security has already fenced it. */
export async function loadState(tx: Tx): Promise<RotaState> {
  const state: Partial<Record<keyof RotaState, unknown[]>> = {};
  for (const t of TABLES) {
    const { rows } = await tx.query(`select ${t.columns.map(([, col]) => col).join(', ')} from ${t.table} order by ${t.primary.join(', ')}`);
    state[t.key] = rows.map((r) => fromRow(t.columns, r));
  }
  return state as RotaState;
}

/** Inserts or updates rows by their key within the organisation. */
export async function upsert<K extends keyof RotaState>(tx: Tx, organisationId: string, key: K, items: RotaState[K]): Promise<void> {
  const t = spec(key);
  const list = items as unknown as Record<string, unknown>[];
  if (list.length === 0) return;
  const cols = ['organisation_id', ...t.columns.map(([, col]) => col)];
  const keyCols = ['organisation_id', ...t.primary];
  const updates = t.columns.map(([, col]) => col).filter((col) => !keyCols.includes(col));
  // Batched so a whole demo load is a handful of statements, under Postgres's parameter limit.
  const per = Math.max(1, Math.floor(30_000 / cols.length));
  for (let i = 0; i < list.length; i += per) {
    const chunk = list.slice(i, i + per);
    const params: unknown[] = [];
    const values = chunk.map((item) => {
      const row = [organisationId, ...toRow(t.columns, item)];
      const start = params.length;
      params.push(...row);
      return `(${row.map((_, j) => `$${start + j + 1}`).join(', ')})`;
    });
    await tx.query(
      `insert into ${t.table} (${cols.join(', ')}) values ${values.join(', ')}
       on conflict (${keyCols.join(', ')}) do ${updates.length ? `update set ${updates.map((u) => `${u} = excluded.${u}`).join(', ')}` : 'nothing'}`,
      params,
    );
  }
}

export async function removeById(tx: Tx, key: 'shifts' | 'clocks', ids: string[]): Promise<void> {
  if (ids.length) await tx.query(`delete from ${spec(key).table} where id = any($1)`, [ids]);
}

/** Replaces all of an organisation's data with `state`. Used to load the demo. */
export async function replaceAll(tx: Tx, organisationId: string, state: RotaState): Promise<void> {
  for (const t of [...TABLES].reverse()) await tx.query(`delete from ${t.table}`);
  for (const t of TABLES) await upsert(tx, organisationId, t.key, state[t.key]);
}

export async function audit(tx: Tx, organisationId: string, userId: string | null, action: string, siteId: string | null, detail: unknown): Promise<void> {
  await tx.query('insert into audit_events (organisation_id, user_id, action, site_id, detail) values ($1, $2, $3, $4, $5)', [
    organisationId,
    userId,
    action,
    siteId,
    JSON.stringify(detail ?? {}),
  ]);
}
