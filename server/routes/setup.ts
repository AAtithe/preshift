import type { FastifyInstance, FastifyRequest } from 'fastify';
import { SAMPLE_ENTITY_IDS, SAMPLE_SITE_IDS } from '../../src/engine/seed';
import { isSampleEntry } from '../../src/engine/seedHistory';
import { applySetup, removalBlocks, validateSetup, type SetupDraft } from '../../src/engine/setup';
import type { Entity, RotaState, Site } from '../../src/engine/types';
import { requireScope } from '../auth';
import { HttpError, orgOf, type AppContext } from '../context';
import { actorName, guard } from '../guard';
import { setupBody } from '../schemas';
import { seedUsers } from '../seedUsers';
import { audit, type OrgData } from '../store';

const SAMPLE_EMPLOYEE = new RegExp(`^(${SAMPLE_SITE_IDS.join('|')})-\\d+$`);
/** Sample HR records are stamped with this author, so they can be told from real ones. */
const SAMPLE_HR_AUTHOR = 'Preshift demo';

const sampleUserIds = (today: string) => new Set(seedUsers(today).users.map((u) => u.id));

/**
 * Why the organisation cannot be wiped back to empty, if it cannot. Only sample data may be
 * cleared: anything that has touched payroll, a clock, a staff login, an HR file, a data request
 * or a real person's access is a record to keep.
 */
async function startFreshBlocks(ctx: AppContext, org: OrgData): Promise<string[]> {
  const { state } = org;
  const reasons: string[] = [];
  if (state.entities.some((e) => !SAMPLE_ENTITY_IDS.includes(e.id)) || state.sites.some((s) => !SAMPLE_SITE_IDS.includes(s.id))) {
    reasons.push('Companies or sites of your own have been added.');
  }
  if (state.employees.some((e) => !SAMPLE_EMPLOYEE.test(e.id))) reasons.push('People of your own have been added.');
  if (state.employees.some((e) => e.payrollId)) reasons.push('Someone has been set up in payroll.');
  if (org.timeEntries.some((e) => !isSampleEntry(e))) reasons.push('Time has been clocked or entered.');
  if (org.submissions.length || org.payRuns.length) reasons.push('Hours have been sent to payroll or a pay run has come back.');
  if (org.outbox.length) reasons.push('Changes have been queued for payroll.');
  if (org.hrRecords.some((r) => r.createdBy !== SAMPLE_HR_AUTHOR)) reasons.push('HR records have been added.');
  if (org.privacy?.requests.length) reasons.push('A staff data request is on record.');
  const samples = sampleUserIds(ctx.store.todayISO());
  const tied = org.users.filter(
    (u) => !samples.has(u.id) && ((u.employeeId && SAMPLE_EMPLOYEE.test(u.employeeId)) || u.memberships.some((m) => m.siteIds?.some((id) => SAMPLE_SITE_IDS.includes(id)))),
  );
  if (tied.length) reasons.push(`${tied.map((u) => u.name).join(', ')} ${tied.length === 1 ? 'has' : 'have'} access tied to a sample site or person.`);
  if ((await ctx.store.listStaffLogins(org.orgId)).length) reasons.push('Staff have been invited to the staff app.');
  return reasons;
}

const isSample = (state: RotaState) =>
  state.sites.length > 0 && state.sites.every((s) => SAMPLE_SITE_IDS.includes(s.id)) && state.entities.every((e) => SAMPLE_ENTITY_IDS.includes(e.id));

/** Keeps the fields other routes own (payroll links, allowance, leave year, geofence, location, travel) when set-up saves. */
function merge(state: RotaState, draft: SetupDraft): SetupDraft {
  const entities = draft.entities.map((e): Entity => ({ ...state.entities.find((x) => x.id === e.id), ...e }));
  const sites = draft.sites.map((s): Site => ({ ...state.sites.find((x) => x.id === s.id), ...s }));
  return { ...draft, entities, sites };
}

/**
 * Set-up changes what every site is, so it needs settings.manage across the organisation, and a
 * person: an integration key has no business restructuring the group or wiping it.
 */
function allowSetup(ctx: AppContext, req: FastifyRequest, org: OrgData) {
  if (!req.principal.email && !req.principal.userId) {
    throw new HttpError(403, 'forbidden', 'Set-up is done by a signed-in person, not an integration key');
  }
  const g = guard(ctx, req, org);
  g.allow('settings.manage');
  return g;
}

export function setupRoutes(app: FastifyInstance, ctx: AppContext) {
  const read = { preHandler: requireScope('rota:read') };
  const write = { preHandler: requireScope('rota:write') };

  app.get('/v1/setup/status', { ...read, schema: { tags: ['Set-up'], description: 'Whether this is still the sample group, and whether it can be cleared.' } }, async (req) => {
    const org = orgOf(req);
    allowSetup(ctx, req, org);
    const blocks = await startFreshBlocks(ctx, org);
    return { sample: isSample(org.state), empty: org.state.sites.length === 0, canStartFresh: blocks.length === 0 && org.state.sites.length > 0, startFreshBlocks: blocks };
  });

  app.put<{ Body: SetupDraft }>(
    '/v1/setup',
    {
      ...write,
      schema: {
        tags: ['Set-up'],
        description:
          'Saves companies, sites, roles and staffing rules, and re-forecasts from this week using each site\'s typical week. ' +
          'Needs settings.manage. Anything still in use cannot be removed. People are added through /v1/employees.',
        body: setupBody,
      },
    },
    async (req) => {
      const org = orgOf(req);
      const g = allowSetup(ctx, req, org);
      const draft = merge(org.state, req.body);
      const blocking = validateSetup(draft).filter((i) => i.severity === 'block');
      if (blocking.length) throw new HttpError(422, 'invalid_setup', 'Set-up has problems to fix', blocking);
      const kept = new Set(draft.sites.map((s) => s.id));
      const access = org.state.sites
        .filter((s) => !kept.has(s.id))
        .flatMap((s) => {
          const people = org.users.filter((u) => u.memberships.some((m) => m.active && m.siteIds?.includes(s.id)));
          return people.length ? [`${s.name} is in the access of ${people.map((u) => u.name).join(', ')}. Change their roles in Access first.`] : [];
        });
      const inUse = [...removalBlocks(org.state, draft, org.timeEntries), ...access];
      if (inUse.length) throw new HttpError(409, 'in_use', 'Some of what you removed is still in use', inUse);
      org.state = applySetup(org.state, draft, ctx.store.todayISO());
      audit(org, actorName(g), 'setup.saved', { entities: draft.entities.length, sites: draft.sites.length, roles: draft.roles.length });
      const { entities, sites, roles, demandRules } = org.state;
      return { entities, sites, roles, demandRules };
    },
  );

  app.post(
    '/v1/setup/start-fresh',
    { ...write, schema: { tags: ['Set-up'], description: 'Clears the sample group so the organisation can be set up from nothing. Refused once anything real exists.' } },
    async (req) => {
      const org = orgOf(req);
      const g = allowSetup(ctx, req, org);
      const blocks = await startFreshBlocks(ctx, org);
      if (blocks.length) throw new HttpError(409, 'not_sample', 'This organisation holds more than sample data, so it cannot be cleared', blocks);
      org.state = { entities: [], sites: [], roles: [], employees: [], shifts: [], forecast: [], demandRules: [], sales: [] };
      org.hrRecords = [];
      // Only the sample's own clocking can be here: anything real refused the clear above.
      org.timeEntries = [];
      // The sample's fictional people go with it: left behind they would hold roles at sites that no longer exist.
      const samples = sampleUserIds(ctx.store.todayISO());
      org.users = org.users.filter((u) => !samples.has(u.id));
      for (const id of samples) delete org.authenticators[id];
      for (const [token, invite] of Object.entries(org.inviteTokens)) if (samples.has(invite.userId)) delete org.inviteTokens[token];
      audit(org, actorName(g), 'setup.started_fresh');
      return { ok: true };
    },
  );
}
