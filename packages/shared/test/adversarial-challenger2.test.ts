import { describe, expect, it } from 'vitest';
import {
  classifyAdjustment,
  eligibleSpendCents,
  type ClassifyInput,
  type CalcItem,
  type CalcAdjustment,
  type AttributionClass,
} from '../src/pos.ts';
import {
  timerState,
  floorTransition,
  tableFreeAt,
  type AlertLevel,
  type FloorStatus,
  type FloorAction,
} from '../src/floor.ts';
import {
  planVoucherHold,
  planVoucherCapture,
  planVoucherRelease,
  planEarnAdjustment,
  writeOffPoints,
  tierFor,
  effectiveTier,
  computeTier,
  pointsForSpend,
  pointsToPaise,
  paiseToPoints,
  clawbackPoints,
  MAX_ACTIVE_VOUCHERS,
  VOUCHER_DENOMINATIONS_CENTS,
  VOUCHER_TTL_DAYS,
} from '../src/loyalty.ts';
import { DEFAULT_VOID_REASON_MAPPINGS, type VoidReason, type TierLevel } from '../src/constants.ts';

const at = (iso: string) => Date.parse(iso);

describe('CHALLENGER 2: Fair Void Attribution (pos.ts)', () => {
  const defaultMappings: Record<string, AttributionClass> = {
    ...DEFAULT_VOID_REASON_MAPPINGS,
    'custom_staff_error': 'SERVER_ENTRY',
    'custom_kitchen_burn': 'KITCHEN',
    'custom_guest_remorse': 'GUEST',
    'custom_system_error': 'SYSTEM',
    'custom_promo': 'PROMOTIONAL',
  };

  const baseOccurredMs = at('2026-06-15T20:30:00Z');
  const baseFiredMs = at('2026-06-15T20:10:00Z'); // 20 mins prior

  describe('Staff & Server Entry Errors Shielding', () => {
    it('never counts SERVER_ENTRY voids as guest return even if fired before adjustment', () => {
      const input: ClassifyInput = {
        kind: 'void',
        reasonRef: 'SPILL',
        mappings: defaultMappings,
        firedAtMs: baseFiredMs,
        occurredAtMs: baseOccurredMs,
        fireDataAvailable: true,
      };
      const res = classifyAdjustment(input);
      expect(res.attributionClass).toBe('SERVER_ENTRY');
      expect(res.firedBefore).toBe(true);
      expect(res.countsAsGuestReturn).toBe(false);
    });

    it('never counts BILLING_ERROR comps or refunds as guest return', () => {
      const compInput: ClassifyInput = {
        kind: 'comp',
        reasonRef: 'BILLING_ERROR',
        mappings: defaultMappings,
        firedAtMs: baseFiredMs,
        occurredAtMs: baseOccurredMs,
        fireDataAvailable: true,
      };
      expect(classifyAdjustment(compInput)).toEqual({
        attributionClass: 'SERVER_ENTRY',
        firedBefore: true,
        countsAsGuestReturn: false,
      });

      const refundInput: ClassifyInput = {
        kind: 'refund',
        reasonRef: 'custom_staff_error',
        mappings: defaultMappings,
        firedAtMs: baseFiredMs,
        occurredAtMs: baseOccurredMs,
        fireDataAvailable: true,
      };
      expect(classifyAdjustment(refundInput)).toEqual({
        attributionClass: 'SERVER_ENTRY',
        firedBefore: true,
        countsAsGuestReturn: false,
      });
    });
  });

  describe('Kitchen Errors & Defects Shielding', () => {
    it('never counts PREPARATION_DEFECT or KITCHEN_ERROR as guest return', () => {
      const defectRes = classifyAdjustment({
        kind: 'void',
        reasonRef: 'PREPARATION_DEFECT',
        mappings: defaultMappings,
        firedAtMs: baseFiredMs,
        occurredAtMs: baseOccurredMs,
        fireDataAvailable: true,
      });
      expect(defectRes.attributionClass).toBe('KITCHEN');
      expect(defectRes.countsAsGuestReturn).toBe(false);

      const kitchenErrRes = classifyAdjustment({
        kind: 'refund',
        reasonRef: 'KITCHEN_ERROR',
        mappings: defaultMappings,
        firedAtMs: baseFiredMs,
        occurredAtMs: baseOccurredMs,
        fireDataAvailable: true,
      });
      expect(kitchenErrRes.attributionClass).toBe('KITCHEN');
      expect(kitchenErrRes.countsAsGuestReturn).toBe(false);
    });

    it('shields guest from kitchen waste even when fire data is missing or present', () => {
      const noFireData = classifyAdjustment({
        kind: 'void',
        reasonRef: 'custom_kitchen_burn',
        mappings: defaultMappings,
        firedAtMs: null,
        occurredAtMs: baseOccurredMs,
        fireDataAvailable: false,
      });
      expect(noFireData.attributionClass).toBe('KITCHEN');
      expect(noFireData.countsAsGuestReturn).toBe(false);
    });
  });

  describe('Guest Remorse vs Post-Fire Rejection', () => {
    it('does NOT penalize guest if remorse occurs BEFORE item is fired to kitchen', () => {
      // Guest orders, then changes mind immediately before kitchen ticket prints
      const preFireRes = classifyAdjustment({
        kind: 'void',
        reasonRef: 'GUEST_REJECTED',
        mappings: defaultMappings,
        firedAtMs: null, // Not yet fired
        occurredAtMs: baseOccurredMs,
        fireDataAvailable: true,
      });
      expect(preFireRes.attributionClass).toBe('GUEST');
      expect(preFireRes.firedBefore).toBe(false);
      expect(preFireRes.countsAsGuestReturn).toBe(false);
    });

    it('does NOT penalize guest if adjustment timestamp is equal to or before fire time', () => {
      // Exact collision
      const exactTimeRes = classifyAdjustment({
        kind: 'void',
        reasonRef: 'GUEST_REJECTED',
        mappings: defaultMappings,
        firedAtMs: baseOccurredMs,
        occurredAtMs: baseOccurredMs,
        fireDataAvailable: true,
      });
      expect(exactTimeRes.firedBefore).toBe(false);
      expect(exactTimeRes.countsAsGuestReturn).toBe(false);

      // Anachronistic clock drift (occurred before firedAt)
      const clockDriftRes = classifyAdjustment({
        kind: 'void',
        reasonRef: 'GUEST_REJECTED',
        mappings: defaultMappings,
        firedAtMs: baseOccurredMs + 1000,
        occurredAtMs: baseOccurredMs,
        fireDataAvailable: true,
      });
      expect(clockDriftRes.firedBefore).toBe(false);
      expect(clockDriftRes.countsAsGuestReturn).toBe(false);
    });

    it('PENALIZES guest ONLY when post-fire void/comp/refund is guest-attributed', () => {
      const postFireRes = classifyAdjustment({
        kind: 'void',
        reasonRef: 'GUEST_REJECTED',
        mappings: defaultMappings,
        firedAtMs: baseOccurredMs - 1, // 1ms after fire
        occurredAtMs: baseOccurredMs,
        fireDataAvailable: true,
      });
      expect(postFireRes.attributionClass).toBe('GUEST');
      expect(postFireRes.firedBefore).toBe(true);
      expect(postFireRes.countsAsGuestReturn).toBe(true);
    });

    it('never penalizes guest for discounts, even if reason is mapped to GUEST', () => {
      const discountRes = classifyAdjustment({
        kind: 'discount',
        reasonRef: 'GUEST_REJECTED',
        mappings: defaultMappings,
        firedAtMs: baseFiredMs,
        occurredAtMs: baseOccurredMs,
        fireDataAvailable: true,
      });
      expect(discountRes.attributionClass).toBe('GUEST');
      expect(discountRes.countsAsGuestReturn).toBe(false);
    });
  });

  describe('Provider Limitations & Fallbacks', () => {
    it('shields guest when POS provider lacks fire data capability', () => {
      const res = classifyAdjustment({
        kind: 'void',
        reasonRef: 'GUEST_REJECTED',
        mappings: defaultMappings,
        firedAtMs: baseFiredMs,
        occurredAtMs: baseOccurredMs,
        fireDataAvailable: false, // Provider has no fire timestamps
      });
      expect(res.firedBefore).toBeNull();
      expect(res.countsAsGuestReturn).toBe(false);
    });

    it('defaults unmapped voids to UNMAPPED and unmapped discounts to PROMOTIONAL', () => {
      const unmappedVoid = classifyAdjustment({
        kind: 'void',
        reasonRef: 'NON_EXISTENT_REASON_CODE',
        mappings: defaultMappings,
        firedAtMs: baseFiredMs,
        occurredAtMs: baseOccurredMs,
        fireDataAvailable: true,
      });
      expect(unmappedVoid.attributionClass).toBe('UNMAPPED');
      expect(unmappedVoid.countsAsGuestReturn).toBe(false);

      const nullReasonVoid = classifyAdjustment({
        kind: 'void',
        reasonRef: null,
        mappings: defaultMappings,
        firedAtMs: baseFiredMs,
        occurredAtMs: baseOccurredMs,
        fireDataAvailable: true,
      });
      expect(nullReasonVoid.attributionClass).toBe('UNMAPPED');
      expect(nullReasonVoid.countsAsGuestReturn).toBe(false);

      const unmappedDiscount = classifyAdjustment({
        kind: 'discount',
        reasonRef: null,
        mappings: defaultMappings,
        firedAtMs: null,
        occurredAtMs: baseOccurredMs,
        fireDataAvailable: true,
      });
      expect(unmappedDiscount.attributionClass).toBe('PROMOTIONAL');
      expect(unmappedDiscount.countsAsGuestReturn).toBe(false);
    });
  });

  describe('Eligible Spend Interaction with Voids', () => {
    it('completely ignores voided items from eligible spend regardless of reason', () => {
      const items: CalcItem[] = [
        { id: 'item-1', grossCents: 4500, voided: true, category: 'ENTREE' }, // Kitchen void
        { id: 'item-2', grossCents: 2000, voided: false, category: 'ENTREE' },
      ];
      const adjustments: CalcAdjustment[] = [
        { kind: 'void', itemId: 'item-1', amountCents: 4500 },
      ];
      expect(eligibleSpendCents(items, adjustments)).toBe(2000);
    });

    it('handles zero-spend check without divide-by-zero when all items are voided', () => {
      const items: CalcItem[] = [
        { id: 'i1', grossCents: 5000, voided: true, category: 'ENTREE' },
      ];
      const adjustments: CalcAdjustment[] = [
        { kind: 'discount', itemId: null, amountCents: 1000 },
      ];
      expect(eligibleSpendCents(items, adjustments)).toBe(0);
    });
  });
});

describe('CHALLENGER 2: Floor Dwell Alert Timer Thresholds (floor.ts)', () => {
  const seatedAt = at('2026-06-15T18:00:00Z');

  describe('Exact Minute and Millisecond Boundaries for 90-Minute Turn', () => {
    const turnMinutes = 90;
    // redAt = Math.ceil(90 * 1.25) = 113 minutes

    it('stays normal 1ms before 90 minutes', () => {
      const now = seatedAt + (89 * 60_000 + 59_999);
      const res = timerState(seatedAt, turnMinutes, now);
      expect(res.elapsedMinutes).toBe(89);
      expect(res.level).toBe('normal');
    });

    it('switches to amber at exactly 90 minutes 0ms', () => {
      const now = seatedAt + 90 * 60_000;
      const res = timerState(seatedAt, turnMinutes, now);
      expect(res.elapsedMinutes).toBe(90);
      expect(res.level).toBe('amber');
    });

    it('stays amber at 90 minutes + 1ms', () => {
      const now = seatedAt + 90 * 60_000 + 1;
      const res = timerState(seatedAt, turnMinutes, now);
      expect(res.elapsedMinutes).toBe(90);
      expect(res.level).toBe('amber');
    });

    it('stays amber 1ms before 113 minutes', () => {
      const now = seatedAt + (112 * 60_000 + 59_999);
      const res = timerState(seatedAt, turnMinutes, now);
      expect(res.elapsedMinutes).toBe(112);
      expect(res.level).toBe('amber');
    });

    it('switches to red at exactly 113 minutes 0ms', () => {
      const now = seatedAt + 113 * 60_000;
      const res = timerState(seatedAt, turnMinutes, now);
      expect(res.elapsedMinutes).toBe(113);
      expect(res.level).toBe('red');
    });

    it('remains red well beyond 113 minutes', () => {
      const now = seatedAt + 240 * 60_000; // 4 hours
      const res = timerState(seatedAt, turnMinutes, now);
      expect(res.elapsedMinutes).toBe(240);
      expect(res.level).toBe('red');
    });
  });

  describe('Boundary Invariants for Dynamic Party Sizes', () => {
    it('evaluates 75-minute turn (1-2 covers): amber at 75m, red at ceil(93.75) = 94m', () => {
      const turnMinutes = 75;
      expect(timerState(seatedAt, turnMinutes, seatedAt + 74 * 60_000).level).toBe('normal');
      expect(timerState(seatedAt, turnMinutes, seatedAt + 75 * 60_000).level).toBe('amber');
      expect(timerState(seatedAt, turnMinutes, seatedAt + 93 * 60_000).level).toBe('amber');
      expect(timerState(seatedAt, turnMinutes, seatedAt + 94 * 60_000).level).toBe('red');
    });

    it('evaluates 120-minute turn (5+ covers): amber at 120m, red at ceil(150.0) = 150m', () => {
      const turnMinutes = 120;
      expect(timerState(seatedAt, turnMinutes, seatedAt + 119 * 60_000).level).toBe('normal');
      expect(timerState(seatedAt, turnMinutes, seatedAt + 120 * 60_000).level).toBe('amber');
      expect(timerState(seatedAt, turnMinutes, seatedAt + 149 * 60_000).level).toBe('amber');
      expect(timerState(seatedAt, turnMinutes, seatedAt + 150 * 60_000).level).toBe('red');
    });

    it('evaluates non-standard 45-minute turn: amber at 45m, red at ceil(56.25) = 57m', () => {
      const turnMinutes = 45;
      expect(timerState(seatedAt, turnMinutes, seatedAt + 44 * 60_000).level).toBe('normal');
      expect(timerState(seatedAt, turnMinutes, seatedAt + 45 * 60_000).level).toBe('amber');
      expect(timerState(seatedAt, turnMinutes, seatedAt + 56 * 60_000).level).toBe('amber');
      expect(timerState(seatedAt, turnMinutes, seatedAt + 57 * 60_000).level).toBe('red');
    });
  });

  describe('Zero and Negative Time Edge Cases', () => {
    it('returns elapsedMinutes 0 and level normal at exact zero elapsed time', () => {
      const res = timerState(seatedAt, 90, seatedAt);
      expect(res.elapsedMinutes).toBe(0);
      expect(res.level).toBe('normal');
    });

    it('gracefully handles clock skew where nowMs is before seatedAtMs (clamped to 0)', () => {
      const skewNow = seatedAt - 120_000; // 2 minutes in the past
      const res = timerState(seatedAt, 90, skewNow);
      expect(res.elapsedMinutes).toBe(0);
      expect(res.level).toBe('normal');
    });

    it('handles turnMinutes = 0 boundary without NaN', () => {
      const res = timerState(seatedAt, 0, seatedAt);
      expect(res.elapsedMinutes).toBe(0);
      expect(res.level).toBe('red'); // redAt is 0, elapsed is 0 >= 0
    });
  });

  describe('Floor Transition State Machine', () => {
    it('validates canonical lifecycle: available -> occupied -> bussing -> available', () => {
      expect(floorTransition('available', 'seat')).toBe('occupied');
      expect(floorTransition('occupied', 'complete')).toBe('bussing');
      expect(floorTransition('bussing', 'clear')).toBe('available');
    });

    it('allows quick re-seat from bussing', () => {
      expect(floorTransition('bussing', 'seat')).toBe('occupied');
    });

    it('rejects illegal transitions', () => {
      expect(floorTransition('available', 'complete')).toBeNull();
      expect(floorTransition('occupied', 'seat')).toBeNull();
      expect(floorTransition('occupied', 'clear')).toBeNull();
      expect(floorTransition('blocked', 'seat')).toBeNull();
    });

    it('ensures tableFreeAt returns at least 5 minutes in the future for occupied tables with past release estimates', () => {
      const now = at('2026-06-15T20:00:00Z');
      const pastPredicted = now - 10 * 60_000;
      expect(tableFreeAt('occupied', now, pastPredicted)).toBe(now + 5 * 60_000);
    });
  });
});

describe('CHALLENGER 2: Loyalty Voucher Lifecycle & Points (loyalty.ts)', () => {
  describe('Voucher Hold -> Capture -> Release Transitions', () => {
    it('executes complete Hold -> Capture lifecycle preserving point conservation', () => {
      const initialAvailable = 5000;
      const initialHeld = 0;
      const voucherValue = 1000;

      // 1. Hold
      const holdRes = planVoucherHold(voucherValue, initialAvailable, 0, true);
      expect(holdRes.ok).toBe(true);
      if (!holdRes.ok) return;

      expect(holdRes.points).toBe(voucherValue);
      expect(holdRes.deltas).toEqual([
        { type: 'redeem_hold', pendingDelta: 0, availableDelta: -voucherValue, heldDelta: voucherValue },
      ]);

      const afterHoldAvailable = initialAvailable + holdRes.deltas[0].availableDelta;
      const afterHoldHeld = initialHeld + holdRes.deltas[0].heldDelta;
      expect(afterHoldAvailable).toBe(4000);
      expect(afterHoldHeld).toBe(1000);
      // Invariant: total points conserved
      expect(afterHoldAvailable + afterHoldHeld).toBe(initialAvailable);

      // 2. Capture (Redeemed at POS)
      const captureDeltas = planVoucherCapture(voucherValue);
      expect(captureDeltas).toEqual([
        { type: 'redeem_capture', pendingDelta: 0, availableDelta: 0, heldDelta: -voucherValue },
      ]);

      const afterCaptureAvailable = afterHoldAvailable + captureDeltas[0].availableDelta;
      const afterCaptureHeld = afterHoldHeld + captureDeltas[0].heldDelta;
      expect(afterCaptureAvailable).toBe(4000);
      expect(afterCaptureHeld).toBe(0);
    });

    it('executes complete Hold -> Release lifecycle restoring available balance', () => {
      const initialAvailable = 3000;
      const voucherValue = 2500;

      // 1. Hold
      const holdRes = planVoucherHold(voucherValue, initialAvailable, 0, true);
      expect(holdRes.ok).toBe(true);
      if (!holdRes.ok) return;

      const afterHoldAvailable = initialAvailable + holdRes.deltas[0].availableDelta; // 500
      const afterHoldHeld = holdRes.deltas[0].heldDelta; // 2500

      // 2. Release (Expired or Cancelled)
      const releaseDeltas = planVoucherRelease(voucherValue);
      expect(releaseDeltas).toEqual([
        { type: 'redeem_release', pendingDelta: 0, availableDelta: voucherValue, heldDelta: -voucherValue },
      ]);

      const afterReleaseAvailable = afterHoldAvailable + releaseDeltas[0].availableDelta;
      const afterReleaseHeld = afterHoldHeld + releaseDeltas[0].heldDelta;
      expect(afterReleaseAvailable).toBe(initialAvailable);
      expect(afterReleaseHeld).toBe(0);
    });
  });

  describe('Denomination Constraints and Boundary Validation', () => {
    it('accepts only exact denominations: 500, 1000, 2500 cents', () => {
      for (const validDenom of VOUCHER_DENOMINATIONS_CENTS) {
        expect(planVoucherHold(validDenom, 10000, 0, true).ok).toBe(true);
      }
    });

    it('rejects arbitrary, zero, and negative denominations', () => {
      const invalidDenoms = [0, 100, 499, 501, 700, 1500, 2000, 5000, -500, 500.5, NaN];
      for (const invalid of invalidDenoms) {
        const res = planVoucherHold(invalid, 10000, 0, true);
        expect(res).toEqual({ ok: false, error: 'INVALID_DENOMINATION' });
      }
    });
  });

  describe('Active Voucher Limit Enforcement', () => {
    it('allows creating vouchers when active count is < 3', () => {
      expect(planVoucherHold(500, 5000, 0, true).ok).toBe(true);
      expect(planVoucherHold(500, 5000, 1, true).ok).toBe(true);
      expect(planVoucherHold(500, 5000, 2, true).ok).toBe(true);
    });

    it('rejects voucher creation when active count is >= 3', () => {
      expect(planVoucherHold(500, 5000, 3, true)).toEqual({
        ok: false,
        error: 'TOO_MANY_ACTIVE_VOUCHERS',
      });
      expect(planVoucherHold(500, 5000, 4, true)).toEqual({
        ok: false,
        error: 'TOO_MANY_ACTIVE_VOUCHERS',
      });
    });
  });

  describe('Points Sufficiency and Account Status', () => {
    it('allows hold when availablePoints exactly equals voucher points', () => {
      const res = planVoucherHold(1000, 1000, 0, true);
      expect(res.ok).toBe(true);
    });

    it('rejects hold when availablePoints is even 1 point less than voucher points', () => {
      const res = planVoucherHold(1000, 999, 0, true);
      expect(res).toEqual({ ok: false, error: 'INSUFFICIENT_POINTS' });
    });

    it('rejects hold when account is not active regardless of points balance', () => {
      const res = planVoucherHold(500, 100_000, 0, false);
      expect(res).toEqual({ ok: false, error: 'ACCOUNT_NOT_ACTIVE' });
    });
  });

  describe('Multi-Market INR Loyalty & Tier Progression', () => {
    it('calculates pointsForSpend accurately by tier multiplier', () => {
      // 1000 INR (100,000 paise)
      expect(pointsForSpend(100_000, 'BASE')).toBe(1000 * 3); // 3000 pts
      expect(pointsForSpend(100_000, 'MEMBER')).toBe(1000 * 4); // 4000 pts
      expect(pointsForSpend(100_000, 'REGULAR')).toBe(1000 * 5); // 5000 pts
      expect(pointsForSpend(100_000, 'FRIENDS_AND_FAMILY')).toBe(1000 * 7); // 7000 pts
    });

    it('floors fractional rupees before applying multiplier', () => {
      // 99 paise (less than 1 rupee) -> 0 points
      expect(pointsForSpend(99, 'BASE')).toBe(0);
      // 199 paise (1.99 INR) -> 1 INR * 3 = 3 points
      expect(pointsForSpend(199, 'BASE')).toBe(3);
      // Negative paise -> 0 points
      expect(pointsForSpend(-500, 'BASE')).toBe(0);
    });

    it('converts points to paise and paise to points symmetrically', () => {
      expect(pointsToPaise(100)).toBe(100); // 100 pts = 100 paise = ₹1
      expect(paiseToPoints(100)).toBe(100);
      expect(pointsToPaise(5000)).toBe(5000);
      expect(paiseToPoints(5000)).toBe(5000);
    });

    it('upgrades tier based on annual spend or single preload', () => {
      expect(computeTier('BASE', 50_000_00, 0)).toBe('MEMBER');
      expect(computeTier('BASE', 0, 25_000_00)).toBe('MEMBER');
      expect(computeTier('BASE', 5_00_000_00, 0)).toBe('REGULAR');
      expect(computeTier('BASE', 0, 2_50_000_00)).toBe('REGULAR');
      expect(computeTier('BASE', 10_00_000_00, 0)).toBe('FRIENDS_AND_FAMILY');
      expect(computeTier('BASE', 0, 5_00_000_00)).toBe('FRIENDS_AND_FAMILY');
    });

    it('NEVER downgrades tier below current tier', () => {
      expect(computeTier('REGULAR', 0, 0)).toBe('REGULAR');
      expect(computeTier('FRIENDS_AND_FAMILY', 100, 0)).toBe('FRIENDS_AND_FAMILY');
    });

    it('calculates void clawback accurately based on tier multiplier', () => {
      // 500 INR voided at REGULAR tier (5x) -> 2500 points clawback
      expect(clawbackPoints(50_000, 'REGULAR')).toBe(2500);
    });
  });
});
