import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  bookingModeFor,
  confirmNoShow,
  holdExpiresAt,
  lateMarkAt,
  nextStatus,
  requestExpiresAt,
  systemNoShowAt,
  type ReservationSnapshot,
  type TransitionContext,
} from '../src/reservation.ts';
import { floorTransition, quoteWaitlist, tableFreeAt, timerState, upcomingBadge } from '../src/floor.ts';

const at = (iso: string) => Date.parse(iso);
const START = at('2026-06-15T23:00:00Z');
const snap = (over: Partial<ReservationSnapshot> = {}): ReservationSnapshot => ({
  status: 'confirmed',
  startsAtMs: START,
  serviceDate: '2026-06-15',
  arrivedAtMs: null,
  noShowConfirmedAtMs: null,
  ...over,
});
const ctx = (over: Partial<TransitionContext> = {}): TransitionContext => ({
  nowMs: at('2026-06-15T20:00:00Z'),
  actor: 'staff',
  todayServiceDate: '2026-06-15',
  lateCancelWindowHours: 24,
  ...over,
});

describe('BR-08 reservation transitions', () => {
  it('follows the transition matrix', () => {
    expect(nextStatus('requested', 'confirm')).toBe('confirmed');
    expect(nextStatus('confirmed', 'seat')).toBe('seated');
    expect(nextStatus('late', 'arrive')).toBe('arrived');
    expect(nextStatus('no_show', 'reinstate')).toBe('arrived');
    expect(nextStatus('seated', 'cancel_guest')).toBeNull();
    expect(nextStatus('completed', 'seat')).toBeNull();
    expect(nextStatus('cancelled', 'confirm')).toBeNull();
  });
  it('flags late cancellations inside the policy window', () => {
    const r = applyEvent(snap(), 'cancel_guest', ctx({ actor: 'guest' }));
    expect(r).toEqual({
      ok: true,
      to: 'cancelled',
      patch: { status: 'cancelled', cancelledAt: at('2026-06-15T20:00:00Z'), cancelledBy: 'guest', cancelReason: 'guest_cancelled', lateCancel: true },
      effects: ['emit_floor_event', 'notify_cancelled', 'evaluate_late_cancel_fee', 'recompute_guest_stats'],
    });
    const early = applyEvent(snap(), 'cancel_guest', ctx({ actor: 'guest', nowMs: at('2026-06-13T20:00:00Z') }));
    expect(early.ok && early.patch.lateCancel).toBe(false);
    const request = applyEvent(snap({ status: 'requested' }), 'cancel_guest', ctx({ actor: 'guest' }));
    expect(request.ok && request.patch.lateCancel).toBe(false);
  });
  it('enforces actors and timing guards', () => {
    expect(applyEvent(snap({ status: 'requested' }), 'confirm', ctx({ actor: 'guest' }))).toEqual({ ok: false, error: 'ACTOR_NOT_ALLOWED' });
    expect(applyEvent(snap(), 'mark_no_show', ctx())).toEqual({ ok: false, error: 'TOO_EARLY_FOR_NO_SHOW' });
    expect(applyEvent(snap({ status: 'seated' }), 'arrive', ctx())).toEqual({ ok: false, error: 'INVALID_TRANSITION' });
  });
  it('records the no-show source and keeps existing arrival time on seat', () => {
    const ns = applyEvent(snap({ status: 'late' }), 'mark_no_show', ctx({ actor: 'system', nowMs: START + 30 * 60_000 }));
    expect(ns.ok && ns.patch).toEqual({ status: 'no_show', noShowAt: START + 30 * 60_000, noShowSource: 'system' });
    const seat = applyEvent(snap({ status: 'arrived', arrivedAtMs: START - 5 * 60_000 }), 'seat', ctx({ nowMs: START }));
    expect(seat.ok && seat.patch).toEqual({ status: 'seated', seatedAt: START, arrivedAt: START - 5 * 60_000 });
  });
  it('allows reinstating only unconfirmed no-shows on the same service date', () => {
    const ok = applyEvent(snap({ status: 'no_show' }), 'reinstate', ctx({ nowMs: START + 40 * 60_000 }));
    expect(ok.ok && ok.patch).toEqual({ status: 'arrived', noShowAt: null, noShowSource: null, arrivedAt: START + 40 * 60_000 });
    expect(applyEvent(snap({ status: 'no_show', noShowConfirmedAtMs: START }), 'reinstate', ctx())).toEqual({ ok: false, error: 'REINSTATE_NOT_ALLOWED' });
    expect(applyEvent(snap({ status: 'no_show' }), 'reinstate', ctx({ todayServiceDate: '2026-06-16' }))).toEqual({ ok: false, error: 'REINSTATE_NOT_ALLOWED' });
  });
  it('confirms no-shows as a separate staff action', () => {
    expect(confirmNoShow(snap({ status: 'no_show' }), 'staff')).toEqual({ ok: true, effects: ['recompute_guest_stats', 'evaluate_no_show_fee'] });
    expect(confirmNoShow(snap({ status: 'no_show', noShowConfirmedAtMs: START }), 'staff')).toEqual({ ok: false, error: 'ALREADY_CONFIRMED' });
    expect(confirmNoShow(snap({ status: 'no_show' }), 'system')).toEqual({ ok: false, error: 'ACTOR_NOT_ALLOWED' });
    expect(confirmNoShow(snap(), 'staff')).toEqual({ ok: false, error: 'INVALID_TRANSITION' });
  });
  it('computes job timings and booking modes', () => {
    expect(lateMarkAt(START, 15)).toBe(START + 15 * 60_000);
    expect(holdExpiresAt(START)).toBe(START + 15 * 60_000);
    expect(applyEvent(snap({ status: 'requested' }), 'confirm', ctx({ actor: 'system' })).ok).toBe(true);
    expect(systemNoShowAt(START, 30)).toBe(START + 30 * 60_000);
    expect(requestExpiresAt(at('2026-06-10T12:00:00Z'), START)).toBe(at('2026-06-11T12:00:00Z'));
    expect(requestExpiresAt(at('2026-06-15T12:00:00Z'), START)).toBe(at('2026-06-15T21:00:00Z'));
    const s = { defaultMode: 'instant' as const, requestToBookMinParty: 9, maxPartyOnline: 12 };
    expect(bookingModeFor(8, s)).toBe('instant');
    expect(bookingModeFor(9, s)).toBe('request');
    expect(bookingModeFor(13, s)).toBe('too_large');
    expect(bookingModeFor(2, { ...s, defaultMode: 'request' })).toBe('request');
  });
});

describe('BR-09 / BR-10 floor', () => {
  it('only allows valid floor transitions', () => {
    expect(floorTransition('available', 'seat')).toBe('occupied');
    expect(floorTransition('occupied', 'clear')).toBeNull();
    expect(floorTransition('bussing', 'seat')).toBe('occupied');
    expect(floorTransition('blocked', 'seat')).toBeNull();
  });
  it('raises amber at 100% and red at ceil(125%) of the turn', () => {
    const seated = at('2026-06-15T23:00:00Z');
    expect(timerState(seated, 90, seated + 89 * 60_000 + 59_000)).toEqual({ elapsedMinutes: 89, level: 'normal' });
    expect(timerState(seated, 90, seated + 90 * 60_000)).toEqual({ elapsedMinutes: 90, level: 'amber' });
    expect(timerState(seated, 90, seated + 112 * 60_000)).toEqual({ elapsedMinutes: 112, level: 'amber' });
    expect(timerState(seated, 90, seated + 113 * 60_000)).toEqual({ elapsedMinutes: 113, level: 'red' });
  });
  it('derives the upcoming-reservation badge', () => {
    const now = at('2026-06-15T22:40:00Z');
    const c = (id: string, iso: string) => ({ reservationId: id, startsAtMs: at(iso), status: 'confirmed' as const });
    expect(upcomingBadge([c('a', '2026-06-15T23:30:00Z'), c('b', '2026-06-15T23:00:00Z'), c('c', '2026-06-15T22:20:00Z')], now, 30, 15)?.reservationId).toBe('b');
  });
});

describe('BR-11 waitlist quotes', () => {
  const now = at('2026-06-15T23:00:00Z');
  const m = (x: number) => now + x * 60_000;
  it('computes table free times', () => {
    expect(tableFreeAt('available', now, null)).toBe(now);
    expect(tableFreeAt('bussing', now, null)).toBe(m(5));
    expect(tableFreeAt('occupied', now, m(20))).toBe(m(20));
    expect(tableFreeAt('occupied', now, m(-10))).toBe(m(5));
    expect(tableFreeAt('blocked', now, null)).toBeNull();
  });
  it('places parties greedily around upcoming reservations', () => {
    const tables = [
      { id: 'A', label: 'A', minCovers: 1, maxCovers: 2, freeAtMs: m(20), nextReservationStartMs: null },
      { id: 'B', label: 'B', minCovers: 2, maxCovers: 4, freeAtMs: now, nextReservationStartMs: m(60) },
      { id: 'C', label: 'C', minCovers: 2, maxCovers: 4, freeAtMs: m(45), nextReservationStartMs: null },
    ];
    const parties = [
      { id: 'p1', partySize: 2, turnMinutes: 75 },
      { id: 'p2', partySize: 4, turnMinutes: 90 },
      { id: 'p3', partySize: 2, turnMinutes: 75 },
      { id: 'p4', partySize: 9, turnMinutes: 120 },
    ];
    expect(quoteWaitlist(now, tables, parties, 10)).toEqual([
      { partyId: 'p1', tableId: 'A', seatAtMs: m(20), quoteMinutes: 20 },
      { partyId: 'p2', tableId: 'C', seatAtMs: m(45), quoteMinutes: 45 },
      { partyId: 'p3', tableId: 'A', seatAtMs: m(105), quoteMinutes: 105 },
      { partyId: 'p4', tableId: null, seatAtMs: null, quoteMinutes: null },
    ]);
  });
  it('rounds quotes up to 5 minutes', () => {
    const q = quoteWaitlist(now, [{ id: 'A', label: 'A', minCovers: 1, maxCovers: 2, freeAtMs: m(7), nextReservationStartMs: null }], [{ id: 'p', partySize: 2, turnMinutes: 75 }], 10);
    expect(q[0]!.quoteMinutes).toBe(10);
  });
});
