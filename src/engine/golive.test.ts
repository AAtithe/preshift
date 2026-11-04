import { describe, expect, it } from 'vitest';
import { byPhase, goLivePlan, type GoLiveFacts } from './golive';

// A new business's plan from sign-up to running its week on Preshift: each step proved by its own data.

const START = '2026-11-02';
const blank: GoLiveFacts = {
  startedOn: START, today: START, billing: 'trial', trialEndsOn: '2026-11-16', ownerAuthenticator: false, sample: false,
  companies: 0, companiesComplete: 0, sites: 0, sitesWithTarget: 0, sitesWithTradingWeek: 0, roles: 0, staffingRules: 0,
  people: 0, peopleBlocked: 0, holidayDue: 0, holidayOpened: 0, managers: 0, emailReady: false, onStaffApp: 0, shiftsAhead: 0, published: 0, takingsDays: 0, clocked: 0, inPayroll: 0,
};
const ready: GoLiveFacts = {
  ...blank, ownerAuthenticator: true, companies: 1, companiesComplete: 1, sites: 2, sitesWithTarget: 2, sitesWithTradingWeek: 2, roles: 5, staffingRules: 8,
  people: 20, peopleBlocked: 0, holidayDue: 18, holidayOpened: 18, managers: 2, emailReady: true, onStaffApp: 12, shiftsAhead: 140, published: 2, takingsDays: 6, clocked: 300, inPayroll: 20, billing: 'paying',
};
const step = (f: GoLiveFacts, code: string) => goLivePlan(f).steps.find((s) => s.code === code)!;

describe('go-live plan', () => {
  it('starts on the authenticator, with everything else waiting on it', () => {
    const plan = goLivePlan(blank);
    expect(plan.next?.code).toBe('authenticator');
    expect(plan.done).toBe(0);
    expect(plan.live).toBe(false);
    expect(step(blank, 'authenticator').status).toBe('due');
    expect(step(blank, 'companies').status).toBe('waiting');
    expect(plan.headline).toBe('Day 0 of 14. 0 of 14 steps done. On plan. Next: set up your authenticator.');
  });

  it('is live once every required step is proved, optional ones aside', () => {
    const plan = goLivePlan({ ...ready, managers: 0, inPayroll: 0 });
    expect(plan.live).toBe(true);
    expect(plan.pct).toBe(100);
    expect(plan.late).toEqual([]);
    expect(plan.steps.find((s) => s.code === 'payroll')!.done).toBe(false);
  });

  it('turns a step late after its day, and says so in the headline', () => {
    const f = { ...blank, today: '2026-11-10', ownerAuthenticator: true, companies: 1, companiesComplete: 1, sites: 1, sitesWithTarget: 1, sitesWithTradingWeek: 1, staffingRules: 3 };
    const plan = goLivePlan(f);
    expect(plan.day).toBe(8);
    expect(plan.late.map((s) => s.code)).toEqual(['team', 'records', 'holiday', 'email', 'staffapp', 'build', 'publish']);
    expect(plan.next?.code).toBe('team');
    expect(plan.headline).toMatch(/^Day 8 of 14\. 4 of 14 steps done\. 7 steps are behind the plan\. Next: load your team\.$/);
  });

  it('never counts an optional step as late', () => {
    expect(step({ ...blank, today: '2026-11-15', ownerAuthenticator: true, sites: 1 }, 'managers').status).not.toBe('late');
  });

  it('holds a business with people who cannot be rostered off the publish step', () => {
    const f = { ...ready, published: 0, peopleBlocked: 3 };
    expect(step(f, 'records')).toMatchObject({ done: false, progress: '3 of 20 held back' });
    expect(step(f, 'publish').status).toBe('waiting');
  });

  it('wants holiday balances for everyone already working, and none from a team of new starters', () => {
    expect(step({ ...ready, holidayOpened: 12 }, 'holiday')).toMatchObject({ done: false, progress: '12 of 18 balances in' });
    expect(goLivePlan({ ...ready, holidayDue: 0, holidayOpened: 0 }).steps.some((s) => s.code === 'holiday')).toBe(false);
  });

  it('proves nothing from the sample group', () => {
    const plan = goLivePlan({ ...ready, sample: true });
    for (const code of ['companies', 'sites', 'team', 'records', 'build', 'publish']) expect(plan.steps.find((s) => s.code === code)!.done, code).toBe(false);
  });

  it('asks a WS client for no subscription, and sets the decision the day before a longer trial ends', () => {
    expect(goLivePlan({ ...blank, billing: 'engagement', trialEndsOn: null }).steps.some((s) => s.code === 'subscribe')).toBe(false);
    const long = goLivePlan({ ...blank, trialEndsOn: '2026-11-23' });
    expect(long.length).toBe(21);
    expect(long.steps.find((s) => s.code === 'subscribe')!.dueOn).toBe('2026-11-22');
  });

  it('groups the steps into phases, in order', () => {
    expect(byPhase(goLivePlan(blank)).map((p) => p.id)).toEqual(['secure', 'business', 'team', 'rota', 'run', 'commit']);
  });
});
