import { can, type User } from '../src/engine/access';
import { ABSENCE_LABEL } from '../src/engine/hr';
import { dayLabel, namesOf, shiftLine } from '../src/engine/requests';
import { addDays } from '../src/engine/time';
import type { StaffRequest } from '../src/engine/types';
import { emailSetting, linkFor, managerDigestEmail, parseEmailSettings, sendMail } from './mail';
import { authority } from './routes/requests';
import { isSandbox } from './sandbox';
import { audit, type OrgData, type Store } from './store';

/** Open shifts still unfilled this close to the day are worth a manager's morning. */
export const DIGEST_OPEN_SHIFT_DAYS = 7;

export interface DigestSection {
  heading: string;
  lines: string[];
}

export interface Digest {
  user: User;
  sections: DigestSection[];
  /** How many things are waiting for this person, for the subject line. */
  count: number;
}

const span = (r: StaffRequest) => (r.from ? (r.to && r.to !== r.from ? `${dayLabel(r.from)} to ${dayLabel(r.to)}` : r.to ? dayLabel(r.from) : `since ${dayLabel(r.from)}`) : '');

/**
 * What each manager has waiting this morning: the requests they may decide, oldest first, and the
 * open shifts at their sites still unfilled in the week ahead. Names, dates and times only: an email
 * can be forwarded or read over a shoulder, so no absence reason, note or pay ever goes in it.
 * People with nothing waiting, who have turned it off, or who asked for the thing themselves, get nothing.
 */
export function managerDigests(org: OrgData, today: string): Digest[] {
  const names = namesOf(org.state);
  const person = (id?: string) => (id ? org.state.employees.find((e) => e.id === id)?.name ?? id : '');
  const off = new Set(org.settings.digestOff ?? []);
  const open = (org.requests ?? []).filter((r) => r.status === 'pending' || r.status === 'accepted').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const unfilled = (org.openShifts ?? []).filter((o) => o.status === 'open' && o.date >= today && o.date <= addDays(today, DIGEST_OPEN_SHIFT_DAYS));
  const out: Digest[] = [];
  for (const user of org.users) {
    if (user.status !== 'active' || off.has(user.id)) continue;
    // A swap nobody has agreed to yet is not the manager's to decide.
    const mine = open.filter(
      (r) => !(r.kind === 'swap' && r.status === 'pending') && r.employeeId !== user.employeeId && can(user, authority(r.kind).permission, today, r.siteId),
    );
    const line = (r: StaffRequest) => {
      const waited = Math.max(0, Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(r.createdAt)) / 86_400_000));
      const age = waited >= 2 ? ` Waiting ${waited} days.` : '';
      const shift = org.state.shifts.find((s) => s.id === r.shiftId);
      const os = (org.openShifts ?? []).find((o) => o.id === r.openShiftId);
      const what =
        r.kind === 'holiday' ? `holiday ${span(r)}${r.hours ? `, ${r.hours} h` : ''}`
        : r.kind === 'time_off' ? `${ABSENCE_LABEL[r.absenceType ?? 'other'].toLowerCase()}, ${span(r)}`
        : r.kind === 'availability' ? 'a new weekly availability'
        : r.kind === 'swap' ? `${shift ? shiftLine(shift, names) : 'a shift'} to ${person(r.takerId)}, who has agreed`
        : r.kind === 'open_shift' ? `the open shift ${os ? shiftLine(os, names) : ''}`.trimEnd()
        : `off sick ${span(r)}`;
      return `${person(r.employeeId)}, ${names.site(r.siteId)}: ${what}.${age}`;
    };
    const sections: DigestSection[] = [];
    const sick = mine.filter((r) => r.kind === 'sickness');
    if (sick.length) {
      sections.push({
        heading: 'Sickness to cover',
        lines: sick.map((r) => {
          const shifts = org.state.shifts.filter((s) => s.employeeId === r.employeeId && s.date >= today && s.date >= r.from! && (!r.to || s.date <= r.to) && s.date <= addDays(today, 6));
          return `${line(r)} ${shifts.length ? `${shifts.length} shift${shifts.length === 1 ? '' : 's'} this week still on their name.` : 'No shifts on their name this week.'}`;
        }),
      });
    }
    const asks = mine.filter((r) => r.kind !== 'sickness');
    if (asks.length) sections.push({ heading: `${asks.length} request${asks.length === 1 ? '' : 's'} to decide`, lines: asks.map(line) });
    const shifts = unfilled.filter((o) => can(user, 'rota.publish', today, o.siteId));
    if (shifts.length) {
      sections.push({
        heading: 'Open shifts not yet filled',
        lines: shifts.map((o) => {
          const claims = (org.requests ?? []).filter((r) => r.openShiftId === o.id && r.status === 'pending').length;
          return `${shiftLine(o, names)}: ${claims ? `${claims} claim${claims === 1 ? '' : 's'} to decide` : 'nobody has claimed it yet'}.`;
        }),
      });
    }
    const count = mine.length + shifts.length;
    if (count) out.push({ user, sections, count });
  }
  return out;
}

/**
 * Sends each organisation's morning digest once a day, through its own Resend. Organisations without
 * email set up, and demo sandboxes, are skipped. The day is marked before sending, so a run that is
 * retried never emails anyone twice; a send that fails is logged and not retried until tomorrow.
 */
export async function sendManagerDigests(store: Store, today: string, log: (msg: string, detail: Record<string, unknown>) => void = () => {}) {
  let sent = 0;
  let orgs = 0;
  for (const orgId of await store.orgIds()) {
    if (isSandbox(orgId)) continue;
    const org = await store.load(orgId);
    if (org.lastDigest === today) continue;
    const settings = parseEmailSettings(await store.getSetting(emailSetting(orgId)));
    if (!settings) continue;
    const digests = managerDigests(org, today);
    org.lastDigest = today;
    audit(org, 'system', 'requests.digest_sent', { people: digests.length });
    await store.save(org);
    orgs++;
    for (const d of digests) {
      const id = await sendMail(settings, managerDigestEmail(d.user.email, d.user.name, d.count, d.sections, linkFor(settings, '/app/?view=requests')));
      if (id === null) log('manager digest not sent', { orgId, userId: d.user.id });
      else sent++;
    }
  }
  return { orgs, sent };
}
