import { describe, expect, it } from 'vitest';
import {
  applyBps,
  assertCents,
  assertPaise,
  formatInr,
  formatMoney,
  formatUsd,
  lineGrossCents,
  lineGrossPaise,
  parseDollars,
  parseMoney,
  parseRupees,
  roundHalfAwayFromZero,
} from '../src/money.ts';
import {
  ACTIVE_RESERVATION_STATUSES,
  RESERVATION_STATUSES,
  TERMINAL_RESERVATION_STATUSES,
  toLowerReservationStatus,
  toUpperReservationStatus,
} from '../src/constants.ts';
import {
  assertTransition,
  canTransition,
  IllegalTransitionError,
  RESERVATION_TRANSITIONS,
} from '../src/fsm.ts';
import {
  applyEvent,
  bookingModeFor,
  confirmNoShow,
  nextStatus,
  type ReservationSnapshot,
  type TransitionContext,
} from '../src/reservation.ts';
import {
  allocateBestFit,
  computeAvailability,
  nearestAlternatives,
  occupancyFor,
  slotMinutes,
  type AvailabilityQuery,
  type TableInput,
  type CombinationInput,
} from '../src/availability.ts';
import {
  bestFitOrder,
  type AllocatableTable,
} from '../src/allocation.ts';
import {
  resolveTurnMinutes,
  validateTurnRules,
  type TurnRule,
} from '../src/turn.ts';
import {
  floorTransition,
  tableFreeAt,
  timerState,
  upcomingBadge,
} from '../src/floor.ts';

describe('Adversarial Challenge 1: Currency Math Edge Cases (money.ts)', () => {
  it('handles zero values across all parse and format functions', () => {
    expect(parseDollars('0')).toBe(0);
    expect(parseDollars('0.0')).toBe(0);
    expect(parseDollars('0.00')).toBe(0);
    expect(parseDollars('-0')).toBe(-0);
    expect(parseDollars('-0.00')).toBe(-0);
    expect(parseRupees('0')).toBe(0);
    expect(parseRupees('₹0')).toBe(0);
    expect(parseRupees('₹ 0.00')).toBe(0);
    expect(parseMoney('0', 'USD')).toBe(0);
    expect(parseMoney('$0.00', 'USD')).toBe(0);
    expect(parseMoney('0', 'INR')).toBe(0);
    expect(parseMoney('₹0', 'INR')).toBe(0);

    expect(formatUsd(0)).toBe('$0.00');
    expect(formatInr(0)).toBe('₹0');
    expect(formatInr(0, { showPaise: true })).toBe('₹0.00');
    expect(formatMoney(0, 'USD')).toBe('$0.00');
    expect(formatMoney(0, 'INR')).toBe('₹0');
  });

  it('handles negative currency values correctly', () => {
    expect(parseDollars('-12.34')).toBe(-1234);
    expect(parseDollars('-0.05')).toBe(-5);
    expect(parseRupees('-50.25')).toBe(-5025);
    expect(parseRupees('₹-50.25')).toBe(-5025);

    expect(formatUsd(-1234)).toBe('-$12.34');
    expect(formatUsd(-5)).toBe('-$0.05');
    expect(formatUsd(-100)).toBe('-$1.00');

    expect(formatInr(-5025)).toBe('-₹50.25');
    expect(formatInr(-5)).toBe('-₹0.05');
    expect(formatInr(-100)).toBe('-₹1');
    expect(formatInr(-100, { showPaise: true })).toBe('-₹1.00');

    expect(formatMoney(-5000, 'USD')).toBe('-$50.00');
    expect(formatMoney(-5000, 'INR')).toBe('-₹50');
  });

  it('handles extreme integer values up to Postgres integer bounds and safe integer bounds', () => {
    const PG_INT_MAX = 2_147_483_647; // 21,474,836.47
    const PG_INT_MIN = -2_147_483_648; // -21,474,836.48

    expect(assertCents(PG_INT_MAX)).toBe(PG_INT_MAX);
    expect(assertPaise(PG_INT_MAX)).toBe(PG_INT_MAX);
    expect(assertCents(PG_INT_MIN)).toBe(PG_INT_MIN);

    expect(formatUsd(PG_INT_MAX)).toBe('$21,474,836.47');
    expect(formatUsd(PG_INT_MIN)).toBe('-$21,474,836.48');

    // Indian numbering format check: 2,14,74,836.47 (crores/lakhs)
    const inrFormatted = formatInr(PG_INT_MAX);
    expect(inrFormatted).toContain('₹');
    expect(inrFormatted).toContain('47');

    // Safe integer boundaries
    expect(() => assertCents(Number.MAX_SAFE_INTEGER + 1)).toThrow('must be an integer number of cents');
    expect(() => assertCents(12.34)).toThrow('must be an integer number of cents');
    expect(() => assertCents(NaN)).toThrow('must be an integer number of cents');
    expect(() => assertCents(Infinity)).toThrow('must be an integer number of cents');
  });

  it('rigorously tests roundHalfAwayFromZero on half-way tie boundaries', () => {
    expect(roundHalfAwayFromZero(0)).toBe(0);
    expect(roundHalfAwayFromZero(0.499999)).toBe(0);
    expect(roundHalfAwayFromZero(0.5)).toBe(1);
    expect(roundHalfAwayFromZero(1.5)).toBe(2);
    expect(roundHalfAwayFromZero(2.5)).toBe(3);

    expect(roundHalfAwayFromZero(-0.499999)).toBe(-0);
    expect(roundHalfAwayFromZero(-0.5)).toBe(-1);
    expect(roundHalfAwayFromZero(-1.5)).toBe(-2);
    expect(roundHalfAwayFromZero(-2.5)).toBe(-3);
  });

  it('tests applyBps with exact boundary and fractional rounding values', () => {
    // 0 bps
    expect(applyBps(10000, 0)).toBe(0);
    // 100% = 10,000 bps
    expect(applyBps(12345, 10_000)).toBe(12345);
    expect(applyBps(-12345, 10_000)).toBe(-12345);

    // Half-way boundaries: 5000 bps = 50%
    // 1 cent * 50% = 0.5 cents -> 1
    expect(applyBps(1, 5000)).toBe(1);
    // -1 cent * 50% = -0.5 cents -> -1
    expect(applyBps(-1, 5000)).toBe(-1);

    // 3 cents * 50% = 1.5 cents -> 2
    expect(applyBps(3, 5000)).toBe(2);
    expect(applyBps(-3, 5000)).toBe(-2);

    // Strict boundary checks
    // 1 cent * 4999 bps = 0.4999 -> rounds to 0
    expect(applyBps(1, 4999)).toBe(0);
    // 1 cent * 5001 bps = 0.5001 -> rounds to 1
    expect(applyBps(1, 5001)).toBe(1);

    // -1 cent * 4999 bps = -0.4999 -> rounds to -0
    expect(Math.abs(applyBps(-1, 4999))).toBe(0);
    // -1 cent * 5001 bps = -0.5001 -> rounds to -1
    expect(applyBps(-1, 5001)).toBe(-1);
  });

  it('rejects malformed currency input strings and tests symbol placement', () => {
    expect(() => parseDollars('abc')).toThrow('Invalid dollar amount');
    expect(() => parseDollars('')).toThrow('Invalid dollar amount');
    expect(() => parseDollars('.50')).toThrow('Invalid dollar amount');
    expect(() => parseDollars('10.')).toThrow('Invalid dollar amount');
    expect(() => parseDollars('10.123')).toThrow('Invalid dollar amount');
    expect(() => parseDollars('10.0.0')).toThrow('Invalid dollar amount');

    expect(() => parseRupees('abc')).toThrow('Invalid rupee amount');
    expect(() => parseRupees('')).toThrow('Invalid rupee amount');
    expect(() => parseRupees('10.123')).toThrow('Invalid rupee amount');

    expect(() => parseMoney('10', 'EUR' as any)).toThrow('Unsupported currency');

    // Negative currency with symbol placement:
    // parseMoney handles '$-5.00' and '₹-50.00'
    expect(parseMoney('$-5.00', 'USD')).toBe(-500);
    expect(parseMoney('₹-50.00', 'INR')).toBe(-5000);
    // Note: '-$5.00' or '-₹50.00' where '-' precedes currency symbol is rejected because
    // regex expects sign immediately before digits
    expect(() => parseMoney('-$5.00', 'USD')).toThrow('Invalid dollar amount');
    expect(() => parseMoney('-₹50.00', 'INR')).toThrow('Invalid rupee amount');
  });

  it('multiplies line items with lineGrossCents and lineGrossPaise', () => {
    expect(lineGrossCents(2, 500)).toBe(1000);
    expect(lineGrossCents(1.5, 1299)).toBe(1949); // 1.5 * 1299 = 1948.5 -> 1949
    expect(lineGrossCents(0.333, 3000)).toBe(999); // 0.333 * 3000 = 999
    expect(lineGrossPaise(2.5, 200)).toBe(500);
  });
});

describe('Adversarial Challenge 2: 8-State FSM Transitions & Normalization', () => {
  it('confirms the canonical 8 states in constants and lists', () => {
    expect(RESERVATION_STATUSES).toEqual([
      'REQUESTED',
      'CONFIRMED',
      'ARRIVED',
      'SEATED',
      'LATE',
      'COMPLETED',
      'CANCELLED',
      'NO_SHOW',
    ]);
    expect(ACTIVE_RESERVATION_STATUSES).toEqual([
      'REQUESTED',
      'CONFIRMED',
      'ARRIVED',
      'SEATED',
      'LATE',
    ]);
    expect(TERMINAL_RESERVATION_STATUSES).toEqual([
      'COMPLETED',
      'CANCELLED',
      'NO_SHOW',
    ]);
  });

  it('normalizes uppercase and lowercase reservation statuses and rejects unknown strings', () => {
    for (const status of RESERVATION_STATUSES) {
      expect(toUpperReservationStatus(status.toLowerCase())).toBe(status);
      expect(toUpperReservationStatus(status)).toBe(status);
      expect(toLowerReservationStatus(status)).toBe(status.toLowerCase());
    }

    expect(toUpperReservationStatus('ArRiVeD')).toBe('ARRIVED');
    expect(toUpperReservationStatus('no_show')).toBe('NO_SHOW');

    expect(() => toUpperReservationStatus('UNKNOWN_STATUS')).toThrow('Invalid reservation status: UNKNOWN_STATUS');
    expect(() => toUpperReservationStatus('')).toThrow('Invalid reservation status: ');
    expect(() => toUpperReservationStatus('PENDING')).toThrow('Invalid reservation status: PENDING');
  });

  it('exhaustively tests valid and invalid transitions in RESERVATION_TRANSITIONS', () => {
    // Valid transitions
    expect(canTransition(RESERVATION_TRANSITIONS, 'REQUESTED', 'CONFIRMED')).toBe(true);
    expect(canTransition(RESERVATION_TRANSITIONS, 'REQUESTED', 'CANCELLED')).toBe(true);

    expect(canTransition(RESERVATION_TRANSITIONS, 'CONFIRMED', 'ARRIVED')).toBe(true);
    expect(canTransition(RESERVATION_TRANSITIONS, 'CONFIRMED', 'SEATED')).toBe(true);
    expect(canTransition(RESERVATION_TRANSITIONS, 'CONFIRMED', 'LATE')).toBe(true);
    expect(canTransition(RESERVATION_TRANSITIONS, 'CONFIRMED', 'CANCELLED')).toBe(true);
    expect(canTransition(RESERVATION_TRANSITIONS, 'CONFIRMED', 'NO_SHOW')).toBe(true);

    expect(canTransition(RESERVATION_TRANSITIONS, 'ARRIVED', 'SEATED')).toBe(true);
    expect(canTransition(RESERVATION_TRANSITIONS, 'ARRIVED', 'CANCELLED')).toBe(true);

    expect(canTransition(RESERVATION_TRANSITIONS, 'LATE', 'ARRIVED')).toBe(true);
    expect(canTransition(RESERVATION_TRANSITIONS, 'LATE', 'SEATED')).toBe(true);
    expect(canTransition(RESERVATION_TRANSITIONS, 'LATE', 'CANCELLED')).toBe(true);
    expect(canTransition(RESERVATION_TRANSITIONS, 'LATE', 'NO_SHOW')).toBe(true);

    expect(canTransition(RESERVATION_TRANSITIONS, 'SEATED', 'COMPLETED')).toBe(true);

    // Invalid transitions
    expect(canTransition(RESERVATION_TRANSITIONS, 'REQUESTED', 'SEATED')).toBe(false);
    expect(canTransition(RESERVATION_TRANSITIONS, 'REQUESTED', 'ARRIVED')).toBe(false);
    expect(canTransition(RESERVATION_TRANSITIONS, 'REQUESTED', 'COMPLETED')).toBe(false);

    expect(canTransition(RESERVATION_TRANSITIONS, 'SEATED', 'CANCELLED')).toBe(false);
    expect(canTransition(RESERVATION_TRANSITIONS, 'SEATED', 'ARRIVED')).toBe(false);
    expect(canTransition(RESERVATION_TRANSITIONS, 'SEATED', 'NO_SHOW')).toBe(false);

    // Terminal states cannot transition to anything
    for (const term of ['COMPLETED', 'CANCELLED', 'NO_SHOW'] as const) {
      for (const target of RESERVATION_STATUSES) {
        expect(canTransition(RESERVATION_TRANSITIONS, term, target)).toBe(false);
      }
    }

    // assertTransition throws IllegalTransitionError on invalid transition
    expect(() => assertTransition('reservation', RESERVATION_TRANSITIONS, 'COMPLETED', 'CONFIRMED'))
      .toThrow(IllegalTransitionError);
    expect(() => assertTransition('reservation', RESERVATION_TRANSITIONS, 'SEATED', 'CANCELLED'))
      .toThrow(IllegalTransitionError);
  });

  it('tests lifecycle event state changes and timing guards in reservation.ts', () => {
    const at = (iso: string) => Date.parse(iso);
    const START = at('2026-06-15T20:00:00Z');
    const baseSnap: ReservationSnapshot = {
      status: 'confirmed',
      startsAtMs: START,
      serviceDate: '2026-06-15',
      arrivedAtMs: null,
      noShowConfirmedAtMs: null,
    };
    const baseCtx: TransitionContext = {
      nowMs: START - 30 * 60_000,
      actor: 'staff',
      todayServiceDate: '2026-06-15',
      lateCancelWindowHours: 2,
    };

    // Arrive
    const arr = applyEvent(baseSnap, 'arrive', baseCtx);
    expect(arr.ok && arr.to).toBe('arrived');

    // Late
    const late = applyEvent(baseSnap, 'mark_late', { ...baseCtx, nowMs: START + 16 * 60_000 });
    expect(late.ok && late.to).toBe('late');

    // Late to Arrive
    const lateSnap: ReservationSnapshot = { ...baseSnap, status: 'late' };
    const lateToArr = applyEvent(lateSnap, 'arrive', { ...baseCtx, nowMs: START + 20 * 60_000 });
    expect(lateToArr.ok && lateToArr.to).toBe('arrived');

    // Arrived to Seated
    const arrSnap: ReservationSnapshot = { ...baseSnap, status: 'arrived', arrivedAtMs: START + 20 * 60_000 };
    const arrToSeat = applyEvent(arrSnap, 'seat', { ...baseCtx, nowMs: START + 25 * 60_000 });
    expect(arrToSeat.ok && arrToSeat.to).toBe('seated');
    expect(arrToSeat.ok && arrToSeat.patch.seatedAt).toBe(START + 25 * 60_000);
    expect(arrToSeat.ok && arrToSeat.patch.arrivedAt).toBe(START + 20 * 60_000);

    // Seated to Completed
    const seatedSnap: ReservationSnapshot = { ...baseSnap, status: 'seated' };
    const comp = applyEvent(seatedSnap, 'complete', { ...baseCtx, nowMs: START + 90 * 60_000 });
    expect(comp.ok && comp.to).toBe('completed');

    // Terminal state cannot be cancelled or seated
    const compSnap: ReservationSnapshot = { ...baseSnap, status: 'completed' };
    expect(applyEvent(compSnap, 'seat', baseCtx)).toEqual({ ok: false, error: 'INVALID_TRANSITION' });
    expect(applyEvent(compSnap, 'cancel_venue', baseCtx)).toEqual({ ok: false, error: 'INVALID_TRANSITION' });

    // Mark No-Show timing guard: cannot mark no-show before startsAt
    expect(applyEvent(baseSnap, 'mark_no_show', { ...baseCtx, nowMs: START - 1 })).toEqual({
      ok: false,
      error: 'TOO_EARLY_FOR_NO_SHOW',
    });
    // Can mark no-show at or after startsAt
    const ns = applyEvent(baseSnap, 'mark_no_show', { ...baseCtx, nowMs: START });
    expect(ns.ok && ns.to).toBe('no_show');
  });
});

describe('Adversarial Challenge 3: Availability & Table Allocation Capacity Limits', () => {
  const table = (id: string, min: number, max: number, extra: Partial<TableInput> = {}): TableInput => ({
    id,
    label: id.toUpperCase(),
    minCovers: min,
    maxCovers: max,
    diningAreaId: 'main',
    areaSortOrder: 0,
    active: true,
    onlineBookable: true,
    ...extra,
  });

  const TABLES: TableInput[] = [
    table('t1', 1, 2),
    table('t2', 1, 2),
    table('t3', 2, 4),
    table('t4', 3, 4, { onlineBookable: false }),
    table('t5', 2, 4),
    table('t6', 2, 4),
    table('b1', 1, 2, { diningAreaId: 'bar', areaSortOrder: 1 }),
  ];

  const COMBOS: CombinationInput[] = [
    { id: 'c56', name: 'T5+T6', minCovers: 5, maxCovers: 8, tableIds: ['t5', 't6'], active: true },
  ];

  const RULES: TurnRule[] = [
    { id: 'r1', partyMin: 1, partyMax: 2, daypart: null, diningAreaId: null, minutes: 75 },
    { id: 'r2', partyMin: 3, partyMax: 4, daypart: null, diningAreaId: null, minutes: 90 },
    { id: 'r3', partyMin: 5, partyMax: 50, daypart: null, diningAreaId: null, minutes: 120 },
  ];

  const makeQuery = (over: Partial<AvailabilityQuery> = {}): AvailabilityQuery => ({
    serviceDate: '2026-06-15',
    timeZone: 'America/New_York',
    period: { id: 'dinner', daypart: 'dinner', openMinute: 1020, lastSeatingMinute: 1260, closeMinute: 1380 },
    slotIntervalMinutes: 15,
    partySize: 2,
    channel: 'public',
    nowMs: Date.parse('2026-06-15T12:00:00Z'),
    minLeadMinutes: 30,
    resetMinutes: 10,
    turnRules: RULES,
    defaultTurnMinutes: 90,
    diningAreaId: null,
    tables: TABLES,
    combinations: COMBOS,
    occupancies: [],
    maxCoversPerSlot: null,
    pacingBookings: [],
    closed: false,
    ...over,
  });

  it('handles zero and negative party size safely', () => {
    // Party size 0: no table has minCovers <= 0
    const q0 = makeQuery({ partySize: 0 });
    const unit0 = allocateBestFit(q0, Date.parse('2026-06-15T21:00:00Z'));
    expect(unit0).toBeNull();

    const slots0 = computeAvailability(q0);
    expect(slots0.every((s) => !s.available && s.reason === 'no_table')).toBe(true);

    // Negative party size
    const qNeg = makeQuery({ partySize: -5 });
    const unitNeg = allocateBestFit(qNeg, Date.parse('2026-06-15T21:00:00Z'));
    expect(unitNeg).toBeNull();
  });

  it('handles party size exceeding combined maximum capacity safely', () => {
    // Max single table is 4, max combination is 8
    // Party size 9 exceeds all units
    const q9 = makeQuery({ partySize: 9 });
    const unit9 = allocateBestFit(q9, Date.parse('2026-06-15T21:00:00Z'));
    expect(unit9).toBeNull();

    const slots9 = computeAvailability(q9);
    expect(slots9.every((s) => !s.available && s.reason === 'no_table')).toBe(true);

    // Party size 100
    const q100 = makeQuery({ partySize: 100 });
    expect(allocateBestFit(q100, Date.parse('2026-06-15T21:00:00Z'))).toBeNull();
  });

  it('deterministically breaks ties when two units have identical capacity and area', () => {
    // Table t1 (T1) and t2 (T2) both have min 1, max 2, areaSortOrder 0
    // Party size 2: waste is 0 for both.
    const q = makeQuery({ partySize: 2 });
    const unit = allocateBestFit(q, Date.parse('2026-06-15T21:00:00Z'));
    expect(unit?.id).toBe('t1'); // 'T1' < 'T2' alphabetically

    // If t1 is excluded, t2 is picked
    const unit2 = allocateBestFit(q, Date.parse('2026-06-15T21:00:00Z'), ['t1']);
    expect(unit2?.id).toBe('t2');
  });

  it('prioritizes single tables over combinations when seat waste is equal', () => {
    // Suppose single table t_large has max 6, combo c_large has max 6
    const customTables: TableInput[] = [
      table('t_large', 2, 6),
      table('t_sub1', 1, 3),
      table('t_sub2', 1, 3),
    ];
    const customCombos: CombinationInput[] = [
      { id: 'c_large', name: 'ComboLarge', minCovers: 2, maxCovers: 6, tableIds: ['t_sub1', 't_sub2'], active: true },
    ];

    const q = makeQuery({
      tables: customTables,
      combinations: customCombos,
      partySize: 6,
    });

    const chosen = allocateBestFit(q, Date.parse('2026-06-15T21:00:00Z'));
    expect(chosen?.kind).toBe('table');
    expect(chosen?.id).toBe('t_large');
  });

  it('strictly validates buffer time boundaries (T_reset)', () => {
    const START = Date.parse('2026-06-15T21:00:00Z');
    // Turn is 75 mins, reset is 10 mins -> total 85 mins
    // Occupancy: [21:00, 22:25)
    const occ = [
      { tableId: 't1', startMs: START, endMs: START + 85 * 60_000 },
    ];

    const q = makeQuery({
      tables: [table('t1', 1, 2)],
      combinations: [],
      partySize: 2,
      occupancies: occ,
      diningAreaId: 'main',
    });

    // 21:00 UTC is minute 1020
    // 22:15 UTC is minute 1095
    // 22:25 UTC is 85 mins after start -> minute 1105
    // Slot at minute 1095 (22:15) starts at 22:15 < 22:25 (end of occupancy) -> unavailable
    // Slot at minute 1110 (22:30) starts at 22:30 >= 22:25 (end of occupancy) -> available
    const slots = computeAvailability(q);
    const slotAt2215 = slots.find((s) => s.minuteOfDay === 1095);
    const slotAt2230 = slots.find((s) => s.minuteOfDay === 1110);

    // At 22:15, table t1 is still occupied or bussing (endMs is 22:25)
    expect(slotAt2215?.available).toBe(false);
    expect(slotAt2215?.reason).toBe('no_table');

    // At 22:30, table t1 is free because 22:30 >= 22:25
    expect(slotAt2230?.available).toBe(true);
    expect(slotAt2230?.unit?.id).toBe('t1');
  });

  it('tests bestFitOrder in allocation.ts', () => {
    const tables: AllocatableTable[] = [
      { id: '1', tableNumber: '10', minCapacity: 2, maxCapacity: 4 },
      { id: '2', tableNumber: '2', minCapacity: 2, maxCapacity: 4 },
      { id: '3', tableNumber: '3', minCapacity: 4, maxCapacity: 6 },
    ];

    // Party of 4 fits 4-tops (differential 0) and 6-tops (differential 2)
    const orderWithUpsize = bestFitOrder(tables, 4, true);
    // Table 2 (tableNumber '2') before Table 1 (tableNumber '10') due to numeric sorting
    expect(orderWithUpsize[0].id).toBe('2');
    expect(orderWithUpsize[1].id).toBe('1');
    expect(orderWithUpsize[2].id).toBe('3');

    // Without upsize, only smallest achievable max_capacity (4)
    const orderNoUpsize = bestFitOrder(tables, 4, false);
    expect(orderNoUpsize.map((t) => t.id)).toEqual(['2', '1']);
  });

  it('tests dynamic dwell alert thresholds in floor.ts', () => {
    const seated = Date.parse('2026-06-15T18:00:00Z');

    // Turn duration: 75 minutes. Ceil(75 * 1.25) = 94 minutes.
    expect(timerState(seated, 75, seated + 74 * 60_000)).toEqual({ elapsedMinutes: 74, level: 'normal' });
    expect(timerState(seated, 75, seated + 75 * 60_000)).toEqual({ elapsedMinutes: 75, level: 'amber' });
    expect(timerState(seated, 75, seated + 93 * 60_000)).toEqual({ elapsedMinutes: 93, level: 'amber' });
    expect(timerState(seated, 75, seated + 94 * 60_000)).toEqual({ elapsedMinutes: 94, level: 'red' });

    // Turn duration: 120 minutes. Ceil(120 * 1.25) = 150 minutes.
    expect(timerState(seated, 120, seated + 119 * 60_000)).toEqual({ elapsedMinutes: 119, level: 'normal' });
    expect(timerState(seated, 120, seated + 120 * 60_000)).toEqual({ elapsedMinutes: 120, level: 'amber' });
    expect(timerState(seated, 120, seated + 149 * 60_000)).toEqual({ elapsedMinutes: 149, level: 'amber' });
    expect(timerState(seated, 120, seated + 150 * 60_000)).toEqual({ elapsedMinutes: 150, level: 'red' });

    // Future timestamp edge case
    expect(timerState(seated, 75, seated - 10 * 60_000)).toEqual({ elapsedMinutes: 0, level: 'normal' });
  });

  it('tests 64-cell exhaustive reservation transition matrix (15 valid, 49 invalid)', () => {
    let validCount = 0;
    let invalidCount = 0;

    for (const from of RESERVATION_STATUSES) {
      for (const to of RESERVATION_STATUSES) {
        const allowed = canTransition(RESERVATION_TRANSITIONS, from, to);
        if (allowed) {
          validCount++;
          expect(() => assertTransition('reservation', RESERVATION_TRANSITIONS, from, to)).not.toThrow();
        } else {
          invalidCount++;
          expect(() => assertTransition('reservation', RESERVATION_TRANSITIONS, from, to)).toThrow(
            IllegalTransitionError,
          );
        }
      }
    }

    expect(validCount).toBe(15);
    expect(invalidCount).toBe(49);
    expect(validCount + invalidCount).toBe(64);
  });

  it('handles empty table list and extreme pacing in computeAvailability', () => {
    // Empty tables list
    const qEmpty = makeQuery({ tables: [], combinations: [] });
    const slotsEmpty = computeAvailability(qEmpty);
    expect(slotsEmpty.length).toBeGreaterThan(0);
    expect(slotsEmpty.every((s) => !s.available && s.reason === 'no_table')).toBe(true);

    // maxCoversPerSlot = 0 (blocks all bookings)
    const qPacingZero = makeQuery({ maxCoversPerSlot: 0 });
    const slotsPacing = computeAvailability(qPacingZero);
    expect(slotsPacing.every((s) => !s.available && s.reason === 'pacing')).toBe(true);

    // nearestAlternatives when all slots are unavailable
    const alts = nearestAlternatives(slotsEmpty, Date.parse('2026-06-15T21:00:00Z'));
    expect(alts).toEqual([]);
  });

  it('exhaustively validates turn rule anomalies with validateTurnRules', () => {
    const invalidRules: TurnRule[] = [
      { id: 'bad-min', partyMin: 0, partyMax: 4, daypart: null, diningAreaId: null, minutes: 60 },
      { id: 'bad-max', partyMin: 10, partyMax: 55, daypart: null, diningAreaId: null, minutes: 60 },
      { id: 'inverted', partyMin: 6, partyMax: 4, daypart: null, diningAreaId: null, minutes: 60 },
      { id: 'not-div-5', partyMin: 1, partyMax: 2, daypart: 'dinner', diningAreaId: null, minutes: 47 },
      { id: 'too-short', partyMin: 1, partyMax: 2, daypart: 'lunch', diningAreaId: null, minutes: 10 },
      { id: 'too-long', partyMin: 1, partyMax: 2, daypart: 'brunch', diningAreaId: null, minutes: 500 },
    ];

    const issues = validateTurnRules(invalidRules);
    expect(issues.some((i) => i.code === 'INVALID_RANGE' && i.ruleIds.includes('bad-min'))).toBe(true);
    expect(issues.some((i) => i.code === 'INVALID_RANGE' && i.ruleIds.includes('bad-max'))).toBe(true);
    expect(issues.some((i) => i.code === 'INVALID_RANGE' && i.ruleIds.includes('inverted'))).toBe(true);
    expect(issues.some((i) => i.code === 'INVALID_MINUTES' && i.ruleIds.includes('not-div-5'))).toBe(true);
    expect(issues.some((i) => i.code === 'INVALID_MINUTES' && i.ruleIds.includes('too-short'))).toBe(true);
    expect(issues.some((i) => i.code === 'INVALID_MINUTES' && i.ruleIds.includes('too-long'))).toBe(true);
  });
});
