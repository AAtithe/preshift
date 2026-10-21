import { createHash, randomBytes } from 'node:crypto';
import { sql } from './db.js';

export const RESET_MINUTES = 30;
/** Reset emails a single account can be sent in an hour, so the form cannot be used to spam someone. */
export const MAX_RESETS_PER_HOUR = 3;

export const hashResetToken = (token: string) => createHash('sha256').update(token).digest('hex');

export async function createResetToken(userId: string, minutes = RESET_MINUTES): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await sql()`
    insert into preshift.password_resets (id, user_id, expires_at)
    values (${hashResetToken(token)}, ${userId}, now() + make_interval(mins => ${minutes}))`;
  return token;
}

export async function findValidReset(token: string) {
  const rows = (await sql()`
    select r.id, u.id as user_id, u.email
    from preshift.password_resets r join preshift.users u on u.id = r.user_id
    where r.id = ${hashResetToken(token)} and r.used_at is null and r.expires_at > now()`) as {
    id: string;
    user_id: string;
    email: string;
  }[];
  return rows[0] ?? null;
}
