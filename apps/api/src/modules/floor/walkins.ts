import { randomBytes } from 'node:crypto';
import {
  WALK_IN_BUFFER_MINS,
  addMinutes,
  bestFitOrder,
  utcToZonedParts,
  type AdminReservation,
  type WalkInCheckResponse,
  type WalkInInput,
} from '@nexora/shared';
import type { z } from 'zod';
import { getPool, query, withTx, type Queryable, type Tx } from '../../db/pool';
import { audit } from '../../core/audit';
import { guestDisplayName, upsertGuest } from '../../core/guests';
import { openOrder } from '../../core/orders';
import { loadAdminReservation, recordCreated, type ReservationRow } from '../../core/reservations';
import { lockTable, setTableStatus } from '../../core/tables';
import { getVenueById, type VenueRow } from '../../core/venues';
import { clock } from '../../lib/clock';
import { conflict, notFound, unprocessable } from '../../lib/errors';

type Conflict = WalkInCheckResponse['conflicts'][number];
type Suggestion = WalkInCheckResponse['suggestions'][number];

/** "19:15" -> "7:15 PM" (manual so ICU's narrow no-break space never sneaks in). */
export function to12h(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

export function collisionMessage(c: Conflict, timeZone: string): string {
  const time = to12h(utcToZonedParts(new Date(c.startAt), timeZone).time);
  return `Collision Alert: Table ${c.tableNumber} reserved for ${c.guestName} at ${time}. Dwell time exceeds arrival threshold.`;
}

/**
 * Walk-in collision analysis (ARCHITECTURE §2, C-17). A walk-in seated now occupies
 * [now, now + turnaround + WALK_IN_BUFFER) for collision purposes; it collides with an active
 * (REQUESTED/CONFIRMED) booking b on the table iff b.start < now + turn + buffer ∧ now < b.end.
 * Suggestions: physically AVAILABLE tables that fit the party with no collision, best-fit order.
 */
export async function analyseWalkIn(
  venue: VenueRow,
  partySize: number,
  tableId: string | null,
  db: Queryable = getPool(),
): Promise<{ conflicts: Conflict[]; suggestions: Suggestion[]; message: string | null }> {
  const now = clock.now();
  const windowEnd = addMinutes(now, venue.turnaround_mins + WALK_IN_BUFFER_MINS);
  const [tables, hits] = await Promise.all([
    query(`SELECT * FROM dining_tables WHERE venue_id = $1 AND archived_at IS NULL`, [venue.id], db),
    query(
      `SELECT r.id, COALESCE(rt.table_id, r.table_id) AS table_id, r.start_at, t.table_number, g.first_name, g.last_name
       FROM reservations r
       LEFT JOIN reservation_tables rt ON rt.reservation_id = r.id
       JOIN dining_tables t ON t.id = COALESCE(rt.table_id, r.table_id)
       JOIN guests g ON g.id = r.guest_id
       WHERE r.venue_id = $1 AND r.status IN ('REQUESTED', 'CONFIRMED')
         AND r.start_at < $2 AND r.end_at > $3
       ORDER BY r.start_at, t.table_number`,
      [venue.id, windowEnd, now],
      db,
    ),
  ]);
  const blocked = new Set(hits.map((h) => h.table_id));
  const conflicts: Conflict[] = hits
    .filter((h) => h.table_id === tableId)
    .map((h) => ({
      tableId: h.table_id,
      tableNumber: h.table_number,
      reservationId: h.id,
      guestName: guestDisplayName(h),
      startAt: new Date(h.start_at).toISOString(),
    }));
  const candidates = tables
    .filter((t) => t.status === 'AVAILABLE' && !blocked.has(t.id))
    .map((t) => ({ id: t.id, tableNumber: t.table_number, minCapacity: t.min_capacity, maxCapacity: t.max_capacity }));
  const suggestions = bestFitOrder(candidates, partySize).map((t) => ({ tableId: t.id, tableNumber: t.tableNumber, maxCapacity: t.maxCapacity }));
  return { conflicts, suggestions, message: conflicts[0] ? collisionMessage(conflicts[0], venue.timezone) : null };
}

export async function checkWalkIn(venueId: string, partySize: number, tableId: string | undefined): Promise<WalkInCheckResponse> {
  const venue = await getVenueById(venueId);
  let table: any = null;
  if (tableId) {
    [table] = await query('SELECT * FROM dining_tables WHERE id = $1 AND venue_id = $2 AND archived_at IS NULL', [tableId, venueId]);
    if (!table) throw notFound('Table');
  }
  const a = await analyseWalkIn(venue, partySize, tableId ?? null);
  let message = a.message;
  let ok = a.conflicts.length === 0;
  if (table && ok && table.status !== 'AVAILABLE') {
    ok = false;
    message = `Table ${table.table_number} is not ready (${table.status}).`;
  } else if (table && ok && partySize > table.max_capacity) {
    ok = false;
    message = `Table ${table.table_number} seats at most ${table.max_capacity}.`;
  } else if (!table) {
    ok = a.suggestions.length > 0;
  }
  return { ok, tableId: tableId ?? null, conflicts: a.conflicts, message, suggestions: a.suggestions };
}

async function resolveWalkInGuest(tx: Tx, input: { guestName?: string; phone?: string }): Promise<string> {
  if (input.phone) {
    const { guest } = await upsertGuest(tx, { fullName: input.guestName || undefined, phone: input.phone });
    return guest.id;
  }
  const name = input.guestName?.trim();
  const [first, ...rest] = name ? name.split(/\s+/) : ['Walk-in'];
  // phone_number is VARCHAR(32) UNIQUE NOT NULL: "walkin:" + 24 hex chars = 31.
  const g = (await tx.one(`INSERT INTO guests (first_name, last_name, phone_number) VALUES ($1, $2, $3) RETURNING id`, [
    first,
    rest.join(' '),
    `walkin:${randomBytes(12).toString('hex')}`,
  ]))!;
  await tx.query('INSERT INTO guest_profiles (guest_id) VALUES ($1) ON CONFLICT DO NOTHING', [g.id]);
  await tx.query('INSERT INTO loyalty_accounts (guest_id) VALUES ($1) ON CONFLICT DO NOTHING', [g.id]);
  return g.id;
}

/** Seat a walk-in (E3-S2): SEATED/WALK_IN reservation + table OCCUPIED + open check, atomically. */
export async function createWalkIn(
  venueId: string,
  input: z.infer<typeof WalkInInput>,
  actor: string,
  externalTx?: Tx,
): Promise<AdminReservation> {
  const execute = async (tx: Tx) => {
    const venue = await getVenueById(venueId, tx.client);
    const table = await lockTable(tx, input.tableId);
    if (table.venue_id !== venueId) throw notFound('Table');
    if (table.status !== 'AVAILABLE') {
      throw conflict('TABLE_NOT_READY', `Table ${table.table_number} is not ready (${table.status})`, { status: table.status });
    }
    if (input.partySize > table.max_capacity) {
      throw unprocessable('PARTY_TOO_LARGE', `Table ${table.table_number} seats at most ${table.max_capacity}`);
    }
    const a = await analyseWalkIn(venue, input.partySize, table.id, tx.client);
    if (a.conflicts.length > 0) {
      if (!input.override) throw conflict('WALK_IN_COLLISION', a.message!, { conflicts: a.conflicts, suggestions: a.suggestions });
      await audit(tx, {
        venueId,
        actor,
        action: 'walk_in.override',
        entity: 'table',
        entityId: table.id,
        data: { partySize: input.partySize, conflicts: a.conflicts },
      });
    }

    const guestId = await resolveWalkInGuest(tx, input);
    const now = clock.now();
    const r = (await tx.one<ReservationRow>(
      `INSERT INTO reservations (venue_id, table_id, guest_id, party_size, booking_date, start_at, end_at, source, status, seated_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'WALK_IN','SEATED',$6,$6,$6) RETURNING *`,
      [venueId, table.id, guestId, input.partySize, utcToZonedParts(now, venue.timezone).date, now, addMinutes(now, venue.turnaround_mins)],
    ))!;
    await recordCreated(tx, r, actor, input.override && a.conflicts.length ? 'walk-in (collision override)' : 'walk-in');
    await setTableStatus(tx, table, 'OCCUPIED');
    await openOrder(tx, { venueId, tableId: table.id, reservationId: r.id, guestId });
    await tx.query('UPDATE guest_profiles SET last_visit_at = $2 WHERE guest_id = $1', [guestId, now]);
    return r.id;
  };

  let reservationId: string;
  try {
    reservationId = externalTx ? await execute(externalTx) : await withTx(execute);
  } catch (err: any) {
    if (err?.code === '23P01') {
      // Override can bypass the (turnaround + buffer) heuristic but never the physical interval.
      const venue = await getVenueById(venueId);
      const a = await analyseWalkIn(venue, input.partySize, input.tableId);
      throw conflict(
        'WALK_IN_COLLISION',
        `${a.message ?? 'This table has an overlapping booking.'} Override cannot double-book a table: an active booking overlaps the next ${venue.turnaround_mins} minutes. Reassign or cancel that booking first.`,
        { conflicts: a.conflicts, suggestions: a.suggestions },
      );
    }
    throw err;
  }
  return loadAdminReservation(reservationId);
}
