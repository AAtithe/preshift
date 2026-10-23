import type { RewardsMember } from '../../../src/engine/welfare';

/**
 * The contract between Preshift and an employee benefits platform. Hospitality Rewards is the first
 * implementation: staff discounts, wellbeing support and recognition points built for hospitality
 * teams. Anything above this line works the same whichever platform answers it.
 */
export interface RewardsProvider {
  readonly name: string;
  /** The account the key opens, shown so nobody connects the wrong business. */
  account(): Promise<{ name: string }>;
  /** Enrols or updates each member, matched by `ref`. Idempotent: sending the same member twice changes nothing. */
  upsertMembers(members: RewardsMember[]): Promise<void>;
  /** Ends membership for people who have left or opted out. */
  removeMembers(refs: string[]): Promise<void>;
  /** Credits recognition points. `id` is Preshift's, sent as the idempotency key, so a retry never pays twice. */
  award(award: RewardsAward): Promise<{ ref: string }>;
}

export interface RewardsAward {
  id: string;
  memberRef: string;
  points: number;
  reason: string;
  message: string;
  awardedBy: string;
}

export class RewardsError extends Error {
  constructor(
    message: string,
    /** Whether trying again later could succeed (network, 5xx, 429) or not (a refused key). */
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
  }
}

export type RewardsEnvironment = 'production' | 'simulator';

/** What the organisation has connected. The API key is kept apart, in the settings store. */
export interface RewardsConnection {
  provider: 'hospitality-rewards';
  environment: RewardsEnvironment;
  /** The API address Hospitality Rewards gives the account. */
  baseUrl?: string;
  connectedAt: string;
  connectedBy: string;
  accountName?: string;
  lastSync?: RewardsSyncResult;
}

export interface RewardsSyncResult {
  at: string;
  ok: boolean;
  error?: string;
  /** Members sent: everyone eligible, enrolled or updated. */
  enrolled: number;
  removed: number;
  /** Recognition points credited in this sync, and any still waiting. */
  awarded: number;
  waiting: number;
}
