import { describe, it, expect } from 'vitest';
import {
  formatMoney,
  formatUsd,
  parseDollars,
  roundHalfAwayFromZero,
  applyBps,
  lineGrossCents,
  assertCents,
} from '../helpers/oracle';

describe('Tier 1: Feature Coverage — Dual-Market Currency Engine & Money Math (F-CURR / F-BR01 / AC-4)', () => {
  describe('formatMoney (USD vs INR)', () => {
    it('formats USD values with $ symbol and 2 decimal places using cents', () => {
      expect(formatMoney(1000, 'USD')).toBe('$10.00');
      expect(formatMoney(2550, 'USD')).toBe('$25.50');
      expect(formatMoney(0, 'USD')).toBe('$0.00');
      expect(formatMoney(5, 'USD')).toBe('$0.05');
      expect(formatMoney(125000, 'USD')).toBe('$1,250.00');
      expect(formatMoney(-310, 'USD')).toBe('-$3.10');
    });

    it('formats INR values with ₹ symbol using paise and localized grouping', () => {
      expect(formatMoney(100000, 'INR')).toBe('₹1,000');
      expect(formatMoney(255050, 'INR')).toBe('₹2,550.50');
      expect(formatMoney(0, 'INR')).toBe('₹0');
      expect(formatMoney(12500000, 'INR')).toBe('₹1,25,000');
      expect(formatMoney(-50000, 'INR')).toBe('-₹500');
    });
  });

  describe('parseDollars and integer cents conversion', () => {
    it('correctly parses decimal dollar strings into integer cents', () => {
      expect(parseDollars('12.50')).toBe(1250);
      expect(parseDollars('12')).toBe(1200);
      expect(parseDollars('12.5')).toBe(1250);
      expect(parseDollars('0.99')).toBe(99);
      expect(parseDollars('-3.10')).toBe(-310);
    });

    it('rejects strings with more than 2 decimal places to prevent float drift', () => {
      expect(() => parseDollars('12.555')).toThrow();
      expect(() => parseDollars('10.1234')).toThrow();
      expect(() => parseDollars('invalid')).toThrow();
    });

    it('validates safe integer cents', () => {
      expect(assertCents(5000)).toBe(5000);
      expect(() => assertCents(5000.5)).toThrow();
      expect(() => assertCents(NaN)).toThrow();
    });
  });

  describe('Half-away-from-zero rounding and basis points arithmetic', () => {
    it('rounds half away from zero symmetrically across positive and negative values', () => {
      expect(roundHalfAwayFromZero(1.5)).toBe(2);
      expect(roundHalfAwayFromZero(2.5)).toBe(3);
      expect(roundHalfAwayFromZero(2.4)).toBe(2);
      expect(roundHalfAwayFromZero(-1.5)).toBe(-2);
      expect(roundHalfAwayFromZero(-2.5)).toBe(-3);
      expect(roundHalfAwayFromZero(-2.4)).toBe(-2);
    });

    it('calculates basis points correctly (1 bp = 0.01%)', () => {
      // 5% of $100 (10000 cents * 500 bps / 10000) = 500 cents
      expect(applyBps(10000, 500)).toBe(500);

      // Negative bps rounding (-15 bps at 5000 -> -7.5 -> rounds to -8)
      expect(applyBps(5000, -15)).toBe(-8);

      // 0 bps
      expect(applyBps(5000, 0)).toBe(0);
    });

    it('calculates line gross cents from fractional quantities', () => {
      // 1.5 units at $10.00 (1000 cents) = 1500 cents
      expect(lineGrossCents(1.5, 1000)).toBe(1500);
      // 1.33 units at $10.00 = 1330 cents
      expect(lineGrossCents(1.33, 1000)).toBe(1330);
    });
  });
});
