import type { BillingStanding } from './BillingView';

// Its own file, apart from the Billing screen, because it shows on every screen: the
// billing screen stays out of the first download and loads when someone opens it.

export const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** One line at the top of every screen when billing needs someone: trial ending, payment failed, or paused. */
export function BillingBanner({ billing, canSettings, onOpen }: { billing?: BillingStanding; canSettings: boolean; onOpen: () => void }) {
  if (!billing) return null;
  const open = canSettings ? (
    <>
      {' '}
      <button className="link" onClick={onOpen}>Open billing</button>
    </>
  ) : null;
  if (billing.locked) {
    return (
      <div className="notice error">
        Your subscription has lapsed, so changes are paused. Everything stays readable.
        {canSettings ? open : ' Ask whoever manages your organisation\'s settings to restart it.'}
      </div>
    );
  }
  if (billing.standing === 'past_due' && canSettings) return <div className="notice error">The last payment failed. Update the card so nothing pauses.{open}</div>;
  if (billing.standing === 'trial' && canSettings && (billing.trialDaysLeft ?? 0) <= 7) {
    return billing.fromEngagement
      ? <div className="notice">Your billing under the accounting partner engagement has ended. Subscribe by card within {plural(billing.trialDaysLeft ?? 0, 'day')} to carry on without a break.{open}</div>
      : <div className="notice">Your free trial ends in {plural(billing.trialDaysLeft ?? 0, 'day')}. Subscribe to carry on without a break.{open}</div>;
  }
  return null;
}
