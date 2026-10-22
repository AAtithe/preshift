// What Preshift costs, in one place. The Billing page, Stripe Checkout, the script that creates the
// Stripe prices (scripts/stripe-prices.ts) and the marketing site's pricing section all read these
// figures; server/pricing.test.ts fails if the site's copy drifts from them.
//
// The model:
// - Per site, per month, everything included. Never per head: hospitality hires seasonally and turns
//   staff over fast, and a per-head price taxes exactly the flexibility a rota exists to manage.
// - Graduated by site count, so a group pays less per site as it grows and nobody's bill jumps at a
//   threshold: sites 1 to 5 at the first rate, 6 to 20 at the second.
// - Above 20 sites, a group plan agreed with us: that operator wants a contract, not a card form.
// - Annual billing is two months free.
// - A free trial with no card, and month to month after it.
// - Founding operators take a fixed discount for a fixed term, through a Stripe promotion code.
// - Williams, Stanley & Co. clients have it within their WS fee, and are never billed here.
// - Prices exclude VAT, as UK business pricing does.

export type Interval = 'month' | 'year';

export interface Band {
  /** First site charged at this rate. */
  from: number;
  /** Last site charged at this rate; null for every site after. */
  to: number | null;
  /** Per site per month, in pence, before VAT. */
  monthlyPence: number;
}

export const PRICING = {
  /** Bump when any figure changes: the Stripe prices are keyed by it, so new prices are made, old customers stay on theirs. */
  version: 1,
  currency: 'gbp',
  vatRate: 0.2,
  trialDays: 14,
  bands: [
    { from: 1, to: 5, monthlyPence: 11_900 },
    { from: 6, to: null, monthlyPence: 9_900 },
  ] as Band[],
  /** Larger groups agree a group plan with us rather than paying by card. */
  selfServeMaxSites: 20,
  /** Months charged for a year paid up front. */
  annualMonthsCharged: 10,
  founding: { percentOff: 30, months: 24 },
} as const;

export interface QuoteLine {
  sites: number;
  /** Per site for the interval, pence. */
  unitPence: number;
  amountPence: number;
}

export interface Quote {
  sites: number;
  interval: Interval;
  lines: QuoteLine[];
  /** For the interval, before VAT. */
  netPence: number;
  vatPence: number;
  grossPence: number;
  /** What one site costs a month on average, before VAT, so monthly and annual compare like for like. */
  perSitePerMonthPence: number;
  /** Above the self-serve limit: a group plan, not a card payment. */
  groupPlan: boolean;
}

/** Per site for the interval, pence: a year is the months charged for it. */
export const unitFor = (band: Band, interval: Interval) => band.monthlyPence * (interval === 'year' ? PRICING.annualMonthsCharged : 1);

/** What a number of sites costs for the interval, band by band. At least one site is always charged. */
export function quote(siteCount: number, interval: Interval = 'month'): Quote {
  const sites = Math.max(1, Math.floor(siteCount));
  const lines: QuoteLine[] = [];
  for (const band of PRICING.bands) {
    const upTo = band.to ?? Infinity;
    const inBand = Math.max(0, Math.min(sites, upTo) - band.from + 1);
    if (inBand > 0) lines.push({ sites: inBand, unitPence: unitFor(band, interval), amountPence: inBand * unitFor(band, interval) });
  }
  const netPence = lines.reduce((sum, l) => sum + l.amountPence, 0);
  const vatPence = Math.round(netPence * PRICING.vatRate);
  const months = interval === 'year' ? 12 : 1;
  return {
    sites,
    interval,
    lines,
    netPence,
    vatPence,
    grossPence: netPence + vatPence,
    perSitePerMonthPence: Math.round(netPence / months / sites),
    groupPlan: sites > PRICING.selfServeMaxSites,
  };
}

/** What paying annually saves over twelve monthly payments, before VAT. */
export const annualSaving = (sites: number) => quote(sites, 'month').netPence * 12 - quote(sites, 'year').netPence;

export const formatPence = (pence: number) =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency: PRICING.currency.toUpperCase(), minimumFractionDigits: pence % 100 ? 2 : 0 }).format(pence / 100);
