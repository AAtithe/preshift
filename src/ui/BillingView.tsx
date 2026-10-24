import { useCallback, useEffect, useState } from 'react';
import { formatPence, type Interval, type Quote } from '../engine/pricing';
import { api, ApiError } from './api';
import { plural } from './BillingBanner';

// Billing, for an organisation that signed itself up: the trial, the subscription and the sites paid
// for. Cards, invoices, VAT details and cancelling are on Stripe's own pages, so Preshift never sees a
// card. An organisation billed under its Williams, Stanley & Co. engagement sees only that.

export type Standing = 'managed' | 'trial' | 'active' | 'past_due' | 'lapsed';

/** What /auth/me says about billing, for the banner every person sees. */
export interface BillingStanding {
  standing: Standing;
  locked: boolean;
  trialEndsAt?: string;
  trialDaysLeft?: number;
}

interface Billing extends BillingStanding {
  stripe: boolean;
  quotes: { month: Quote; year?: Quote } | null;
  pricing: { selfServeMaxSites: number; annualMonthsCharged: number } | null;
  sites: { now: number; billed: number | null };
  subscription: { status: string | null; interval: Interval | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean } | null;
  lastInvoice: { status: 'paid' | 'failed'; amountPence: number; currency: string; at: string; url?: string } | null;
  canSubscribe: boolean;
  canManage: boolean;
}

const STANDING: Record<Standing, { label: string; tone: string }> = {
  managed: { label: 'Billed by Williams, Stanley & Co.', tone: 'good' },
  trial: { label: 'Free trial', tone: 'warn' },
  active: { label: 'Subscribed', tone: 'good' },
  past_due: { label: 'Payment failed', tone: 'bad' },
  lapsed: { label: 'Lapsed', tone: 'bad' },
};

const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '');
const money = (pence: number, currency: string) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: currency.toUpperCase() }).format(pence / 100);
const problem = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

export function BillingView({ canSettings }: { canSettings: boolean }) {
  const [billing, setBilling] = useState<Billing | null>(null);
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(() =>
    new URLSearchParams(location.search).get('checkout') === 'done'
      ? { text: 'Thank you. Stripe has your card. The subscription shows here as soon as Stripe confirms it, usually within a minute.' }
      : null,
  );
  const [busy, setBusy] = useState(false);
  const [interval, setPeriod] = useState<Interval>('month');

  const refresh = useCallback(async () => {
    try {
      setBilling(await api.get<Billing>('/v1/billing'));
    } catch (e) {
      setMessage({ text: problem(e), bad: true });
    }
  }, []);
  useEffect(() => {
    if (canSettings) void refresh();
  }, [canSettings, refresh]);

  /** Checkout and the portal are Stripe's own pages: the browser goes there and comes back. */
  async function goTo(path: string, body?: unknown) {
    setBusy(true);
    setMessage(null);
    try {
      const { url } = await api.post<{ url: string }>(path, body);
      location.assign(url);
    } catch (e) {
      setMessage({ text: problem(e), bad: true });
      setBusy(false);
    }
  }

  async function matchSites() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await api.post<{ sites: { now: number; billed: number } }>('/v1/billing/sites');
      setMessage({ text: `Now paying for ${plural(res.sites.billed, 'site')}. Stripe adjusts the next invoice for the part of the month left.` });
      await refresh();
    } catch (e) {
      setMessage({ text: problem(e), bad: true });
    } finally {
      setBusy(false);
    }
  }

  if (!canSettings) {
    return (
      <div className="settings">
        <section className="settings-card">
          <h2>Billing</h2>
          <p className="muted small">Billing is looked after by whoever manages your organisation's settings, usually the owner.</p>
        </section>
      </div>
    );
  }
  if (!billing) return <div className="settings">{message ? <p className="small bad-text">{message.text}</p> : <p className="muted small">Loading billing...</p>}</div>;

  const s = STANDING[billing.standing];
  const chosen = (interval === 'year' && billing.quotes?.year) || billing.quotes?.month;
  const group = !!chosen?.groupPlan;
  const sitesOut = billing.subscription && billing.sites.billed !== null && billing.sites.billed !== billing.sites.now;

  return (
    <div className="settings">
      <section className="settings-card">
        <h2>
          Billing <span className={`pill tone-${s.tone}`}>{s.label}</span>
        </h2>
        {billing.standing === 'managed' && (
          <p className="small">
            Your organisation is billed under its engagement with Williams, Stanley & Co., so there is nothing to pay here. Questions
            about your fees go to your client partner.
          </p>
        )}
        {billing.standing === 'trial' && (
          <p className="small">
            Your free trial ends on {day(billing.trialEndsAt)}, in {plural(billing.trialDaysLeft ?? 0, 'day')}. Subscribe at any time:
            you are not charged until the trial ends, and the days you have left are kept.
          </p>
        )}
        {billing.standing === 'active' && billing.subscription && (
          <p className="small">
            {billing.subscription.cancelAtPeriodEnd
              ? `Cancelled. Everything works until ${day(billing.subscription.currentPeriodEnd)}, then changes pause and everything stays readable. Restart it from Manage billing.`
              : `Paying ${billing.subscription.interval === 'year' ? 'yearly' : 'monthly'} for ${plural(billing.sites.billed ?? 1, 'site')}. ${billing.subscription.status === 'trialing' ? `The first payment is taken on ${day(billing.trialEndsAt)}.` : `Renews on ${day(billing.subscription.currentPeriodEnd)}.`}`}
          </p>
        )}
        {billing.standing === 'past_due' && (
          <p className="small bad-text">
            The last payment failed. Stripe tries the card again over the next few days; update it in Manage billing so nothing
            pauses. Everything keeps working meanwhile.
          </p>
        )}
        {billing.standing === 'lapsed' && (
          <p className={`small ${billing.locked ? 'bad-text' : ''}`}>
            {billing.subscription
              ? 'The subscription has ended.'
              : `The free trial ended on ${day(billing.trialEndsAt)}.`}{' '}
            {billing.locked
              ? 'Changes are paused until you subscribe. Everything stays readable, and data requests from your staff can still be answered.'
              : 'Card payments are not set up on this system yet, so nothing is paused. Contact hello@preshift.co.uk and we will invoice you.'}
          </p>
        )}

        {billing.standing !== 'managed' && (
          <>
            {billing.canSubscribe && chosen && (
              <>
                <h3 className="settings-sub">Your price</h3>
                {billing.quotes?.year && (
                  <div className="segmented" role="radiogroup" aria-label="Billing period">
                    <button role="radio" aria-checked={interval === 'month'} className={interval === 'month' ? 'active' : ''} onClick={() => setPeriod('month')}>Monthly</button>
                    <button role="radio" aria-checked={interval === 'year'} className={interval === 'year' ? 'active' : ''} onClick={() => setPeriod('year')}>
                      Yearly, {12 - (billing.pricing?.annualMonthsCharged ?? 10)} months free
                    </button>
                  </div>
                )}
                <Breakdown quote={chosen} />
                {group && (
                  <p className="small">
                    You have {plural(chosen.sites, 'site')}. Groups of more than {billing.pricing?.selfServeMaxSites} sites are on a group plan agreed
                    with us: email <a href="mailto:hello@preshift.co.uk?subject=Preshift%20group%20plan">hello@preshift.co.uk</a>.
                  </p>
                )}
              </>
            )}
            <div className="settings-form">
              {billing.canSubscribe && !group && (
                <button className="primary" disabled={busy} onClick={() => void goTo('/v1/billing/checkout', { interval })}>
                  {billing.locked ? 'Subscribe and carry on' : `Subscribe ${interval === 'year' ? 'yearly' : 'monthly'}`}
                </button>
              )}
              {billing.canManage && (
                <button disabled={busy} onClick={() => void goTo('/v1/billing/portal')}>
                  Manage billing
                </button>
              )}
              {sitesOut && (
                <button disabled={busy} onClick={() => void matchSites()}>
                  Pay for {plural(billing.sites.now, 'site')} instead of {billing.sites.billed}
                </button>
              )}
            </div>
            {billing.canManage && (
              <p className="small muted">Manage billing opens Stripe: change the card, download invoices with VAT, update your company details or cancel.</p>
            )}
          </>
        )}
        {billing.lastInvoice && (
          <>
            <h3 className="settings-sub">Last invoice</h3>
            <p className="small">
              {money(billing.lastInvoice.amountPence, billing.lastInvoice.currency)} on {day(billing.lastInvoice.at)},{' '}
              <span className={billing.lastInvoice.status === 'paid' ? '' : 'bad-text'}>{billing.lastInvoice.status === 'paid' ? 'paid' : 'payment failed'}</span>
              {billing.lastInvoice.url && (
                <>
                  {'. '}
                  <a href={billing.lastInvoice.url} target="_blank" rel="noreferrer">View invoice</a>
                </>
              )}
            </p>
          </>
        )}
        {message && <p className={`small ${message.bad ? 'bad-text' : 'muted'}`}>{message.text}</p>}
      </section>
    </div>
  );
}

/** The quote band by band, then VAT and the total, as the invoice will show it. */
function Breakdown({ quote }: { quote: Quote }) {
  const per = quote.interval === 'year' ? 'a year' : 'a month';
  return (
    <table className="billing-quote small">
      <tbody>
        {quote.lines.map((l, i) => (
          <tr key={i}>
            <td>{plural(l.sites, 'site')} at {formatPence(l.unitPence)} {per}</td>
            <td>{formatPence(l.amountPence)}</td>
          </tr>
        ))}
        <tr><td>VAT at 20%</td><td>{formatPence(quote.vatPence)}</td></tr>
        <tr className="total"><td>Total {per}</td><td>{formatPence(quote.grossPence)}</td></tr>
        <tr><td className="muted" colSpan={2}>Works out at {formatPence(quote.perSitePerMonthPence)} per site a month before VAT. Prices are per site, never per member of staff.</td></tr>
      </tbody>
    </table>
  );
}
