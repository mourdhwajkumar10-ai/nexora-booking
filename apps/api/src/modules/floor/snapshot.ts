import {
  DINING_ZONES,
  DWELL_RED_EXTRA_MINS,
  FLOOR_STATUSES,
  dwellLevel,
  type FloorSnapshot,
  type FloorStatus,
  type FloorTable,
} from '@nexora/shared';
import { getPool, query, type Queryable } from '../../db/pool';
import { getVenueById } from '../../core/venues';
import { guestDisplayName } from '../../core/guests';
import { clock } from '../../lib/clock';
import { iso } from '../../lib/http';

const zoneRank = (z: string): number => {
  const i = (DINING_ZONES as readonly string[]).indexOf(z);
  return i === -1 ? DINING_ZONES.length : i;
};

/** Zone (canonical DINING_ZONES order, then alphabetical), then natural table number (T-2 < T-10). */
export function compareTables(a: { diningZone: string; tableNumber: string }, b: { diningZone: string; tableNumber: string }): number {
  return (
    zoneRank(a.diningZone) - zoneRank(b.diningZone) ||
    a.diningZone.localeCompare(b.diningZone) ||
    a.tableNumber.localeCompare(b.tableNumber, undefined, { numeric: true })
  );
}

/**
 * Build the floor snapshot (E3-S1). Five queries total regardless of table count:
 * venue, tables (+ derived RESERVED flag), current seatings, open orders, next bookings.
 * Pass `tableId` to build a single table's FloorTable (counts/covers then cover just that table).
 */
export async function buildFloorSnapshot(venueId: string, opts: { tableId?: string } = {}, db: Queryable = getPool()): Promise<FloorSnapshot> {
  const now = clock.now();
  const venue = await getVenueById(venueId, db);
  const turn = venue.turnaround_mins;
  const grace = venue.grace_period_mins;
  const tableFilter = opts.tableId ? 'AND t.id = $5' : '';
  const tableFilterR = opts.tableId ? 'AND r.table_id = $3' : '';
  const tableFilterO = opts.tableId ? 'AND o.table_id = $2' : '';
  const extra = opts.tableId ? [opts.tableId] : [];

  const [tables, seated, orders, next] = await Promise.all([
    // RESERVED (derived, ARCHITECTURE §3): a CONFIRMED booking with start − turnaround ≤ now < start + grace.
    query(
      `SELECT t.*, EXISTS (
          SELECT 1 FROM reservations r
          WHERE r.table_id = t.id AND r.status = 'CONFIRMED'
            AND r.start_at - make_interval(mins => $2) <= $3
            AND $3 < r.start_at + make_interval(mins => $4)
        ) AS reserved_now
       FROM dining_tables t
       WHERE t.venue_id = $1 AND t.archived_at IS NULL ${tableFilter}`,
      [venueId, turn, now, grace, ...extra],
      db,
    ),
    query(
      `SELECT DISTINCT ON (r.table_id)
              r.id, r.table_id, r.guest_id, r.party_size, r.seated_at, r.source,
              g.first_name, g.last_name, gp.allergies,
              COALESCE((SELECT array_agg(tag_name ORDER BY tag_name) FROM guest_tags gt WHERE gt.guest_id = g.id), '{}') AS tags
       FROM reservations r
       JOIN guests g ON g.id = r.guest_id
       LEFT JOIN guest_profiles gp ON gp.guest_id = g.id
       WHERE r.venue_id = $1 AND r.status = 'SEATED' AND r.table_id IS NOT NULL AND r.seated_at <= $2 ${tableFilterR}
       ORDER BY r.table_id, r.seated_at DESC`,
      [venueId, now, ...extra],
      db,
    ),
    query(
      `SELECT o.id, o.table_id, o.status, o.placed_at, o.received_at, o.net_paise,
              COALESCE((SELECT SUM(i.quantity) FROM pos_order_items i WHERE i.order_id = o.id AND NOT i.is_voided), 0) AS item_count
       FROM pos_orders o
       WHERE o.venue_id = $1 AND o.status NOT IN ('BILLED', 'VOIDED') ${tableFilterO}`,
      [venueId, ...extra],
      db,
    ),
    query(
      `SELECT DISTINCT ON (r.table_id) r.id, r.table_id, r.party_size, r.start_at, r.status, g.first_name, g.last_name
       FROM reservations r JOIN guests g ON g.id = r.guest_id
       WHERE r.venue_id = $1 AND r.status IN ('REQUESTED', 'CONFIRMED') AND r.table_id IS NOT NULL
         AND r.start_at >= $2 ${tableFilterR}
       ORDER BY r.table_id, r.start_at ASC`,
      [venueId, new Date(now.getTime() - grace * 60_000), ...extra],
      db,
    ),
  ]);

  const seatedBy = new Map(seated.map((r) => [r.table_id, r]));
  const orderBy = new Map(orders.map((o) => [o.table_id, o]));
  const nextBy = new Map(next.map((r) => [r.table_id, r]));

  const out: FloorTable[] = tables.map((t) => {
    const s = seatedBy.get(t.id);
    const o = orderBy.get(t.id);
    const n = nextBy.get(t.id);
    const floorStatus: FloorStatus = t.status === 'AVAILABLE' && t.reserved_now ? 'RESERVED' : t.status;
    const elapsedSecs = s ? Math.max(0, Math.floor((now.getTime() - new Date(s.seated_at).getTime()) / 1000)) : 0;
    return {
      id: t.id,
      tableNumber: t.table_number,
      diningZone: t.dining_zone,
      minCapacity: t.min_capacity,
      maxCapacity: t.max_capacity,
      physicalStatus: t.status,
      floorStatus,
      statusChangedAt: iso(t.status_changed_at)!,
      current: s
        ? {
            reservationId: s.id,
            guestId: s.guest_id,
            guestName: guestDisplayName(s),
            partySize: s.party_size,
            seatedAt: iso(s.seated_at)!,
            tags: s.tags ?? [],
            allergies: s.allergies ?? null,
            source: s.source,
          }
        : null,
      order: o
        ? {
            id: o.id,
            status: o.status,
            placedAt: iso(o.placed_at)!,
            receivedAt: iso(o.received_at),
            itemCount: Number(o.item_count),
            netPaise: o.net_paise,
          }
        : null,
      next: n
        ? { reservationId: n.id, guestName: guestDisplayName(n), partySize: n.party_size, startAt: iso(n.start_at)!, status: n.status }
        : null,
      dwell: s ? { seatedAt: iso(s.seated_at)!, elapsedSecs, level: dwellLevel(elapsedSecs, turn, DWELL_RED_EXTRA_MINS) } : null,
    };
  });
  out.sort(compareTables);

  const counts = Object.fromEntries(FLOOR_STATUSES.map((s) => [s, 0])) as Record<FloorStatus, number>;
  for (const t of out) counts[t.floorStatus]++;

  return {
    serverTime: now.toISOString(),
    venue: { id: venue.id, name: venue.name, turnaroundMins: turn, gracePeriodMins: grace, blackout: venue.blackout, timezone: venue.timezone },
    counts,
    covers: {
      seated: out.reduce((sum, t) => sum + (t.current?.partySize ?? 0), 0),
      capacity: out.filter((t) => t.physicalStatus !== 'BLOCKED').reduce((sum, t) => sum + t.maxCapacity, 0),
    },
    tables: out,
  };
}
