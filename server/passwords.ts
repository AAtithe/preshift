// Password hashing for people who sign in. Node only (scrypt).

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 64;
const PARAMS = { N: 16384, r: 8, p: 1 };
export const MIN_PASSWORD_LENGTH = 12;

const derive = (password: string, salt: Buffer) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, PARAMS, (err, key) => (err ? reject(err) : resolve(key))),
  );

export async function hashPassword(password: string): Promise<{ salt: string; hash: string }> {
  const salt = randomBytes(16);
  return { salt: salt.toString('hex'), hash: (await derive(password, salt)).toString('hex') };
}

// Checked against when the email is unknown, so a wrong email takes as long as a wrong password.
const DUMMY = { salt: '0'.repeat(32), hash: '0'.repeat(128) };

/** Whether the password matches. Always does the full hash, even when there is no such user. */
export async function verifyPassword(record: { salt: string; hash: string } | null, password: string): Promise<boolean> {
  const { salt, hash } = record ?? DUMMY;
  const actual = await derive(password, Buffer.from(salt, 'hex'));
  return timingSafeEqual(actual, Buffer.from(hash, 'hex')) && record !== null;
}

/** A reason the password is not acceptable, or null. */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > 200) return 'Use 200 characters or fewer.';
  return null;
}
