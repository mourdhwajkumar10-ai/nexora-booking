/**
 * Booking engine (module A2). Availability is computed in memory from two queries; allocation
 * tries best-fit candidates one at a time, each in its own READ COMMITTED transaction:
 * lock the table row -> re-check overlap -> insert (CRITIQUE C-02, C-07). The EXCLUDE constraint
 * is the backstop: a 23P01 is treated as "this candidate is taken".
 */
import {
  MAX_ACTIVE_REQUESTS_PER_PHONE,
  RESERVATION_STATUSES,
  RESERVATION_TRANSITIONS,
  assertTransition,
  bestFitOrder,
  dayOfWeekFor,
  generateSlots,
  overlaps,
  parseHm,
  utcToZonedParts,
  validateRequestedSlot,
  type AdminReservation,
  type AvailabilityResponse,
  type ReservationSource,
  type ReservationStatus,
  type SlotAvailability,
  type StaffUser,
  type TableStatus,
} from '@nexora/shared';
import { getPool, query, queryOne, withTx, type Queryable, type Tx } from '../../db/pool';
import { upsertGuest } from '../../core/guests';
import { lockOrder, openOrder, transitionOrder, type OrderRow } from '../../core/orders';
import {
  loadAdminReservation,
  lockReservation,
  recordCreated,
  transitionReservation,
  type ReservationRow,
} from '../../core/reservations';
import { lockTable, setTableStatus, type TableRow } from '../../core/tables';
import { getShifts, type VenueRow } from '../../core/venues';
import { assertVenueAccess } from '../../lib/auth';
import { clock } from '../../lib/clock';
import { AppError, badRequest, conflict, notFound, unprocessable } from '../../lib/errors';
import { notifyReservation } from './notify';

const ACTIVE_SQL = `('REQUESTED','CONFIRMED','SEATED')`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALTERNATIVE_WINDOW_MINS = 60;

export function assertUuid(id: string, entity: string): void {
  if (!UUID_RE.test(id)) throw notFound(entity);
}

/** zod only checks the YYYY-MM-DD shape; reject impossible dates like 2026-02-31. */
export function assertValidDate(date: string): void {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) throw badRequest('VALIDATION_ERROR', 'Invalid date');
}

interface VenueTable {
  id: string;
  tableNumber: string;
  minCapacity: number;
  maxCapacity: number;
  status: TableStatus;
}

async function loadTables(venueId: string, db: Queryable = getPool()): Promise<VenueTable[]> {
  const rows = await query(
    `SELECT id, table_number, min_capacity, max_capacity, status FROM dining_tables
     WHERE venue_id = $1 AND archived_at IS NULL`,
    [venueId],
    db,
  );
  return rows.map((r) => ({ id: r.id, tableNumber: r.table_number, minCapacity: r.min_capacity, maxCapacity: r.max_capacity, status: r.status }));
}

const fitsParty = (t: { minCapacity: number; maxCapacity: number }, p: number) => t.minCapacity <= p && p <= t.maxCapacity;

// ------------------------------------------------------------------ availability

export async function computeAvailability(venue: VenueRow, date: string, partySize: number): Promise<AvailabilityResponse> {
  assertValidDate(date);
  const now = clock.now();
  const shifts = await getShifts(venue.id);
  const dow = dayOfWeekFor(date);
  const slots = generateSlots(date, shifts, venue.turnaround_mins, venue.timezone);
  const base = {
    venueId: venue.id,
    date,
    partySize,
    turnaroundMins: venue.turnaround_mins,
    closed: !shifts.some((s) => s.dayOfWeek === dow),
    blackout: venue.blackout,
    serverTime: now.toISOString(),
  };
  if (slots.length === 0) return { ...base, slots: [] };

  const windowStart = slots[0].start;
  const windowEnd = new Date(Math.max(...slots.map((s) => s.end.getTime())));
  const [tables, reservations] = await Promise.all([
    loadTables(venue.id),
    query<{ table_id: string; start_at: Date; end_at: Date }>(
      `SELECT table_id, start_at, end_at FROM reservations
       WHERE venue_id = $1 AND table_id IS NOT NULL AND status IN ${ACTIVE_SQL}
         AND start_at < $3 AND end_at > $2`,
      [venue.id, windowStart, windowEnd],
    ),
  ]);

  // Tables this party may be allocated to (honours allow_upsize_fallback), ignoring time.
  const allowed = bestFitOrder(
    tables.filter((t) => t.status !== 'BLOCKED'),
    partySize,
    venue.allow_upsize_fallback,
  );
  const busy = new Map<string, { start: Date; end: Date }[]>();
  for (const r of reservations) {
    const list = busy.get(r.table_id) ?? [];
    list.push({ start: new Date(r.start_at), end: new Date(r.end_at) });
    busy.set(r.table_id, list);
  }

  const out: SlotAvailability[] = slots.map((s) => {
    const tablesLeft = allowed.filter((t) => !(busy.get(t.id) ?? []).some((iv) => overlaps(s, iv))).length;
    const past = s.start.getTime() < now.getTime();
    return {
      time: s.time,
      startAt: s.start.toISOString(),
      endAt: s.end.toISOString(),
      available: !venue.blackout && !past && tablesLeft > 0,
      tablesLeft: venue.blackout ? 0 : tablesLeft,
      past,
    };
  });
  return { ...base, slots: out };
}

/** Nearest available slot times within ±60 min of the requested time (closest first). */
async function findAlternatives(venue: VenueRow, date: string, time: string, partySize: number): Promise<string[]> {
  const avail = await computeAvailability(venue, date, partySize);
  const target = parseHm(time);
  return avail.slots
    .filter((s) => s.available && s.time !== time)
    .map((s) => ({ time: s.time, diff: Math.abs(parseHm(s.time) - target) }))
    .filter((s) => s.diff <= ALTERNATIVE_WINDOW_MINS)
    .sort((a, b) => a.diff - b.diff || a.time.localeCompare(b.time))
    .map((s) => s.time);
}

// ------------------------------------------------------------------ create booking

export interface BookingRequest {
  date: string;
  time: string;
  partySize: number;
  fullName: string;
  phone: string;
  email?: string;
  dietaryRequests?: string;
  seatingPreference?: string;
  notes?: string;
}

export interface BookingOptions {
  source: ReservationSource;
  status: 'REQUESTED' | 'CONFIRMED';
  actor: string;
  /** Host override: book this specific table (still locked + overlap-checked). */
  tableId?: string;
}

/**
 * The single booking engine shared by the public flow and host phone-ins.
 * Validation order: blackout, slot validity, past, party fit, per-phone cap. Then best-fit allocation.
 */
export async function createBooking(venue: VenueRow, input: BookingRequest, opts: BookingOptions): Promise<ReservationRow> {
  assertValidDate(input.date);
  if (venue.blackout) {
    throw unprocessable('VENUE_BLACKOUT', venue.blackout_reason ? `Not taking bookings: ${venue.blackout_reason}` : 'This venue is not taking bookings right now');
  }
  const shifts = await getShifts(venue.id);
  const slot = validateRequestedSlot(input.date, input.time, shifts, venue.turnaround_mins, venue.timezone);
  if (!slot.ok) {
    throw unprocessable(
      slot.reason,
      slot.reason === 'OFF_GRID' ? 'Bookings start on 15-minute boundaries' : 'That time is outside the venue’s bookable hours',
    );
  }
  if (slot.start.getTime() < clock.now().getTime()) throw badRequest('IN_PAST', 'That time has already passed');

  const tables = await loadTables(venue.id);
  let candidates: VenueTable[];
  if (opts.tableId) {
    const t = tables.find((x) => x.id === opts.tableId);
    if (!t) throw notFound('Table');
    if (!fitsParty(t, input.partySize)) {
      throw unprocessable('NO_TABLE_FOR_PARTY', `Table ${t.tableNumber} seats ${t.minCapacity}–${t.maxCapacity}, not a party of ${input.partySize}`);
    }
    candidates = t.status === 'BLOCKED' ? [] : [t];
  } else {
    if (!tables.some((t) => fitsParty(t, input.partySize))) {
      throw unprocessable('NO_TABLE_FOR_PARTY', `No table here seats a party of ${input.partySize}`);
    }
    candidates = bestFitOrder(
      tables.filter((t) => t.status !== 'BLOCKED'),
      input.partySize,
      venue.allow_upsize_fallback,
    );
  }

  if (opts.status === 'REQUESTED') {
    const c = await queryOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM reservations r JOIN guests g ON g.id = r.guest_id
       WHERE g.phone_number = $1 AND r.status = 'REQUESTED' AND r.end_at > $2`,
      [input.phone, clock.now()],
    );
    if ((c?.n ?? 0) >= MAX_ACTIVE_REQUESTS_PER_PHONE) {
      throw unprocessable('TOO_MANY_REQUESTS_FOR_PHONE', `This phone number already has ${MAX_ACTIVE_REQUESTS_PER_PHONE} pending requests`);
    }
  }

  for (const c of candidates) {
    const row = await tryAllocate(venue, c.id, slot.start, slot.end, input, opts);
    if (row) return row;
  }
  const alternatives = await findAlternatives(venue, input.date, input.time, input.partySize);
  throw conflict('SLOT_UNAVAILABLE', 'No table is available at that time', { alternatives });
}

/** One candidate, one transaction: lock -> re-check overlap -> insert. Returns null on conflict. */
async function tryAllocate(
  venue: VenueRow,
  tableId: string,
  start: Date,
  end: Date,
  input: BookingRequest,
  opts: BookingOptions,
): Promise<ReservationRow | null> {
  try {
    return await withTx(async (tx) => {
      const table = await tx.one<TableRow>('SELECT * FROM dining_tables WHERE id = $1 AND archived_at IS NULL FOR UPDATE', [tableId]);
      if (!table || table.status === 'BLOCKED') return null;
      // Fresh READ COMMITTED snapshot after the lock: sees any winner that committed while we waited.
      const clash = await tx.one(
        `SELECT 1 FROM reservations
         WHERE table_id = $1 AND status IN ${ACTIVE_SQL} AND start_at < $3 AND end_at > $2 LIMIT 1`,
        [tableId, start, end],
      );
      if (clash) return null;

      const { guest } = await upsertGuest(tx, { fullName: input.fullName, phone: input.phone, email: input.email });
      const now = clock.now();
      const r = (await tx.one<ReservationRow>(
        `INSERT INTO reservations (venue_id, table_id, guest_id, party_size, booking_date, start_at, end_at, source, status,
                                   dietary_requests, seating_preference, notes, confirmed_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14) RETURNING *`,
        [
          venue.id,
          tableId,
          guest.id,
          input.partySize,
          utcToZonedParts(start, venue.timezone).date,
          start,
          end,
          opts.source,
          opts.status,
          input.dietaryRequests || null,
          input.seatingPreference ?? null,
          input.notes || null,
          opts.status === 'CONFIRMED' ? now : null,
          now,
        ],
      ))!;
      await recordCreated(tx, r, opts.actor);
      await notifyReservation(tx, r.id, opts.status === 'CONFIRMED' ? 'RESERVATION_CONFIRMED' : 'RESERVATION_REQUESTED');
      return r;
    });
  } catch (err: any) {
    if (err?.code === '23P01') return null; // EXCLUDE backstop fired: someone else won this table
    throw err;
  }
}

// ------------------------------------------------------------------ public tracker

export async function cancelByGuest(token: string, phoneLast4: string): Promise<void> {
  await withTx(async (tx) => {
    const ref = await tx.one<{ id: string }>('SELECT id FROM reservations WHERE public_token = $1', [token]);
    if (!ref) throw notFound('Reservation');
    const r = await lockReservation(tx, ref.id);
    const g = await tx.one<{ phone_number: string }>('SELECT phone_number FROM guests WHERE id = $1', [r.guest_id]);
    if (!g || g.phone_number.slice(-4) !== phoneLast4) {
      throw new AppError(403, 'PHONE_MISMATCH', 'The phone number does not match this booking');
    }
    await transitionReservation(tx, r, 'CANCELLED', 'guest', { cancelReason: 'Cancelled by guest' });
    await notifyReservation(tx, r.id, 'RESERVATION_CANCELLED');
  });
}

// ------------------------------------------------------------------ admin

export function parseStatuses(raw: string | undefined): ReservationStatus[] | null {
  if (!raw) return null;
  const list = raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  for (const s of list) {
    if (!(RESERVATION_STATUSES as readonly string[]).includes(s)) throw badRequest('VALIDATION_ERROR', `Unknown status ${s}`);
  }
  return list.length ? (list as ReservationStatus[]) : null;
}

/** Lock the reservation, check venue access, run `fn`, then return the fresh admin DTO. */
async function adminAction(staff: StaffUser | undefined, id: string, fn: (tx: Tx, r: ReservationRow) => Promise<void>): Promise<AdminReservation> {
  assertUuid(id, 'Reservation');
  await withTx(async (tx) => {
    const r = await lockReservation(tx, id);
    assertVenueAccess(staff, r.venue_id);
    await fn(tx, r);
  });
  return loadAdminReservation(id);
}

export const approve = (staff: StaffUser | undefined, id: string, actor: string) =>
  adminAction(staff, id, async (tx, r) => {
    await transitionReservation(tx, r, 'CONFIRMED', actor);
    await notifyReservation(tx, r.id, 'RESERVATION_CONFIRMED');
  });

export const reject = (staff: StaffUser | undefined, id: string, actor: string, reason?: string) =>
  adminAction(staff, id, async (tx, r) => {
    if (r.status !== 'REQUESTED') throw conflict('ILLEGAL_TRANSITION', `Only requested reservations can be rejected (status is ${r.status})`, { from: r.status, to: 'CANCELLED' });
    await transitionReservation(tx, r, 'CANCELLED', actor, { cancelReason: reason || 'Declined by venue' });
    await notifyReservation(tx, r.id, 'RESERVATION_DECLINED', reason);
  });

export const cancelByStaff = (staff: StaffUser | undefined, id: string, actor: string, reason?: string) =>
  adminAction(staff, id, async (tx, r) => {
    await transitionReservation(tx, r, 'CANCELLED', actor, { cancelReason: reason || 'Cancelled by venue' });
    await notifyReservation(tx, r.id, 'RESERVATION_CANCELLED', reason);
  });

export const seat = (staff: StaffUser | undefined, id: string, actor: string) =>
  adminAction(staff, id, async (tx, r) => {
    assertTransition('reservation', RESERVATION_TRANSITIONS, r.status, 'SEATED');
    if (!r.table_id) throw conflict('NO_TABLE_ASSIGNED', 'Assign a table before seating');
    const table = await lockTable(tx, r.table_id);
    if (table.status !== 'AVAILABLE') {
      throw conflict('TABLE_NOT_READY', `Table ${table.table_number} is ${table.status.toLowerCase()}`, { tableId: table.id, status: table.status });
    }
    await setTableStatus(tx, table, 'OCCUPIED');
    await transitionReservation(tx, r, 'SEATED', actor);
    await openOrder(tx, { venueId: r.venue_id, tableId: table.id, reservationId: r.id, guestId: r.guest_id });
    await tx.query(
      `INSERT INTO guest_profiles (guest_id, last_visit_at) VALUES ($1,$2)
       ON CONFLICT (guest_id) DO UPDATE SET last_visit_at = EXCLUDED.last_visit_at`,
      [r.guest_id, clock.now()],
    );
  });

export const complete = (staff: StaffUser | undefined, id: string, actor: string) =>
  adminAction(staff, id, async (tx, r) => {
    assertTransition('reservation', RESERVATION_TRANSITIONS, r.status, 'COMPLETED');
    const open = await tx.one<OrderRow & { item_count: number }>(
      `SELECT o.*, (SELECT count(*)::int FROM pos_order_items i WHERE i.order_id = o.id AND NOT i.is_voided) AS item_count
       FROM pos_orders o WHERE o.reservation_id = $1 AND o.status NOT IN ('BILLED','VOIDED')
       ORDER BY o.created_at DESC LIMIT 1`,
      [r.id],
    );
    if (open) {
      if (open.item_count > 0) throw conflict('CHECK_OPEN', 'Settle the check before clearing the table', { orderId: open.id, status: open.status });
      await transitionOrder(tx, await lockOrder(tx, open.id), 'VOIDED');
    }
    if (r.table_id) {
      const table = await tx.one<TableRow>('SELECT * FROM dining_tables WHERE id = $1 FOR UPDATE', [r.table_id]);
      if (table && table.status === 'OCCUPIED') await setTableStatus(tx, table, 'BUSSING');
    }
    await transitionReservation(tx, r, 'COMPLETED', actor);
    await tx.query(
      `INSERT INTO guest_profiles (guest_id, total_visits, avg_party_size) VALUES ($1, 1, $2)
       ON CONFLICT (guest_id) DO UPDATE SET
         avg_party_size = ROUND((guest_profiles.avg_party_size * guest_profiles.total_visits + $2) / (guest_profiles.total_visits + 1), 2),
         total_visits   = guest_profiles.total_visits + 1`,
      [r.guest_id, r.party_size],
    );
  });

/** CONFIRMED -> NO_SHOW with the counter bump + guest SMS. Shared by the admin action and the grace worker. */
export async function markNoShow(tx: Tx, r: ReservationRow, actor: string): Promise<ReservationRow> {
  const updated = await transitionReservation(tx, r, 'NO_SHOW', actor, { cancelReason: 'No-show' });
  await tx.query(
    `INSERT INTO guest_profiles (guest_id, no_show_count) VALUES ($1, 1)
     ON CONFLICT (guest_id) DO UPDATE SET no_show_count = guest_profiles.no_show_count + 1`,
    [r.guest_id],
  );
  await notifyReservation(tx, r.id, 'NO_SHOW');
  return updated;
}

export const noShow = (staff: StaffUser | undefined, id: string, actor: string) =>
  adminAction(staff, id, async (tx, r) => {
    await markNoShow(tx, r, actor);
  });

export const reassign = (staff: StaffUser | undefined, id: string, actor: string, tableId: string) =>
  adminAction(staff, id, async (tx, r) => {
    if (r.status !== 'REQUESTED' && r.status !== 'CONFIRMED') {
      throw conflict('INVALID_STATUS', `Only requested or confirmed reservations can be reassigned (status is ${r.status})`);
    }
    if (r.table_id === tableId) return;
    const table = await tx.one<TableRow>('SELECT * FROM dining_tables WHERE id = $1 AND archived_at IS NULL FOR UPDATE', [tableId]);
    if (!table || table.venue_id !== r.venue_id) throw notFound('Table');
    if (table.status === 'BLOCKED') throw conflict('TABLE_BLOCKED', `Table ${table.table_number} is blocked`);
    if (!fitsParty({ minCapacity: table.min_capacity, maxCapacity: table.max_capacity }, r.party_size)) {
      throw unprocessable('NO_TABLE_FOR_PARTY', `Table ${table.table_number} seats ${table.min_capacity}–${table.max_capacity}, not a party of ${r.party_size}`);
    }
    const clash = await tx.one(
      `SELECT 1 FROM reservations
       WHERE table_id = $1 AND id <> $4 AND status IN ${ACTIVE_SQL} AND start_at < $3 AND end_at > $2 LIMIT 1`,
      [tableId, r.start_at, r.end_at, r.id],
    );
    if (clash) throw conflict('SLOT_UNAVAILABLE', `Table ${table.table_number} is already booked at that time`, { alternatives: [] });
    const now = clock.now();
    await tx.query('UPDATE reservations SET table_id = $2, updated_at = $3 WHERE id = $1', [r.id, tableId, now]);
    await tx.query(
      'INSERT INTO reservation_events (reservation_id, from_status, to_status, actor, note, created_at) VALUES ($1,$2,$2,$3,$4,$5)',
      [r.id, r.status, actor, `Reassigned to table ${table.table_number}`, now],
    );
    tx.emit({ type: 'reservation.changed', venueId: r.venue_id, reservationId: r.id, guestId: r.guest_id, tableId, from: r.status, to: r.status });
    tx.emit({ type: 'table.changed', venueId: r.venue_id, tableIds: [r.table_id, tableId].filter((x): x is string => !!x) });
  });
