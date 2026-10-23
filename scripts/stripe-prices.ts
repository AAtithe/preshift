// Creates the Stripe product, prices and founding coupon from src/engine/pricing.ts, so what Stripe
// charges is what the Billing page and the marketing site say. Safe to run again: anything already
// made for this pricing version is found and reused, never duplicated. Change a price by changing
// pricing.ts and bumping its version; customers already subscribed stay on the price they bought.
//
//   STRIPE_SECRET_KEY=sk_test_... npm run stripe:prices             create (test mode first)
//   STRIPE_SECRET_KEY=sk_test_... npm run stripe:prices -- --dry-run  show what it would do
//
// It prints the STRIPE_PRICE_ID and STRIPE_PRICE_ID_ANNUAL values to set in Vercel.

import { stripeCall, StripeError, type FormValue, type StripeConfig } from '../server/billing';
import { PRICING, unitFor, type Interval } from '../src/engine/pricing';

const PRODUCT_ID = 'preshift_rota';
const dryRun = process.argv.includes('--dry-run');
const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
if (!secretKey) {
  console.error('Set STRIPE_SECRET_KEY (start with a test key, sk_test_...).');
  process.exit(1);
}
const config: StripeConfig = { secretKey, webhookSecret: '', priceId: '' };
const call = <T>(method: 'GET' | 'POST', path: string, params: Record<string, FormValue> = {}) => stripeCall<T>(config, fetch, method, path, params);

async function find<T>(path: string): Promise<T | null> {
  try {
    return await call<T>('GET', path);
  } catch (err) {
    if (err instanceof StripeError && err.status === 404) return null;
    throw err;
  }
}

async function ensure<T extends { id: string }>(label: string, existing: T | null, create: () => Promise<T>): Promise<string> {
  if (existing) {
    console.log(`${label}: already there, ${existing.id}`);
    return existing.id;
  }
  if (dryRun) {
    console.log(`${label}: would create`);
    return '(dry run)';
  }
  const made = await create();
  console.log(`${label}: created ${made.id}`);
  return made.id;
}

const mode = secretKey.startsWith('sk_live_') ? 'LIVE' : 'test';
console.log(`Stripe ${mode} mode, pricing version ${PRICING.version}${dryRun ? ', dry run' : ''}\n`);

await ensure('Product', await find<{ id: string }>(`/products/${PRODUCT_ID}`), () =>
  call('POST', '/products', {
    id: PRODUCT_ID,
    name: 'Preshift Rota',
    description: 'Rota, time and attendance, HR and the labour accrual for UK hospitality. Priced per site.',
    unit_label: 'site',
    tax_code: 'txcd_10103001', // Software as a service, business use
  }),
);

const prices: Record<Interval, string> = { month: '', year: '' };
for (const interval of ['month', 'year'] as Interval[]) {
  const lookupKey = `preshift_site_${interval}ly_v${PRICING.version}`;
  const found = await call<{ data: { id: string }[] }>('GET', '/prices', { lookup_keys: [lookupKey], active: true });
  prices[interval] = await ensure(`Price, ${interval}ly`, found.data[0] ?? null, () =>
    call('POST', '/prices', {
      product: PRODUCT_ID,
      currency: PRICING.currency,
      nickname: `Per site, ${interval}ly, v${PRICING.version}`,
      lookup_key: lookupKey,
      recurring: { interval, usage_type: 'licensed' },
      billing_scheme: 'tiered',
      // Graduated: each site is charged at the rate of the band it falls in.
      tiers_mode: 'graduated',
      tiers: PRICING.bands.map((b) => ({ up_to: b.to ?? 'inf', unit_amount: unitFor(b, interval) })),
      tax_behavior: 'exclusive',
    }),
  );
}

const { percentOff, months } = PRICING.founding;
const couponId = `founding_${percentOff}_${months}m`;
await ensure('Founding coupon', await find<{ id: string }>(`/coupons/${couponId}`), () =>
  call('POST', '/coupons', { id: couponId, name: `Founding site, ${percentOff}% off for ${months} months`, percent_off: percentOff, duration: 'repeating', duration_in_months: months }),
);

console.log(`
Set these in Vercel (Production), then redeploy:
  STRIPE_PRICE_ID=${prices.month}
  STRIPE_PRICE_ID_ANNUAL=${prices.year}

Founding places: in Stripe, make a promotion code on the coupon ${couponId} for each founding
operator (one redemption each), and send it to them. Checkout takes promotion codes.`);
