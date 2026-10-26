// The review of staff app logins closed and opened again. A reset only ever goes to the person's
// own email, so the one way a manager can take over someone's clocking is to close their login,
// invite them again and set it up themselves. That cannot be blocked, as it is also how someone
// who has lost their address gets back in; it is caught by review. Shared by the API and the page.

import type { TimeEntry } from './types';

/** One event in a staff login's life, kept for good: the audit log is trimmed, this is not. */
export interface StaffLoginEvent {
  at: string;
  employeeId: string;
  kind: 'invited' | 'activated' | 'closed';
  /** Who did it: a manager's name, or the person themselves for an activation. */
  by: string;
  /** For an invite: whether it went to the person's own email rather than being handed over. */
  emailed?: boolean;
  /** For an activation: the address the login was set up with. */
  email?: string;
}

export interface LoginCaseReview {
  caseId: string;
  at: string;
  by: string;
  outcome: 'genuine' | 'concern';
  note: string;
}

export type LoginFlag = 'same_person' | 'handed_over' | 'new_address' | 'phone_hours';

export const FLAG_TEXT: Record<LoginFlag, string> = {
  same_person: 'The same person closed the login and invited them again',
  handed_over: 'The new link was handed over, not emailed to them',
  new_address: 'They set it up again with a different email',
  phone_hours: 'Hours have been clocked by phone since',
};

export interface LoginCase {
  /** The employee and the moment the login was closed: stable, so a review stays with its case. */
  id: string;
  employeeId: string;
  closedAt: string;
  closedBy: string;
  reinvitedAt?: string;
  reinvitedBy?: string;
  reinviteEmailed?: boolean;
  rejoinedAt?: string;
  previousEmail?: string;
  newEmail?: string;
  /** Hours clocked on the phone from the re-join to the next close, or to now. */
  phoneHours: number;
  /** Closed and left closed; invited again; set up again. */
  status: 'closed' | 'reinvited' | 'rejoined';
  flags: LoginFlag[];
  risk: 'high' | 'medium' | 'low';
  review?: LoginCaseReview;
  /** Opened again and not yet signed off. A login left closed gives nobody access and needs none. */
  needsReview: boolean;
}

const hoursOf = (e: TimeEntry) => (e.clockOut === undefined ? 0 : Math.max(0, e.clockOut - e.clockIn - e.breakMinutes) / 60);
/** When a time entry started, as an ISO instant comparable with the log's. Minutes on its date, read as UTC like the rest of the engine. */
const startOf = (e: TimeEntry) => new Date(Date.parse(`${e.date}T00:00:00Z`) + e.clockIn * 60_000).toISOString();

/**
 * Every login close in [from, to] (ISO dates, inclusive), followed through to what came after it,
 * newest first. A close starts a case; the first invite after it and the first activation after
 * that belong to it, until the next close of the same login.
 */
export function loginCases(log: StaffLoginEvent[], reviews: LoginCaseReview[], entries: TimeEntry[], from: string, to: string): LoginCase[] {
  const byEmployee = new Map<string, StaffLoginEvent[]>();
  for (const e of [...log].sort((a, b) => a.at.localeCompare(b.at))) byEmployee.set(e.employeeId, [...(byEmployee.get(e.employeeId) ?? []), e]);
  const reviewOf = new Map<string, LoginCaseReview>();
  for (const r of [...reviews].sort((a, b) => a.at.localeCompare(b.at))) reviewOf.set(r.caseId, r);

  const cases: LoginCase[] = [];
  for (const [employeeId, events] of byEmployee) {
    events.forEach((close, i) => {
      if (close.kind !== 'closed') return;
      const day = close.at.slice(0, 10);
      if (day < from || day > to) return;
      const next = events.findIndex((e, j) => j > i && e.kind === 'closed');
      const after = events.slice(i + 1, next === -1 ? undefined : next);
      const previous = [...events.slice(0, i)].reverse().find((e) => e.kind === 'activated');
      const invite = after.find((e) => e.kind === 'invited');
      const rejoin = invite ? after.find((e) => e.kind === 'activated' && e.at >= invite.at) : undefined;
      const until = next === -1 ? '9999' : events[next].at;
      const phoneHours = rejoin
        ? entries.filter((t) => t.employeeId === employeeId && (t.method === 'phone' || t.method === 'tag') && startOf(t) >= rejoin.at && startOf(t) < until).reduce((s, t) => s + hoursOf(t), 0)
        : 0;

      const flags: LoginFlag[] = [];
      if (invite && invite.by === close.by) flags.push('same_person');
      if (invite && invite.emailed === false) flags.push('handed_over');
      if (rejoin && previous?.email && rejoin.email && rejoin.email !== previous.email) flags.push('new_address');
      if (phoneHours > 0) flags.push('phone_hours');
      // A handed-over link taken up by the same hands is the pattern that matters; the rest is context.
      const risk = flags.includes('same_person') && flags.includes('handed_over') && (flags.includes('new_address') || flags.includes('phone_hours'))
        ? 'high'
        : flags.includes('handed_over') || flags.includes('same_person')
          ? 'medium'
          : 'low';
      const id = `${employeeId}:${close.at}`;
      const status = rejoin ? 'rejoined' : invite ? 'reinvited' : 'closed';
      const review = reviewOf.get(id);
      cases.push({
        id,
        employeeId,
        closedAt: close.at,
        closedBy: close.by,
        reinvitedAt: invite?.at,
        reinvitedBy: invite?.by,
        reinviteEmailed: invite?.emailed,
        rejoinedAt: rejoin?.at,
        previousEmail: previous?.email,
        newEmail: rejoin?.email,
        phoneHours: Math.round(phoneHours * 100) / 100,
        status,
        flags,
        risk,
        review,
        needsReview: status !== 'closed' && !review,
      });
    });
  }
  return cases.sort((a, b) => b.closedAt.localeCompare(a.closedAt));
}

/** Why this person may not sign this case off: four eyes, so never someone who closed or re-invited it. */
export function reviewRefusal(c: LoginCase, reviewer: string): string | null {
  if (c.status === 'closed') return 'This login was closed and not opened again, so there is nothing to sign off.';
  if (c.review) return `This was signed off by ${c.review.by} on ${c.review.at.slice(0, 10)}.`;
  if (reviewer === c.closedBy || reviewer === c.reinvitedBy) return 'You closed or re-invited this login, so someone else must review it.';
  return null;
}
