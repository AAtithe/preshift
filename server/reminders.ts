import { can } from '../src/engine/access';
import { dueAlerts, pruneAlerts, type DueAlert } from '../src/engine/reminders';
import { namesOf, shiftLine } from '../src/engine/requests';
import { formatMinute, londonParts } from '../src/engine/time';
import { emailSetting, lateAlertEmail, linkFor, parseEmailSettings, sendMail } from './mail';
import { deliverNotifications, notify } from './notify';
import { releaseDueWaves } from './routes/requests';
import { isSandbox } from './sandbox';
import { audit, type OrgData, type Store } from './store';

/**
 * Sends what is due now in one organisation: reminders to each person's phone, and for a shift
 * nobody has clocked in for, a nudge to the person and an email to whoever publishes that site's
 * rota. Each is marked before it is delivered, so a run that overlaps another never sends twice.
 * Returns what was sent, or null when nothing was due.
 */
export async function shiftAlerts(store: Store, org: OrgData, at: Date, fetcher: typeof fetch = fetch) {
  const now = londonParts(at);
  const sent = pruneAlerts(org.shiftAlerts ?? {}, now.date);
  const due = dueAlerts(org.state, org.timeEntries, sent, now);
  if (due.length === 0) {
    if (Object.keys(sent).length !== Object.keys(org.shiftAlerts ?? {}).length) org.shiftAlerts = sent;
    return null;
  }
  const logins = new Map((await store.listStaffLogins(org.orgId)).map((l) => [l.employeeId, l]));
  const names = namesOf(org.state);
  const late: DueAlert[] = [];
  for (const a of due) {
    sent[a.shift.id] = { ...(sent[a.shift.id] ?? { date: a.shift.date }), [a.kind]: at.toISOString() };
    const login = logins.get(a.shift.employeeId);
    const line = shiftLine(a.shift, names);
    if (a.kind === 'late') {
      late.push(a);
      if (login?.hash) notify(org, a.shift.employeeId, 'shift_late', 'You have not clocked in', `${line} started at ${formatMinute(a.shift.startMinute)}. Clock in now, or tell your manager if you cannot make it.`, at, { email: false });
      continue;
    }
    // Reminders only reach people with the app, and not those who turned them off.
    if (!login?.hash || login.reminders === false) continue;
    const title = a.kind === 'evening' ? 'You are working tomorrow' : `Your shift starts at ${formatMinute(a.shift.startMinute)}`;
    notify(org, a.shift.employeeId, 'shift_reminder', title, `${line}.`, at, { email: false });
  }
  org.shiftAlerts = sent;
  await deliverNotifications(store, org, fetcher);
  const emailed = await emailLate(store, org, late, now);
  audit(org, 'system', 'shifts.alerts_sent', { reminders: due.length - late.length, late: late.length });
  return { reminders: due.length - late.length, late: late.length, emailed };
}

/** Tells each manager who publishes the site's rota, unless they turned staff request emails off or it is about them. */
async function emailLate(store: Store, org: OrgData, late: DueAlert[], now: { date: string; minute: number }) {
  if (late.length === 0) return 0;
  const settings = parseEmailSettings(await store.getSetting(emailSetting(org.orgId)));
  if (!settings) return 0;
  const off = new Set(org.settings.digestOff ?? []);
  const names = namesOf(org.state);
  let emailed = 0;
  for (const a of late) {
    const person = org.state.employees.find((e) => e.id === a.shift.employeeId)?.name ?? 'Someone';
    const managers = org.users.filter((u) => u.status === 'active' && !off.has(u.id) && u.employeeId !== a.shift.employeeId && can(u, 'rota.publish', now.date, a.shift.siteId));
    for (const u of managers) {
      const id = await sendMail(settings, lateAlertEmail(u.email, u.name, person, shiftLine(a.shift, names), -a.startsIn, linkFor(settings, '/app/?view=requests')));
      if (id !== null) emailed++;
    }
  }
  return emailed;
}

/**
 * The scheduled run across every organisation, every few minutes. Demo sandboxes are left out; one
 * organisation failing never stops the rest, and the run stops before the function's time runs out.
 */
export async function runShiftAlerts(
  store: Store,
  at = new Date(),
  log: (msg: string, detail: Record<string, unknown>) => void = () => {},
  // Sends notices to people who chose WhatsApp or text there instead of push and email.
  carry: (org: OrgData) => Promise<void> = async () => {},
) {
  const started = Date.now();
  let reminders = 0;
  let late = 0;
  let offers = 0;
  for (const orgId of await store.orgIds()) {
    if (isSandbox(orgId) || Date.now() - started > 40_000) continue;
    try {
      const org = await store.load(orgId);
      const before = JSON.stringify([org.shiftAlerts ?? {}, (org.openShifts ?? []).map((o) => o.offer)]);
      // Open shifts whose cheaper wave has had its time go to the next.
      const offered = releaseDueWaves(org, at);
      if (offered) await carry(org);
      const result = await shiftAlerts(store, org, at);
      if (offered && !result) await deliverNotifications(store, org);
      offers += offered;
      if (result || JSON.stringify([org.shiftAlerts ?? {}, (org.openShifts ?? []).map((o) => o.offer)]) !== before) await store.save(org);
      reminders += result?.reminders ?? 0;
      late += result?.late ?? 0;
    } catch (err) {
      log('shift alerts failed', { orgId, err: (err as Error).message });
    }
  }
  return { reminders, late, offers };
}
