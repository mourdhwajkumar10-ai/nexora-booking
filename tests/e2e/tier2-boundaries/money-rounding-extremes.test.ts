import { describe, it, expect } from 'vitest';
import {
  roundHalfAwayFromZero,
  applyBps,
  lineGrossCents,
  assertCents,
  parseDollars,
  formatUsd,
} from '../helpers/oracle';

describe('Tier 2: Boundary & Corner Cases — Money Rounding Extremes & 32-bit Limits (F-BR01)', () => {
  describe('Symmetrical Half-Away-From-Zero Rounding', () => {
    it('rounds exact halves away from zero for positive numbers', () => {
      expect(roundHalfAwayFromZero(0.5)).toBe(1);
      expect(roundHalfAwayFromZero(1.5)).toBe(2);
      expect(roundHalfAwayFromZero(2.5)).toBe(3);
      expect(roundHalfAwayFromZero(100.5)).toBe(101);
    });

    it('rounds exact halves away from zero for negative numbers (towards -infinity)', () => {
      expect(roundHalfAwayFromZero(-0.5)).toBe(-1);
      expect(roundHalfAwayFromZero(-1.5)).toBe(-2);
      expect(roundHalfAwayFromZero(-2.5)).toBe(-3);
      expect(roundHalfAwayFromZero(-100.5)).toBe(-101);
    });

    it('preserves zero exactly without negative zero artifacts', () => {
      expect(roundHalfAwayFromZero(0)).toBe(0);
      expect(Object.is(roundHalfAwayFromZero(0), 0)).toBe(true);
    });
  });

  describe('Basis Points Extremes (1 bp = 0.01%)', () => {
    it('handles 0 bps (0%)', () => {
      expect(applyBps(10000, 0)).toBe(0);
    });

    it('handles 10,000 bps (100%)', () => {
      expect(applyBps(2550, 10000)).toBe(2550);
    });

    it('handles >10,000 bps (e.g. 15,000 bps = 150% markup)', () => {
      expect(applyBps(1000, 15000)).toBe(1500);
    });

    it('handles negative bps (-10,000 bps = -100%)', () => {
      expect(applyBps(2550, -10000)).toBe(-2550);
    });

    it('handles odd fractional basis point division rounding', () => {
      // 333 cents * 333 bps = 110889 / 10000 = 11.0889 -> 11
      expect(applyBps(333, 333)).toBe(11);
      // 1 cent * 5000 bps = 5000 / 10000 = 0.5 -> 1
      expect(applyBps(1, 5000)).toBe(1);
      // 1 cent * 4999 bps = 4999 / 10000 = 0.4999 -> 0
      expect(applyBps(1, 4999)).toBe(0);
    });
  });

  describe('PostgreSQL 32-bit Signed Integer Boundaries', () => {
    const MAX_PG_INT32 = 2_147_483_647; // $21,474,836.47

    it('allows maximum 32-bit signed integer cents amount', () => {
      expect(assertCents(MAX_PG_INT32)).toBe(MAX_PG_INT32);
      expect(formatUsd(MAX_PG_INT32)).toBe('$21,474,836.47');
    });

    it('rejects floating-point non-integers', () => {
      expect(() => assertCents(10.5)).toThrow();
      expect(() => assertCents(0.001)).toThrow();
      expect(() => assertCents(Infinity)).toThrow();
    });
  });

  describe('Fractional quantities on line item gross', () => {
    it('accurately calculates line item gross with rounding', () => {
      // 0.25 kg of specialty meat at $45.00/kg (4500 cents) = 1125 cents
      expect(lineGrossCents(0.25, 4500)).toBe(1125);

      // 0.333333 portions at $10.00 = 333.333 -> 333 cents
      expect(lineGrossCents(1 / 3, 1000)).toBe(333);

      // 0 quantity -> 0 cents
      expect(lineGrossCents(0, 5000)).toBe(0);
    });
  });
});
