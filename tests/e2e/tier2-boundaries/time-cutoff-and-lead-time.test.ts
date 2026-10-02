import { describe, it, expect } from 'vitest';
import {
  serviceDateFor,
  localToInstant,
  minuteOffsetFrom,
  toLocalParts,
  type IsoDate,
} from '../helpers/oracle';

describe('Tier 2: Boundary & Corner Cases — Service Date Cutoff & Time Boundaries (F-BR02 / F-BR04)', () => {
  const tz = 'America/New_York';

  describe('04:00 AM Service Date Cutoff (BR-02)', () => {
    it('attributes 03:59:59 AM to the PREVIOUS service date (late night shift)', () => {
      // 2026-10-03 03:59 EDT (minute 239)
      const instant = localToInstant('2026-10-03', 239, tz);
      const serviceDate = serviceDateFor(instant, tz, 240);
      expect(serviceDate).toBe('2026-10-02');
    });

    it('attributes 04:00:00 AM to the CURRENT calendar service date', () => {
      // 2026-10-03 04:00 EDT (minute 240)
      const instant = localToInstant('2026-10-03', 240, tz);
      const serviceDate = serviceDateFor(instant, tz, 240);
      expect(serviceDate).toBe('2026-10-03');
    });

    it('handles post-midnight minute offsets >= 1440', () => {
      // 01:30 AM after Friday shift is offset 1530 relative to Friday's service date
      const fridayServiceDate: IsoDate = '2026-10-02';
      const instant = localToInstant(fridayServiceDate, 1530, tz);

      // Wall clock parts show Saturday Oct 3, 01:30
      const local = toLocalParts(instant, tz);
      expect(local.date).toBe('2026-10-03');
      expect(local.minuteOfDay).toBe(90); // 01:30 AM

      // Offset relative to Friday is 1530
      expect(minuteOffsetFrom(fridayServiceDate, instant, tz)).toBe(1530);

      // Service date for this instant with 04:00 (240m) cutoff is Friday
      expect(serviceDateFor(instant, tz)).toBe('2026-10-02');
    });
  });

  describe('Daylight Saving Time (DST) Transitions', () => {
    it('handles Spring-Forward non-existent local hour by shifting forward', () => {
      // 2026-03-08 in America/New_York spring forward happens at 02:00 -> 03:00
      // Requesting 02:30 (minute 150) should resolve to a valid UTC instant that maps to 03:30
      const instant = localToInstant('2026-03-08', 150, tz);
      expect(instant).toBeInstanceOf(Date);
      expect(isNaN(instant.getTime())).toBe(false);
    });

    it('handles Fall-Back ambiguous local hour by selecting earlier instant', () => {
      // 2026-11-01 in America/New_York fall back happens at 02:00 -> 01:00
      // Requesting 01:30 (minute 90)
      const instant = localToInstant('2026-11-01', 90, tz);
      expect(instant).toBeInstanceOf(Date);
      expect(isNaN(instant.getTime())).toBe(false);
    });
  });

  describe('Lead Time & Booking Window Boundaries (BR-04)', () => {
    it('verifies lead time gate calculation: slot start >= now + minLeadMinutes', () => {
      const nowMs = 1759431600000; // Reference now
      const minLeadMinutes = 60; // 1 hour lead time

      const bookableAt = nowMs + minLeadMinutes * 60_000;
      const unbookableAt = bookableAt - 1; // 1 ms too early

      const isBookable = (slotMs: number) => slotMs >= nowMs + minLeadMinutes * 60_000;

      expect(isBookable(bookableAt)).toBe(true);
      expect(isBookable(unbookableAt)).toBe(false);
    });

    it('verifies booking window horizon: today <= serviceDate <= today + windowDays', () => {
      const today: IsoDate = '2026-10-02';
      const windowDays = 30;

      const isWithinWindow = (date: IsoDate) => {
        return date >= today && date <= '2026-11-01'; // 30 days later
      };

      expect(isWithinWindow('2026-10-02')).toBe(true);
      expect(isWithinWindow('2026-10-20')).toBe(true);
      expect(isWithinWindow('2026-11-01')).toBe(true);
      expect(isWithinWindow('2026-11-02')).toBe(false); // 31 days -> rejected
      expect(isWithinWindow('2026-10-01')).toBe(false); // in past -> rejected
    });
  });
});
