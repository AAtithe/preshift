import { sql } from './db.js';

// Shared by sign-in and password change, so a stolen session cannot be used to guess the
// current password any faster than the login form allows.
export const MAX_FAILURES = 5;
export const WINDOW_MINUTES = 15;

export async function isLockedOut(email: string): Promise<boolean> {
  const [{ failures }] = (await sql()`
    select count(*)::int as failures from preshift.login_attempts
    where email = ${email} and not ok and at > now() - make_interval(mins => ${WINDOW_MINUTES})`) as { failures: number }[];
  return failures >= MAX_FAILURES;
}

export async function recordAttempt(email: string, ok: boolean) {
  await sql()`insert into preshift.login_attempts (email, ok) values (${email}, ${ok})`;
}

export const LOCKED_OUT = `Too many attempts. Try again in ${WINDOW_MINUTES} minutes.`;
