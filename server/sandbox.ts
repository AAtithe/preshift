// What makes an organisation a demo sandbox, and when its day ends. Kept free of imports so the
// store, sign-in and payroll code can all ask without depending on the demo routes.
//
// A sandbox is recognised by its id alone. Only POST /demo/start creates ids with this prefix, and
// every check that keeps demo visitors away from customers (the route allowlist, payroll, sign-in,
// deletion) keys off it, so a customer organisation can never be treated as a sandbox or the reverse.

export const SANDBOX_PREFIX = 'sandbox-';

export const isSandbox = (orgId: string | undefined | null): boolean => typeof orgId === 'string' && orgId.startsWith(SANDBOX_PREFIX);

/** A new sandbox id: the creation time (epoch milliseconds, base 36) and 48 random bits as hex. */
export const sandboxId = (now: number, random: string) => `${SANDBOX_PREFIX}${now.toString(36)}-${random}`;

/** When the sandbox was created, from its id, or null for any other organisation. */
export function sandboxCreatedAt(orgId: string): number | null {
  if (!isSandbox(orgId)) return null;
  const t = parseInt(orgId.slice(SANDBOX_PREFIX.length).split('-')[0], 36);
  return Number.isFinite(t) && t > 0 ? t : null;
}

const londonDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' });

/** The calendar date in London (YYYY-MM-DD) at an instant. */
export const londonDate = (at: number) => londonDay.format(new Date(at));

/** The first instant of the next London calendar day, allowing for British Summer Time. */
export function nextLondonMidnight(now: number): number {
  const [y, m, d] = londonDate(now).split('-').map(Number);
  const utcMidnight = Date.UTC(y, m - 1, d + 1);
  // In summer London is an hour ahead, so its midnight is 23:00 UTC the evening before.
  const bst = utcMidnight - 3600_000;
  return londonDate(bst) !== londonDate(now) ? bst : utcMidnight;
}

/**
 * True once London's date has moved on since the sandbox was made: every sandbox ends at midnight
 * UK time. An id that does not parse counts as expired, so a malformed sandbox never lingers.
 */
export function sandboxExpired(orgId: string, now: number): boolean {
  const created = sandboxCreatedAt(orgId);
  return created === null || londonDate(created) !== londonDate(now);
}
