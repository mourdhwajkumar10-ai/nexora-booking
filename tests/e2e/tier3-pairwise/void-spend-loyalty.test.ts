import { describe, it, expect } from 'vitest';
import { NexoraPlatformSimulator } from '../helpers/client-simulator';
import { type AttributionClass } from '../helpers/oracle';

describe('Tier 3: Cross-Feature Combination — Fair Void Attribution + Eligible Spend + Loyalty + Profile Protection', () => {
  const mappings: Record<string, AttributionClass> = {
    PREPARATION_DEFECT: 'KITCHEN',
    WRONG_ITEM_RUNG: 'SERVER_ENTRY',
    GUEST_CHANGED_MIND: 'GUEST',
  };

  it('correctly calculates eligible spend, accrues points, and shields guest profile from kitchen/server voids', () => {
    const sim = new NexoraPlatformSimulator();
    const venueId = 'venue-us-001';
    const now = 1759431600000;
    sim.setClock(now);

    // 1. Create and seat a reservation
    const booking = sim.createReservation({
      venueId,
      guestId: 'guest-vip-101',
      guestName: 'Marcus Aurelius',
      guestPhone: '+15559876543',
      partySize: 2,
      serviceDate: '2026-10-02',
      startsAtMs: now,
    });
    sim.seatReservation(booking.id, 't-us-1');

    // 2. Open POS check
    const check = sim.createPOSCheck(booking.id, 't-us-1');

    // 3. Add items to check:
    // - Salmon ($35.00 = 3500 cents)
    // - Ribeye Steak ($55.00 = 5500 cents)
    // - Burnt Appetizer ($20.00 = 2000 cents, fired at now + 5m)
    // - Mistaken Drink ($10.00 = 1000 cents, fired at now + 5m)
    // - Gift Card ($50.00 = 5000 cents) -> excluded category GIFT_CARD
    const firedAt = now + 5 * 60_000;

    sim.addCheckItem(check.id, { id: 'item-salmon', name: 'King Salmon', grossCents: 3500, category: 'FOOD', firedAtMs: firedAt });
    sim.addCheckItem(check.id, { id: 'item-steak', name: 'Ribeye Steak', grossCents: 5500, category: 'FOOD', firedAtMs: firedAt });
    sim.addCheckItem(check.id, { id: 'item-app', name: 'Crispy Calamari', grossCents: 2000, category: 'FOOD', firedAtMs: firedAt });
    sim.addCheckItem(check.id, { id: 'item-drink', name: 'Martini', grossCents: 1000, category: 'BEVERAGE', firedAtMs: firedAt });
    sim.addCheckItem(check.id, { id: 'item-gc', name: 'Dining Gift Card', grossCents: 5000, category: 'GIFT_CARD', firedAtMs: null });

    // Advance clock to void time (10 min after fire)
    sim.setClock(firedAt + 10 * 60_000);

    // 4. Void burnt appetizer as KITCHEN defect
    const kitchenVoid = sim.voidCheckItem(check.id, 'item-app', {
      kind: 'void',
      reasonRef: 'PREPARATION_DEFECT',
      mappings,
    });
    expect(kitchenVoid.attributionClass).toBe('KITCHEN');
    expect(kitchenVoid.countsAsGuestReturn).toBe(false);

    // 5. Void mistakenly rung drink as SERVER_ENTRY
    const serverVoid = sim.voidCheckItem(check.id, 'item-drink', {
      kind: 'void',
      reasonRef: 'WRONG_ITEM_RUNG',
      mappings,
    });
    expect(serverVoid.attributionClass).toBe('SERVER_ENTRY');
    expect(serverVoid.countsAsGuestReturn).toBe(false);

    // 6. Check guest profile BEFORE settlement
    const profileMid = sim.getOrCreateGuestProfile(booking.guestId);
    expect(profileMid.guestReturnsCount).toBe(0);
    expect(profileMid.guestReturnsValue).toBe(0);
    expect(profileMid.nonGuestVoidsCount).toBe(2); // Recorded as operational voids, not diner fault

    // 7. Settle the check
    const { eligibleSpend, pointsEarned } = sim.settleCheck(check.id);

    // Eligible spend should be only Salmon (3500) + Steak (5500) = 9000 cents ($90.00)
    // (Burnt app and drink are voided; Gift Card is excluded from loyalty spend)
    expect(eligibleSpend).toBe(9000);
    // US earn rate: 100 cents ($1) = 1 pt -> exactly 90 points
    expect(pointsEarned).toBe(90);

    // 8. Verify final Guest Profile metrics
    const profileFinal = sim.getOrCreateGuestProfile(booking.guestId);
    expect(profileFinal.guestReturnsCount).toBe(0); // Zero penalty strikes!
    expect(profileFinal.guestReturnsValue).toBe(0);
    expect(profileFinal.lifetimeSpend).toBe(9000);
    expect(profileFinal.loyaltyPoints).toBe(90);
  });
});
