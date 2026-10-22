// What became of an email Preshift sent, as the People list carries it, and what that asks of
// whoever manages access. Shared by the API and the browser, so the overview and the server agree.

import { ukDate, type Attention, type User } from './access';

export type MailKind = 'invite' | 'reset' | 'forgot' | 'staff_invite' | 'email_change';
export type MailStatus = 'sent' | 'delivered' | 'delayed' | 'bounced' | 'complained' | 'failed';

export interface MailView {
  id: string;
  to: string;
  kind: MailKind;
  userId?: string;
  /** A staff app invitation names the employee, who has no Preshift account. */
  employeeId?: string;
  sentAt: string;
  by: string;
  status: MailStatus;
  /** When the status was reported. */
  at: string;
  detail?: string;
}

const WHAT: Record<MailKind, string> = { invite: 'invitation', reset: 'password reset email', forgot: 'password reset email', staff_invite: 'staff app invitation', email_change: 'new email confirmation' };

/**
 * An email that went wrong, while it still matters: an invitation while the person has not
 * accepted, a reset while they have not signed in since. Each says what to do next.
 */
export function mailAttention(users: User[], latest: Map<string, MailView>): Attention[] {
  const out: Attention[] = [];
  for (const u of users) {
    const m = latest.get(u.id);
    if (!m || u.status === 'suspended') continue;
    const stillMatters = m.kind === 'invite' ? u.status === 'invited' : !u.lastSeenAt || u.lastSeenAt < m.sentAt;
    if (!stillMatters) continue;
    const what = `${u.name}'s ${WHAT[m.kind]} to ${m.to}`;
    const because = m.detail ? ` (${m.detail.replace(/\.$/, '')})` : '';
    const handOver =
      m.kind === 'invite'
        ? 'Withdraw the invitation and invite the right address, or resend it and hand the link over in person.'
        : m.kind === 'email_change'
          ? 'Check the new address with them, then ask for the change again, or hand the link over in person.'
          : 'Reset again and hand the link over in person.';
    if (m.status === 'bounced') {
      out.push({ kind: 'email_bounced', severity: 'warn', userId: u.id, message: `${what} bounced on ${ukDate(m.at)}${because}. ${handOver}` });
    } else if (m.status === 'failed') {
      out.push({ kind: 'email_failed', severity: 'warn', userId: u.id, message: `${what} could not be sent${because}. Check the email settings, or hand the link over in person.` });
    } else if (m.status === 'complained') {
      out.push({ kind: 'email_complained', severity: 'warn', userId: u.id, message: `${what} was marked as spam. Resend stops sending to that address, so hand links over in person.` });
    } else if (m.status === 'delayed') {
      out.push({ kind: 'email_delayed', severity: 'info', userId: u.id, message: `${what} is delayed. Resend keeps trying for up to 72 hours.` });
    }
  }
  return out;
}

