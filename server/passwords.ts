// Password hashing and the user list. Node only (scrypt), used by the sign-in handler.
//
// Users live in the APP_USERS environment variable, one per line or separated by commas:
//   name@example.com:<salt hex>:<hash hex>[:<organisation id>]
// The organisation defaults to "demo". Generate a line with
// `npm run hash-password -- name@example.com [orgId]`. When users move into the database the
// hash format stays the same.

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { SessionUser } from './session';

const KEY_LENGTH = 64;
const PARAMS = { N: 16384, r: 8, p: 1 };
export const DEFAULT_ORG = 'demo';

interface UserRecord {
  salt: string;
  hash: string;
  orgId: string;
}

const derive = (password: string, salt: Buffer) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, PARAMS, (err, key) => (err ? reject(err) : resolve(key))),
  );

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${(await derive(password, salt)).toString('hex')}`;
}

export function parseUsers(value = ''): Map<string, UserRecord> {
  const users = new Map<string, UserRecord>();
  for (const entry of value.split(/[\n,]/)) {
    const [email, salt, hash, orgId] = entry.trim().split(':');
    if (email && /^[0-9a-f]{32}$/.test(salt ?? '') && /^[0-9a-f]{128}$/.test(hash ?? '')) {
      users.set(email.toLowerCase(), { salt, hash, orgId: orgId || DEFAULT_ORG });
    }
  }
  return users;
}

// Checked against when the email is unknown, so a wrong email takes as long as a wrong password.
const DUMMY: UserRecord = { salt: '0'.repeat(32), hash: '0'.repeat(128), orgId: '' };

/** The signed-in user when the password matches, otherwise null. */
export async function verifyLogin(users: Map<string, UserRecord>, email: unknown, password: unknown): Promise<SessionUser | null> {
  if (typeof email !== 'string' || typeof password !== 'string' || !password) return null;
  const key = email.trim().toLowerCase();
  const user = users.get(key);
  const record = user ?? DUMMY;
  const actual = await derive(password, Buffer.from(record.salt, 'hex'));
  const match = timingSafeEqual(actual, Buffer.from(record.hash, 'hex'));
  return user && match ? { email: key, orgId: user.orgId } : null;
}
