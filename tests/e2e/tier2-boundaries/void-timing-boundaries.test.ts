import { describe, it, expect } from 'vitest';
import { classifyAdjustment, type AttributionClass } from '../helpers/oracle';

describe('Tier 2: Boundary & Corner Cases — Void Timing Boundaries & Missing Timestamps', () => {
  const mappings: Record<string, AttributionClass> = {
    GUEST_RETURN: 'GUEST',
    KITCHEN_DEFECT: 'KITCHEN',
    MISTAKE: 'SERVER_ENTRY',
  };

  const firedAt = 1759431600000;

  it('treats occurredAt == firedAt as NOT fired before (pre-fire boundary)', () => {
    const result = classifyAdjustment({
      kind: 'void',
      reasonRef: 'GUEST_RETURN',
      mappings,
      firedAtMs: firedAt,
      occurredAtMs: firedAt, // exactly identical millisecond
      fireDataAvailable: true,
    });

    expect(result.firedBefore).toBe(false);
    expect(result.countsAsGuestReturn).toBe(false);
  });

  it('treats occurredAt == firedAt + 1ms as fired before (post-fire boundary)', () => {
    const result = classifyAdjustment({
      kind: 'void',
      reasonRef: 'GUEST_RETURN',
      mappings,
      firedAtMs: firedAt,
      occurredAtMs: firedAt + 1, // 1 ms after firing
      fireDataAvailable: true,
    });

    expect(result.firedBefore).toBe(true);
    expect(result.countsAsGuestReturn).toBe(true);
  });

  it('treats occurredAt == firedAt - 1ms as pre-fire', () => {
    const result = classifyAdjustment({
      kind: 'void',
      reasonRef: 'GUEST_RETURN',
      mappings,
      firedAtMs: firedAt,
      occurredAtMs: firedAt - 1,
      fireDataAvailable: true,
    });

    expect(result.firedBefore).toBe(false);
    expect(result.countsAsGuestReturn).toBe(false);
  });

  it('never counts as guest return when fireDataAvailable is false even if firedAtMs was provided', () => {
    const result = classifyAdjustment({
      kind: 'void',
      reasonRef: 'GUEST_RETURN',
      mappings,
      firedAtMs: firedAt,
      occurredAtMs: firedAt + 10_000,
      fireDataAvailable: false,
    });

    expect(result.firedBefore).toBeNull();
    expect(result.countsAsGuestReturn).toBe(false);
  });

  it('handles null firedAtMs when fireDataAvailable is true (item was never fired)', () => {
    const result = classifyAdjustment({
      kind: 'void',
      reasonRef: 'GUEST_RETURN',
      mappings,
      firedAtMs: null,
      occurredAtMs: firedAt,
      fireDataAvailable: true,
    });

    expect(result.firedBefore).toBe(false);
    expect(result.countsAsGuestReturn).toBe(false);
  });

  it('handles null reasonRef gracefully defaulting to UNMAPPED for voids', () => {
    const result = classifyAdjustment({
      kind: 'void',
      reasonRef: null,
      mappings,
      firedAtMs: firedAt,
      occurredAtMs: firedAt + 10_000,
      fireDataAvailable: true,
    });

    expect(result.attributionClass).toBe('UNMAPPED');
    expect(result.countsAsGuestReturn).toBe(false);
  });

  it('handles null reasonRef defaulting to PROMOTIONAL for discounts', () => {
    const result = classifyAdjustment({
      kind: 'discount',
      reasonRef: null,
      mappings,
      firedAtMs: firedAt,
      occurredAtMs: firedAt + 10_000,
      fireDataAvailable: true,
    });

    expect(result.attributionClass).toBe('PROMOTIONAL');
    expect(result.countsAsGuestReturn).toBe(false);
  });
});
