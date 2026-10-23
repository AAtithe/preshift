import type { RewardsMember } from '../../../src/engine/welfare';
import { RewardsError, type RewardsAward, type RewardsProvider } from './provider';

type Fetch = typeof fetch;

/** Members go across in batches this size, so a large group never sends one enormous request. */
export const MEMBER_BATCH = 200;

/**
 * Hospitality Rewards over HTTPS with the account's API key.
 *
 * Hospitality Rewards does not publish an open API: integrations are agreed account by account. The
 * calls below are the contract Preshift offers them, and the base address is whatever their team
 * gives the account. Until an account has one, the eligibility file under Wellbeing does the same
 * job by upload. Every request is JSON over HTTPS with `Authorization: Bearer <key>`:
 *
 *   GET    /account                 -> { name }
 *   PUT    /members                 { members: RewardsMember[] }            upsert by ref
 *   POST   /members/remove          { refs: string[] }
 *   POST   /recognitions            { memberRef, points, reason, message, awardedBy }  -> { id }
 *          with `Idempotency-Key: <Preshift recognition id>`
 */
export class HospitalityRewardsProvider implements RewardsProvider {
  readonly name = 'Hospitality Rewards';

  constructor(private readonly opts: { baseUrl: string; apiKey: string; fetch: Fetch }) {}

  private async call<T>(method: 'GET' | 'PUT' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.opts.fetch(`${this.opts.baseUrl.replace(/\/+$/, '')}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.opts.apiKey}`,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new RewardsError(`Could not reach Hospitality Rewards: ${(err as Error).message}`, true);
    }
    if (res.status === 401 || res.status === 403) throw new RewardsError('Hospitality Rewards refused the API key. Check it with your account manager and save it again.', false, res.status);
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new RewardsError(`Hospitality Rewards answered ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`, res.status === 429 || res.status >= 500, res.status);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  async account() {
    const body = await this.call<{ name?: string }>('GET', '/account');
    return { name: body.name ?? 'Hospitality Rewards account' };
  }

  async upsertMembers(members: RewardsMember[]) {
    for (let i = 0; i < members.length; i += MEMBER_BATCH) await this.call('PUT', '/members', { members: members.slice(i, i + MEMBER_BATCH) });
  }

  async removeMembers(refs: string[]) {
    for (let i = 0; i < refs.length; i += MEMBER_BATCH) await this.call('POST', '/members/remove', { refs: refs.slice(i, i + MEMBER_BATCH) });
  }

  async award(a: RewardsAward) {
    const body = await this.call<{ id?: string }>(
      'POST',
      '/recognitions',
      { memberRef: a.memberRef, points: a.points, reason: a.reason, message: a.message, awardedBy: a.awardedBy },
      { 'idempotency-key': a.id },
    );
    return { ref: body.id ?? a.id };
  }
}
