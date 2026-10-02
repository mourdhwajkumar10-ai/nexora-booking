import { describe, it, expect } from 'vitest';
import {
  applyReservationEvent,
  formatMoney,
  type ReservationSnapshot,
  type TransitionContext,
} from '../helpers/oracle';

describe('Tier 3: Cross-Feature Combination — Dual-Market Pricing & Cancellation Policy Evaluation', () => {
  const serviceDate = '2026-10-02' as any;
  const startsAtMs = 1759431600000; // 19:00 UTC

  it('evaluates timely vs late cancellation fees in USD for US venue', () => {
    const usLateFeeCents = 2500; // $25.00 fee
    const lateCancelWindowHours = 2; // 2 hour policy

    // 1. Timely cancellation: 4 hours before startsAtMs
    const timelyNow = startsAtMs - 4 * 3600_000;
    const timelyResult = applyReservationEvent(
      {
        status: 'confirmed',
        startsAtMs,
        serviceDate,
      },
      'cancel_guest',
      {
        nowMs: timelyNow,
        actor: 'guest',
        lateCancelWindowHours,
      }
    );

    expect(timelyResult.status).toBe('cancelled');
    expect(timelyResult.patch.lateCancel).toBe(false);
    expect(timelyResult.effects).not.toContain('evaluate_late_cancel_fee');

    // 2. Late cancellation: 1 hour before startsAtMs (within 2h window)
    const lateNow = startsAtMs - 1 * 3600_000;
    const lateResult = applyReservationEvent(
      {
        status: 'confirmed',
        startsAtMs,
        serviceDate,
      },
      'cancel_guest',
      {
        nowMs: lateNow,
        actor: 'guest',
        lateCancelWindowHours,
      }
    );

    expect(lateResult.status).toBe('cancelled');
    expect(lateResult.patch.lateCancel).toBe(true);
    expect(lateResult.effects).toContain('evaluate_late_cancel_fee');

    // Formatted fee in USD
    const formattedFee = formatMoney(usLateFeeCents, 'USD');
    expect(formattedFee).toBe('$25.00');
  });

  it('evaluates timely vs late cancellation fees in INR for India venue', () => {
    const inLateFeePaise = 50000; // ₹500 fee
    const lateCancelWindowHours = 4; // 4 hour policy in India

    // 1. Timely cancellation: 6 hours before
    const timelyNow = startsAtMs - 6 * 3600_000;
    const timelyResult = applyReservationEvent(
      {
        status: 'confirmed',
        startsAtMs,
        serviceDate,
      },
      'cancel_guest',
      {
        nowMs: timelyNow,
        actor: 'guest',
        lateCancelWindowHours,
      }
    );
    expect(timelyResult.patch.lateCancel).toBe(false);

    // 2. Late cancellation: 2 hours before (within 4h window)
    const lateNow = startsAtMs - 2 * 3600_000;
    const lateResult = applyReservationEvent(
      {
        status: 'confirmed',
        startsAtMs,
        serviceDate,
      },
      'cancel_guest',
      {
        nowMs: lateNow,
        actor: 'guest',
        lateCancelWindowHours,
      }
    );
    expect(lateResult.patch.lateCancel).toBe(true);
    expect(lateResult.effects).toContain('evaluate_late_cancel_fee');

    // Formatted fee in INR
    const formattedFee = formatMoney(inLateFeePaise, 'INR');
    expect(formattedFee).toBe('₹500');
  });
});
