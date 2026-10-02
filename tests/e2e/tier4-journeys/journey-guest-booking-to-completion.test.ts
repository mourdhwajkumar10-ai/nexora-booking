import { describe, it, expect } from 'vitest';
import { NexoraPlatformSimulator } from '../helpers/client-simulator';

describe('Tier 4: Real-World Application Scenario — Guest Booking to Completion Journey (Demo Flow 1)', () => {
  it('walks through guest booking, live tracking, arrival, host seating, dwell alerts, and completion', () => {
    const sim = new NexoraPlatformSimulator();
    const venueId = 'venue-us-001';
    const startsAt = 1759431600000; // 19:00 UTC
    sim.setClock(startsAt - 3600_000); // 18:00 (1h before booking)

    // 1. Guest books a table for party of 4
    const booking = sim.createReservation({
      venueId,
      guestId: 'guest-demo-1',
      guestName: 'Sophia Chen',
      guestPhone: '+15554321098',
      partySize: 4,
      serviceDate: '2026-10-02',
      startsAtMs: startsAt,
      allergies: ['Peanuts'],
      specialRequests: 'Window booth preferred',
    });

    expect(booking.status).toBe('confirmed');
    expect(booking.turnMinutes).toBe(90);
    expect(booking.publicToken).toBeDefined();

    // 2. Live guest booking tracker initial verification
    const tracker1 = sim.getGuestTracking(booking.publicToken);
    expect(tracker1.status).toBe('confirmed');
    expect(tracker1.partySize).toBe(4);
    expect(tracker1.allergies).toContain('Peanuts');

    // 3. Guest arrives at venue (18:50 UTC, 10 min before start)
    sim.setClock(startsAt - 600_000);
    sim.transitionReservation(booking.id, 'arrive', 'system');

    // Live tracker updates to ARRIVED
    const tracker2 = sim.getGuestTracking(booking.publicToken);
    expect(tracker2.status).toBe('arrived');
    expect(tracker2.history.map((h) => h.status)).toEqual(['confirmed', 'arrived']);

    // 4. Host floor management: Host views floor plan and seats party at Table T2
    sim.setClock(startsAt);
    sim.seatReservation(booking.id, 't-us-2');

    // Live tracker updates to SEATED
    const tracker3 = sim.getGuestTracking(booking.publicToken);
    expect(tracker3.status).toBe('seated');
    expect(tracker3.tableId).toBe('t-us-2');

    // Floor table status updates to OCCUPIED
    const table = sim.tables.get('t-us-2')!;
    expect(table.status).toBe('occupied');
    expect(table.currentReservationId).toBe(booking.id);

    // 5. Host floor dwell warnings:
    // At 45 min elapsed -> Normal
    sim.advanceClock(45);
    expect(sim.getTableDwellState('t-us-2')).toEqual({ elapsedMinutes: 45, level: 'normal' });

    // At 90 min elapsed (100% of turn duration) -> AMBER warning
    sim.advanceClock(45); // 90 min total
    expect(sim.getTableDwellState('t-us-2')).toEqual({ elapsedMinutes: 90, level: 'amber' });

    // At 113 min elapsed (ceil(125% * 90) = 113) -> RED warning
    sim.advanceClock(23); // 113 min total
    expect(sim.getTableDwellState('t-us-2')).toEqual({ elapsedMinutes: 113, level: 'red' });

    // 6. POS Order payment and dining completion
    sim.advanceClock(5); // 118 min total
    sim.completeDining('t-us-2');

    // Floor table transitions to BUSSING
    expect(table.status).toBe('bussing');
    expect(table.currentReservationId).toBeUndefined();

    // Live tracker confirms terminal COMPLETED status
    const tracker4 = sim.getGuestTracking(booking.publicToken);
    expect(tracker4.status).toBe('completed');
    expect(tracker4.history.map((h) => h.status)).toEqual(['confirmed', 'arrived', 'seated', 'completed']);

    // Guest visit count incremented in CRM profile
    const profile = sim.getOrCreateGuestProfile(booking.guestId);
    expect(profile.totalVisits).toBe(1);
  });
});
