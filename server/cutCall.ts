import { can } from '../src/engine/access';
import { cutCall, type CutCall } from '../src/engine/cutcall';
import { intradayFlash, type IntradayFlash } from '../src/engine/labourFlash';
import { formatMinute, londonParts } from '../src/engine/time';
import { eraSettings } from './employmentRights';
import { callInEmail, cutCallEmail, emailSetting, linkFor, parseEmailSettings, sendMail } from './mail';
import { isSandbox } from './sandbox';
import { audit, type OrgData, type Store } from './store';

/** A site's cut call and labour flash at an instant, priced with the organisation's Employment Rights Act settings. */
export function siteCall(org: OrgData, siteId: string, at: Date): { date: string; call: CutCall; flash: IntradayFlash } {
  const { date, minute } = londonParts(at);
  const call = cutCall(org.state, org.timeEntries, siteId, date, minute, { rights: { settings: eraSettings(org), at } });
  return { date, call, flash: intradayFlash(org.state, org.timeEntries, siteId, date, minute, call) };
}

/** An alert is worth a manager's attention only for a saving at least this size. */
export const ALERT_MIN_SAVING = 25;
/** Trading this far ahead of forecast, with hours short, is worth calling someone in for. */
export const AHEAD_PACE = 1.15;

const money = (n: number) => `£${n.toFixed(0)}`;

/**
 * Tells whoever publishes each site's rota, once a day each way: when trading has fallen behind and
 * early finishes would save at least ALERT_MIN_SAVING, and when it is running well ahead with hours
 * still short. Only while the site trades, and only on a call the cut call is confident in.
 */
export async function cutCallAlerts(store: Store, org: OrgData, at: Date) {
  const now = londonParts(at);
  const sent = Object.fromEntries(Object.entries(org.cutAlerts ?? {}).filter(([k]) => k.endsWith(`|${now.date}`)));
  const due: { siteId: string; kind: 'behind' | 'ahead'; call: CutCall }[] = [];
  for (const site of org.state.sites) {
    if (now.minute < site.openMinute || now.minute > site.closeMinute - 60) continue;
    const key = `${site.id}|${now.date}`;
    const { call } = siteCall(org, site.id, at);
    if (!call.confident) continue;
    if (!sent[key]?.behind && call.totalSaving >= ALERT_MIN_SAVING) due.push({ siteId: site.id, kind: 'behind', call });
    else if (!sent[key]?.ahead && call.pace >= AHEAD_PACE && call.short.length > 0) due.push({ siteId: site.id, kind: 'ahead', call });
  }
  const changed = Object.keys(sent).length !== Object.keys(org.cutAlerts ?? {}).length;
  if (due.length === 0) {
    if (changed) org.cutAlerts = sent;
    return null;
  }
  // Marked before sending, so an overlapping run never sends twice.
  for (const d of due) sent[`${d.siteId}|${now.date}`] = { ...(sent[`${d.siteId}|${now.date}`] ?? {}), [d.kind]: at.toISOString() };
  org.cutAlerts = sent;

  const settings = parseEmailSettings(await store.getSetting(emailSetting(org.orgId)));
  const off = new Set(org.settings.digestOff ?? []);
  const name = (id: string) => org.state.employees.find((e) => e.id === id)?.name ?? 'Someone';
  let emailed = 0;
  for (const d of due) {
    const site = org.state.sites.find((s) => s.id === d.siteId)!;
    const behindBy = Math.round((1 - d.call.pace) * 100);
    const link = settings ? linkFor(settings, `/app/?view=cutcall&site=${encodeURIComponent(site.id)}`) : '';
    const managers = org.users.filter((u) => u.status === 'active' && !off.has(u.id) && can(u, 'rota.publish', now.date, site.id));
    audit(org, 'system', `cutcall.alert_${d.kind}`, { siteId: site.id, pace: d.call.pace, saving: d.call.totalSaving, managers: managers.length });
    if (!settings) continue;
    for (const u of managers) {
      const mail =
        d.kind === 'behind'
          ? cutCallEmail(
              u.email,
              u.name,
              site.name,
              `${site.name} is trading ${behindBy}% behind forecast at ${formatMinute(now.minute)}. The day now looks like ${money(d.call.reforecastDay)} against ${money(d.call.forecastDay)} forecast. Sending ${d.call.recommendations.length} ${d.call.recommendations.length === 1 ? 'person' : 'people'} home early saves ${money(d.call.totalSaving)} on the week and keeps every hour covered.`,
              d.call.recommendations.map((r) => `${name(r.employeeId)}: ${r.standDown ? 'stand down' : `finish at ${formatMinute(r.newEnd)}`}, saves ${money(r.saving)}`),
              link,
            )
          : callInEmail(
              u.email,
              u.name,
              site.name,
              `${site.name} is trading ${Math.round((d.call.pace - 1) * 100)}% ahead of forecast at ${formatMinute(now.minute)}, and the rest of the day is short by ${d.call.short.reduce((s, h) => s + h.short, 0)} person hours on the reforecast.`,
              link,
            );
      if ((await sendMail(settings, mail)) !== null) emailed++;
    }
  }
  return { alerts: due.length, emailed };
}

/** Across every organisation, alongside the shift reminders. One failing never stops the rest. */
export async function runCutCallAlerts(store: Store, at = new Date(), log: (msg: string, detail: Record<string, unknown>) => void = () => {}) {
  let alerts = 0;
  for (const orgId of await store.orgIds()) {
    if (isSandbox(orgId)) continue;
    try {
      const org = await store.load(orgId);
      const before = JSON.stringify(org.cutAlerts ?? {});
      const result = await cutCallAlerts(store, org, at);
      if (result || JSON.stringify(org.cutAlerts ?? {}) !== before) await store.save(org);
      alerts += result?.alerts ?? 0;
    } catch (err) {
      log('cut call alerts failed', { orgId, err: (err as Error).message });
    }
  }
  return { cutAlerts: alerts };
}
