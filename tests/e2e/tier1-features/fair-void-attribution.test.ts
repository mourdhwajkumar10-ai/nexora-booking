import { describe, it, expect } from 'vitest';
import {
  classifyAdjustment,
  type AttributionClass,
  type ClassifyInput,
} from '../helpers/oracle';

describe('Tier 1: Feature Coverage — Fair Void Attribution & Guest Profile Protection (F-BR13 / Acceptance Criterion 3)', () => {
  const mappings: Record<string, AttributionClass> = {
    BURNT: 'KITCHEN',
    PREPARATION_DEFECT: 'KITCHEN',
    WRONG_TEMP: 'KITCHEN',
    WRONG_ITEM_RUNG: 'SERVER_ENTRY',
    MISTAKE: 'SERVER_ENTRY',
    DUPLICATE_ORDER: 'SERVER_ENTRY',
    VIP_COMP: 'PROMOTIONAL',
    SERVICE_RECOVERY: 'PROMOTIONAL',
    POS_CRASH: 'SYSTEM',
    TEST_ORDER: 'SYSTEM',
    GUEST_CHANGED_MIND: 'GUEST',
    GUEST_REJECTED: 'GUEST',
  };

  const firedAt = 1759431600000;
  const voidOccurredAtPostFire = firedAt + 10 * 60_000; // 10 min after fire
  const voidOccurredAtPreFire = firedAt - 5 * 60_000;  // 5 min before fire

  it('guarantees KITCHEN voids do NOT increment guest return counters', () => {
    const result = classifyAdjustment({
      kind: 'void',
      reasonRef: 'BURNT',
      mappings,
      firedAtMs: firedAt,
      occurredAtMs: voidOccurredAtPostFire,
      fireDataAvailable: true,
    });

    expect(result.attributionClass).toBe('KITCHEN');
    expect(result.firedBefore).toBe(true);
    expect(result.countsAsGuestReturn).toBe(false);
  });

  it('guarantees SERVER_ENTRY voids do NOT increment guest return counters', () => {
    const result = classifyAdjustment({
      kind: 'void',
      reasonRef: 'WRONG_ITEM_RUNG',
      mappings,
      firedAtMs: firedAt,
      occurredAtMs: voidOccurredAtPostFire,
      fireDataAvailable: true,
    });

    expect(result.attributionClass).toBe('SERVER_ENTRY');
    expect(result.firedBefore).toBe(true);
    expect(result.countsAsGuestReturn).toBe(false);
  });

  it('guarantees PROMOTIONAL and SYSTEM voids do NOT increment guest return counters', () => {
    const promo = classifyAdjustment({
      kind: 'comp',
      reasonRef: 'VIP_COMP',
      mappings,
      firedAtMs: firedAt,
      occurredAtMs: voidOccurredAtPostFire,
      fireDataAvailable: true,
    });
    expect(promo.attributionClass).toBe('PROMOTIONAL');
    expect(promo.countsAsGuestReturn).toBe(false);

    const system = classifyAdjustment({
      kind: 'void',
      reasonRef: 'POS_CRASH',
      mappings,
      firedAtMs: firedAt,
      occurredAtMs: voidOccurredAtPostFire,
      fireDataAvailable: true,
    });
    expect(system.attributionClass).toBe('SYSTEM');
    expect(system.countsAsGuestReturn).toBe(false);
  });

  it('defaults unmapped reason codes to UNMAPPED without penalizing the guest', () => {
    const unmapped = classifyAdjustment({
      kind: 'void',
      reasonRef: 'NEW_VENDOR_CODE_XYZ',
      mappings,
      firedAtMs: firedAt,
      occurredAtMs: voidOccurredAtPostFire,
      fireDataAvailable: true,
    });
    expect(unmapped.attributionClass).toBe('UNMAPPED');
    expect(unmapped.countsAsGuestReturn).toBe(false);
  });

  it('counts as guest return ONLY when GUEST attribution is post-fire', () => {
    // Post-fire guest rejection -> counts against guest
    const postFire = classifyAdjustment({
      kind: 'void',
      reasonRef: 'GUEST_REJECTED',
      mappings,
      firedAtMs: firedAt,
      occurredAtMs: voidOccurredAtPostFire,
      fireDataAvailable: true,
    });
    expect(postFire.attributionClass).toBe('GUEST');
    expect(postFire.firedBefore).toBe(true);
    expect(postFire.countsAsGuestReturn).toBe(true);

    // Pre-fire guest change of mind -> does NOT count against guest
    const preFire = classifyAdjustment({
      kind: 'void',
      reasonRef: 'GUEST_CHANGED_MIND',
      mappings,
      firedAtMs: firedAt,
      occurredAtMs: voidOccurredAtPreFire,
      fireDataAvailable: true,
    });
    expect(preFire.attributionClass).toBe('GUEST');
    expect(preFire.firedBefore).toBe(false);
    expect(preFire.countsAsGuestReturn).toBe(false);
  });

  it('does NOT penalize guest if POS provider lacks fire data', () => {
    const noFireData = classifyAdjustment({
      kind: 'void',
      reasonRef: 'GUEST_REJECTED',
      mappings,
      firedAtMs: null,
      occurredAtMs: voidOccurredAtPostFire,
      fireDataAvailable: false,
    });
    expect(noFireData.attributionClass).toBe('GUEST');
    expect(noFireData.firedBefore).toBeNull();
    expect(noFireData.countsAsGuestReturn).toBe(false);
  });

  it('never counts discounts as guest returns even if reason maps to GUEST', () => {
    const discount = classifyAdjustment({
      kind: 'discount',
      reasonRef: 'GUEST_REJECTED',
      mappings,
      firedAtMs: firedAt,
      occurredAtMs: voidOccurredAtPostFire,
      fireDataAvailable: true,
    });
    expect(discount.countsAsGuestReturn).toBe(false);
  });
});
