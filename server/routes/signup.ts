import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { User } from '../../src/engine/access';
import { putBilling } from '../billing';
import type { AppContext } from '../context';
import { emailSetting, parseEmailSettings, sendMail, signupEmail, signupExistingEmail } from '../mail';
import { passwordProblem } from '../passwords';
import { isSandbox } from '../sandbox';
import { audit } from '../store';
import { backToLogin, EMAIL, FIRST_ORG, newAccount, normalise, signIn } from './access';

// Self sign-up: a business starts a free trial without anyone at Preshift or Williams, Stanley & Co.
// setting it up. It makes a new, empty organisation with the person as its owner, on a trial that
// Billing then turns into a subscription.
//
// The rules, in the same spirit as the invitation and reset links:
// - Switched on with PRESHIFT_SIGNUP=1, and only once the first organisation has email set up,
//   because the person must prove the inbox is theirs before any account exists. Otherwise anyone
//   could claim someone else's email, and with it every invitation later sent to that address.
// - The page says the same thing whether or not the email already has an account. An existing
//   account is told so in its own inbox, so the form cannot be used to find out who is a customer.
// - The link is single use, valid a day, with its token after # so it never reaches a server log,
//   and only its hash is kept. The password is chosen on opening it, so nobody else ever knows it.
// - Capped per email, per visitor address and per day, so the form cannot flood an inbox or fill
//   the database.

export const SIGNUP_HOURS = 24;
const SENDS_PER_EMAIL_PER_HOUR = 3;
export const SIGNUPS_PER_ADDRESS_PER_DAY = 10;
export const SIGNUPS_PER_DAY = 200;
/** The form always takes at least this long, so its timing does not show whether an account exists. */
const SIGNUP_MIN_MS = 1200;

interface PendingSignup {
  email: string;
  name: string;
  business: string;
  /** Epoch seconds. */
  expires: number;
}

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const pendingSetting = (hash: string) => `signup:${hash}`;
const usedSetting = (hash: string) => `signup_used:${hash}`;
const sendsSetting = (email: string) => `signup_sends:${createHash('sha256').update(email).digest('hex')}`;
const nowSeconds = () => Math.floor(Date.now() / 1000);
const clean = (value: unknown, max: number) => (typeof value === 'string' ? value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max) : '');

async function readPending(ctx: AppContext, token: string): Promise<{ hash: string; pending: PendingSignup } | null> {
  if (!token) return null;
  const hash = tokenHash(token);
  const raw = await ctx.store.getSetting(pendingSetting(hash));
  if (!raw) return null;
  try {
    const pending = JSON.parse(raw) as PendingSignup;
    return typeof pending?.email === 'string' ? { hash, pending } : null;
  } catch {
    return null;
  }
}

/** The visitor's address, kept only as a keyed hash, as the demo does. */
async function addressKey(ctx: AppContext, req: FastifyRequest) {
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  return createHmac('sha256', await ctx.store.sessionSecret()).update(forwarded || req.ip).digest('hex').slice(0, 32);
}

export function signupRoutes(app: FastifyInstance, ctx: AppContext, options: { enabled: boolean; trialDays: number }) {
  const { store } = ctx;
  const hidden = { schema: { hide: true } };
  const emailSettings = async () => parseEmailSettings(await store.getSetting(emailSetting(FIRST_ORG)));

  app.post<{ Body: Record<string, string> }>('/auth/signup', hidden, async (req, reply) => {
    const started = Date.now();
    const settings = options.enabled ? await emailSettings() : null;
    if (!settings) return backToLogin(reply, { error: 'nosignup' });
    const email = normalise(req.body?.email);
    const name = clean(req.body?.name, 120);
    const business = clean(req.body?.business, 120);
    if (!EMAIL.test(email)) return backToLogin(reply, { error: 'email', signup: '1' });
    if (!name || !business) return backToLogin(reply, { error: 'details', signup: '1' });

    // Caps before anything is sent. Saying "busy" reveals nothing about anyone's account.
    const today = store.todayISO();
    if ((await store.addToSetting(`signup_day:${today}`, 1)) > SIGNUPS_PER_DAY) return backToLogin(reply, { error: 'busy', signup: '1' });
    if ((await store.addToSetting(`signup_addr:${today}:${await addressKey(ctx, req)}`, 1)) > SIGNUPS_PER_ADDRESS_PER_DAY) {
      return backToLogin(reply, { error: 'busy', signup: '1' });
    }

    const recent = (JSON.parse((await store.getSetting(sendsSetting(email))) ?? '[]') as number[]).filter((t) => t > nowSeconds() - 3600);
    if (recent.length < SENDS_PER_EMAIL_PER_HOUR) {
      await store.setSetting(sendsSetting(email), JSON.stringify([...recent, nowSeconds()]));
      const existing = await store.getUser(email);
      if (existing && !isSandbox(existing.orgId)) {
        await sendMail(settings, signupExistingEmail(email, `${settings.appUrl}/login`));
      } else if (!existing) {
        const token = randomBytes(32).toString('base64url');
        const pending: PendingSignup = { email, name, business, expires: nowSeconds() + SIGNUP_HOURS * 3600 };
        await store.setSetting(pendingSetting(tokenHash(token)), JSON.stringify(pending));
        await sendMail(settings, signupEmail(email, name, business, `${settings.appUrl}/login#signup=${token}`, SIGNUP_HOURS));
      }
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, SIGNUP_MIN_MS - (Date.now() - started))));
    return backToLogin(reply, { signupsent: '1' });
  });

  // Who a sign-up link is for, so the page can greet them before they choose a password. The token
  // comes in the body, never the address.
  app.post<{ Body: { token?: string } }>('/auth/signup/link', hidden, async (req, reply) => {
    const found = await readPending(ctx, typeof req.body?.token === 'string' ? req.body.token : '');
    if (!found || found.pending.expires < nowSeconds()) return reply.code(404).send({ error: 'badlink' });
    return { email: found.pending.email, name: found.pending.name, business: found.pending.business };
  });

  app.post<{ Body: Record<string, string> }>('/auth/signup/complete', hidden, async (req, reply) => {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    const back = (error: string) => backToLogin(reply, { error }, `#signup=${encodeURIComponent(token)}`);
    if (!options.enabled) return backToLogin(reply, { error: 'nosignup' });
    const found = await readPending(ctx, token);
    if (!found) return backToLogin(reply, { error: 'badlink' });
    if (found.pending.expires < nowSeconds()) return backToLogin(reply, { error: 'expired' });
    if (passwordProblem(req.body?.password)) return back('weak');
    if (req.body.password !== req.body?.confirm) return back('mismatch');

    // Single use, even when the link is opened twice at once: whoever writes the claim first wins.
    const claim = randomUUID();
    if ((await store.settingOnce(usedSetting(found.hash), () => claim)) !== claim) return backToLogin(reply, { error: 'badlink' });
    await store.setSetting(pendingSetting(found.hash), null);

    const { email, name, business } = found.pending;
    let orgId = '';
    do orgId = `org-${randomBytes(6).toString('hex')}`; while (await store.has(orgId));
    const account = await newAccount(email, orgId, req.body.password);
    // Made meanwhile, by an invitation or another sign-up: they sign in with that account instead.
    if (!(await store.createUser(account))) return backToLogin(reply, { error: 'registered' });

    const org = await store.load(orgId);
    const at = new Date().toISOString();
    // The company they trade as, so the switcher and set-up start from its name.
    org.state.entities.push({ id: 'main', name: business, companyNumber: '', payeReference: '', intercompanyCode: '1350' });
    const owner: User = {
      id: `usr_${randomUUID().slice(0, 12)}`,
      email,
      name,
      jobTitle: 'Owner',
      audience: 'operator',
      status: 'active',
      mfaEnrolled: false,
      createdAt: at,
      activatedAt: at,
      memberships: [{ id: `mem_${randomUUID().slice(0, 12)}`, roleId: 'owner', siteIds: null, starts: store.todayISO(), active: true, grantedBy: 'Sign-up', grantedAt: at }],
    };
    org.users.push(owner);
    audit(org, name, 'org.signed_up', { business, trialDays: options.trialDays });
    audit(org, name, 'access.owner_created');
    await store.save(org);
    const trialEndsAt = new Date(ctx.now().getTime() + options.trialDays * 86_400_000).toISOString();
    await putBilling(store, orgId, { trialEndsAt, createdAt: at });
    // Straight into set-up: companies, sites, roles and the team are the first job.
    return signIn(req, reply, store, account, '/app/?view=setup', orgId);
  });
}
