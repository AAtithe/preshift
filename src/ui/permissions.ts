import { can, type Permission } from '../engine/access';
import { toISODate } from '../engine/time';
import type { Me } from './access/model';

export type Allow = (p: Permission, siteId?: string) => boolean;

/**
 * The same test the API applies, run in the browser so a screen only offers
 * what the server will accept. It previews; the server still decides.
 */
export function allowFor(me: Me | null): Allow {
  if (!me) return () => false;
  const user = me.user;
  if (!user) return () => true;
  const today = toISODate(new Date());
  return (p, siteId) => can(user, p, today, siteId);
}

/**
 * What the person's roles grant once their authenticator is set up and proved this session. A new
 * owner holds settings.manage from the start, but it stays off until then; this tells the app to
 * walk them through the authenticator rather than treat them as someone with no role.
 */
export function heldOnceVerified(me: Me | null): Allow {
  if (!me?.user) return allowFor(me);
  const user = { ...me.user, mfaEnrolled: true };
  const today = toISODate(new Date());
  return (p, siteId) => can(user, p, today, siteId);
}

export const NOT_YOURS = 'Your roles do not include this here.';
