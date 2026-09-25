import {
  RESERVATION_TRANSITIONS,
  assertTransition,
  utcToZonedParts,
  type AdminReservation,
  type PublicReservation,
  type ReservationStatus,
} from '@nexora/shared';
import { getPool, query, type Queryable, type Tx } from '../db/pool';
import { clock } from '../lib/clock';
import { notFound } from '../lib/errors';
import { iso } from '../lib/http';
import { guestDisplayName, maskPhone } from './guests';

export interface ReservationRow {
  id: string;
  public_token: string;
  venue_id: string;
  table_id: string | null;
  guest_id: string;
  party_size: number;
  booking_date: string;
  start_at: Date;
  end_at: Date;
  source: 'ONLINE' | 'PHONE' | 'WALK_IN';
  status: ReservationStatus;
  dietary_requests: string | null;
  seating_preference: string | null;
  notes: string | null;
  escalated_at: Date | null;
  confirmed_at: Date | null;
  seated_at: Date | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Lock a reservation row for update inside a transaction. */
export async function lockReservation(tx: Tx, id: string): Promise<ReservationRow> {
  const r = await tx.one<ReservationRow>('SELECT * FROM reservations WHERE id = $1 FOR UPDATE', [id]);
  if (!r) throw notFound('Reservation');
  return r;
}

const TIMESTAMP_COLUMN: Partial<Record<ReservationStatus, string>> = {
  CONFIRMED: 'confirmed_at',
  SEATED: 'seated_at',
  COMPLETED: 'completed_at',
  CANCELLED: 'cancelled_at',
  NO_SHOW: 'cancelled_at',
};

/**
 * Apply a reservation FSM transition: validates, stamps the lifecycle timestamp, writes the
 * reservation_events audit row, and emits `reservation.changed` (published after commit).
 * Does NOT touch table status / orders — callers compose those with core/tables & core/orders.
 */
export async function transitionReservation(
  tx: Tx,
  current: ReservationRow,
  to: ReservationStatus,
  actor: string,
  opts: { note?: string; cancelReason?: string; extraSet?: Record<string, unknown> } = {},
): Promise<ReservationRow> {
  assertTransition('reservation', RESERVATION_TRANSITIONS, current.status, to);
  const now = clock.now();
  const sets: string[] = ['status = $2', 'updated_at = $3'];
  const params: unknown[] = [current.id, to, now];
  const col = TIMESTAMP_COLUMN[to];
  if (col) {
    params.push(now);
    sets.push(`${col} = $${params.length}`);
  }
  if (opts.cancelReason !== undefined) {
    params.push(opts.cancelReason);
    sets.push(`cancel_reason = $${params.length}`);
  }
  for (const [k, v] of Object.entries(opts.extraSet ?? {})) {
    params.push(v);
    sets.push(`${k} = $${params.length}`);
  }
  const updated = (await tx.one<ReservationRow>(`UPDATE reservations SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params))!;
  await tx.query(
    'INSERT INTO reservation_events (reservation_id, from_status, to_status, actor, note, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
    [current.id, current.status, to, actor, opts.note ?? opts.cancelReason ?? null, now],
  );
  tx.emit({
    type: 'reservation.changed',
    venueId: updated.venue_id,
    reservationId: updated.id,
    guestId: updated.guest_id,
    tableId: updated.table_id,
    from: current.status,
    to,
  });
  return updated;
}

/** Record the initial (null -> status) event for a newly inserted reservation. */
export async function recordCreated(tx: Tx, r: ReservationRow, actor: string, note?: string): Promise<void> {
  await tx.query(
    'INSERT INTO reservation_events (reservation_id, from_status, to_status, actor, note, created_at) VALUES ($1,NULL,$2,$3,$4,$5)',
    [r.id, r.status, actor, note ?? null, clock.now()],
  );
  tx.emit({ type: 'reservation.changed', venueId: r.venue_id, reservationId: r.id, guestId: r.guest_id, tableId: r.table_id, from: null, to: r.status });
}

const ADMIN_SELECT = `
  SELECT r.*, v.timezone, v.triage_timeout_secs,
         t.table_number, t.max_capacity,
         g.first_name, g.last_name, g.phone_number, g.email,
         gp.allergies, gp.no_show_count, gp.total_visits,
         la.tier_level,
         COALESCE((SELECT array_agg(tag_name ORDER BY tag_name) FROM guest_tags gt WHERE gt.guest_id = g.id), '{}') AS tags
  FROM reservations r
  JOIN venues v ON v.id = r.venue_id
  JOIN guests g ON g.id = r.guest_id
  LEFT JOIN guest_profiles gp ON gp.guest_id = g.id
  LEFT JOIN loyalty_accounts la ON la.guest_id = g.id
  LEFT JOIN dining_tables t ON t.id = r.table_id`;

export function toAdminReservation(r: any): AdminReservation {
  const local = utcToZonedParts(new Date(r.start_at), r.timezone);
  return {
    id: r.id,
    token: r.public_token,
    venueId: r.venue_id,
    status: r.status,
    source: r.source,
    date: local.date,
    time: local.time,
    startAt: iso(r.start_at)!,
    endAt: iso(r.end_at)!,
    partySize: r.party_size,
    table: r.table_id ? { id: r.table_id, tableNumber: r.table_number, maxCapacity: r.max_capacity } : null,
    guest: {
      id: r.guest_id,
      name: guestDisplayName(r),
      phone: r.phone_number,
      email: r.email,
      tags: r.tags ?? [],
      allergies: r.allergies ?? null,
      tier: r.tier_level ?? null,
      noShowCount: r.no_show_count ?? 0,
      totalVisits: r.total_visits ?? 0,
    },
    dietaryRequests: r.dietary_requests,
    seatingPreference: r.seating_preference,
    notes: r.notes,
    escalatedAt: iso(r.escalated_at),
    triageDeadline: r.status === 'REQUESTED' ? new Date(new Date(r.created_at).getTime() + r.triage_timeout_secs * 1000).toISOString() : null,
    createdAt: iso(r.created_at)!,
    confirmedAt: iso(r.confirmed_at),
    seatedAt: iso(r.seated_at),
    completedAt: iso(r.completed_at),
    cancelledAt: iso(r.cancelled_at),
    cancelReason: r.cancel_reason,
  };
}

export async function loadAdminReservations(where: string, params: unknown[], db: Queryable = getPool(), orderBy = 'r.start_at ASC'): Promise<AdminReservation[]> {
  const rows = await query(`${ADMIN_SELECT} WHERE ${where} ORDER BY ${orderBy}`, params, db);
  return rows.map(toAdminReservation);
}

export async function loadAdminReservation(id: string, db: Queryable = getPool()): Promise<AdminReservation> {
  const [r] = await loadAdminReservations('r.id = $1', [id], db);
  if (!r) throw notFound('Reservation');
  return r;
}

export async function loadPublicReservation(token: string, db: Queryable = getPool()): Promise<PublicReservation> {
  const [r] = await query(
    `SELECT r.*, v.slug AS venue_slug, v.name AS venue_name, v.address, v.image_url, v.timezone,
            l.name || ', ' || l.city AS locality_label,
            g.first_name, g.last_name, g.phone_number, t.table_number
     FROM reservations r
     JOIN venues v ON v.id = r.venue_id
     JOIN localities l ON l.id = v.locality_id
     JOIN guests g ON g.id = r.guest_id
     LEFT JOIN dining_tables t ON t.id = r.table_id
     WHERE r.public_token = $1`,
    [token],
    db,
  );
  if (!r) throw notFound('Reservation');
  const local = utcToZonedParts(new Date(r.start_at), r.timezone);
  const revealTable = ['CONFIRMED', 'SEATED', 'COMPLETED'].includes(r.status);
  return {
    token: r.public_token,
    status: r.status,
    venue: { slug: r.venue_slug, name: r.venue_name, address: r.address, localityLabel: r.locality_label, imageUrl: r.image_url },
    date: local.date,
    time: local.time,
    startAt: iso(r.start_at)!,
    endAt: iso(r.end_at)!,
    partySize: r.party_size,
    guestName: guestDisplayName(r),
    phoneMasked: maskPhone(r.phone_number),
    tableNumber: revealTable ? r.table_number : null,
    createdAt: iso(r.created_at)!,
    confirmedAt: iso(r.confirmed_at),
    cancelledAt: iso(r.cancelled_at),
    cancelReason: r.cancel_reason,
  };
}
