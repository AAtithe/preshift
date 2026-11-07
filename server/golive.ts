import { live } from '../src/engine/access';
import { reviewEmployee } from '../src/engine/employees';
import { requiredCourses, trainingStatus } from '../src/engine/hr';
import { goLivePlan, type GoLiveBilling, type GoLiveFacts, type GoLivePlan, type GoLiveStep } from '../src/engine/golive';
import { SAMPLE_SITE_IDS } from '../src/engine/seed';
import { isSampleEntry } from '../src/engine/seedHistory';
import { addDays, weekStart } from '../src/engine/time';
import { engaged, getBilling, standingOf, type BillingRecord } from './billing';
import { goLiveNudgeEmail, emailSetting, linkFor, parseEmailSettings, sendMail } from './mail';
import { FIRST_ORG, orgName } from './routes/access';
import { isSandbox } from './sandbox';
import { seedUsers } from './seedUsers';
import { audit, type OrgData, type Store } from './store';

// Go-live, on the server: the facts behind each organisation's plan (src/engine/golive.ts), and the
// morning nudge that tells a self sign-up's owner when a step has gone late.
//
// The rules:
// - Counts only. The facts carry no name, pay or personal detail, so the plan can be shown to whoever
//   runs the organisation's settings, read by Shifty, and summarised in an email without risk.
// - A nudge goes only to self sign-ups, never to a WS client: a client has a client partner who calls.
// - One nudge per late step, ever, and no more than one every NUDGE_GAP_DAYS, so it reads as a
//   coach's note and never as a drip campaign. Nothing is sent once the business is live.
// - Nudges go through the email of the organisation that runs Preshift, as the sign-up link did: a
//   business days old has rarely set up its own.

/** Days between nudges to the same business. */
export const NUDGE_GAP_DAYS = 2;

export interface GoLiveRecord {
  /** The step codes nudged, with the London date each went. */
  nudged: Record<string, string>;
  /** The day every required step was first seen done. */
  liveOn?: string;
}

export const goLiveOf = (org: OrgData): GoLiveRecord => (org.goLive ??= { nudged: {} });

function billingOf(record: BillingRecord | null, now: Date): { billing: GoLiveBilling; trialEndsOn: string | null } {
  if (!record || engaged(record, now)) return { billing: 'engagement', trialEndsOn: null };
  const s = standingOf(record, now, true).standing;
  const billing: GoLiveBilling = s === 'trial' ? 'trial' : s === 'active' || s === 'past_due' ? 'paying' : 'lapsed';
  return { billing, trialEndsOn: record.trialEndsAt.slice(0, 10) };
}

/** The owner: the person holding the owner role there now. */
export function ownerOf(org: OrgData, today: string) {
  return org.users.find((u) => u.audience === 'operator' && u.status === 'active' && u.memberships.some((m) => m.roleId === 'owner' && live(m, today)));
}

/** Everything the plan is worked from, for one organisation. */
export async function goLiveFacts(store: Store, org: OrgData, today: string, now: Date): Promise<GoLiveFacts> {
  const { state } = org;
  const record = await getBilling(store, org.orgId);
  const { billing, trialEndsOn } = billingOf(record, now);
  const firstAudit = org.audit.length ? org.audit[0].at.slice(0, 10) : null;
  const startedOn = record?.createdAt.slice(0, 10) ?? firstAudit ?? today;

  const sample = state.sites.length > 0 && state.sites.every((s) => SAMPLE_SITE_IDS.includes(s.id));
  const own = (siteId: string) => !SAMPLE_SITE_IDS.includes(siteId);
  const sites = state.sites.filter((s) => own(s.id));
  const siteIds = new Set(sites.map((s) => s.id));
  const owner = ownerOf(org, today);
  const samples = new Set(seedUsers(today).users.map((u) => u.id));

  const people = state.employees.filter((e) => siteIds.has(e.siteId) && !e.anonymisedOn && e.status !== 'leaver' && !(e.leaveDate && e.leaveDate < today));
  const current = new Set(people.map((e) => e.id));
  const logins = await store.listStaffLogins(org.orgId);
  const since = addDays(today, -14);
  const takings = new Set<string>();
  for (const d of state.sales ?? []) if (siteIds.has(d.siteId) && d.date >= since && d.date < today && d.netSales > 0) takings.add(`${d.siteId}|${d.date}`);
  for (const h of state.actuals ?? []) if (siteIds.has(h.siteId) && h.date >= since && h.date < today && h.sales > 0) takings.add(`${h.siteId}|${h.date}`);
  const takingsDays = new Set([...takings].map((k) => k.split('|')[1])).size;
  const thisWeek = weekStart(today);

  return {
    startedOn,
    today,
    billing,
    trialEndsOn,
    ownerAuthenticator: !!owner?.mfaEnrolled,
    sample,
    companies: state.entities.length,
    companiesComplete: state.entities.filter((e) => e.companyNumber && e.payeReference).length,
    sites: sites.length,
    sitesWithTarget: sites.filter((s) => s.labourTargetPct > 0).length,
    sitesWithTradingWeek: sites.filter((s) => (s.salesProfile?.dailySales ?? []).some((n) => n > 0)).length,
    roles: state.roles.length,
    staffingRules: state.demandRules.filter((r) => siteIds.has(r.siteId)).length,
    people: people.length,
    peopleBlocked: people.filter((e) => reviewEmployee(e, today).some((c) => c.severity === 'block')).length,
    rtwChecked: people.filter((e) => e.rightToWork?.checked).length,
    rtwCopies: people.filter((e) => e.rightToWork?.checked && (e.rightToWork.documents?.length ?? 0) > 0).length,
    statementsIssued: people.filter((e) => e.hr?.contractIssuedOn).length,
    trainingNeeded: people.filter((e) => requiredCourses(e, state.roles).length > 0).length,
    trainingHeld: people.filter((e) => {
      const needed = requiredCourses(e, state.roles);
      return needed.length > 0 && needed.every((c) => ['valid', 'expiring'].includes(trainingStatus(org.hrRecords, e.id, c.name, today).status));
    }).length,
    holidayDue: people.filter((e) => !e.startDate || e.startDate < today).length,
    holidayOpened: people.filter((e) => (!e.startDate || e.startDate < today) && (e.holiday?.carriedOverHours !== undefined || e.holiday?.openingAccruedHours !== undefined || e.holiday?.openingTakenHours !== undefined)).length,
    managers: org.users.filter((u) => u.audience === 'operator' && u.id !== owner?.id && !samples.has(u.id) && (u.status === 'active' || u.status === 'invited')).length,
    emailReady: !!parseEmailSettings(await store.getSetting(emailSetting(org.orgId))),
    onStaffApp: logins.filter((l) => l.activatedAt && current.has(l.employeeId)).length,
    shiftsAhead: state.shifts.filter((s) => siteIds.has(s.siteId) && s.date >= thisWeek).length,
    published: org.publications.filter((p) => siteIds.has(p.siteId)).length,
    takingsDays,
    clocked: org.timeEntries.filter((e) => !isSampleEntry(e) && siteIds.has(e.siteId)).length,
    inPayroll: people.filter((e) => e.payrollId).length,
  };
}

/** The plan for one organisation, noting the day it first went live. */
export async function planFor(store: Store, org: OrgData, today: string, now: Date): Promise<GoLivePlan> {
  const plan = goLivePlan(await goLiveFacts(store, org, today, now));
  if (plan.live && !org.goLive?.liveOn) {
    goLiveOf(org).liveOn = today;
    audit(org, 'system', 'golive.live', { day: plan.day });
  }
  return plan;
}

/** The step to nudge about this morning, if any: the earliest late step not nudged before, at most one every NUDGE_GAP_DAYS. */
export function nudgeFor(plan: GoLivePlan, record: GoLiveRecord, today: string): GoLiveStep | null {
  if (plan.live || plan.billing === 'engagement') return null;
  const last = Object.values(record.nudged).sort().pop();
  if (last && last > addDays(today, -NUDGE_GAP_DAYS)) return null;
  return plan.late.find((s) => !record.nudged[s.code]) ?? null;
}

/**
 * Each morning, for every self sign-up still going live: if a step has gone late, one email to the
 * owner naming it, why it matters and how to do it. Marked before sending, so a retried run never
 * sends twice; a send that fails is logged and the step is not nudged again.
 */
export async function sendGoLiveNudges(store: Store, today: string, now: Date, log: (msg: string, detail: Record<string, unknown>) => void = () => {}) {
  const settings = parseEmailSettings(await store.getSetting(emailSetting(FIRST_ORG)));
  if (!settings) return { nudged: 0 };
  let nudged = 0;
  for (const orgId of await store.orgIds()) {
    if (orgId === FIRST_ORG || isSandbox(orgId)) continue;
    const record = await getBilling(store, orgId);
    // Self sign-ups only: a WS client is run by its client partner, who calls rather than emails.
    if (!record || engaged(record, now)) continue;
    const org = await store.load(orgId);
    const plan = await planFor(store, org, today, now);
    const step = nudgeFor(plan, goLiveOf(org), today);
    const owner = ownerOf(org, today);
    if (!step || !owner) {
      if (plan.live) await store.save(org);
      continue;
    }
    goLiveOf(org).nudged[step.code] = today;
    audit(org, 'system', 'golive.nudged', { step: step.code, day: plan.day });
    await store.save(org);
    const id = await sendMail(settings, goLiveNudgeEmail(owner.email, owner.name, orgName(org), plan, step, linkFor(settings, '/app/?view=golive')));
    if (id === null) log('go-live nudge not sent', { orgId, step: step.code });
    else nudged++;
  }
  return { nudged };
}
