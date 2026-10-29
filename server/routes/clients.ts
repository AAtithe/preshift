import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { canOrgWide, INVITE_DAYS, live, roleOf, type User } from '../../src/engine/access';
import { isNewStarter } from '../../src/engine/onboarding';
import { SAMPLE_SITE_IDS } from '../../src/engine/seed';
import { addDays } from '../../src/engine/time';
import { engaged, getBilling, putBilling, standingOf, type Standing } from '../billing';
import { HttpError, notFound, orgOf, type AppContext } from '../context';
import { actorOf } from '../guard';
import { emailSetting, inviteEmail, linkFor, parseEmailSettings, sendMail } from '../mail';
import { recordSent } from '../maillog';
import { isSandbox } from '../sandbox';
import { audit, orgsOfAccount, type OrgData, type UserRecord } from '../store';
import { EMAIL, normalise, orgName } from './access';
import { issueInvite } from './users';

// Clients, for Williams, Stanley & Co. One page per WS person listing the client organisations they
// hold a partner role in, how far each is through onboarding, and what needs attention; and the one way
// a new client organisation comes into being.
//
// The rules, in the same spirit as src/engine/access.ts:
// - Only a signed-in person, never a key, and only their own list. No client learns of another.
// - Only a client partner, with their authenticator proved, adds a client, and only from their
//   home organisation, whose email the invitation goes through. A client's email never carries
//   another client's owner.
// - WS never appoints inside a client. The one exception is the client's owner at creation, exactly
//   as first-run set-up makes the first owner, and the link only ever goes to the owner's own email:
//   nobody at the accounting partner ever holds a client owner's link. From then on the owner runs their own access,
//   WS partner included.
// - A client is removed only while nobody on the client's side has ever signed in to it, so WS can
//   never take away a business that is using Preshift. Removing closes it: every record there is
//   suspended, its links stop working and it leaves everyone's list, but nothing is deleted.
// - How a client pays is on its row: under the partner engagement, or by card through Stripe. When an
//   engagement ends, the client partner moves the client to card billing with a date to subscribe by;
//   the reverse, taking on a card customer, is customer operations' (server/routes/customers.ts).

const RESENDS_PER_HOUR = 3;
/** Days a former WS client has to subscribe by card, unless the partner sets another date. */
export const CARD_GRACE_DAYS = 14;
const CARD_GRACE_MAX_DAYS = 90;
/** No change for this long and a live client is flagged as quiet. */
export const QUIET_DAYS = 14;

const WS_ROLES = new Set(['ws_partner', 'ws_accountant', 'ws_payroll']);

/** The partner roles a person holds live in an organisation, if they are active there. */
function wsRolesIn(org: OrgData, email: string, today: string): string[] {
  const record = org.users.find((u) => u.email === email);
  if (!record || record.status !== 'active' || record.audience !== 'ws') return [];
  return record.memberships.filter((m) => live(m, today) && WS_ROLES.has(m.roleId)).map((m) => m.roleId);
}

/** The signed-in account behind the request. Keys have no client list. */
async function accountOf(ctx: AppContext, req: FastifyRequest): Promise<UserRecord> {
  const email = req.principal.email;
  const account = email && !req.principal.userId ? await ctx.store.getUser(email) : null;
  if (!account) throw new HttpError(403, 'forbidden', 'Clients are listed for a signed-in accounting partner person, not for a key.');
  return account;
}

/**
 * The person here as a client partner with their authenticator proved this session, in their
 * home organisation. Everything that creates or invites for a client asks this first.
 */
function clientPartner(req: FastifyRequest, org: OrgData, account: UserRecord, today: string): User {
  const actor = actorOf(req, org, today);
  const user = actor.kind === 'user' ? actor.user : null;
  if (!user || user.audience !== 'ws' || !user.memberships.some((m) => m.roleId === 'ws_partner' && live(m, today) && !m.siteIds)) {
    throw new HttpError(403, 'forbidden', 'Clients are added by a client partner.');
  }
  if (!canOrgWide(user, 'users.manage', today)) {
    throw new HttpError(403, 'forbidden', `${user.name} needs to enter their authenticator code to add a client.`);
  }
  if (account.orgId !== org.orgId) {
    throw new HttpError(409, 'not_home', 'Add clients from your own accounting partner organisation, whose email sends the invitation. Switch to it first.');
  }
  return user;
}

export interface ClientStep {
  code: string;
  label: string;
  done: boolean;
}

export interface ClientSummary {
  orgId: string;
  name: string;
  current: boolean;
  /** The partner roles the person holds there. */
  roles: string[];
  stage: 'invited' | 'setting-up' | 'live';
  owner: { name: string; status: 'active' | 'invited' | 'expired' } | null;
  companies: number;
  sites: number;
  people: number;
  /** People starting soon or started in the last 90 days. */
  starters: number;
  /** Current people not yet set up in payroll. */
  notInPayroll: number;
  accounts: { active: number; invited: number };
  emailReady: boolean;
  lastActivity: string | null;
  steps: ClientStep[];
  attention: string[];
  /** Nobody on the client's side has ever signed in and nothing has been set up: it can be removed. */
  removable: boolean;
  /**
   * How the client pays Preshift: under the partner engagement, by card through Stripe, or moving between the
   * two from `from`. `standing` is the card side's (trial, paying, lapsed), or 'managed' under the engagement.
   */
  billing: { mode: 'engagement' | 'card' | 'to-engagement' | 'to-card'; from?: string; standing: Standing };
}

/** Why this client cannot be removed, or null. Once the client has signed in, it is theirs. */
export function removalBlock(org: OrgData): string | null {
  if (org.users.some((u) => u.audience !== 'ws' && (u.status === 'active' || u.activatedAt))) {
    return 'Someone at the client has signed in, so the client runs its own organisation now. Ask its owner to remove the accounting partner instead.';
  }
  if (org.state.sites.length > 0 || org.state.employees.length > 0) return 'The client already has sites or people set up.';
  return null;
}

/** One client at a glance. Counts only: nobody's personal details leave the client's own screens. */
export async function summarise(ctx: AppContext, org: OrgData, roles: string[], current: boolean, today: string): Promise<ClientSummary> {
  const { state } = org;
  const operators = org.users.filter((u) => u.audience === 'operator');
  const ownerRecord = operators.find((u) => u.status === 'active' && u.memberships.some((m) => m.roleId === 'owner' && live(m, today)))
    ?? operators.find((u) => u.status === 'invited' && u.memberships.some((m) => m.roleId === 'owner' && m.active));
  const owner = ownerRecord
    ? { name: ownerRecord.name, status: ownerRecord.status === 'active' ? 'active' as const : ownerRecord.inviteExpiresAt && ownerRecord.inviteExpiresAt < today ? 'expired' as const : 'invited' as const }
    : null;
  const staff = state.employees.filter((e) => !e.anonymisedOn && !(e.leaveDate && e.leaveDate < today));
  const sample = state.sites.length > 0 && state.sites.every((s) => SAMPLE_SITE_IDS.includes(s.id));
  const realSites = sample ? 0 : state.sites.length;
  const companiesReady = state.entities.length > 0 && state.entities.every((e) => e.companyNumber && e.payeReference);
  const notInPayroll = staff.filter((e) => !e.payrollId).length;
  const emailReady = !!parseEmailSettings(await ctx.store.getSetting(emailSetting(org.orgId)));
  const lastActivity = org.audit.length ? org.audit[org.audit.length - 1].at : null;
  const record = await getBilling(ctx.store, org.orgId);
  const now = ctx.now();
  const standing = standingOf(record, now, true).standing;
  const billing: ClientSummary['billing'] = !record || engaged(record, now)
    ? { mode: 'engagement', standing }
    : record.engagement
      ? { mode: 'to-engagement', from: record.engagement.from, standing }
      : record.fromEngagement && standing === 'trial'
        ? { mode: 'to-card', from: record.trialEndsAt, standing }
        : { mode: 'card', standing };

  const steps: ClientStep[] = [
    { code: 'owner', label: 'Owner has accepted the invitation', done: owner?.status === 'active' },
    { code: 'companies', label: 'Companies with company number and PAYE reference', done: companiesReady },
    { code: 'sites', label: 'Sites, opening hours and labour targets', done: realSites > 0 },
    { code: 'team', label: 'Team loaded', done: !sample && staff.length > 0 },
    { code: 'payroll', label: 'Everyone set up in payroll', done: !sample && staff.length > 0 && notInPayroll === 0 },
    { code: 'email', label: 'Email set up for invitations and resets', done: emailReady },
    { code: 'rota', label: 'First rota published', done: !sample && org.publications.length > 0 },
  ];
  const stage = owner?.status !== 'active' ? 'invited' : steps.every((s) => s.done) ? 'live' : 'setting-up';

  const attention: string[] = [];
  if (!owner) attention.push('No owner on record.');
  else if (owner.status === 'expired') attention.push(`${owner.name}'s invitation has expired. Send a new one.`);
  if (sample) attention.push('Still on the sample group.');
  if (owner?.status === 'active' && notInPayroll > 0 && !sample) attention.push(`${notInPayroll} ${notInPayroll === 1 ? 'person is' : 'people are'} not set up in payroll.`);
  if (stage === 'live' && lastActivity && lastActivity.slice(0, 10) < addDays(today, -QUIET_DAYS)) attention.push(`Nothing changed since ${lastActivity.slice(0, 10)}.`);
  // WS on a card customer: if the firm now bills them too, they would pay twice.
  if (roles.length && billing.mode === 'card' && standing !== 'lapsed') {
    attention.push('Pays Preshift by card through Stripe. If the firm now bills them, customer operations moves them to engagement billing.');
  }
  if (billing.mode === 'to-card' && standing === 'trial') attention.push(`Off the engagement: to subscribe by card by ${billing.from!.slice(0, 10)}.`);
  if (record?.fromEngagement && standing === 'lapsed') attention.push('Left the engagement and has not subscribed: changes are paused.');

  return {
    orgId: org.orgId,
    name: orgName(org),
    current,
    roles,
    stage,
    owner,
    companies: state.entities.length,
    sites: realSites,
    people: sample ? 0 : staff.length,
    starters: sample ? 0 : staff.filter((e) => isNewStarter(e, today)).length,
    notInPayroll: sample ? 0 : notInPayroll,
    accounts: { active: org.users.filter((u) => u.status === 'active').length, invited: org.users.filter((u) => u.status === 'invited').length },
    emailReady,
    lastActivity,
    steps,
    attention,
    removable: removalBlock(org) === null && !record,
    billing,
  };
}

/** The client's owner, still to accept: the only person WS may invite there. */
function pendingOwner(org: OrgData, today: string): User {
  const operators = org.users.filter((u) => u.audience === 'operator');
  if (operators.some((u) => u.status === 'active' && u.memberships.some((m) => m.roleId === 'owner' && live(m, today)))) {
    throw new HttpError(409, 'owner_active', 'The owner has accepted. From here the client invites its own people, and resets its owner itself.');
  }
  const owner = operators.find((u) => u.status === 'invited' && u.memberships.some((m) => m.roleId === 'owner' && m.active));
  if (!owner) throw notFound('A waiting owner invitation');
  return owner;
}

/** Sends the owner's link to the owner alone, through the WS home organisation's email. */
async function emailOwner(ctx: AppContext, home: OrgData, client: OrgData, owner: User, by: string, path: string) {
  const settings = parseEmailSettings(await ctx.store.getSetting(emailSetting(home.orgId)));
  if (!settings) throw new HttpError(409, 'email_only', 'A client owner\'s invitation only ever goes to their own email. Set up email under Settings first.');
  const existing = !!(await ctx.store.getUser(owner.email));
  const message = inviteEmail(owner.email, owner.name, by, `${roleOf('owner')!.name} of ${orgName(client)}`, linkFor(settings, path), INVITE_DAYS, existing);
  const id = await sendMail(settings, message);
  if (id === null) return { emailed: false, emailProblem: 'The email did not go. Check the email settings, then send the invitation again from Clients.' };
  // Logged in the client, against the owner, so it shows on their Access tab.
  if (id) recordSent(client, id, { to: owner.email, kind: 'invite', userId: owner.id, by });
  return { emailed: true };
}

export function clientRoutes(app: FastifyInstance, ctx: AppContext, options: { stripe: boolean } = { stripe: false }) {
  const tags = ['Clients'];
  const today = () => ctx.store.todayISO();

  app.get('/v1/clients', { schema: { tags, description: 'The client organisations the signed-in accounting partner person holds a role in, with onboarding progress and what needs attention.' } }, async (req) => {
    const account = await accountOf(ctx, req);
    const here = orgOf(req);
    const out: ClientSummary[] = [];
    for (const orgId of orgsOfAccount(account)) {
      if (isSandbox(orgId) || !(await ctx.store.has(orgId))) continue;
      const org = orgId === here.orgId ? here : await ctx.store.load(orgId);
      if (org.closed) continue;
      const roles = wsRolesIn(org, account.email, today());
      if (roles.length) out.push(await summarise(ctx, org, roles, orgId === here.orgId, today()));
    }
    // Whether this person could add one here, so the screen offers the form only when it would work.
    let canAdd = false;
    try {
      clientPartner(req, here, account, today());
      canAdd = true;
    } catch {
      canAdd = false;
    }
    return { clients: out.sort((a, b) => a.name.localeCompare(b.name)), canAdd };
  });

  app.post<{ Body: { name: string; ownerName: string; ownerEmail: string } }>(
    '/v1/clients',
    {
      schema: {
        tags,
        description:
          'Adds a client: a new organisation with the caller as its client partner, and an invitation for its owner, emailed to the owner alone. ' +
          'Needs a client partner with their authenticator, in their home organisation, with email set up.',
        body: {
          type: 'object',
          required: ['name', 'ownerName', 'ownerEmail'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 120 },
            ownerName: { type: 'string', minLength: 1, maxLength: 120 },
            ownerEmail: { type: 'string', maxLength: 254 },
          },
        },
      },
    },
    async (req, reply) => {
      const home = orgOf(req);
      const account = await accountOf(ctx, req);
      const partner = clientPartner(req, home, account, today());
      const name = req.body.name.trim();
      const ownerName = req.body.ownerName.trim();
      const ownerEmail = normalise(req.body.ownerEmail);
      if (!name || !ownerName) throw new HttpError(400, 'invalid_request', 'Give the client\'s name and the owner\'s name.');
      if (!EMAIL.test(ownerEmail)) throw new HttpError(400, 'invalid_request', 'That is not an email address.');
      if (ownerEmail === account.email) throw new HttpError(422, 'own_email', 'The owner is the client\'s own person, never someone at the accounting partner');
      // Checked before anything is made, so a client is never left with an owner nobody can reach.
      if (!parseEmailSettings(await ctx.store.getSetting(emailSetting(home.orgId)))) {
        throw new HttpError(409, 'email_only', 'A client owner\'s invitation only ever goes to their own email. Set up email under Settings first.');
      }

      let orgId = '';
      do orgId = `org-${randomBytes(6).toString('hex')}`; while (await ctx.store.has(orgId));
      const client = await ctx.store.load(orgId);
      const now = new Date();
      const at = now.toISOString();
      // The company the client trades as, so the switcher and set-up start from its name.
      client.state.entities.push({ id: 'main', name, companyNumber: '', payeReference: '', intercompanyCode: '1350' });
      const mine = home.users.find((u) => u.id === partner.id)!;
      client.users.push({
        id: `usr_${randomUUID().slice(0, 12)}`,
        email: account.email,
        name: mine.name,
        jobTitle: mine.jobTitle,
        audience: 'ws',
        status: 'active',
        mfaEnrolled: true,
        createdAt: at,
        activatedAt: at,
        memberships: [{ id: `mem_${randomUUID().slice(0, 12)}`, roleId: 'ws_partner', siteIds: null, starts: today(), active: true, grantedBy: 'Client set-up', grantedAt: at }],
      });
      const owner: User = {
        id: `usr_${randomUUID().slice(0, 12)}`,
        email: ownerEmail,
        name: ownerName,
        jobTitle: 'Owner',
        audience: 'operator',
        status: 'invited',
        mfaEnrolled: false,
        createdAt: at,
        invitedBy: partner.name,
        memberships: [{ id: `mem_${randomUUID().slice(0, 12)}`, roleId: 'owner', siteIds: null, starts: today(), active: true, grantedBy: `Client set-up by ${partner.name}`, grantedAt: at }],
      };
      client.users.push(owner);
      const link = issueInvite(client, owner, now);
      const sent = await emailOwner(ctx, home, client, owner, partner.name, link.path);
      audit(client, partner.name, 'client.created', { by: partner.name });
      audit(client, partner.name, 'user.invited', { userId: owner.id, email: ownerEmail, audience: 'operator', emailed: sent.emailed });
      await ctx.store.save(client);
      await ctx.store.updateUser(account.email, { orgs: [...new Set([...orgsOfAccount(account), orgId])] });
      audit(home, partner.name, 'client.created', { orgId, name });
      const summary = await summarise(ctx, client, ['ws_partner'], false, today());
      return reply.code(201).send({ client: summary, expiresAt: link.expiresAt, ...sent });
    },
  );

  /** A client this person is the WS partner of, other than the one they are in. Anything else reads as not found. */
  async function partnersClient(account: UserRecord, home: OrgData, orgId: string): Promise<OrgData> {
    if (orgId === home.orgId || isSandbox(orgId) || !orgsOfAccount(account).includes(orgId) || !(await ctx.store.has(orgId))) throw notFound(`Client ${orgId}`);
    const client = await ctx.store.load(orgId);
    if (client.closed || !wsRolesIn(client, account.email, today()).includes('ws_partner')) throw notFound(`Client ${orgId}`);
    return client;
  }

  app.post<{ Params: { orgId: string } }>(
    '/v1/clients/:orgId/owner-invite',
    {
      schema: {
        tags,
        description: 'Emails the client\'s owner a fresh invitation while they have not yet accepted. Only ever to their own email; at most three an hour.',
        params: { type: 'object', required: ['orgId'], properties: { orgId: { type: 'string' } } },
      },
    },
    async (req) => {
      const home = orgOf(req);
      const account = await accountOf(ctx, req);
      const partner = clientPartner(req, home, account, today());
      const client = await partnersClient(account, home, req.params.orgId);
      const owner = pendingOwner(client, today());
      const recent = (client.inviteSends[owner.id] ?? []).filter((t) => Date.now() - Date.parse(t) < 3_600_000);
      if (recent.length >= RESENDS_PER_HOUR) throw new HttpError(429, 'rate_limited', 'Three invitations have gone in the last hour. Wait before sending another.');
      const now = new Date();
      const link = issueInvite(client, owner, now);
      const sent = await emailOwner(ctx, home, client, owner, partner.name, link.path);
      audit(client, partner.name, 'invite.resent', { userId: owner.id, emailed: sent.emailed });
      await ctx.store.save(client);
      return { expiresAt: link.expiresAt, ...sent };
    },
  );

  // An engagement ends and the client carries on with Preshift on its own: from now on it pays by card. It
  // gets a date to subscribe by (no free trial: it has used the product for real), after which changes pause
  // until it does, exactly as for any card customer. The engagement's own last invoice is the firm's to send.
  app.post<{ Params: { orgId: string }; Body: { payBy?: string } | undefined }>(
    '/v1/clients/:orgId/card-billing',
    {
      schema: {
        tags,
        description:
          'Moves a client off billing under its partner engagement onto paying by card through Stripe, with a date to subscribe by ' +
          `(default ${CARD_GRACE_DAYS} days, at most ${CARD_GRACE_MAX_DAYS}). Only the client's client partner, once its owner has signed in.`,
        params: { type: 'object', required: ['orgId'], properties: { orgId: { type: 'string' } } },
        body: { type: ['object', 'null'], additionalProperties: false, properties: { payBy: { type: 'string', format: 'date' } } },
      },
    },
    async (req) => {
      const home = orgOf(req);
      const account = await accountOf(ctx, req);
      const partner = clientPartner(req, home, account, today());
      const client = await partnersClient(account, home, req.params.orgId);
      if (!options.stripe) throw new HttpError(503, 'billing_not_set_up', 'Card payments are not set up on this system, so the client could not pay. Keep billing them under the engagement.');
      const existing = await getBilling(ctx.store, client.orgId);
      const now = ctx.now();
      if (existing && !engaged(existing, now)) {
        throw new HttpError(409, 'card', existing.engagement ? 'This client is still moving onto the engagement. Wait until that date, then move it back.' : 'This client already pays by card.');
      }
      const owner = client.users.find((u) => u.audience === 'operator' && u.status === 'active' && u.memberships.some((m) => m.roleId === 'owner' && live(m, today())));
      if (!owner) throw new HttpError(409, 'no_owner', 'Nobody at the client has signed in as owner yet, so nobody could subscribe. Keep billing them under the engagement.');
      const payBy = req.body?.payBy ?? addDays(today(), CARD_GRACE_DAYS);
      if (payBy <= today() || payBy > addDays(today(), CARD_GRACE_MAX_DAYS)) {
        throw new HttpError(400, 'invalid_date', `Give a date after today and within ${CARD_GRACE_MAX_DAYS} days.`);
      }
      // A Stripe customer made before, while it last paid by card, is kept so its invoices stay together.
      await putBilling(ctx.store, client.orgId, {
        trialEndsAt: new Date(`${payBy}T23:59:59.000Z`).toISOString(),
        createdAt: now.toISOString(),
        ...(existing?.customerId ? { customerId: existing.customerId } : {}),
        ...(existing?.subscriptionId ? { previousSubscriptionId: existing.subscriptionId } : {}),
        ...(existing?.lastEventAt ? { lastEventAt: existing.lastEventAt } : {}),
        fromEngagement: { at: now.toISOString(), by: partner.name },
      });
      audit(client, partner.name, 'billing.moved_to_card', { payBy });
      await ctx.store.save(client);
      audit(home, partner.name, 'client.moved_to_card', { orgId: client.orgId, name: orgName(client), payBy });
      return summarise(ctx, client, wsRolesIn(client, account.email, today()), false, today());
    },
  );

  app.delete<{ Params: { orgId: string } }>(
    '/v1/clients/:orgId',
    {
      schema: {
        tags,
        description:
          'Removes a client nobody on the client\'s side has ever signed in to: its owner invitation stops working, every record there is ' +
          'suspended and it leaves everyone\'s list. The organisation and its audit trail are kept, never deleted. Refused (409) once the client has signed in.',
        params: { type: 'object', required: ['orgId'], properties: { orgId: { type: 'string' } } },
      },
    },
    async (req, reply) => {
      const home = orgOf(req);
      const account = await accountOf(ctx, req);
      const partner = clientPartner(req, home, account, today());
      const client = await partnersClient(account, home, req.params.orgId);
      const block = removalBlock(client);
      if (block) throw new HttpError(409, 'client_in_use', block);

      const at = new Date().toISOString();
      for (const u of client.users) {
        for (const m of u.memberships) {
          if (m.active) Object.assign(m, { active: false, revokedBy: partner.name, revokedAt: at });
        }
        u.status = 'suspended';
        u.inviteExpiresAt = undefined;
      }
      client.inviteTokens = {};
      client.closed = { at, by: partner.name };
      audit(client, partner.name, 'client.removed', { by: partner.name });
      await ctx.store.save(client);
      // Off every switcher: the WS people who held it, and anyone invited who already had an account.
      for (const u of client.users) {
        const a = await ctx.store.getUser(u.email);
        if (!a || !orgsOfAccount(a).includes(client.orgId) || a.orgId === client.orgId) continue;
        await ctx.store.updateUser(a.email, { orgs: orgsOfAccount(a).filter((o) => o !== client.orgId), ...(a.lastOrgId === client.orgId ? { lastOrgId: undefined } : {}) });
      }
      audit(home, partner.name, 'client.removed', { orgId: client.orgId, name: orgName(client) });
      return reply.code(204).send();
    },
  );
}
