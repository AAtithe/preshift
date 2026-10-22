import pg from 'pg';

// Dates come back as ISO strings and numerics as numbers, matching the engine's types.
pg.types.setTypeParser(1082, (v: string) => v);
pg.types.setTypeParser(1700, (v: string) => Number(v));

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(connectionString: string): Db {
  return new pg.Pool({ connectionString, max: 10 });
}

/**
 * Runs `fn` in a transaction scoped to one organisation. Row level security
 * reads app.org_id, so every tenant query inside sees only this
 * organisation's rows, whatever the query says.
 */
export async function withOrg<T>(db: Db, organisationId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query('begin');
    await tx.query("select set_config('app.org_id', $1, true)", [organisationId]);
    const result = await fn(tx);
    await tx.query('commit');
    return result;
  } catch (e) {
    await tx.query('rollback');
    throw e;
  } finally {
    tx.release();
  }
}

/** A transaction for the global identity tables, outside any one organisation. */
export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query('begin');
    const result = await fn(tx);
    await tx.query('commit');
    return result;
  } catch (e) {
    await tx.query('rollback');
    throw e;
  } finally {
    tx.release();
  }
}
