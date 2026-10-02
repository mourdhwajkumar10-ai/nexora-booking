import { DWELL_RED_EXTRA_MINS, bestFitOrder, timerState } from '@nexora/shared';
import { query, withTx, type Tx } from '../../db/pool';
import { createAlert } from '../../core/alerts';
import { audit } from '../../core/audit';
import { guestDisplayName } from '../../core/guests';
import { enqueueNotification } from '../../core/notifications';
import { lockTable } from '../../core/tables';
import { clock } from '../../lib/clock';

export const DWELL_JOB = 'dwell-monitor';
const ACTOR = 'system:dwell-monitor';
/** How far ahead a table's next booking counts as "about to arrive" when the table goes red. */
export const DWELL_NEXT_BOOKING_WINDOW_MINS = 15;
export const DWELL_DELAY_SMS =
  'Your table is undergoing final preparation. Enjoy a complimentary beverage at the bar while we finalize your seating.';

/**
 * E3-S5: amber at ≥ turnaround, red at ≥ turnaround + 15 (once per seating via dedupe keys).
 * When the red alert is newly raised, protect the table's next booking: auto-migrate it to a free
 * best-fit table, else SMS the guest a complimentary-beverage apology. One transaction per seating,
 * so a failure rolls back the red alert too and the next run retries.
 */
export async function runDwellMonitor(): Promise<void> {
  const now = clock.now();
  const rows = await query(
    `SELECT r.id, r.venue_id, r.table_id, r.guest_id, r.party_size, r.seated_at, r.turn_minutes,
            v.turnaround_mins, v.grace_period_mins, t.table_number, g.first_name, g.last_name
     FROM reservations r
     JOIN venues v ON v.id = r.venue_id
     JOIN dining_tables t ON t.id = r.table_id
     JOIN guests g ON g.id = r.guest_id
     WHERE r.status = 'SEATED' AND r.seated_at IS NOT NULL
     ORDER BY r.seated_at`,
  );
  for (const r of rows) {
    try {
      await withTx((tx) => processSeating(tx, r, now));
    } catch (err) {
      console.error(`[job:${DWELL_JOB}] reservation ${r.id} failed`, err);
    }
  }
}

async function processSeating(tx: Tx, r: any, now: Date): Promise<void> {
  const partySize = r.party_size ?? 2;
  const turnMinutes = r.turn_minutes ?? (partySize <= 2 ? 75 : partySize <= 4 ? 90 : 120);
  const timer = timerState(new Date(r.seated_at).getTime(), turnMinutes, now.getTime());
  if (timer.level === 'normal') return;

  const elapsedMins = timer.elapsedMinutes;
  const guest = guestDisplayName(r);
  const data = { reservationId: r.id, tableId: r.table_id, tableNumber: r.table_number, seatedAt: new Date(r.seated_at).toISOString() };
  await createAlert(tx, {
    venueId: r.venue_id,
    kind: 'DWELL_AMBER',
    severity: 'warning',
    title: `Table ${r.table_number} reached turnaround`,
    body: `${guest} (party of ${r.party_size}) has been seated ${elapsedMins} min (turnaround ${turnMinutes} min).`,
    data,
    dedupeKey: `dwell-amber:${r.id}`,
  });
  if (timer.level !== 'red') return;
  const red = await createAlert(tx, {
    venueId: r.venue_id,
    kind: 'DWELL_RED',
    severity: 'critical',
    title: `Table ${r.table_number} is overstaying`,
    body: `${guest} (party of ${r.party_size}) has been seated ${elapsedMins} min, ${elapsedMins - turnMinutes} min past turnaround.`,
    data,
    dedupeKey: `dwell-red:${r.id}`,
  });
  if (!red) return;
  await protectNextBooking(tx, r, now);
}

async function protectNextBooking(tx: Tx, seated: any, now: Date): Promise<void> {
  const next = await tx.one(
    `SELECT r.*, g.first_name, g.last_name, g.phone_number
     FROM reservations r JOIN guests g ON g.id = r.guest_id
     WHERE r.table_id = $1 AND r.status = 'CONFIRMED'
       AND r.start_at <= $2 AND r.start_at + make_interval(mins => $4) > $3
     ORDER BY r.start_at LIMIT 1`,
    [seated.table_id, new Date(now.getTime() + DWELL_NEXT_BOOKING_WINDOW_MINS * 60_000), now, seated.grace_period_mins],
  );
  if (!next) return;

  const candidates = await tx.query(
    `SELECT t.id, t.table_number, t.min_capacity, t.max_capacity
     FROM dining_tables t
     WHERE t.venue_id = $1 AND t.archived_at IS NULL AND t.status = 'AVAILABLE' AND t.id <> $2
       AND NOT EXISTS (
         SELECT 1 FROM reservations o
         WHERE o.table_id = t.id AND o.id <> $3 AND o.status IN ('REQUESTED', 'CONFIRMED', 'ARRIVED', 'SEATED', 'LATE')
           AND o.start_at < $5 AND $4 < o.end_at
       )`,
    [seated.venue_id, seated.table_id, next.id, next.start_at, next.end_at],
  );
  const ordered = bestFitOrder(
    candidates.map((t) => ({ id: t.id, tableNumber: t.table_number, minCapacity: t.min_capacity, maxCapacity: t.max_capacity })),
    next.party_size,
  );
  const guest = guestDisplayName(next);

  for (const alt of ordered) {
    // Lock both tables in id order (deadlock-free), then re-validate under the locks.
    const [first, second] = [seated.table_id, alt.id].sort();
    const locked = new Map([[first, await lockTable(tx, first)], [second, await lockTable(tx, second)]]);
    const target = locked.get(alt.id)!;
    if (target.status !== 'AVAILABLE') continue;
    const clash = await tx.one(
      `SELECT 1 FROM reservations WHERE table_id = $1 AND id <> $2 AND status IN ('REQUESTED', 'CONFIRMED', 'ARRIVED', 'SEATED', 'LATE')
         AND start_at < $4 AND $3 < end_at LIMIT 1`,
      [alt.id, next.id, next.start_at, next.end_at],
    );
    if (clash) continue;
    const moved = await tx.one(
      `UPDATE reservations SET table_id = $2, updated_at = $3 WHERE id = $1 AND status = 'CONFIRMED' AND table_id = $4 RETURNING *`,
      [next.id, alt.id, now, seated.table_id],
    );
    if (!moved) return; // changed underneath us (cancelled / reassigned); nothing to protect
    await tx.query(
      'INSERT INTO reservation_events (reservation_id, from_status, to_status, actor, note, created_at) VALUES ($1,$2,$2,$3,$4,$5)',
      [next.id, 'CONFIRMED', ACTOR, `auto-migrated ${seated.table_number} -> ${alt.tableNumber} (dwell overrun)`, now],
    );
    await audit(tx, {
      venueId: seated.venue_id,
      actor: ACTOR,
      action: 'reservation.auto_migrated',
      entity: 'reservation',
      entityId: next.id,
      data: { fromTableId: seated.table_id, toTableId: alt.id, overstayingReservationId: seated.id },
    });
    await createAlert(tx, {
      venueId: seated.venue_id,
      kind: 'AUTO_MIGRATED',
      severity: 'info',
      title: `${guest} moved to Table ${alt.tableNumber}`,
      body: `Table ${seated.table_number} is overstaying, so ${guest}'s booking (party of ${next.party_size}) was moved to Table ${alt.tableNumber}.`,
      data: { reservationId: next.id, fromTableId: seated.table_id, fromTableNumber: seated.table_number, toTableId: alt.id, toTableNumber: alt.tableNumber },
      dedupeKey: `auto-migrated:${next.id}:${seated.id}`,
    });
    tx.emit({ type: 'reservation.changed', venueId: seated.venue_id, reservationId: next.id, guestId: next.guest_id, tableId: alt.id, from: 'CONFIRMED', to: 'CONFIRMED' });
    tx.emit({ type: 'table.changed', venueId: seated.venue_id, tableIds: [seated.table_id, alt.id] });
    return;
  }

  await enqueueNotification(tx, {
    venueId: seated.venue_id,
    reservationId: next.id,
    guestId: next.guest_id,
    channel: 'SMS',
    template: 'DWELL_DELAY',
    to: next.phone_number,
    body: DWELL_DELAY_SMS,
    payload: { tableId: seated.table_id, overstayingReservationId: seated.id },
  });
}
