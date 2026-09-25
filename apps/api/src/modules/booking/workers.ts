/**
 * Booking workers (ARCHITECTURE §7): triage escalation / auto-confirm, grace-period no-shows and
 * the notification outbox. Each item is processed in its own transaction and re-verified under lock.
 */
import { GOOD_STANDING_LOOKBACK_DAYS, utcToZonedParts } from '@nexora/shared';
import { query, withTx, type Tx } from '../../db/pool';
import { createAlert } from '../../core/alerts';
import { guestDisplayName } from '../../core/guests';
import { toNotificationDto } from '../../core/notifications';
import { lockReservation, transitionReservation } from '../../core/reservations';
import { clock } from '../../lib/clock';
import { formatTimeLabel, notifyReservation } from './notify';
import { markNoShow } from './service';

const BATCH = 100;

/** Good Standing (C-09): no NO_SHOW in the last 90 days and no UNRESOLVED_LOYALTY_DEFICIT flag. */
export async function isGoodStanding(tx: Tx, guestId: string, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - GOOD_STANDING_LOOKBACK_DAYS * 86_400_000);
  const row = await tx.one<{ recent_no_show: boolean; deficit: boolean }>(
    `SELECT
       EXISTS (SELECT 1 FROM reservations WHERE guest_id = $1 AND status = 'NO_SHOW' AND start_at >= $2 AND start_at <= $3) AS recent_no_show,
       COALESCE((SELECT 'UNRESOLVED_LOYALTY_DEFICIT' = ANY(flags) FROM guest_profiles WHERE guest_id = $1), false) AS deficit`,
    [guestId, since, now],
  );
  return !row!.recent_no_show && !row!.deficit;
}

async function processTriage(id: string): Promise<void> {
  await withTx(async (tx) => {
    const now = clock.now();
    const r = await lockReservation(tx, id);
    if (r.status !== 'REQUESTED' || r.escalated_at) return; // handled meanwhile
    const v = (await tx.one('SELECT name, timezone, triage_timeout_secs FROM venues WHERE id = $1', [r.venue_id]))!;
    if (new Date(r.created_at).getTime() + v.triage_timeout_secs * 1000 > now.getTime()) return;

    const good = await isGoodStanding(tx, r.guest_id, now);
    const table = r.table_id
      ? await tx.one<{ status: string; archived_at: Date | null }>('SELECT status, archived_at FROM dining_tables WHERE id = $1', [r.table_id])
      : null;
    const tableOk = !!table && table.status !== 'BLOCKED' && !table.archived_at;
    const upcoming = new Date(r.start_at).getTime() > now.getTime();

    if (good && tableOk && upcoming) {
      await transitionReservation(tx, r, 'CONFIRMED', 'system:triage', { note: 'Auto-confirmed after triage timeout (Good Standing)' });
      await notifyReservation(tx, r.id, 'RESERVATION_CONFIRMED');
      return;
    }

    await tx.query('UPDATE reservations SET escalated_at = $2, updated_at = $2 WHERE id = $1', [r.id, now]);
    const g = (await tx.one('SELECT first_name, last_name FROM guests WHERE id = $1', [r.guest_id]))!;
    const reason = !good ? 'Guest is not in Good Standing' : !tableOk ? 'Assigned table is unavailable' : 'Requested time has passed';
    const time = formatTimeLabel(utcToZonedParts(new Date(r.start_at), v.timezone).time);
    await createAlert(tx, {
      venueId: r.venue_id,
      kind: 'TRIAGE_ESCALATION',
      severity: 'critical',
      title: `Triage timeout: ${guestDisplayName(g)}, party of ${r.party_size} at ${time}`,
      body: `${reason}. Approve or decline manually.`,
      data: { reservationId: r.id, reason },
      dedupeKey: `triage:${r.id}`,
    });
    tx.emit({ type: 'reservation.changed', venueId: r.venue_id, reservationId: r.id, guestId: r.guest_id, tableId: r.table_id, from: r.status, to: r.status });
  });
}

export async function runTriageEscalation(): Promise<void> {
  const due = await query<{ id: string }>(
    `SELECT r.id FROM reservations r JOIN venues v ON v.id = r.venue_id
     WHERE r.status = 'REQUESTED' AND r.escalated_at IS NULL
       AND r.created_at + make_interval(secs => v.triage_timeout_secs) <= $1
     ORDER BY r.created_at LIMIT ${BATCH}`,
    [clock.now()],
  );
  for (const { id } of due) {
    try {
      await processTriage(id);
    } catch (err) {
      console.error(`[job:triage-escalation] ${id} failed`, err);
    }
  }
}

async function processNoShow(id: string): Promise<void> {
  await withTx(async (tx) => {
    const now = clock.now();
    const r = await lockReservation(tx, id);
    if (r.status !== 'CONFIRMED') return;
    const v = (await tx.one('SELECT timezone, grace_period_mins FROM venues WHERE id = $1', [r.venue_id]))!;
    if (new Date(r.start_at).getTime() + v.grace_period_mins * 60_000 > now.getTime()) return;
    await markNoShow(tx, r, 'system:grace-no-show');
    const g = (await tx.one('SELECT first_name, last_name FROM guests WHERE id = $1', [r.guest_id]))!;
    const time = formatTimeLabel(utcToZonedParts(new Date(r.start_at), v.timezone).time);
    await createAlert(tx, {
      venueId: r.venue_id,
      kind: 'NO_SHOW',
      severity: 'warning',
      title: `No-show: ${guestDisplayName(g)}, party of ${r.party_size} at ${time}`,
      body: `Not seated within the ${v.grace_period_mins}-minute grace period. The table has been released.`,
      data: { reservationId: r.id, tableId: r.table_id },
      dedupeKey: `noshow:${r.id}`,
    });
  });
}

export async function runGraceNoShow(): Promise<void> {
  const due = await query<{ id: string }>(
    `SELECT r.id FROM reservations r JOIN venues v ON v.id = r.venue_id
     WHERE r.status = 'CONFIRMED' AND r.start_at + make_interval(mins => v.grace_period_mins) <= $1
     ORDER BY r.start_at LIMIT ${BATCH}`,
    [clock.now()],
  );
  for (const { id } of due) {
    try {
      await processNoShow(id);
    } catch (err) {
      console.error(`[job:grace-no-show] ${id} failed`, err);
    }
  }
}

/** Mock dispatcher: log the message, mark SENT, emit `notification.sent`. SKIP LOCKED keeps concurrent runs safe. */
export async function runNotificationOutbox(): Promise<void> {
  await withTx(async (tx) => {
    const rows = await tx.query(
      `SELECT * FROM notifications_outbox WHERE status = 'PENDING' ORDER BY created_at, id LIMIT ${BATCH} FOR UPDATE SKIP LOCKED`,
    );
    const now = clock.now();
    for (const n of rows) {
      console.log(`[MOCK ${n.channel}] to ${n.to_address}: ${n.body}`);
      const sent = (await tx.one(
        `UPDATE notifications_outbox SET status = 'SENT', sent_at = $2, attempts = attempts + 1 WHERE id = $1 RETURNING *`,
        [n.id, now],
      ))!;
      if (sent.venue_id) tx.emit({ type: 'notification.sent', venueId: sent.venue_id, notification: toNotificationDto(sent) });
    }
  });
}
