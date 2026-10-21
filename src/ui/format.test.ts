import { describe, expect, it } from 'vitest';
import { isoWeek, ledger, roundToTotal } from './format';

describe('formatting', () => {
  it('shows costs in brackets, accounting style', () => {
    expect(ledger(38121)).toBe('38,121');
    expect(ledger(-8973)).toBe('(8,973)');
    expect(ledger(0)).toBe('0');
  });

  it('rounds parts so they add up to the rounded total', () => {
    const parts = [7111.6, 737.7, 946.6, 177.4];
    const rounded = roundToTotal(parts);
    expect(rounded.reduce((a, b) => a + b, 0)).toBe(Math.round(parts.reduce((a, b) => a + b, 0)));
    // Tied to a headline total that rounds differently from the parts.
    expect(roundToTotal([7112.4, 737.77, 947.05, 176.98], 8973.43).reduce((a, b) => a + b, 0)).toBe(8973);
    expect(roundToTotal([10.2, 10.2, 10.2], 28).reduce((a, b) => a + b, 0)).toBe(28);
  });

  it('numbers trading weeks the ISO way', () => {
    expect(isoWeek('2026-10-19')).toBe(43);
    expect(isoWeek('2026-01-01')).toBe(1);
    expect(isoWeek('2027-01-01')).toBe(53);
  });
});
