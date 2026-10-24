// Whether each site is actually using the staff app: who is on it, who will hear about a change,
// how fast requests are decided, how cover is found, and how many people did not turn up.
// Counts only, so it can go to anyone who runs a site; names are added by the API for those who manage the team.

import { isEmployedOn } from './employees';
import { isAbsentOn } from './hr';
import { clockedFor, clockingSites } from './reminders';
import { addDays } from './time';
import type { WeekSeen } from './rotaSeen';
import type { Employee, OpenShift, RotaState, StaffRequest, TimeEntry } from './types';

/** What good looks like, used to colour the screen. */
export const TARGETS = { onAppPct: 90, pushPct: 70, decisionHours: 24, fillPct: 80, noShowPct: 2, seenPct: 90 };

export interface LoginSummary {
  employeeId: string;
  active: boolean;
  pushDevices: number;
}

export interface SiteAdoption {
  siteId: string;
  team: number;
  onApp: number;
  withPush: number;
  /** Requests decided in the period: how many, the median and slowest hours to a decision, and the share within a day. */
  decided: number;
  medianDecisionHours: number | null;
  slowestDecisionHours: number | null;
  decidedInADayPct: number | null;
  /** Waiting now, and how long the oldest has waited, in hours. */
  waiting: number;
  oldestWaitingHours: number | null;
  /** Open shifts posted in the period, how many were filled, and the median hours to fill. */
  openShiftsPosted: number;
  openShiftsFilled: number;
  medianFillHours: number | null;
  /** Published shifts at a clocking site with nothing clocked, leave and sickness excepted. Null where nobody clocks. */
  noShows: number | null;
  shiftsChecked: number;
  /** Published weeks of people on the app in the period, and how many they pressed Seen it on as they stood. */
  rotaWeeks: number;
  rotaSeen: number;
  /** People not yet on the app, or on it without notifications, for those who may see names. */
  notOnApp?: string[];
  noNotifications?: string[];
}

const hoursBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 3_600_000;
const r1 = (n: number) => Math.round(n * 10) / 10;
const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return r1(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
};
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : null);

/**
 * The last `weeks` weeks up to yesterday, per site. A person counts at their home site. Requests
 * count where they are decided; cancelled ones count as neither decided nor waiting.
 */
export function adoption(
  state: Pick<RotaState, 'sites' | 'employees' | 'shifts'>,
  input: { logins: LoginSummary[]; requests: StaffRequest[]; openShifts: OpenShift[]; entries: TimeEntry[]; weeks?: WeekSeen[] },
  siteIds: string[],
  today: string,
  nowIso: string,
  weeks = 4,
): SiteAdoption[] {
  const from = addDays(today, -7 * weeks);
  const yesterday = addDays(today, -1);
  const logins = new Map(input.logins.map((l) => [l.employeeId, l]));
  const clocking = clockingSites(input.entries, yesterday);
  const sinceIso = `${from}T00:00:00.000Z`;
  return siteIds.map((siteId) => {
    const team = state.employees.filter((e) => e.siteId === siteId && e.status !== 'leaver' && isEmployedOn(e, today));
    const onApp = team.filter((e) => logins.get(e.id)?.active);
    const withPush = onApp.filter((e) => (logins.get(e.id)?.pushDevices ?? 0) > 0);

    const here = input.requests.filter((r) => r.siteId === siteId);
    const decided = here.filter((r) => (r.status === 'approved' || r.status === 'declined') && r.decidedAt && r.decidedAt >= sinceIso);
    const hours = decided.map((r) => hoursBetween(r.createdAt, r.decidedAt!));
    const waiting = here.filter((r) => r.status === 'pending' || r.status === 'accepted');
    // A swap waits on the colleague first; the manager's clock starts once they agree.
    const managersQueue = waiting.filter((r) => !(r.kind === 'swap' && r.status === 'pending'));

    const posted = input.openShifts.filter((o) => o.siteId === siteId && o.postedAt >= sinceIso);
    const filled = posted.filter((o) => o.status === 'filled');
    const fillHours = filled.filter((o) => o.filledAt).map((o) => hoursBetween(o.postedAt, o.filledAt!));

    const checked = clocking.has(siteId)
      ? state.shifts.filter((s) => s.siteId === siteId && s.published && s.date >= from && s.date <= yesterday).filter((s) => {
          const e = state.employees.find((x) => x.id === s.employeeId) as Employee | undefined;
          return e && !e.leave.includes(s.date) && !isAbsentOn(e, s.date);
        })
      : [];
    const noShows = clocking.has(siteId) ? checked.filter((s) => !clockedFor(input.entries, s)).length : null;

    // Only people who could press Seen it: those on the app, for weeks that began in the period.
    const weeksHere = (input.weeks ?? []).filter((w) => w.siteId === siteId && w.weekStart >= from && w.weekStart <= today && logins.get(w.employeeId)?.active);

    return {
      siteId,
      rotaWeeks: weeksHere.length,
      rotaSeen: weeksHere.filter((w) => w.seen).length,
      team: team.length,
      onApp: onApp.length,
      withPush: withPush.length,
      decided: decided.length,
      medianDecisionHours: median(hours),
      slowestDecisionHours: hours.length ? r1(Math.max(...hours)) : null,
      decidedInADayPct: pct(hours.filter((h) => h <= 24).length, hours.length),
      waiting: managersQueue.length,
      oldestWaitingHours: managersQueue.length ? r1(Math.max(...managersQueue.map((r) => hoursBetween(r.createdAt, nowIso)))) : null,
      openShiftsPosted: posted.length,
      openShiftsFilled: filled.length,
      medianFillHours: median(fillHours),
      noShows,
      shiftsChecked: checked.length,
      notOnApp: team.filter((e) => !logins.get(e.id)?.active).map((e) => e.name),
      noNotifications: onApp.filter((e) => !(logins.get(e.id)?.pushDevices ?? 0)).map((e) => e.name),
    };
  });
}

/** The group line: totals across the sites shown. Times stay per site, where someone can act on them. */
export function adoptionTotal(rows: SiteAdoption[]) {
  const sum = (k: keyof SiteAdoption) => rows.reduce((n, r) => n + ((r[k] as number | null) ?? 0), 0);
  const clocking = rows.filter((r) => r.noShows !== null);
  return {
    team: sum('team'),
    onApp: sum('onApp'),
    withPush: sum('withPush'),
    decided: sum('decided'),
    waiting: sum('waiting'),
    openShiftsPosted: sum('openShiftsPosted'),
    openShiftsFilled: sum('openShiftsFilled'),
    noShows: clocking.length ? clocking.reduce((n, r) => n + (r.noShows ?? 0), 0) : null,
    shiftsChecked: clocking.reduce((n, r) => n + r.shiftsChecked, 0),
    rotaWeeks: sum('rotaWeeks'),
    rotaSeen: sum('rotaSeen'),
  };
}
