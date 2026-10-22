import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createPool, type Db } from './db';
import { migrate } from './migrate';

/** Local development and tests only. Production sets its own password and never runs this. */
export const LOCAL_APP_PASSWORD = 'preshift-app-local';

/**
 * A throwaway database for one test run: created, migrated as the owner, and
 * opened as preshift_app, the same restricted role production uses, so row
 * level security is tested as it really runs.
 */
export async function testDatabase(adminUrl: string): Promise<{ db: Db; drop: () => Promise<void> }> {
  const name = `preshift_test_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.query(`do $$ begin
    if not exists (select from pg_roles where rolname = 'preshift_app') then create role preshift_app login; end if;
  end $$`);
  await admin.query(`alter role preshift_app password '${LOCAL_APP_PASSWORD}'`);
  await admin.end();

  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${name}`;
  await migrate(ownerUrl.toString());

  const appUrl = new URL(ownerUrl.toString());
  appUrl.username = 'preshift_app';
  appUrl.password = LOCAL_APP_PASSWORD;
  const db = createPool(appUrl.toString());
  return {
    db,
    drop: async () => {
      await db.end();
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      await c.query(`drop database ${name} with (force)`);
      await c.end();
    },
  };
}
