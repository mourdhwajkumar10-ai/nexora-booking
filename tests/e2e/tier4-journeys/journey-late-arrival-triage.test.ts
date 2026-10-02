import { describe, it, expect } from 'vitest';
import { NexoraPlatformSimulator } from '../helpers/client-simulator';

describe('Tier 4: Real-World Application Scenario — Late Arrival & Host Triage Journey (Demo Flow 2)', () => {
  it('manages grace period expiry, auto-transition to LATE, guest communication, and eventual seating', () => {
    const sim = new NexoraPlatformSimulator();
    const venueId = 'venue-us-001';
    const startsAt = 1759435200000; // 20:00 UTC
    sim.setClock(startsAt);

    // 1. Guest books table for 2 covers (turn time 75 min)
    const booking = sim.createReservation({
      venueId,
      guestId: 'guest-late-flow-2',
      guestName: 'Liam O’Connor',
      guestPhone: '+15553334444',
      partySize: 2,
      serviceDate: '2026-10-02',
      startsAtMs: startsAt,
    });

    expect(booking.status).toBe('confirmed');
    expect(booking.turnMinutes).toBe(75);

    // 2. 15 minutes pass without party arrival (startsAt + 15 min grace period)
    sim.advanceClock(15); // Clock is now 20:15 UTC

    // System worker evaluates grace period and transitions booking to LATE
    sim.transitionReservation(booking.id, 'mark_late', 'system');

    // Live tracker displays LATE status to the guest
    const trackerLate = sim.getGuestTracking(booking.publicToken);
    expect(trackerLate.status).toBe('late');
    expect(trackerLate.history.map((h) => h.status)).toEqual(['confirmed', 'late']);

    // 3. Guest arrives at host stand at 20:25 (10 min after being marked late)
    sim.advanceClock(10); // Clock is now 20:25 UTC
    sim.transitionReservation(booking.id, 'arrive', 'staff');

    // Live tracker updates to ARRIVED
    const trackerArrived = sim.getGuestTracking(booking.publicToken);
    expect(trackerArrived.status).toBe('arrived');

    // 4. Host seats the party at Table T1
    sim.seatReservation(booking.id, 't-us-1');

    // Live tracker updates to SEATED
    const trackerSeated = sim.getGuestTracking(booking.publicToken);
    expect(trackerSeated.status).toBe('seated');

    // 5. Verify dwell timer calculates from SEATED time (20:25), NOT original booking start (20:00)
    // At 21:00 (35 min after seating):
    sim.advanceClock(35);
    const dwell35 = sim.getTableDwellState('t-us-1');
    expect(dwell35.elapsedMinutes).toBe(35); // NOT 60m
    expect(dwell35.level).toBe('normal');

    // At 21:40 (75 min after seating -> 100% of 75m turn):
    sim.advanceClock(40); // 75 min total elapsed
    const dwell75 = sim.getTableDwellState('t-us-1');
    expect(dwell75.elapsedMinutes).toBe(75);
    expect(dwell75.level).toBe('amber');

    // 6. Complete dining and vacate
    sim.advanceClock(10);
    sim.completeDining('t-us-1');

    const trackerFinal = sim.getGuestTracking(booking.publicToken);
    expect(trackerFinal.status).toBe('completed');
    expect(trackerFinal.history.map((h) => h.status)).toEqual([
      'confirmed',
      'late',
      'arrived',
      'seated',
      'completed',
    ]);
  });

  it('supports guest self-service "running late" report and contactless arrival check-in (G-20 / G-21)', () => {
    const sim = new NexoraPlatformSimulator();
    const venueId = 'venue-us-001';
    const startsAt = 1759435200000; // 20:00 UTC
    sim.setClock(startsAt);

    // 1. Guest books table
    const booking = sim.createReservation({
      venueId,
      guestId: 'guest-self-late-1',
      guestName: 'Maya Patel',
      guestPhone: '+15558889999',
      partySize: 4,
      serviceDate: '2026-10-02',
      startsAtMs: startsAt,
    });
    expect(booking.status).toBe('confirmed');

    // 2. Guest realizes they are stuck in traffic at 20:05 and taps "Running Late" on live tracker
    sim.advanceClock(5); // 20:05
    sim.transitionReservation(booking.id, 'mark_late', 'system');

    const trackerLate = sim.getGuestTracking(booking.publicToken);
    expect(trackerLate.status).toBe('late');
    expect(trackerLate.history.map((h) => h.status)).toEqual(['confirmed', 'late']);

    // 3. Guest arrives at restaurant front door at 20:22 and taps "Check In (I'm Here)"
    sim.advanceClock(17); // 20:22
    sim.transitionReservation(booking.id, 'arrive', 'system');

    const trackerArrived = sim.getGuestTracking(booking.publicToken);
    expect(trackerArrived.status).toBe('arrived');
    expect(trackerArrived.history.map((h) => h.status)).toEqual(['confirmed', 'late', 'arrived']);

    // 4. Host sees guest in ARRIVED queue and seats at Table T2
    sim.advanceClock(2); // 20:24
    sim.seatReservation(booking.id, 't-us-2');

    const trackerSeated = sim.getGuestTracking(booking.publicToken);
    expect(trackerSeated.status).toBe('seated');
    expect(trackerSeated.tableId).toBe('t-us-2');
  });
});
