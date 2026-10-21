// Password hashing and the user list. Node only (scrypt), used by the login function.
//
// Users live in the APP_USERS environment variable, one per line or separated by commas:
//   name@example.com:<salt hex>:<hash hex>
// Generate a line with `npm run hash-password -- name@example.com`. When the app gains a
// database this list moves there; the hash format stays the same.

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 64;
const PARAMS = { N: 16384, r: 8, p: 1 };

const derive = (password, salt) =>
  new Promise((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, PARAMS, (err, key) => (err ? reject(err) : resolve(key))),
  );

export async function hashPassword(password) {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${(await derive(password, salt)).toString('hex')}`;
}

export function parseUsers(value = '') {
  const users = new Map();
  for (const entry of value.split(/[\n,]/)) {
    const [email, salt, hash] = entry.trim().split(':');
    if (email && /^[0-9a-f]{32}$/.test(salt ?? '') && /^[0-9a-f]{128}$/.test(hash ?? '')) {
      users.set(email.toLowerCase(), { salt, hash });
    }
  }
  return users;
}

// Checked against when the email is unknown, so a wrong email takes as long as a wrong password.
const DUMMY = { salt: '0'.repeat(32), hash: '0'.repeat(128) };

/** The canonical email when the password matches, otherwise null. */
export async function verifyLogin(users, email, password) {
  if (typeof email !== 'string' || typeof password !== 'string' || !password) return null;
  const key = email.trim().toLowerCase();
  const user = users.get(key);
  const record = user ?? DUMMY;
  const actual = await derive(password, Buffer.from(record.salt, 'hex'));
  const match = timingSafeEqual(actual, Buffer.from(record.hash, 'hex'));
  return user && match ? key : null;
}
