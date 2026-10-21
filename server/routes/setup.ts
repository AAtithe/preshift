import type { FastifyInstance } from 'fastify';
import { SAMPLE_ENTITY_IDS, SAMPLE_SITE_IDS } from '../../src/engine/seed';
import { applySetup, removalBlocks, validateSetup, type SetupDraft } from '../../src/engine/setup';
import type { Entity, RotaState, Site } from '../../src/engine/types';
import { requireAdmin } from '../auth';
import { HttpError, londonParts, orgOf, type AppContext } from '../context';
import { setupBody } from '../schemas';
import { audit, type OrgData } from '../store';

const SAMPLE_EMPLOYEE = new RegExp(`^(${SAMPLE_SITE_IDS.join('|')})-\\d+$`);

/**
 * Why the organisation cannot be wiped back to empty, if it cannot. Only sample data may be
 * cleared: anything that has touched payroll, a clock or a staff login is a record to keep.
 */
async function startFreshBlocks(ctx: AppContext, org: OrgData): Promise<string[]> {
  const { state } = org;
  const reasons: string[] = [];
  if (state.entities.some((e) => !SAMPLE_ENTITY_IDS.includes(e.id)) || state.sites.some((s) => !SAMPLE_SITE_IDS.includes(s.id))) {
    reasons.push('Companies or sites of your own have been added.');
  }
  if (state.employees.some((e) => !SAMPLE_EMPLOYEE.test(e.id))) reasons.push('People of your own have been added.');
  if (state.employees.some((e) => e.payrollId)) reasons.push('Someone has been set up in payroll.');
  if (org.timeEntries.length) reasons.push('Time has been clocked or entered.');
  if (org.submissions.length || org.payRuns.length) reasons.push('Hours have been sent to payroll or a pay run has come back.');
  if (org.outbox.length) reasons.push('Changes have been queued for payroll.');
  if ((await ctx.store.listStaffLogins(org.orgId)).length) reasons.push('Staff have been invited to the staff app.');
  return reasons;
}

const isSample = (state: RotaState) =>
  state.sites.length > 0 && state.sites.every((s) => SAMPLE_SITE_IDS.includes(s.id)) && state.entities.every((e) => SAMPLE_ENTITY_IDS.includes(e.id));

/** Keeps the fields other routes own (payroll links, allowance, leave year, geofence) when set-up saves. */
function merge(state: RotaState, draft: SetupDraft): SetupDraft {
  const entities = draft.entities.map((e): Entity => ({ ...state.entities.find((x) => x.id === e.id), ...e }));
  const sites = draft.sites.map((s): Site => ({ ...state.sites.find((x) => x.id === s.id), ...s }));
  return { ...draft, entities, sites };
}

export function setupRoutes(app: FastifyInstance, ctx: AppContext) {
  const admin = { preHandler: requireAdmin };

  app.get('/v1/setup/status', { ...admin, schema: { tags: ['Set-up'], description: 'Whether this is still the sample group, and whether it can be cleared.' } }, async (req) => {
    const org = orgOf(req);
    const blocks = await startFreshBlocks(ctx, org);
    return { sample: isSample(org.state), empty: org.state.sites.length === 0, canStartFresh: blocks.length === 0 && org.state.sites.length > 0, startFreshBlocks: blocks };
  });

  app.put<{ Body: SetupDraft }>(
    '/v1/setup',
    {
      ...admin,
      schema: {
        tags: ['Set-up'],
        description:
          'Saves companies, sites, roles and staffing rules, and re-forecasts from this week using each site\'s typical week. ' +
          'Anything still in use cannot be removed. People are added through /v1/employees.',
        body: setupBody,
      },
    },
    async (req) => {
      const org = orgOf(req);
      const draft = merge(org.state, req.body);
      const blocking = validateSetup(draft).filter((i) => i.severity === 'block');
      if (blocking.length) throw new HttpError(422, 'invalid_setup', 'Set-up has problems to fix', blocking);
      const inUse = removalBlocks(org.state, draft, org.timeEntries);
      if (inUse.length) throw new HttpError(409, 'in_use', 'Some of what you removed is still in use', inUse);
      const today = londonParts(new Date()).date;
      org.state = applySetup(org.state, draft, today);
      audit(org, req.principal.name, 'setup.saved', {
        entities: draft.entities.length,
        sites: draft.sites.length,
        roles: draft.roles.length,
      });
      const { entities, sites, roles, demandRules } = org.state;
      return { entities, sites, roles, demandRules };
    },
  );

  app.post('/v1/setup/start-fresh', { ...admin, schema: { tags: ['Set-up'], description: 'Clears the sample group so the organisation can be set up from nothing. Refused once anything real exists.' } }, async (req) => {
    const org = orgOf(req);
    const blocks = await startFreshBlocks(ctx, org);
    if (blocks.length) throw new HttpError(409, 'not_sample', 'This organisation holds more than sample data, so it cannot be cleared', blocks);
    org.state = { entities: [], sites: [], roles: [], employees: [], shifts: [], forecast: [], demandRules: [] };
    audit(org, req.principal.name, 'setup.started_fresh');
    return { ok: true };
  });
}
