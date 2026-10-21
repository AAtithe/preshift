import {
  accessHealth, AUDIENCE_LABEL, live, PERMISSIONS, roleOf, ukDate, type AccessReview, type Actor, type Attention, type Permission, type User,
} from '../../engine/access';
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

export interface AuditRow {
  at: string;
  actor: string;
  action: string;
  detail?: Record<string, unknown>;
}

export const today = () => toISODate(new Date());

export const actorOf = (me: Me): Actor => (me.user ? { kind: 'user', user: me.user } : { kind: 'system', name: me.key });

export function healthOf(users: User[], state: RotaState, reviews: AccessReview[]): Attention[] {
  return accessHealth(users, state.sites, state.employees, reviews, today());
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
  'access.reviewed': 'Recorded an access review',
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
