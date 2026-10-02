import { describe, it, expect } from 'vitest';
import {
  applyReservationEvent,
  floorTransition,
  upcomingBadge,
  type FloorStatus,
  type ReservationStatus,
} from '../helpers/oracle';

describe('Tier 3: Cross-Feature Combination — Reservation Lifecycle & Floor Status Synchronization', () => {
  const serviceDate = '2026-10-02' as any;
  const startsAtMs = 1759431600000;

  it('synchronizes table floor status with reservation lifecycle events from booking to table release', () => {
    let floorStatus: FloorStatus = 'available';
    let resStatus: ReservationStatus = 'confirmed';
    let now = startsAtMs - 1800_000; // 30 min before start

    // 1. Table is physical available, with derived upcoming badge
    const badge = upcomingBadge(
      [{ reservationId: 'res-sync-1', startsAtMs, status: 'confirmed' }],
      now,
      30, // 30 min hold window
      15  // 15 min grace
    );
    expect(floorStatus).toBe('available');
    expect(badge).not.toBeNull();
    expect(badge?.reservationId).toBe('res-sync-1');

    // 2. Guest arrives at venue (10 min before start)
    now = startsAtMs - 600_000;
    const arriveResult = applyReservationEvent(
      { status: resStatus, startsAtMs, serviceDate },
      'arrive',
      { nowMs: now, actor: 'system' }
    );
    resStatus = arriveResult.status;
    expect(resStatus).toBe('arrived');
    expect(floorStatus).toBe('available'); // Floor table is still waiting to be seated

    // 3. Host seats the party
    now = startsAtMs;
    const seatResult = applyReservationEvent(
      { status: resStatus, startsAtMs, serviceDate, arrivedAtMs: arriveResult.patch.arrivedAt },
      'seat',
      { nowMs: now, actor: 'staff' }
    );
    resStatus = seatResult.status;
    expect(resStatus).toBe('seated');

    // Floor transition triggers 'seat' action -> 'occupied'
    const nextFloor = floorTransition(floorStatus, 'seat');
    expect(nextFloor).toBe('occupied');
    floorStatus = nextFloor!;

    // 4. Dining completes, check is paid
    now = startsAtMs + 90 * 60_000;
    const completeResult = applyReservationEvent(
      { status: resStatus, startsAtMs, serviceDate, seatedAt: seatResult.patch.seatedAt },
      'complete',
      { nowMs: now, actor: 'staff' }
    );
    resStatus = completeResult.status;
    expect(resStatus).toBe('completed');

    // Floor transition triggers 'complete' action -> 'bussing'
    const bussingFloor = floorTransition(floorStatus, 'complete');
    expect(bussingFloor).toBe('bussing');
    floorStatus = bussingFloor!;

    // 5. Staff clears and sanitizes the table
    const clearFloor = floorTransition(floorStatus, 'clear');
    expect(clearFloor).toBe('available');
    floorStatus = clearFloor!;
  });
});
