import { describe, expect, it } from 'vitest';
import { annualSaving, formatPence, PRICING, quote } from './pricing';

describe('pricing', () => {
  it('charges each site at the rate of its band, so no bill jumps at a threshold', () => {
    expect(quote(1).netPence).toBe(11_900);
    expect(quote(5).netPence).toBe(5 * 11_900);
    expect(quote(6)).toMatchObject({ netPence: 5 * 11_900 + 9_900, lines: [{ sites: 5, unitPence: 11_900 }, { sites: 1, unitPence: 9_900 }] });
    expect(quote(20).netPence).toBe(5 * 11_900 + 15 * 9_900);
    // Adding a site never costs more than the first rate.
    for (let n = 1; n < 30; n++) expect(quote(n + 1).netPence - quote(n).netPence).toBeLessThanOrEqual(11_900);
  });

  it('charges at least one site', () => {
    expect(quote(0)).toMatchObject({ sites: 1, netPence: 11_900 });
  });

  it('adds VAT at 20%', () => {
    expect(quote(3)).toMatchObject({ netPence: 35_700, vatPence: 7_140, grossPence: 42_840 });
  });

  it('charges ten months for a year paid up front', () => {
    expect(quote(1, 'year').netPence).toBe(119_000);
    expect(quote(8, 'year').netPence).toBe(quote(8).netPence * PRICING.annualMonthsCharged);
    expect(annualSaving(1)).toBe(2 * 11_900);
    expect(quote(1, 'year').perSitePerMonthPence).toBe(9_917);
  });

  it('sends larger groups to a group plan', () => {
    expect(quote(PRICING.selfServeMaxSites).groupPlan).toBe(false);
    expect(quote(PRICING.selfServeMaxSites + 1).groupPlan).toBe(true);
  });

  it('keeps the bands contiguous and falling, and open at the top', () => {
    PRICING.bands.forEach((b, i) => {
      if (i > 0) {
        expect(b.from).toBe((PRICING.bands[i - 1].to ?? 0) + 1);
        expect(b.monthlyPence).toBeLessThan(PRICING.bands[i - 1].monthlyPence);
      }
    });
    expect(PRICING.bands[0].from).toBe(1);
    expect(PRICING.bands.at(-1)!.to).toBeNull();
  });

  it('writes pounds as a UK invoice does', () => {
    expect(formatPence(11_900)).toBe('£119');
    expect(formatPence(14_280)).toBe('£142.80');
    expect(formatPence(1_190_000)).toBe('£11,900');
  });
});
