import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  DEFAULT_WELFARE_POLICY,
  eligibilityCsv,
  LOOKBACK_DAYS,
  milestones,
  pointsGiven,
  policyProblem,
  pulseTrend,
  RECOGNITION_LABEL,
  recognitionProblem,
  rewardsMembers,
  staffMeals,
  teamWelfare,
  travelHome,
  welfarePolicy,
  type Recognition,
  type RecognitionCategory,
  type WelfarePolicy,
} from '../../src/engine/welfare';
import { addDays, weekStart } from '../../src/engine/time';
import { requireScope } from '../auth';
import { HttpError, londonToday, notFound, orgOf, type AppContext } from '../context';
import { actorName, guard } from '../guard';
import { HospitalityRewardsProvider } from '../integrations/rewards/hospitalityRewards';
import { RewardsError, type RewardsEnvironment, type RewardsProvider } from '../integrations/rewards/provider';
import { RewardsSimulator } from '../integrations/rewards/simulator';
import { sendAwards, syncRewards } from '../integrations/rewards/sync';
import { isSandbox } from '../sandbox';
import { idParam } from '../schemas';
import { audit, welfareOf, type OrgData } from '../store';
import { forReader } from './employees';

/** The Hospitality Rewards API key, kept with the other secrets and never returned. */
export const rewardsKeySetting = (orgId: string) => `rewards_key:${orgId}`;

interface Options {
  /** The simulated platform is offered in the demo and in development, never against live payroll. */
  simulatorAllowed: boolean;
}

/** The platform an organisation is connected to, or null when there is none. */
export async function rewardsProviderFor(ctx: AppContext, org: OrgData, opts: Options): Promise<RewardsProvider | null> {
  const conn = org.welfare?.rewards;
  if (!conn) return null;
  if (conn.environment === 'simulator') return opts.simulatorAllowed || isSandbox(org.orgId) ? new RewardsSimulator() : null;
  const key = await ctx.store.getSetting(rewardsKeySetting(org.orgId));
  if (!key || !conn.baseUrl) return null;
  return new HospitalityRewardsProvider({ baseUrl: conn.baseUrl, apiKey: key, fetch: ctx.fetch });
}

function rewardsProblem(err: unknown): never {
  if (err instanceof RewardsError) throw new HttpError(err.retryable ? 502 : 422, 'rewards_error', err.message);
  throw err;
}

/** Every morning, for every organisation with a platform connected. One failing never stops the rest. */
export async function syncAllRewards(ctx: AppContext, opts: Options) {
  const today = londonToday(ctx);
  for (const orgId of await ctx.store.orgIds()) {
    try {
      const org = await ctx.store.load(orgId);
      if (!org.welfare?.rewards || org.welfare.rewards.lastSync?.at.slice(0, 10) === today) continue;
      const provider = await rewardsProviderFor(ctx, org, opts);
      if (!provider) continue;
      org.welfare.rewards.lastSync = await syncRewards(org, provider, today, ctx.now());
      audit(org, 'Schedule', 'rewards.synced', { ok: org.welfare.rewards.lastSync.ok, enrolled: org.welfare.rewards.lastSync.enrolled, removed: org.welfare.rewards.lastSync.removed });
      await ctx.store.save(org);
    } catch {
      // The next manual sync shows what went wrong.
    }
  }
}

const POLICY_KEYS: (keyof WelfarePolicy)[] = ['lateFinishMinute', 'travelHomeAllowance', 'under18TravelHome', 'mealFromHours', 'mealCost', 'pointsPerSiteMonth', 'supportLine'];

export function welfareRoutes(app: FastifyInstance, ctx: AppContext, opts: Options) {
  const read = { preHandler: requireScope('employees:read') };
  const write = { preHandler: requireScope('rota:write') };
  const hidden = { schema: { hide: true } };

  /** Policy and connections are settings: a person with settings.manage, never an integration key. */
  function settingsPerson(req: FastifyRequest) {
    if (!req.principal.email) throw new HttpError(403, 'forbidden', 'Wellbeing settings are changed by a person signed in, not an API key.');
    const g = guard(ctx, req, orgOf(req));
    g.allow('settings.manage');
    return actorName(g);
  }

  app.get<{ Querystring: { sites?: string } }>(
    '/v1/welfare',
    {
      ...read,
      schema: {
        tags: ['Wellbeing'],
        description:
          'Wellbeing for the team at the sites where the caller manages the team or reads HR: who needs a conversation and why, late finishes ahead, ' +
          'staff meals this week, milestones, recognition, the team pulse (only weeks with five or more answers) and chats people have asked for. ' +
          'Short sickness spells count only where the caller reads HR.',
        querystring: { type: 'object', properties: { sites: { type: 'string', description: 'Comma separated site ids; defaults to every site the caller reaches.' } } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      const reach = g.sites('team.manage', 'hr.view');
      if (reach !== 'all' && reach.size === 0) g.allow('team.manage');
      const asked = req.query.sites?.split(',').filter(Boolean);
      const siteIds = org.state.sites.map((s) => s.id).filter((id) => (reach === 'all' || reach.has(id)) && (!asked || asked.includes(id)));
      const today = londonToday(ctx);
      const thisWeek = weekStart(today);
      const w = welfareOf(org);
      const policy = welfarePolicy(w.policy);
      const team = org.state.employees.filter((e) => siteIds.includes(e.siteId)).map((e) => forReader(g, e));
      const ids = new Set(team.map((e) => e.id));
      const openChats = w.chats.filter((c) => c.status === 'open' && ids.has(c.employeeId) && g.can('team.manage', c.siteId));
      const recent = org.state.shifts.filter((s) => s.date >= addDays(today, -LOOKBACK_DAYS - 7));
      return {
        today,
        policy,
        defaults: DEFAULT_WELFARE_POLICY,
        people: teamWelfare(
          team,
          recent.filter((s) => ids.has(s.employeeId)),
          org.timeEntries.filter((t) => ids.has(t.employeeId) && t.date >= addDays(today, -LOOKBACK_DAYS)),
          today,
          policy,
          (e) => ({ hr: g.can('hr.view', e.siteId) }),
          (e) => ({ chatRequestedAt: openChats.find((c) => c.employeeId === e.id)?.at }),
        ),
        travelHome: travelHome(team, org.state.shifts.filter((s) => ids.has(s.employeeId) && s.date >= today), today, policy),
        milestones: milestones(team, today),
        sites: siteIds.map((siteId) => ({
          siteId,
          pointsGiven: pointsGiven(w.recognitions, siteId, today),
          pointsBudget: policy.pointsPerSiteMonth,
          meals: staffMeals(org.state.shifts, thisWeek, [siteId], policy)[0],
          pulse: pulseTrend(w.pulses, [siteId], thisWeek),
        })),
        pulse: pulseTrend(w.pulses, siteIds, thisWeek),
        chats: openChats,
        recognitions: w.recognitions.filter((r) => ids.has(r.employeeId) && r.at >= addDays(today, -90)).sort((a, b) => b.at.localeCompare(a.at)),
        rewards: {
          connected: !!w.rewards,
          enrolled: w.rewardsEnrolled.filter((id) => ids.has(id)).length,
          optedOut: w.rewardsOptOut.filter((id) => ids.has(id)).length,
        },
      };
    },
  );

  app.put<{ Body: Partial<WelfarePolicy> & { supportLine?: WelfarePolicy['supportLine'] | null } }>(
    '/v1/welfare/policy',
    {
      schema: {
        hide: true,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            lateFinishMinute: { type: 'integer' },
            travelHomeAllowance: { type: 'number' },
            under18TravelHome: { type: 'boolean' },
            mealFromHours: { type: 'number' },
            mealCost: { type: 'number' },
            pointsPerSiteMonth: { type: 'integer' },
            supportLine: {
              type: ['object', 'null'],
              additionalProperties: false,
              required: ['name'],
              properties: { name: { type: 'string', maxLength: 80 }, phone: { type: 'string', maxLength: 30 }, url: { type: 'string', maxLength: 200 } },
            },
          },
        },
      },
    },
    async (req) => {
      const by = settingsPerson(req);
      const org = orgOf(req);
      const w = welfareOf(org);
      const { supportLine, ...rest } = req.body ?? {};
      const next: Partial<WelfarePolicy> = { ...(w.policy ?? {}), ...rest };
      if (supportLine === null) delete next.supportLine;
      else if (supportLine) next.supportLine = { name: supportLine.name.trim(), ...(supportLine.phone?.trim() ? { phone: supportLine.phone.trim() } : {}), ...(supportLine.url?.trim() ? { url: supportLine.url.trim() } : {}) };
      const problem = policyProblem(next);
      if (problem) throw new HttpError(422, 'invalid_policy', problem);
      w.policy = Object.fromEntries(POLICY_KEYS.filter((k) => next[k] !== undefined).map((k) => [k, next[k]]));
      audit(org, by, 'welfare.policy_changed', { fields: Object.keys(req.body ?? {}) });
      return welfarePolicy(w.policy);
    },
  );

  app.post<{ Body: { employeeId: string; category: RecognitionCategory; message: string; points?: number } }>(
    '/v1/welfare/recognitions',
    {
      ...write,
      schema: {
        tags: ['Wellbeing'],
        description:
          "Recognises someone, with points from their home site's monthly budget. Given by a person who manages the team at that site, never to themselves. " +
          'When Hospitality Rewards is connected and the person is a member, the points are credited there at once; otherwise they wait for the next sync.',
        body: {
          type: 'object',
          required: ['employeeId', 'category', 'message'],
          additionalProperties: false,
          properties: {
            employeeId: { type: 'string' },
            category: { type: 'string', enum: Object.keys(RECOGNITION_LABEL) },
            message: { type: 'string', maxLength: 400 },
            points: { type: 'integer', minimum: 0 },
          },
        },
      },
    },
    async (req, reply) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      const employee = org.state.employees.find((e) => e.id === req.body.employeeId);
      if (!employee || employee.anonymisedOn) throw notFound(`Employee ${req.body.employeeId}`);
      g.allow('team.manage', employee.siteId);
      if (employee.status === 'leaver') throw new HttpError(409, 'leaver', `${employee.name} has left.`);
      const w = welfareOf(org);
      const policy = welfarePolicy(w.policy);
      const today = londonToday(ctx);
      const award = { ...req.body, points: req.body.points ?? 0 };
      const problem = recognitionProblem(award, g.behind?.employeeId, pointsGiven(w.recognitions, employee.siteId, today), policy);
      if (problem) throw new HttpError(422, 'invalid_recognition', problem);
      const r: Recognition = {
        id: `rec_${randomUUID()}`,
        employeeId: employee.id,
        siteId: employee.siteId,
        category: award.category,
        message: award.message.trim(),
        points: award.points,
        by: actorName(g),
        ...(g.behind ? { byId: g.behind.id } : {}),
        at: ctx.now().toISOString(),
        rewards: { status: award.points === 0 ? 'none' : w.rewards ? 'pending' : 'not-connected' },
      };
      w.recognitions.push(r);
      audit(org, r.by, 'welfare.recognised', { employeeId: r.employeeId, points: r.points, category: r.category });
      // Straight across where it can go; a failure leaves it for the next sync rather than failing the thank you.
      if (r.rewards.status === 'pending') {
        const provider = await rewardsProviderFor(ctx, org, opts);
        if (provider) await sendAwards(org, provider, ctx.now(), r.id);
      }
      return reply.code(201).send(r);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/welfare/chats/:id/done',
    { ...write, schema: { tags: ['Wellbeing'], description: 'Marks a chat someone asked for as held. What was said stays between the two people.', params: idParam } },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      const chat = welfareOf(org).chats.find((c) => c.id === req.params.id);
      if (!chat) throw notFound(`Chat ${req.params.id}`);
      g.allow('team.manage', chat.siteId);
      if (chat.status === 'done') return chat;
      Object.assign(chat, { status: 'done', doneBy: actorName(g), doneAt: ctx.now().toISOString() });
      audit(org, actorName(g), 'welfare.chat_held', { employeeId: chat.employeeId });
      return chat;
    },
  );

  // Hospitality Rewards

  app.get('/v1/integrations/rewards', { ...read, schema: { tags: ['Wellbeing'], description: 'Whether Hospitality Rewards is connected, who is enrolled and the last sync.' } }, async (req) => {
    const org = orgOf(req);
    const g = guard(ctx, req, org);
    if (!g.can('settings.manage') && !g.can('payroll.view')) {
      const reach = g.sites('team.manage');
      if (reach !== 'all' && reach.size === 0) g.allow('settings.manage');
    }
    const w = welfareOf(org);
    const key = req.principal.email && g.can('settings.manage') ? await ctx.store.getSetting(rewardsKeySetting(org.orgId)) : null;
    const today = londonToday(ctx);
    return {
      connection: w.rewards ?? null,
      keyEndsWith: key ? key.slice(-4) : null,
      eligible: rewardsMembers(org.state.employees, org.state.sites, org.state.entities, today, w.rewardsOptOut).length,
      enrolled: w.rewardsEnrolled.length,
      optedOut: w.rewardsOptOut.length,
      waiting: w.recognitions.filter((r) => r.rewards.status === 'pending' || r.rewards.status === 'failed').length,
      simulatorAllowed: opts.simulatorAllowed || isSandbox(org.orgId),
    };
  });

  app.put<{ Body: { environment?: RewardsEnvironment; baseUrl?: string; apiKey?: string } }>(
    '/v1/integrations/rewards',
    {
      schema: {
        hide: true,
        body: { type: 'object', additionalProperties: false, properties: { environment: { type: 'string', enum: ['production', 'simulator'] }, baseUrl: { type: 'string', maxLength: 200 }, apiKey: { type: 'string', maxLength: 400 } } },
      },
    },
    async (req) => {
      const by = settingsPerson(req);
      const org = orgOf(req);
      const environment = req.body?.environment ?? 'production';
      const simulatorAllowed = opts.simulatorAllowed || isSandbox(org.orgId);
      if (environment === 'simulator' && !simulatorAllowed) throw new HttpError(400, 'simulator_off', 'The simulated platform is only available in the demo.');
      // A demo visitor's team is fictional and must never reach a real platform.
      if (environment !== 'simulator' && isSandbox(org.orgId)) throw new HttpError(403, 'demo', 'The demo connects to the simulated platform only.');
      const w = welfareOf(org);
      let provider: RewardsProvider;
      let baseUrl: string | undefined;
      let apiKey: string | null = null;
      if (environment === 'simulator') {
        provider = new RewardsSimulator();
      } else {
        baseUrl = (req.body?.baseUrl ?? w.rewards?.baseUrl ?? '').trim();
        if (!/^https:\/\/[^\s/]+/.test(baseUrl)) throw new HttpError(400, 'base_url_required', 'Enter the https API address Hospitality Rewards gave your account.');
        apiKey = req.body?.apiKey?.trim() || (await ctx.store.getSetting(rewardsKeySetting(org.orgId)));
        if (!apiKey) throw new HttpError(400, 'key_required', 'Paste the Hospitality Rewards API key.');
        provider = new HospitalityRewardsProvider({ baseUrl, apiKey, fetch: ctx.fetch });
      }
      // Prove the key works before saving anything, so a typo never looks connected. Nothing about anyone is sent yet.
      const account = await provider.account().catch(rewardsProblem);
      await ctx.store.setSetting(rewardsKeySetting(org.orgId), apiKey);
      // Another account or environment has its own members: start the record of who is enrolled again.
      if (w.rewards && (w.rewards.environment !== environment || w.rewards.baseUrl !== baseUrl)) w.rewardsEnrolled = [];
      w.rewards = { provider: 'hospitality-rewards', environment, ...(baseUrl ? { baseUrl } : {}), connectedAt: ctx.now().toISOString(), connectedBy: by, accountName: account.name };
      // Thanks given while nothing was connected stay as they were; from now on points go across.
      audit(org, by, 'rewards.connected', { environment });
      return { connection: w.rewards, keyEndsWith: apiKey ? apiKey.slice(-4) : null };
    },
  );

  app.delete('/v1/integrations/rewards', hidden, async (req) => {
    const by = settingsPerson(req);
    const org = orgOf(req);
    const w = welfareOf(org);
    await ctx.store.setSetting(rewardsKeySetting(org.orgId), null);
    delete w.rewards;
    w.rewardsEnrolled = [];
    for (const r of w.recognitions) if (r.rewards.status === 'pending' || r.rewards.status === 'failed') r.rewards = { status: 'not-connected' };
    audit(org, by, 'rewards.disconnected');
    // Membership at Hospitality Rewards is ended there: Preshift can no longer reach it.
    return { connection: null };
  });

  app.post('/v1/integrations/rewards/sync', hidden, async (req) => {
    const by = settingsPerson(req);
    const org = orgOf(req);
    const w = welfareOf(org);
    if (!w.rewards) throw new HttpError(409, 'not_connected', 'Hospitality Rewards is not connected.');
    const provider = await rewardsProviderFor(ctx, org, opts);
    if (!provider) throw new HttpError(409, 'not_ready', 'The connection is missing its key or address. Connect it again.');
    w.rewards.lastSync = await syncRewards(org, provider, londonToday(ctx), ctx.now());
    audit(org, by, 'rewards.synced', { ok: w.rewards.lastSync.ok, enrolled: w.rewards.lastSync.enrolled, removed: w.rewards.lastSync.removed, awarded: w.rewards.lastSync.awarded });
    return w.rewards.lastSync;
  });

  app.get('/v1/integrations/rewards/eligibility.csv', hidden, async (req, reply) => {
    const by = settingsPerson(req);
    const org = orgOf(req);
    const w = welfareOf(org);
    const today = londonToday(ctx);
    const members = rewardsMembers(org.state.employees, org.state.sites, org.state.entities, today, w.rewardsOptOut);
    audit(org, by, 'rewards.eligibility_exported', { people: members.length });
    req.orgChanged = true;
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="hospitality-rewards-eligibility-${today}.csv"`)
      .send(eligibilityCsv(members));
  });
}
