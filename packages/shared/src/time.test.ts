import { describe, expect, it } from 'vitest';
import { dwellLevel, generateSlots, maxIntervalsPerShift, overlaps, validateRequestedSlot, zonedToUtc } from './time';
import { bestFitOrder } from './allocation';
import { canTransition, RESERVATION_TRANSITIONS, ORDER_TRANSITIONS } from './fsm';
import { computeTier, pointsForSpend, clawbackPoints } from './loyalty';

const TZ = 'Asia/Kolkata';
// 2026-10-02 is a Friday (dow 5)
const shifts = [{ dayOfWeek: 5, openTime: '12:00', closeTime: '15:00' }, { dayOfWeek: 5, openTime: '19:00', closeTime: '23:00' }];

describe('time math', () => {
  it('converts venue-local to UTC', () => {
    expect(zonedToUtc('2026-10-02', '19:00', TZ).toISOString()).toBe('2026-10-02T13:30:00.000Z');
  });
  it('N_max = floor((close-open)/turn)', () => {
    expect(maxIntervalsPerShift('19:00', '23:00', 30)).toBe(8);
    expect(maxIntervalsPerShift('22:00', '02:00', 30)).toBe(8); // crosses midnight
  });
  it('generates 15-min slots with last slot = close - turnaround', () => {
    const slots = generateSlots('2026-10-02', shifts, 30, TZ).map((s) => s.time);
    expect(slots[0]).toBe('12:00');
    expect(slots).toContain('14:30');
    expect(slots).not.toContain('14:45');
    expect(slots.at(-1)).toBe('22:30');
    expect(slots.filter((s) => s.startsWith('19') || s.startsWith('2')).length).toBe(15);
  });
  it('rejects outside hours and off-grid', () => {
    expect(validateRequestedSlot('2026-10-02', '11:45', shifts, 30, TZ)).toEqual({ ok: false, reason: 'OUTSIDE_HOURS' });
    expect(validateRequestedSlot('2026-10-02', '22:45', shifts, 30, TZ)).toEqual({ ok: false, reason: 'OUTSIDE_HOURS' });
    expect(validateRequestedSlot('2026-10-02', '19:10', shifts, 30, TZ)).toEqual({ ok: false, reason: 'OFF_GRID' });
    expect(validateRequestedSlot('2026-10-03', '19:00', shifts, 30, TZ)).toEqual({ ok: false, reason: 'OUTSIDE_HOURS' });
    expect(validateRequestedSlot('2026-10-02', '19:00', shifts, 30, TZ).ok).toBe(true);
  });
  it('overlap is strict (touching intervals do not conflict)', () => {
    const a = { start: new Date('2026-01-01T10:00Z'), end: new Date('2026-01-01T10:30Z') };
    expect(overlaps(a, { start: new Date('2026-01-01T10:30Z'), end: new Date('2026-01-01T11:00Z') })).toBe(false);
    expect(overlaps(a, { start: new Date('2026-01-01T10:15Z'), end: new Date('2026-01-01T10:45Z') })).toBe(true);
  });
  it('dwell levels amber at 30m, red at 45m', () => {
    expect(dwellLevel(29 * 60 + 59, 30)).toBe('normal');
    expect(dwellLevel(30 * 60, 30)).toBe('amber');
    expect(dwellLevel(45 * 60, 30)).toBe('red');
  });
});

describe('best fit', () => {
  const tables = [
    { id: 'a', tableNumber: 'T-4', minCapacity: 2, maxCapacity: 4 },
    { id: 'b', tableNumber: 'T-2', minCapacity: 1, maxCapacity: 2 },
    { id: 'c', tableNumber: 'T-10', minCapacity: 1, maxCapacity: 2 },
  ];
  it('party of 2 prefers 2-tops, ordered naturally', () => {
    expect(bestFitOrder(tables, 2).map((t) => t.id)).toEqual(['b', 'c', 'a']);
  });
  it('no upsize fallback keeps only best capacity', () => {
    expect(bestFitOrder(tables, 2, false).map((t) => t.id)).toEqual(['b', 'c']);
  });
  it('party of 3 only fits 4-tops', () => {
    expect(bestFitOrder(tables, 3).map((t) => t.id)).toEqual(['a']);
  });
});

describe('fsm', () => {
  it('reservation transitions', () => {
    expect(canTransition(RESERVATION_TRANSITIONS, 'REQUESTED', 'CONFIRMED')).toBe(true);
    expect(canTransition(RESERVATION_TRANSITIONS, 'REQUESTED', 'SEATED')).toBe(false);
    expect(canTransition(RESERVATION_TRANSITIONS, 'COMPLETED', 'CANCELLED')).toBe(false);
  });
  it('order transitions', () => {
    expect(canTransition(ORDER_TRANSITIONS, 'SERVED', 'BILLED')).toBe(true);
    expect(canTransition(ORDER_TRANSITIONS, 'PLACED', 'SERVED')).toBe(false);
  });
});

describe('loyalty', () => {
  it('points by tier multiplier', () => {
    expect(pointsForSpend(20_000_00, 'REGULAR')).toBe(100_000);
    expect(clawbackPoints(10_000_00, 'REGULAR')).toBe(50_000);
  });
  it('preload unlocks tier immediately', () => {
    expect(computeTier('BASE', 0, 25_000_00)).toBe('MEMBER');
    expect(computeTier('BASE', 5_00_000_00)).toBe('REGULAR');
    expect(computeTier('REGULAR', 0)).toBe('REGULAR');
  });
});
