import { RECOGNITION_LABEL, rewardsChanges, rewardsMembers } from '../../../src/engine/welfare';
import { welfareOf, type OrgData } from '../../store';
import { RewardsError, type RewardsProvider, type RewardsSyncResult } from './provider';

/**
 * Brings Hospitality Rewards in line with the team: enrols everyone eligible, removes leavers and
 * anyone who opted out, then credits recognition points still waiting. Membership is recorded only
 * once the platform has taken it, so a failure part way leaves the next sync to finish the job.
 */
export async function syncRewards(org: OrgData, provider: RewardsProvider, today: string, now: Date): Promise<RewardsSyncResult> {
  const w = welfareOf(org);
  const eligible = rewardsMembers(org.state.employees, org.state.sites, org.state.entities, today, w.rewardsOptOut);
  const { upsert, remove } = rewardsChanges(eligible, w.rewardsEnrolled);
  const result: RewardsSyncResult = { at: now.toISOString(), ok: true, enrolled: 0, removed: 0, awarded: 0, waiting: 0 };
  try {
    await provider.upsertMembers(upsert);
    result.enrolled = upsert.length;
    if (remove.length) await provider.removeMembers(remove);
    result.removed = remove.length;
    w.rewardsEnrolled = upsert.map((m) => m.ref);
  } catch (err) {
    return { ...result, ok: false, error: (err as Error).message, waiting: waitingAwards(org) };
  }
  result.awarded = await sendAwards(org, provider, now);
  result.waiting = waitingAwards(org);
  if (result.waiting && w.recognitions.some((r) => r.rewards.status === 'failed')) {
    result.ok = false;
    result.error = w.recognitions.find((r) => r.rewards.status === 'failed')?.rewards.error;
  }
  return result;
}

const waitingAwards = (org: OrgData) => welfareOf(org).recognitions.filter((r) => r.points > 0 && (r.rewards.status === 'pending' || r.rewards.status === 'failed')).length;

/**
 * Credits points for recognitions not yet credited, to members only. Someone who has opted out keeps
 * their thank you; their points simply never go across. A refused key stops the run; anything
 * retryable is left for the next sync.
 */
export async function sendAwards(org: OrgData, provider: RewardsProvider, now: Date, only?: string): Promise<number> {
  const w = welfareOf(org);
  const members = new Set(w.rewardsEnrolled);
  let sent = 0;
  for (const r of w.recognitions) {
    if (only && r.id !== only) continue;
    if (r.points === 0 || r.rewards.status === 'sent' || r.rewards.status === 'not-connected' || r.rewards.status === 'none') continue;
    if (!members.has(r.employeeId)) {
      r.rewards = { status: 'pending', error: 'Not a Hospitality Rewards member yet: sent once they are enrolled.' };
      continue;
    }
    try {
      const { ref } = await provider.award({ id: r.id, memberRef: r.employeeId, points: r.points, reason: RECOGNITION_LABEL[r.category], message: r.message, awardedBy: r.by });
      r.rewards = { status: 'sent', ref, at: now.toISOString() };
      sent++;
    } catch (err) {
      r.rewards = { status: 'failed', error: (err as Error).message };
      if (err instanceof RewardsError && !err.retryable) break;
    }
  }
  return sent;
}
