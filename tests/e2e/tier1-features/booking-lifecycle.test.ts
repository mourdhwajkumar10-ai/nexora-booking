import { describe, it, expect } from 'vitest';
import {
  applyReservationEvent,
  TRANSITIONS,
  EVENT_ACTORS,
  type ReservationStatus,
  type ReservationEvent,
  type Actor,
} from '../helpers/oracle';

describe('Tier 1: Feature Coverage — 8-State Reservation Lifecycle (F-BR08)', () => {
  const baseReservation = {
    id: 'res-e2e-001',
    venueId: 'venue-manhattan-1',
    serviceDate: '2026-10-02' as any,
    startsAtMs: 1759431600000, // 2026-10-02 19:00 UTC
    partySize: 4,
  };

  it('verifies all 8 states exist in the state machine transition definitions', () => {
    const definedStates = Object.keys(TRANSITIONS);
    expect(definedStates).toContain('requested');
    expect(definedStates).toContain('confirmed');
    expect(definedStates).toContain('arrived');
    expect(definedStates).toContain('late');
    expect(definedStates).toContain('seated');
    expect(definedStates).toContain('completed');
    expect(definedStates).toContain('cancelled');
    expect(definedStates).toContain('no_show');
    expect(definedStates.length).toBe(8);
  });

  it('executes canonical happy path: requested -> confirmed -> arrived -> seated -> completed', () => {
    let now = baseReservation.startsAtMs - 3600_000; // 1 hour before

    // 1. Confirm requested booking (staff or system)
    const step1 = applyReservationEvent(
      { ...baseReservation, status: 'requested' },
      'confirm',
      { nowMs: now, actor: 'staff' }
    );
    expect(step1.status).toBe('confirmed');
    expect(step1.effects).toContain('notify_confirmed');

    // 2. Guest arrives (system arrival detection via Wi-Fi/QR or staff check-in)
    now = baseReservation.startsAtMs - 600_000;
    const step2 = applyReservationEvent(
      { ...baseReservation, status: step1.status },
      'arrive',
      { nowMs: now, actor: 'system' }
    );
    expect(step2.status).toBe('arrived');
    expect(step2.patch.arrivedAt).toBe(now);

    // 3. Host seats the party
    now = baseReservation.startsAtMs;
    const step3 = applyReservationEvent(
      { ...baseReservation, status: step2.status, arrivedAtMs: step2.patch.arrivedAt },
      'seat',
      { nowMs: now, actor: 'staff' }
    );
    expect(step3.status).toBe('seated');
    expect(step3.patch.seatedAt).toBe(now);
    expect(step3.effects).toContain('tables_occupied');

    // 4. Party completes dining
    now = baseReservation.startsAtMs + 90 * 60_000;
    const step4 = applyReservationEvent(
      { ...baseReservation, status: step3.status, seatedAt: step3.patch.seatedAt },
      'complete',
      { nowMs: now, actor: 'staff' }
    );
    expect(step4.status).toBe('completed');
    expect(step4.patch.completedAt).toBe(now);
    expect(step4.effects).toContain('tables_bussing');
  });

  it('handles running late flow: confirmed -> mark_late -> arrived -> seated', () => {
    // 15 minutes past start without seating -> mark_late
    const now = baseReservation.startsAtMs + 15 * 60_000;
    const lateStep = applyReservationEvent(
      { ...baseReservation, status: 'confirmed' },
      'mark_late',
      { nowMs: now, actor: 'system', graceMinutes: 15 }
    );
    expect(lateStep.status).toBe('late');
    expect(lateStep.effects).toContain('notify_late_prompt');

    // Guest arrives while in late state
    const arriveStep = applyReservationEvent(
      { ...baseReservation, status: 'late' },
      'arrive',
      { nowMs: now + 5 * 60_000, actor: 'staff' }
    );
    expect(arriveStep.status).toBe('arrived');

    // Host seats the late party
    const seatStep = applyReservationEvent(
      { ...baseReservation, status: 'arrived', arrivedAtMs: arriveStep.patch.arrivedAt },
      'seat',
      { nowMs: now + 7 * 60_000, actor: 'staff' }
    );
    expect(seatStep.status).toBe('seated');
  });

  it('allows seating a late party directly without explicit intermediate arrive event', () => {
    const now = baseReservation.startsAtMs + 20 * 60_000;
    const seatStep = applyReservationEvent(
      { ...baseReservation, status: 'late' },
      'seat',
      { nowMs: now, actor: 'staff' }
    );
    expect(seatStep.status).toBe('seated');
    expect(seatStep.patch.seatedAt).toBe(now);
  });

  it('prevents illegal transitions: completed cannot transition to seated or arrived', () => {
    expect(() =>
      applyReservationEvent(
        { ...baseReservation, status: 'completed' },
        'seat',
        { nowMs: baseReservation.startsAtMs, actor: 'staff' }
      )
    ).toThrow();

    expect(() =>
      applyReservationEvent(
        { ...baseReservation, status: 'completed' },
        'arrive',
        { nowMs: baseReservation.startsAtMs, actor: 'staff' }
      )
    ).toThrow();
  });

  it('prevents illegal transitions: cancelled cannot be seated', () => {
    expect(() =>
      applyReservationEvent(
        { ...baseReservation, status: 'cancelled' },
        'seat',
        { nowMs: baseReservation.startsAtMs, actor: 'staff' }
      )
    ).toThrow();
  });

  it('allows no_show to be reinstated to arrived on the same date', () => {
    const now = baseReservation.startsAtMs + 45 * 60_000;
    const reinstated = applyReservationEvent(
      { ...baseReservation, status: 'no_show' },
      'reinstate',
      { nowMs: now, actor: 'staff' }
    );
    expect(reinstated.status).toBe('arrived');
  });

  it('enforces actor permission checks (e.g. guests cannot seat parties)', () => {
    expect(() =>
      applyReservationEvent(
        { ...baseReservation, status: 'confirmed' },
        'seat',
        { nowMs: baseReservation.startsAtMs, actor: 'guest' }
      )
    ).toThrow();
  });
});
