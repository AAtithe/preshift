// Database admin for Preshift Rota. Reads DATABASE_URL from the environment or .env.local.
//
//   npm run db:migrate
//   npm run user:create -- --email jane@site.co.uk --name "Jane Smith" --account "Marylebone Group" [--admin]
//
// There is no public sign-up: accounts are provisioned here, deliberately, while we onboard
// founding sites by hand. The password is prompted for, never passed on the command line.
import { readFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { neon } from '@neondatabase/serverless';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../api/_lib/password.ts';

if (!process.env.DATABASE_URL && existsSync('.env.local')) process.loadEnvFile('.env.local');
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Add it to .env.local or the environment.');
  process.exit(1);
}
const sql = neon(process.env.DATABASE_URL);

const [command, ...rest] = process.argv.slice(2);

if (command === 'migrate') {
  const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
  const statements = schema
    .split(/;\s*$/m)
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean);
  for (const statement of statements) await sql.query(statement);
  console.log(`Applied ${statements.length} statements.`);
} else if (command === 'create-user') {
  const { values } = parseArgs({
    args: rest,
    options: { email: { type: 'string' }, name: { type: 'string' }, account: { type: 'string' }, admin: { type: 'boolean' } },
  });
  if (!values.email || !values.name || !values.account) {
    console.error('Usage: npm run user:create -- --email <email> --name <name> --account <account name> [--admin]');
    process.exit(1);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const password = await rl.question(`Password (min ${MIN_PASSWORD_LENGTH} characters): `);
  rl.close();
  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    process.exit(1);
  }
  const email = values.email.trim().toLowerCase();
  const existing = await sql`select id from preshift.accounts where name = ${values.account}`;
  const accountId = existing[0]?.id ?? (await sql`insert into preshift.accounts (name) values (${values.account}) returning id`)[0].id;
  const role = values.admin ? 'admin' : 'manager';
  await sql`
    insert into preshift.users (account_id, email, name, password_hash, role)
    values (${accountId}, ${email}, ${values.name}, ${await hashPassword(password)}, ${role})`;
  console.log(`Created ${role} ${email} on account "${values.account}".`);
} else {
  console.error('Commands: migrate, create-user');
  process.exit(1);
}
