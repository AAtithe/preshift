import type { RewardsMember } from '../../../src/engine/welfare';
import type { RewardsAward, RewardsProvider } from './provider';

/**
 * Hospitality Rewards for the demo and development: it keeps members and awards in memory, so the
 * Wellbeing screen shows enrolment and points landing without anyone holding a live account.
 */
export class RewardsSimulator implements RewardsProvider {
  readonly name = 'Hospitality Rewards (simulator)';
  readonly members = new Map<string, RewardsMember>();
  readonly awards: RewardsAward[] = [];

  async account() {
    return { name: 'Simulated Hospitality Rewards account' };
  }

  async upsertMembers(members: RewardsMember[]) {
    for (const m of members) this.members.set(m.ref, m);
  }

  async removeMembers(refs: string[]) {
    for (const ref of refs) this.members.delete(ref);
  }

  async award(a: RewardsAward) {
    // Same id, same award: a retry is not paid twice.
    if (!this.awards.some((x) => x.id === a.id)) this.awards.push(a);
    return { ref: `sim-${a.id}` };
  }
}
