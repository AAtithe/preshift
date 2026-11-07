import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { goLivePlan, type GoLivePlan } from '../src/engine/golive';
import { putBilling } from './billing';
import { nudgeFor, sendGoLiveNudges } from './golive';
import { emailSetting } from './mail';
import { MemoryStore } from './store';
import { kit, TODAY } from './testkit';

// Getting started: the go-live plan behind the screen and Shifty, and the morning nudge to a self
// sign-up's owner when a step goes late. One nudge a step, never more often than every two days,
// never to a WS client, never once live.

const OLIVIA = 'olivia@marylebonegroup.example';
const EMAIL = { resendApiKey: 're_test_1234567890abcd', from: 'Preshift <hello@preshift.example>', appUrl: 'https://rota.preshift.example' };
const DAY = 86_400_000;
let mails: { to: string[]; subject: string; text: string }[] = [];
const fake = async (url: string, init: RequestInit = {}) => {
  if (url !== 'https://api.resend.com/emails') throw new Error(`unexpected fetch ${url}`);
  mails.push(JSON.parse(String(init.body)));
  return new Response(JSON.stringify({ id: `mail-${mails.length}` }), { status: 200 });
};
beforeEach(() => { mails = []; vi.stubGlobal('fetch', fake); });
afterEach(() => vi.unstubAllGlobals());

describe('GET /v1/golive', () => {
  it('gives the owner the plan, proving nothing from the sample group', async () => {
    const k = await kit();
    const res = await k.call('GET', '/v1/golive', await k.as(OLIVIA, 'demo-usr_owner'));
    expect(res.status).toBe(200);
    const plan = res.body as GoLivePlan;
    expect(plan.steps.find((s) => s.code === 'authenticator')!.done).toBe(true);
    expect(plan.steps.find((s) => s.code === 'publish')!.done).toBe(false);
    expect(plan.live).toBe(false);
    // A WS-billed organisation has no subscription to decide.
    expect(plan.steps.some((s) => s.code === 'subscribe')).toBe(false);
  });

  it('is refused to a general manager, who does not run the settings', async () => {
    const k = await kit();
    expect((await k.call('GET', '/v1/golive', await k.as('priya@marylebonegroup.example'))).status).toBe(403);
  });
});

describe('nudges', () => {
  const late = (codes: string[]): GoLivePlan => {
    const plan = goLivePlan({
      startedOn: '2026-10-01', today: TODAY, billing: 'trial', trialEndsOn: '2026-10-25', ownerAuthenticator: true, sample: false,
      companies: 1, companiesComplete: 1, sites: 1, sitesWithTarget: 1, sitesWithTradingWeek: 1, roles: 1, staffingRules: 1,
      people: 0, peopleBlocked: 0, holidayDue: 0, holidayOpened: 0, rtwChecked: 0, rtwCopies: 0, statementsIssued: 0, trainingNeeded: 0, trainingHeld: 0, managers: 0, emailReady: true, onStaffApp: 0, shiftsAhead: 0, published: 0, takingsDays: 0, clocked: 0, inPayroll: 0,
    });
    return { ...plan, late: plan.late.filter((s) => codes.includes(s.code)) };
  };

  it('picks the earliest late step not nudged before, at most every two days', () => {
    const plan = late(['team', 'build']);
    expect(nudgeFor(plan, { nudged: {} }, TODAY)?.code).toBe('team');
    expect(nudgeFor(plan, { nudged: { team: '2026-10-17' } }, TODAY)?.code).toBe('build');
    expect(nudgeFor(plan, { nudged: { team: '2026-10-20' } }, TODAY)).toBeNull();
    expect(nudgeFor({ ...plan, billing: 'engagement' }, { nudged: {} }, TODAY)).toBeNull();
  });

  it('emails a self sign-up owner once for a late step, and a WS client never', async () => {
    const store = new MemoryStore(['demo', 'acme', 'wsclient'], TODAY);
    const k = await kit({ store });
    await store.setSetting(emailSetting('demo'), JSON.stringify(EMAIL));
    const demo = await store.load('demo');
    const owner = demo.users.find((u) => u.email === OLIVIA)!;
    for (const id of ['acme', 'wsclient']) {
      const org = await store.load(id);
      org.state = { entities: [], sites: [], roles: [], employees: [], shifts: [], forecast: [], demandRules: [], sales: [] };
      org.users = [{ ...owner, id: `usr_${id}`, email: `owner@${id}.example`, name: 'Sam Carter' }];
      await (store as { save: (o: typeof org) => Promise<void> }).save(org);
    }
    await putBilling(store, 'acme', { createdAt: new Date(Date.parse(TODAY) - 9 * DAY).toISOString(), trialEndsAt: new Date(Date.parse(TODAY) + 5 * DAY).toISOString() });

    const now = new Date(`${TODAY}T08:00:00Z`);
    expect(await sendGoLiveNudges(store, TODAY, now)).toEqual({ nudged: 1 });
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toEqual(['owner@acme.example']);
    expect(mails[0].subject).toBe('Preshift Rota set-up: companies with company number and PAYE reference');
    expect(mails[0].text).toMatch(/Hello Sam,/);
    expect(mails[0].text).toMatch(/day 9 of setting up Preshift Rota/);
    expect((await store.load('acme')).goLive?.nudged).toEqual({ companies: TODAY });

    // Run again the same morning: nothing more.
    expect(await sendGoLiveNudges(store, TODAY, now)).toEqual({ nudged: 0 });
    expect(k).toBeTruthy();
  });
});
