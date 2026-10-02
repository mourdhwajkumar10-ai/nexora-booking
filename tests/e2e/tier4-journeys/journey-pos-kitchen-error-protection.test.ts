import { describe, it, expect } from 'vitest';
import { NexoraPlatformSimulator } from '../helpers/client-simulator';
import { type AttributionClass } from '../helpers/oracle';

describe('Tier 4: Real-World Application Scenario — POS Kitchen Error Protection Journey (Demo Flow 3)', () => {
  const mappings: Record<string, AttributionClass> = {
    BURNT_BY_KITCHEN: 'KITCHEN',
    WRONG_TEMPERATURE: 'KITCHEN',
    SERVER_TYPO: 'SERVER_ENTRY',
    GUEST_DID_NOT_LIKE: 'GUEST',
  };

  it('guarantees staff mistakes and kitchen defects do not penalize the guest profile in a live dining scenario', () => {
    const sim = new NexoraPlatformSimulator();
    const venueId = 'venue-us-001';
    const startsAt = 1759431600000;
    sim.setClock(startsAt);

    // 1. VIP guest arrives and is seated
    const booking = sim.createReservation({
      venueId,
      guestId: 'guest-protection-303',
      guestName: 'Dr. Evelyn Reed',
      guestPhone: '+15558889999',
      partySize: 2,
      serviceDate: '2026-10-02',
      startsAtMs: startsAt,
    });
    sim.seatReservation(booking.id, 't-us-1');

    // Initial guest profile is clean
    const initialProfile = sim.getOrCreateGuestProfile(booking.guestId);
    expect(initialProfile.totalVisits).toBe(0);
    expect(initialProfile.guestReturnsCount).toBe(0);
    expect(initialProfile.nonGuestVoidsCount).toBe(0);

    // 2. Server opens POS check and rings items
    const check = sim.createPOSCheck(booking.id, 't-us-1');
    const firedAt = startsAt + 5 * 60_000; // fired 5 min in

    sim.addCheckItem(check.id, { id: 'dish-1', name: 'Dry Aged Ribeye', grossCents: 6500, category: 'FOOD', firedAtMs: firedAt });
    sim.addCheckItem(check.id, { id: 'dish-2', name: 'Lobster Risotto', grossCents: 4500, category: 'FOOD', firedAtMs: firedAt });
    sim.addCheckItem(check.id, { id: 'dish-3', name: 'Accidental Cocktail', grossCents: 1800, category: 'BEVERAGE', firedAtMs: firedAt });

    // 3. Operational Defect 1: Kitchen burns the risotto
    sim.setClock(firedAt + 12 * 60_000); // 12 min after fire
    const kitchenVoid = sim.voidCheckItem(check.id, 'dish-2', {
      kind: 'void',
      reasonRef: 'BURNT_BY_KITCHEN',
      mappings,
    });

    expect(kitchenVoid.attributionClass).toBe('KITCHEN');
    expect(kitchenVoid.countsAsGuestReturn).toBe(false);

    // Replacement risotto refired and served
    sim.addCheckItem(check.id, { id: 'dish-2-refire', name: 'Lobster Risotto (Replacement)', grossCents: 4500, category: 'FOOD', firedAtMs: sim.currentTimeMs });

    // 4. Operational Defect 2: Server accidentally rung extra cocktail
    const serverVoid = sim.voidCheckItem(check.id, 'dish-3', {
      kind: 'void',
      reasonRef: 'SERVER_TYPO',
      mappings,
    });

    expect(serverVoid.attributionClass).toBe('SERVER_ENTRY');
    expect(serverVoid.countsAsGuestReturn).toBe(false);

    // 5. Diner finishes dining and settles the check
    sim.advanceClock(45);
    const { eligibleSpend, pointsEarned } = sim.settleCheck(check.id);

    // Check should charge only Ribeye ($65) + Replacement Risotto ($45) = $110 (11,000 cents)
    expect(eligibleSpend).toBe(11000);
    expect(pointsEarned).toBe(110);

    sim.completeDining('t-us-1');

    // 6. Deep CRM Profile Inspection:
    // Assert zero penalization of guest profile
    const finalProfile = sim.getOrCreateGuestProfile(booking.guestId);
    expect(finalProfile.totalVisits).toBe(1);
    expect(finalProfile.lifetimeSpend).toBe(11000);
    expect(finalProfile.guestReturnsCount).toBe(0); // Zero penalty!
    expect(finalProfile.guestReturnsValue).toBe(0);  // Zero dollar amount attributed to diner!
    expect(finalProfile.nonGuestVoidsCount).toBe(2); // Recorded as venue operational voids
  });
});
