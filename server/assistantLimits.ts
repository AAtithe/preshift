import { londonParts } from '../src/engine/time';
import type { UserStore } from './store';

/**
 * Spend limits for the rota assistant, set by an admin in Settings. Spending is metered from the
 * usage Claude reports on every response, in US dollars because that is how Claude bills.
 */
export interface ClaudeLimits {
  /** Most the organisation spends on the assistant in a calendar month. */
  monthlyUsd: number;
  /** Most any one person spends in a day, so one heavy user cannot use up the month. */
  dailyPerPersonUsd: number;
}

export const DEFAULT_LIMITS: ClaudeLimits = { monthlyUsd: 50, dailyPerPersonUsd: 10 };

const limitsKey = (orgId: string) => `claude_limits:${orgId}`;
const monthKey = (orgId: string, at: Date) => `claude_spend:${orgId}:${londonParts(at).date.slice(0, 7)}`;
const dayKey = (orgId: string, email: string, at: Date) => `claude_spend:${orgId}:${email}:${londonParts(at).date}`;

export async function getLimits(store: UserStore, orgId: string): Promise<ClaudeLimits> {
  const raw = await store.getSetting(limitsKey(orgId));
  return raw ? { ...DEFAULT_LIMITS, ...(JSON.parse(raw) as Partial<ClaudeLimits>) } : DEFAULT_LIMITS;
}

export async function setLimits(store: UserStore, orgId: string, limits: ClaudeLimits) {
  await store.setSetting(limitsKey(orgId), JSON.stringify(limits));
}

export async function spend(store: UserStore, orgId: string, email: string | null, at = new Date()) {
  const month = Number((await store.getSetting(monthKey(orgId, at))) ?? 0);
  const today = email ? Number((await store.getSetting(dayKey(orgId, email, at))) ?? 0) : 0;
  return { monthUsd: month, todayUsd: today };
}

/** Why the next request must wait, or null if it may go ahead. */
export async function overLimit(store: UserStore, orgId: string, email: string, at = new Date()): Promise<string | null> {
  const [limits, used] = await Promise.all([getLimits(store, orgId), spend(store, orgId, email, at)]);
  if (used.monthUsd >= limits.monthlyUsd) {
    return `The rota assistant has reached this month's limit of $${limits.monthlyUsd}. An admin can raise it under Settings.`;
  }
  if (used.todayUsd >= limits.dailyPerPersonUsd) {
    return `You have reached today's limit of $${limits.dailyPerPersonUsd} on the rota assistant. It resets at midnight, or an admin can raise it.`;
  }
  return null;
}

export async function recordSpend(store: UserStore, orgId: string, email: string, usd: number, at = new Date()) {
  if (!(usd > 0)) return;
  await Promise.all([store.addToSetting(monthKey(orgId, at), usd), store.addToSetting(dayKey(orgId, email, at), usd)]);
}
