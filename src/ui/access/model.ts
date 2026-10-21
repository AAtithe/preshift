import {
  accessHealth, AUDIENCE_LABEL, live, PERMISSIONS, roleOf, ukDate, type AccessReview, type Actor, type Attention, type Permission, type User,
} from '../../engine/access';
import { mailAttention, type MailView } from '../../engine/mail';
import { addDays, toISODate } from '../../engine/time';
import type { AuthenticatorState } from './Authenticator';
import type { RotaState } from '../../engine/types';

export interface Me {
  key: string;
  user?: User;
  permissions: Permission[];
  /** Signed in with no access record: organisation-wide, as before roles existed. */
  withoutRecord?: boolean;
  authenticator?: AuthenticatorState;
  simulator?: boolean;
}

/** Whether a person can sign in: from their account, which holds the password. Never the hash. */
export interface AccountState {
  exists: boolean;
  locked: boolean;
  since?: string;
}

export const accountOf = (u: User) => (u as User & { account?: AccountState }).account;

export function signInState(u: User): { text: string; tone: 'good' | 'bad' | 'muted' } {
  const a = accountOf(u);
  if (!a) return { text: 'Unknown', tone: 'muted' };
  if (a.locked) return { text: 'Locked after wrong passwords', tone: 'bad' };
  if (a.exists) return { text: 'Password set', tone: 'good' };
  return { text: u.status === 'invited' ? 'Sets a password from the invitation' : 'No password yet', tone: 'muted' };
}

export interface AuditRow {
  at: string;
  actor: string;
  action: string;
  detail?: Record<string, unknown>;
}

export const today = () => toISODate(new Date());

export const actorOf = (me: Me): Actor => (me.user ? { kind: 'user', user: me.user } : { kind: 'system', name: me.key });

/** The same list the server gives: access rules, then emails that did not arrive, worst first. */
export function healthOf(users: User[], state: RotaState, reviews: AccessReview[]): Attention[] {
  const latest = new Map(users.flatMap((u) => { const m = lastEmailOf(u); return m ? [[u.id, m] as const] : []; }));
  const rank = { block: 0, warn: 1, info: 2 };
  return [...accessHealth(users, state.sites, state.employees, reviews, today()), ...mailAttention(users, latest)].sort((x, y) => rank[x.severity] - rank[y.severity]);
}

export const siteName = (state: RotaState, id: string) => state.sites.find((s) => s.id === id)?.name ?? id;

export function reach(state: RotaState, siteIds: string[] | null) {
  return siteIds ? siteIds.map((id) => siteName(state, id)).join(', ') : 'Every site';
}

export const STATUS_LABEL: Record<User['status'], string> = { active: 'Active', invited: 'Invited', suspended: 'Suspended' };

export function needsAuthenticator(u: User) {
  return u.memberships.some((m) => live(m, today()) && roleOf(m.roleId)?.mfa);
}

export function signInText(u: User): { text: string; tone: 'good' | 'bad' | 'muted' } {
  if (u.mfaEnrolled) return { text: 'Authenticator', tone: 'good' };
  if (needsAuthenticator(u) && u.status === 'active') return { text: 'Must enrol', tone: 'bad' };
  return { text: needsAuthenticator(u) ? 'Will need one' : 'Not required', tone: 'muted' };
}

export function lastSeen(u: User): string {
  if (u.status === 'invited') return u.inviteExpiresAt ? `Invite ${u.inviteExpiresAt < today() ? 'expired' : 'ends'} ${shortDate(u.inviteExpiresAt)}` : 'Invited';
  if (!u.lastSeenAt) return 'Never';
  const days = Math.round((Date.parse(today()) - Date.parse(u.lastSeenAt.slice(0, 10))) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return days < 60 ? `${days} days ago` : shortDate(u.lastSeenAt.slice(0, 10));
}

export const shortDate = ukDate;

export const endingSoon = (ends?: string) => !!ends && ends >= today() && ends <= addDays(today(), 30);

/** Permissions grouped by area, for "what this lets them do". */
export function byArea(perms: Iterable<Permission>) {
  const out = new Map<string, Permission[]>();
  for (const p of perms) {
    const area = PERMISSIONS[p].area;
    out.set(area, [...(out.get(area) ?? []), p]);
  }
  return [...out.entries()];
}

const ACTION_TEXT: Record<string, string> = {
  'user.invited': 'Invited',
  'user.updated': 'Updated details',
  'user.suspended': 'Suspended',
  'user.reactivated': 'Reactivated',
  'user.authenticator_reset': 'Reset authenticator',
  'membership.granted': 'Granted a role',
  'membership.revoked': 'Removed a role',
  'membership.end_changed': 'Changed an end date',
  'invite.resent': 'Resent invitation',
  'invite.revoked': 'Withdrew invitation',
  'invite.accepted': 'Accepted invitation',
  'email.bounced': 'Email bounced',
  'email.complained': 'Email marked as spam',
  'email.failed': 'Email could not be sent',
  'access.reviewed': 'Recorded an access review',
  'access.owner_created': 'Created the owner account',
  'user.password_reset': 'Reset the password',
  'user.password_set': 'Set a password from a link',
  'authenticator.enrolled': 'Set up an authenticator',
  'authenticator.verified': 'Entered an authenticator code',
  'authenticator.recovery_used': 'Used a recovery code',
  'authenticator.recovery_replaced': 'Made new recovery codes',
  'authenticator.locked': 'Locked out after wrong codes',
};

export function describeEvent(e: AuditRow, users: User[], state: RotaState): { what: string; whom: string; detail: string } {
  const d = e.detail ?? {};
  const whom = typeof d.userId === 'string' ? users.find((u) => u.id === d.userId)?.name ?? String(d.email ?? d.userId) : '';
  const role = typeof d.roleId === 'string' ? roleOf(d.roleId)?.name ?? d.roleId : '';
  const parts: string[] = [];
  if (role) parts.push(`${role}, ${reach(state, (d.siteIds as string[] | null) ?? null)}`);
  if (typeof d.ends === 'string') parts.push(`until ${shortDate(d.ends)}`);
  if (e.action === 'membership.end_changed') parts.push(`${d.from ? shortDate(String(d.from)) : 'no end'} to ${shortDate(String(d.to))}`);
  if (Array.isArray(d.warnings) && d.warnings.length) parts.push(`accepted ${d.warnings.length} paired-duty warning${d.warnings.length > 1 ? 's' : ''}`);
  if (e.action === 'access.reviewed') parts.push(`${d.people} people, ${d.attention} open points`);
  if (e.action === 'user.invited' && typeof d.audience === 'string') parts.push(AUDIENCE_LABEL[d.audience as User['audience']]);
  if (d.emailed === true) parts.push('emailed');
  if (d.handedOver === true) parts.push('link handed over');
  else if (d.emailed === false) parts.push('link shown to the sender');
  if (e.action.startsWith('email.') && typeof d.kind === 'string') parts.push(MAIL_KIND[d.kind as MailState['kind']] ?? d.kind);
  return { what: ACTION_TEXT[e.action] ?? e.action, whom, detail: parts.join('; ') };
}

export function csvOfAccess(users: User[], state: RotaState): string {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const rows = [['Name', 'Email', 'Job title', 'Side', 'Status', 'Authenticator', 'Role', 'Reach', 'From', 'Until', 'Granted by', 'Granted on', 'Last seen']];
  for (const u of users) {
    const ms = u.memberships.filter((m) => m.active);
    for (const m of ms.length ? ms : [null]) {
      rows.push([
        u.name, u.email, u.jobTitle ?? '', AUDIENCE_LABEL[u.audience], STATUS_LABEL[u.status], u.mfaEnrolled ? 'Yes' : 'No',
        m ? roleOf(m.roleId)?.name ?? m.roleId : '', m ? reach(state, m.siteIds) : '', m?.starts ?? '', m?.ends ?? '',
        m?.grantedBy ?? '', m?.grantedAt.slice(0, 10) ?? '', u.lastSeenAt?.slice(0, 10) ?? '',
      ]);
    }
  }
  return rows.map((r) => r.map(esc).join(',')).join('\n');
}

/** How a link went out: by email, or back to whoever made it, to hand over. */
export interface Delivery {
  emailed?: boolean;
  inviteUrl?: string;
  emailProblem?: string;
}

/** Links come back relative until the app's address is saved under Settings. */
export const fullLink = (url: string) => (/^https?:\/\//.test(url) ? url : `${location.origin}${url}`);

/** What to tell whoever sent a link: that it was emailed, or the link itself, shown this once. */
export function deliveryText(done: string, email: string, d: Delivery | undefined): string {
  if (d?.emailed) return `${done}. The link is on its way to ${email}.`;
  if (!d?.inviteUrl) return done;
  return `${done}. ${d.emailProblem ? `${d.emailProblem} ` : ''}Send them this link yourself; it works once and is not shown again: ${fullLink(d.inviteUrl)}`;
}

/** The last email sent to a person and what Resend reported, from the People list. */
export type MailState = MailView;

export const lastEmailOf = (u: User) => (u as User & { lastEmail?: MailState }).lastEmail;

export const MAIL_KIND: Record<MailState['kind'], string> = { invite: 'Invitation', reset: 'Password reset', forgot: 'Forgotten password' };

const MAIL_STATUS: Record<MailState['status'], { text: string; tone: 'good' | 'bad' | 'muted' }> = {
  sent: { text: 'accepted by Resend, not yet confirmed delivered', tone: 'muted' },
  delivered: { text: 'delivered', tone: 'good' },
  delayed: { text: 'delayed, Resend is retrying', tone: 'muted' },
  bounced: { text: 'bounced', tone: 'bad' },
  complained: { text: 'marked as spam', tone: 'bad' },
  failed: { text: 'could not be sent', tone: 'bad' },
};

/** An email that did not reach the person: a link sent again by email would likely fail the same way. */
export const undelivered = (m: MailState | undefined) => !!m && (m.status === 'bounced' || m.status === 'complained' || m.status === 'failed');

/** Whether Resend may still have more to say. */
export const unsettled = (m: MailState | undefined) => !!m && (m.status === 'sent' || m.status === 'delayed');

export function emailState(m: MailState): { text: string; tone: 'good' | 'bad' | 'muted' } {
  const s = MAIL_STATUS[m.status];
  const when = m.status === 'sent' ? shortDate(m.sentAt.slice(0, 10)) : shortDate(m.at.slice(0, 10));
  return { text: `${MAIL_KIND[m.kind]} email ${s.text}, ${when}${m.detail ? `: ${m.detail}` : ''}`, tone: s.tone };
}
