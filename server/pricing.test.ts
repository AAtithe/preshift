import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatPence, PRICING } from '../src/engine/pricing';

// The marketing site is static, with no build step, so it carries its own copy of the prices. What it
// publishes must be what Stripe charges and the Billing page quotes: this fails the build when the
// two drift, so a price change is made in src/engine/pricing.ts and the site together.

const site = (file: string) => readFileSync(path.resolve(__dirname, '../site', file), 'utf8');

describe('published prices', () => {
  const script = site('main.js');
  const page = site('index.html');

  it('the site calculator uses the same figures as the engine', () => {
    const block = script.match(/const PRICING = (\{[\s\S]*?\n\});/)?.[1];
    expect(block, 'site/main.js must define const PRICING').toBeTruthy();
    const published = new Function(`return ${block}`)() as Record<string, unknown>;
    expect(published).toEqual({
      bands: PRICING.bands,
      vatRate: PRICING.vatRate,
      annualMonthsCharged: PRICING.annualMonthsCharged,
      selfServeMaxSites: PRICING.selfServeMaxSites,
    });
  });

  it('the page copy states the same prices, bands, trial and offers', () => {
    const [first, second] = PRICING.bands;
    expect(page).toContain(`Sites 1 to ${first.to}`);
    expect(page).toContain(`Sites ${second.from} to ${PRICING.selfServeMaxSites}`);
    expect(page).toContain(`More than ${PRICING.selfServeMaxSites} sites`);
    expect(page).toContain(`From &pound;${first.monthlyPence / 100} per site a month`);
    expect(page).toContain(`>${formatPence(first.monthlyPence)}<`);
    expect(page).toContain(`>${formatPence(second.monthlyPence)}<`);
    expect(page).toContain(`${PRICING.trialDays} days free`);
    expect(page).toContain(`${['zero', 'one', 'two', 'three'][12 - PRICING.annualMonthsCharged]} months free`);
    expect(page).toContain(`${PRICING.founding.percentOff}% off for two years`);
    expect(page).toContain(`less ${PRICING.founding.percentOff}% for ${PRICING.founding.months} months`);
    expect(page).toContain(`VAT at ${PRICING.vatRate * 100}%`);
  });
});
