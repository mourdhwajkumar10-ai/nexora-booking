import { describe, it, expect } from 'vitest';
import { NexoraPlatformSimulator } from '../helpers/client-simulator';

describe('Tier 4: Real-World Application Scenario — Dual-Market Parallel Venue Operations (Demo Flow 4)', () => {
  it('operates parallel US (USD) and India (INR) venues with precise multi-market formatting and loyalty', () => {
    const sim = new NexoraPlatformSimulator();
    const usVenueId = 'venue-us-001';
    const inVenueId = 'venue-in-001';
    const startsAt = 1759431600000;
    sim.setClock(startsAt);

    // --- US Operations ($ / USD / cents) ---
    // 1. Guest books in Manhattan
    const usBooking = sim.createReservation({
      venueId: usVenueId,
      guestId: 'guest-us-diner',
      guestName: 'Alex Hamilton',
      guestPhone: '+15551112222',
      partySize: 2,
      serviceDate: '2026-10-02',
      startsAtMs: startsAt,
    });
    sim.seatReservation(usBooking.id, 't-us-1');

    // 2. POS Check in USD
    const usCheck = sim.createPOSCheck(usBooking.id, 't-us-1');
    sim.addCheckItem(usCheck.id, { id: 'us-item-1', name: 'New York Strip', grossCents: 4800, category: 'FOOD' }); // $48.00
    sim.addCheckItem(usCheck.id, { id: 'us-item-2', name: 'Manhattan Cocktail', grossCents: 1800, category: 'BEVERAGE' }); // $18.00

    // Format item prices in US Venue
    expect(sim.formatVenueCurrency(4800, usVenueId)).toBe('$48.00');
    expect(sim.formatVenueCurrency(1800, usVenueId)).toBe('$18.00');

    // Settle US check ($66.00 = 6600 cents)
    const usSettlement = sim.settleCheck(usCheck.id);
    expect(usSettlement.eligibleSpend).toBe(6600);
    // US earn rate: $1 = 1 point -> 66 points
    expect(usSettlement.pointsEarned).toBe(66);
    expect(sim.formatVenueCurrency(usSettlement.eligibleSpend, usVenueId)).toBe('$66.00');

    // --- India Operations (₹ / INR / paise) ---
    // 3. Guest books in Bengaluru
    const inBooking = sim.createReservation({
      venueId: inVenueId,
      guestId: 'guest-in-diner',
      guestName: 'Aditi Sharma',
      guestPhone: '+919876543210',
      partySize: 2,
      serviceDate: '2026-10-02',
      startsAtMs: startsAt,
    });
    sim.seatReservation(inBooking.id, 't-in-1');

    // 4. POS Check in INR (amounts in paise)
    const inCheck = sim.createPOSCheck(inBooking.id, 't-in-1');
    // Butter Chicken: ₹550.00 = 55000 paise
    // Garlic Naan: ₹120.00 = 12000 paise
    // Kulfi: ₹180.50 = 18050 paise
    sim.addCheckItem(inCheck.id, { id: 'in-item-1', name: 'Murgh Makhani', grossCents: 55000, category: 'FOOD' });
    sim.addCheckItem(inCheck.id, { id: 'in-item-2', name: 'Garlic Naan', grossCents: 12000, category: 'FOOD' });
    sim.addCheckItem(inCheck.id, { id: 'in-item-3', name: 'Kesar Pista Kulfi', grossCents: 18050, category: 'FOOD' });

    // Format item prices in India Venue
    expect(sim.formatVenueCurrency(55000, inVenueId)).toBe('₹550');
    expect(sim.formatVenueCurrency(12000, inVenueId)).toBe('₹120');
    expect(sim.formatVenueCurrency(18050, inVenueId)).toBe('₹180.50');

    // Settle India check (Total 85050 paise = ₹850.50)
    const inSettlement = sim.settleCheck(inCheck.id);
    expect(inSettlement.eligibleSpend).toBe(85050);
    // India earn rate: ₹10 (1000 paise) = 1 point -> floor(85050 / 1000) = 85 points
    expect(inSettlement.pointsEarned).toBe(85);
    expect(sim.formatVenueCurrency(inSettlement.eligibleSpend, inVenueId)).toBe('₹850.50');

    // 5. Large banquet invoice formatting in INR (demonstrating Indian numbering lakh grouping)
    // 12,50,000 paise = ₹12,500
    expect(sim.formatVenueCurrency(1250000, inVenueId)).toBe('₹12,500');
    // 1,25,00,000 paise = ₹1,25,000 (1.25 Lakh)
    expect(sim.formatVenueCurrency(12500000, inVenueId)).toBe('₹1,25,000');
  });
});
