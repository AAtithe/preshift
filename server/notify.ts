import { randomUUID } from 'node:crypto';
import { dayLabel, namesOf, pruneNotifications, weekChange, weekLines } from '../src/engine/requests';
import { londonParts, weekDates, weekStart } from '../src/engine/time';
import type { Shift, StaffNotification, StaffNotificationKind } from '../src/engine/types';
import { emailSetting, linkFor, parseEmailSettings, sendMail, staffNoticeEmail } from './mail';
import type { OrgData, Store } from './store';

/**
 * Tells one member of staff something. It shows in their staff app at once, and is emailed once
 * the request that raised it has saved (see emailNotifications), so a refused change tells nobody.
 */
export function notify(org: OrgData, employeeId: string, kind: StaffNotificationKind, title: string, body: string, at = new Date()) {
  const note: StaffNotification = { id: `ntf_${randomUUID().slice(0, 12)}`, employeeId, kind, at: at.toISOString(), title, body, email: 'pending' };
  org.notifications = pruneNotifications([...(org.notifications ?? []), note], londonParts(at).date);
  return note;
}

const toldKey = (employeeId: string, siteId: string, ws: string) => `${employeeId}|${siteId}|${ws}`;

/**
 * After a publish: each person whose published week at these sites differs from what they were
 * last told hears about it. The first publish of a week lists their shifts; a later one lists
 * what was added and what was taken off. People with no change hear nothing.
 */
export function notifyPublished(org: OrgData, siteIds: string[], ws: string, at = new Date()) {
  const dates = new Set(weekDates(ws));
  const names = namesOf(org.state);
  const told = (org.toldWeeks ??= {});
  const week = `week of ${dayLabel(ws)}`;
  for (const siteId of siteIds) {
    const site = names.site(siteId);
    const byPerson = new Map<string, Shift[]>();
    for (const s of org.state.shifts) {
      if (s.siteId === siteId && dates.has(s.date) && s.published) byPerson.set(s.employeeId, [...(byPerson.get(s.employeeId) ?? []), s]);
    }
    // People told before about this week and site who now have nothing there are told too.
    const suffix = `|${siteId}|${ws}`;
    const before = Object.keys(told).filter((k) => k.endsWith(suffix)).map((k) => k.slice(0, -suffix.length));
    for (const employeeId of new Set([...byPerson.keys(), ...before])) {
      const key = toldKey(employeeId, siteId, ws);
      const now = weekLines(byPerson.get(employeeId) ?? [], names);
      const was = told[key];
      if (!was) {
        if (now.length === 0) continue;
        notify(org, employeeId, 'rota_published', `Your rota at ${site} is out`, `${week}: ${now.join('; ')}.`, at);
      } else {
        const { added, removed } = weekChange(was, now);
        if (added.length === 0 && removed.length === 0) continue;
        const parts = [added.length ? `New: ${added.join('; ')}.` : '', removed.length ? `Taken off: ${removed.join('; ')}.` : ''].filter(Boolean);
        notify(org, employeeId, 'rota_changed', `Your shifts at ${site} have changed`, `${week}. ${parts.join(' ')}`, at);
      }
      if (now.length) told[key] = now;
      else delete told[key];
    }
  }
}

/**
 * Keeps what a person was told in step with a change made straight to their published week (a
 * swap, a claimed open shift, a cancelled shift), which they are told about on its own, so the
 * next publish does not tell them again.
 */
export function syncTold(org: OrgData, employeeIds: string[], shifts: Pick<Shift, 'siteId' | 'date'>[]) {
  const names = namesOf(org.state);
  const told = (org.toldWeeks ??= {});
  const pairs = new Set(shifts.map((s) => `${s.siteId}|${weekStart(s.date)}`));
  for (const employeeId of employeeIds) {
    for (const pair of pairs) {
      const [siteId, ws] = pair.split('|');
      const dates = new Set(weekDates(ws));
      const key = toldKey(employeeId, siteId, ws);
      // Only weeks the person has been told about: an unpublished week is told whole when it goes out.
      if (!told[key] && !org.state.shifts.some((s) => s.employeeId === employeeId && s.siteId === siteId && dates.has(s.date) && s.published)) continue;
      const now = weekLines(org.state.shifts.filter((s) => s.employeeId === employeeId && s.siteId === siteId && dates.has(s.date) && s.published), names);
      if (now.length) told[key] = now;
      else delete told[key];
    }
  }
}

/**
 * Emails what is waiting, one email per person, to their staff app address or else the one on
 * their record. Run inside the request, after its checks and before its save, so the saved state
 * says what was sent. Without email set up, or an address, the notice stays in the app only.
 */
export async function emailNotifications(store: Store, org: OrgData) {
  const pending = (org.notifications ?? []).filter((n) => n.email === 'pending');
  if (pending.length === 0) return;
  const settings = parseEmailSettings(await store.getSetting(emailSetting(org.orgId)));
  const byPerson = new Map<string, StaffNotification[]>();
  for (const n of pending) byPerson.set(n.employeeId, [...(byPerson.get(n.employeeId) ?? []), n]);
  for (const [employeeId, notes] of byPerson) {
    const e = org.state.employees.find((x) => x.id === employeeId);
    const login = settings && e ? await store.getStaffLogin(org.orgId, employeeId) : null;
    const to = (login?.email ?? e?.email ?? '').trim().toLowerCase();
    if (!settings || !e || e.status === 'leaver' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
      for (const n of notes) n.email = 'none';
      continue;
    }
    const id = await sendMail(settings, staffNoticeEmail(to, e.name, notes, linkFor(settings, '/staff/')));
    for (const n of notes) n.email = id === null ? 'failed' : 'sent';
  }
}
