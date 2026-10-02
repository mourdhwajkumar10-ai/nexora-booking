import { describe, expect, it } from 'vitest';
import {
  addDays,
  dayOfWeek,
  diffDays,
  formatMinute,
  isValidTimeZone,
  localToInstant,
  minuteOffsetFrom,
  parseIsoDate,
  serviceDateFor,
  toLocalParts,
} from '../src/time.ts';

const NY = 'America/New_York';

describe('BR-02 localToInstant', () => {
  it('converts a summer evening (EDT, UTC-4)', () => {
    expect(localToInstant('2026-06-15', 19 * 60, NY).toISOString()).toBe('2026-06-15T23:00:00.000Z');
  });
  it('handles after-midnight offsets (>= 1440) on the next calendar day', () => {
    expect(localToInstant('2026-06-15', 1530, NY).toISOString()).toBe('2026-06-16T05:30:00.000Z');
  });
  it('shifts a non-existent spring-forward time forward by the gap', () => {
    expect(localToInstant('2026-03-08', 150, NY).toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });
  it('returns the earlier instant for an ambiguous fall-back time', () => {
    expect(localToInstant('2026-11-01', 90, NY).toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });
  it('handles PST and zones without DST', () => {
    expect(localToInstant('2026-12-24', 18 * 60, 'America/Los_Angeles').toISOString()).toBe('2026-12-25T02:00:00.000Z');
    expect(localToInstant('2026-07-01', 12 * 60, 'America/Phoenix').toISOString()).toBe('2026-07-01T19:00:00.000Z');
  });
  it('rejects negative or fractional minutes', () => {
    expect(() => localToInstant('2026-06-15', -1, NY)).toThrow('Invalid minuteOfDay');
    expect(() => localToInstant('2026-06-15', 10.5, NY)).toThrow('Invalid minuteOfDay');
  });
});

describe('BR-02 service dates', () => {
  it('assigns times before the 04:00 cutoff to the previous service date', () => {
    expect(serviceDateFor(Date.parse('2026-06-16T05:30:00Z'), NY)).toBe('2026-06-15');
    expect(serviceDateFor(Date.parse('2026-06-16T08:30:00Z'), NY)).toBe('2026-06-16');
  });
  it('computes wall-clock offsets relative to a service date', () => {
    expect(minuteOffsetFrom('2026-06-15', Date.parse('2026-06-16T05:30:00Z'), NY)).toBe(1530);
  });
  it('returns local parts', () => {
    expect(toLocalParts(Date.parse('2026-06-15T23:00:00Z'), NY)).toEqual({
      date: '2026-06-15',
      minuteOfDay: 1140,
      second: 0,
      dayOfWeek: 1,
      month: 6,
    });
  });
});

describe('calendar helpers', () => {
  it('adds and diffs days across month ends and leap years', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(diffDays('2026-03-01', '2026-02-28')).toBe(1);
    expect(dayOfWeek('2026-06-15')).toBe(1);
  });
  it('rejects impossible dates', () => {
    expect(() => parseIsoDate('2026-02-30')).toThrow('Invalid ISO date');
    expect(() => parseIsoDate('2026-6-1')).toThrow('Invalid ISO date');
  });
  it('formats minutes and validates zones', () => {
    expect(formatMinute(1530)).toBe('01:30');
    expect(formatMinute(1140)).toBe('19:00');
    expect(isValidTimeZone('America/Chicago')).toBe(true);
    expect(isValidTimeZone('Mars/Base')).toBe(false);
  });
});
