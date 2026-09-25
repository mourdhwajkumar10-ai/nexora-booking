import { describe, expect, it } from 'vitest';
import { findShiftOverlap, hoursForToday, isOpenAt } from '../src/modules/venues/hours';

const TZ = 'Asia/Kolkata';
const at = (istLocal: string) => new Date(`${istLocal}+05:30`);

describe('venue hours (pure)', () => {
  const lunchDinner = [
    { dayOfWeek: 5, openTime: '12:00', closeTime: '15:00' },
    { dayOfWeek: 5, openTime: '19:00', closeTime: '23:00' },
  ];

  it('is open inside a shift and closed in the gap / at close', () => {
    expect(isOpenAt(lunchDinner, TZ, at('2026-10-02T12:00:00'))).toBe(true);
    expect(isOpenAt(lunchDinner, TZ, at('2026-10-02T16:00:00'))).toBe(false);
    expect(isOpenAt(lunchDinner, TZ, at('2026-10-02T23:00:00'))).toBe(false); // [open, close)
    expect(isOpenAt(lunchDinner, TZ, at('2026-10-09T13:00:00'))).toBe(true); // next Friday
    expect(isOpenAt(lunchDinner, TZ, at('2026-10-03T13:00:00'))).toBe(false); // Saturday
  });

  it('keeps a Saturday late shift open into Sunday morning (week wrap)', () => {
    const late = [{ dayOfWeek: 6, openTime: '18:00', closeTime: '01:00' }];
    expect(isOpenAt(late, TZ, at('2026-10-04T00:30:00'))).toBe(true); // Sun 00:30
    expect(isOpenAt(late, TZ, at('2026-10-04T01:00:00'))).toBe(false);
    expect(isOpenAt(late, TZ, at('2026-10-03T17:59:00'))).toBe(false);
  });

  it('todayHours lists the local weekday shifts in order', () => {
    const shifts = [...lunchDinner].reverse();
    expect(hoursForToday(shifts, TZ, new Date('2026-10-02T12:30:00Z'))).toEqual([
      { openTime: '12:00', closeTime: '15:00' },
      { openTime: '19:00', closeTime: '23:00' },
    ]);
    // 2026-10-02T19:00Z is already Saturday 00:30 in IST
    expect(hoursForToday(shifts, TZ, new Date('2026-10-02T19:00:00Z'))).toEqual([]);
  });

  it('detects overlaps, including cross-midnight spans; touching is fine', () => {
    expect(findShiftOverlap(lunchDinner)).toBeNull();
    expect(findShiftOverlap([{ dayOfWeek: 1, openTime: '12:00', closeTime: '15:00' }, { dayOfWeek: 1, openTime: '15:00', closeTime: '18:00' }])).toBeNull();
    expect(findShiftOverlap([{ dayOfWeek: 1, openTime: '12:00', closeTime: '15:00' }, { dayOfWeek: 1, openTime: '12:00', closeTime: '15:00' }])).not.toBeNull();
    expect(findShiftOverlap([{ dayOfWeek: 1, openTime: '20:00', closeTime: '02:00' }, { dayOfWeek: 1, openTime: '10:00', closeTime: '21:00' }])).not.toBeNull();
    expect(findShiftOverlap([{ dayOfWeek: 1, openTime: '20:00', closeTime: '02:00' }, { dayOfWeek: 2, openTime: '01:30', closeTime: '03:00' }])).not.toBeNull();
    expect(findShiftOverlap([{ dayOfWeek: 0, openTime: '00:30', closeTime: '03:00' }, { dayOfWeek: 6, openTime: '22:00', closeTime: '01:00' }])).not.toBeNull();
  });
});
