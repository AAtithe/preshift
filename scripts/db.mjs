// Database admin for Preshift Rota. Reads DATABASE_URL from the environment or .env.local.
//
//   npm run db:migrate
//   npm run user:create -- --email jane@site.co.uk --name "Jane Smith" --account "Marylebone Group" [--admin]
//   npm run user:reset-link -- --email jane@site.co.uk
//
// There is no public sign-up: accounts are provisioned here, deliberately, while we onboard
// founding sites by hand. The password is prompted for, never passed on the command line, and the
// user is made to replace it on first sign-in.
import { readFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { neon } from '@neondatabase/serverless';
import { hashPassword, MIN_PASSWORD_LENGTH, newPasswordProblem } from '../api/_lib/password.ts';
import { createHash, randomBytes } from 'node:crypto';

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
  const email = values.email.trim().toLowerCase();
  const problem = newPasswordProblem(password, email);
  if (problem) {
    console.error(`Password not accepted: ${problem}`);
    process.exit(1);
  }
  const existing = await sql`select id from preshift.accounts where name = ${values.account}`;
  const accountId = existing[0]?.id ?? (await sql`insert into preshift.accounts (name) values (${values.account}) returning id`)[0].id;
  const role = values.admin ? 'admin' : 'manager';
  await sql`
    insert into preshift.users (account_id, email, name, password_hash, role, must_change_password)
    values (${accountId}, ${email}, ${values.name}, ${await hashPassword(password)}, ${role}, true)`;
  console.log(`Created ${role} ${email} on account "${values.account}".`);
} else if (command === 'reset-link') {
  // For when someone is locked out and email is not set up, or the email has not arrived. Hand the
  // link over by phone or in person, not by an unencrypted channel: it is as good as the password.
  const { values } = parseArgs({ args: rest, options: { email: { type: 'string' }, base: { type: 'string' } } });
  const base = (values.base ?? process.env.APP_URL ?? '').replace(/\/+$/, '');
  if (!values.email || !base) {
    console.error('Usage: npm run user:reset-link -- --email <email> [--base https://your-domain] (or set APP_URL)');
    process.exit(1);
  }
  const [user] = await sql`select id from preshift.users where email = ${values.email.trim().toLowerCase()}`;
  if (!user) {
    console.error(`No user with email ${values.email}.`);
    process.exit(1);
  }
  const token = randomBytes(32).toString('base64url');
  const id = createHash('sha256').update(token).digest('hex');
  await sql`insert into preshift.password_resets (id, user_id, expires_at) values (${id}, ${user.id}, now() + interval '24 hours')`;
  console.log(`Single-use reset link, valid for 24 hours:\n${base}/app/reset#token=${token}`);
} else {
  console.error('Commands: migrate, create-user, reset-link');
  process.exit(1);
}
