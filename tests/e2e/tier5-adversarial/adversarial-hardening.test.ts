import { describe, it, expect } from 'vitest';
import { NexoraPlatformSimulator } from '../helpers/client-simulator';
import { applyReservationEvent, formatMoney } from '../helpers/oracle';

describe('Tier 5: Adversarial Verification & Hardening', () => {
  it('handles XSS and SQL injection payloads in guest names and allergy notes safely', () => {
    const sim = new NexoraPlatformSimulator();
    const venueId = 'venue-us-001';
    const startsAt = 1759431600000;

    const maliciousName = "<script>alert('xss')</script>";
    const sqlInjectionRequest = "'; DROP TABLE reservations; --";
    const specialAllergies = ["<img src=x onerror=alert('allergy')>", "Gluten' OR '1'='1"];

    const booking = sim.createReservation({
      venueId,
      guestId: 'guest-adversarial-1',
      guestName: maliciousName,
      guestPhone: '+15550009999',
      partySize: 2,
      serviceDate: '2026-10-02',
      startsAtMs: startsAt,
      allergies: specialAllergies,
      specialRequests: sqlInjectionRequest,
    });

    expect(booking.status).toBe('confirmed');
    expect(booking.guestName).toBe(maliciousName);
    expect(booking.allergies).toEqual(specialAllergies);
    expect(booking.specialRequests).toBe(sqlInjectionRequest);

    // Tracking lookup succeeds without unhandled evaluation errors
    const tracking = sim.getGuestTracking(booking.publicToken);
    expect(tracking.id).toBe(booking.id);
  });

  it('handles Unicode, Emoji, and multi-lingual inputs without corruption', () => {
    const sim = new NexoraPlatformSimulator();
    const venueId = 'venue-in-001';
    const startsAt = 1759431600000;

    const unicodeName = 'रोहन शर्मा 🌟 (Rohan Sharma)';
    const unicodeRequests = 'शाकाहारी भोजन केवल (Pure Vegetarian Only) 🌱🍷';

    const booking = sim.createReservation({
      venueId,
      guestId: 'guest-unicode-2',
      guestName: unicodeName,
      guestPhone: '+919999888877',
      partySize: 4,
      serviceDate: '2026-10-02',
      startsAtMs: startsAt,
      specialRequests: unicodeRequests,
    });

    expect(booking.guestName).toBe(unicodeName);
    expect(booking.specialRequests).toBe(unicodeRequests);
  });

  it('rejects out-of-order and contradictory state events', () => {
    const serviceDate = '2026-10-02' as any;
    const startsAtMs = 1759431600000;

    // Completed reservation cannot be marked late or arrived
    expect(() =>
      applyReservationEvent(
        { status: 'completed', startsAtMs, serviceDate },
        'mark_late',
        { nowMs: startsAtMs + 3600_000, actor: 'system' }
      )
    ).toThrow();

    // Seated reservation cannot be marked as no-show
    expect(() =>
      applyReservationEvent(
        { status: 'seated', startsAtMs, serviceDate },
        'mark_no_show',
        { nowMs: startsAtMs + 3600_000, actor: 'staff' }
      )
    ).toThrow();
  });

  it('handles extreme monetary values without overflow', () => {
    // 1 billion dollars in cents = 100,000,000,000 cents (safe JS integer)
    const largeAmountCents = 100_000_000_000;
    const formattedUsd = formatMoney(largeAmountCents, 'USD');
    expect(formattedUsd).toBe('$1,000,000,000.00');

    // 100 crore rupees in paise = 10,00,00,00,000 paise
    const largeAmountPaise = 10_000_000_000;
    const formattedInr = formatMoney(largeAmountPaise, 'INR');
    expect(formattedInr).toBe('₹10,00,00,000');
  });
});
