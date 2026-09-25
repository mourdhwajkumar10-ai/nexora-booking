import {
  ACTIVE_RESERVATION_STATUSES,
  type AuditLogDto,
  type CreateMenuItemInput,
  type CreateTableInput,
  type DiningTableDto,
  type Locality,
  type MenuItemDto,
  type ReplaceShiftsInput,
  type ShiftDef,
  type ShiftDto,
  type StaffUser,
  type UpdateTableInput,
  type UpdateVenueInput,
  type VenueCard,
  type VenueDetail,
  type VenueSettings,
} from '@nexora/shared';
import type { z } from 'zod';
import { audit } from '../../core/audit';
import { lockTable, type TableRow } from '../../core/tables';
import { getShifts } from '../../core/venues';
import { getPool, query, withTx, type Queryable, type Tx } from '../../db/pool';
import { assertVenueAccess } from '../../lib/auth';
import { clock } from '../../lib/clock';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { findShiftOverlap } from './hours';
import {
  toAuditLogDto,
  toLocality,
  toMenuItemDto,
  toShiftDto,
  toTableDto,
  toVenueCard,
  toVenueDetail,
  toVenueSettings,
  type VenueWithLocality,
} from './mappers';

type CreateTable = z.infer<typeof CreateTableInput>;
type UpdateTable = z.infer<typeof UpdateTableInput>;
type ReplaceShifts = z.infer<typeof ReplaceShiftsInput>;
type CreateMenuItem = z.infer<typeof CreateMenuItemInput>;

const ACTIVE = [...ACTIVE_RESERVATION_STATUSES];

const VENUE_SELECT = `SELECT v.*, l.name || ', ' || l.city AS locality_label FROM venues v JOIN localities l ON l.id = v.locality_id`;

// ---------------------------------------------------------------- public directory

export async function listLocalities(): Promise<Locality[]> {
  const rows = await query('SELECT id, slug, name, city FROM localities ORDER BY sort_order, name');
  return rows.map(toLocality);
}

/** Shifts for many venues in one query, keyed by venue id. */
async function shiftsByVenue(venueIds: string[]): Promise<Map<string, ShiftDef[]>> {
  const rows = await query<{ venue_id: string; day_of_week: number; open_time: string; close_time: string }>(
    `SELECT venue_id, day_of_week, open_time, close_time FROM operating_shifts
     WHERE venue_id = ANY($1::uuid[]) ORDER BY day_of_week, open_time`,
    [venueIds],
  );
  const out = new Map<string, ShiftDef[]>();
  for (const r of rows) {
    const list = out.get(r.venue_id) ?? [];
    list.push({ dayOfWeek: r.day_of_week, openTime: r.open_time.slice(0, 5), closeTime: r.close_time.slice(0, 5) });
    out.set(r.venue_id, list);
  }
  return out;
}

/** Active venues, optionally filtered by locality slug (unknown slug → []), best rated first. */
export async function listVenueCards(localitySlug?: string): Promise<VenueCard[]> {
  const venues = await query<VenueWithLocality>(
    `${VENUE_SELECT} WHERE v.is_active AND ($1::text IS NULL OR l.slug = $1)
     ORDER BY v.rating DESC, v.rating_count DESC, v.name`,
    [localitySlug ?? null],
  );
  const shifts = await shiftsByVenue(venues.map((v) => v.id));
  const now = clock.now();
  return venues.map((v) => toVenueCard(v, shifts.get(v.id) ?? [], now));
}

export async function getVenueDetail(slug: string): Promise<VenueDetail> {
  const [v] = await query<VenueWithLocality>(`${VENUE_SELECT} WHERE v.slug = $1 AND v.is_active`, [slug]);
  if (!v) throw notFound('Venue');
  return toVenueDetail(v, await getShifts(v.id), clock.now());
}

// ---------------------------------------------------------------- venue settings

async function loadVenue(venueId: string, db: Queryable, lock = false): Promise<VenueWithLocality> {
  const [v] = await query<VenueWithLocality>(`${VENUE_SELECT} WHERE v.id = $1 ${lock ? 'FOR UPDATE OF v' : ''}`, [venueId], db);
  if (!v) throw notFound('Venue');
  return v;
}

async function settingsOf(venueId: string, db: Queryable): Promise<VenueSettings> {
  const v = await loadVenue(venueId, db);
  return toVenueSettings(v, await getShifts(venueId, db), clock.now());
}

export async function getVenueSettings(venueId: string): Promise<VenueSettings> {
  return settingsOf(venueId, getPool());
}

const VENUE_COLUMNS: Record<keyof UpdateVenueInput, string> = {
  name: 'name',
  description: 'description',
  turnaroundMins: 'turnaround_mins',
  gracePeriodMins: 'grace_period_mins',
  triageTimeoutSecs: 'triage_timeout_secs',
  allowUpsizeFallback: 'allow_upsize_fallback',
  costForOnePaise: 'cost_for_one_paise',
  costForTwoPaise: 'cost_for_two_paise',
  isActive: 'is_active',
};

export async function updateVenue(venueId: string, input: UpdateVenueInput, actor: string): Promise<VenueSettings> {
  return withTx(async (tx) => {
    await loadVenue(venueId, tx.client, true);
    const entries = (Object.keys(VENUE_COLUMNS) as (keyof UpdateVenueInput)[])
      .filter((k) => input[k] !== undefined)
      .map((k) => [VENUE_COLUMNS[k], input[k]] as const);
    if (entries.length > 0) {
      const sets = entries.map(([col], i) => `${col} = $${i + 2}`).join(', ');
      await tx.query(`UPDATE venues SET ${sets} WHERE id = $1`, [venueId, ...entries.map(([, val]) => val)]);
      await audit(tx, { venueId, actor, action: 'venue.updated', entity: 'venue', entityId: venueId, data: input });
    }
    return settingsOf(venueId, tx.client);
  });
}

export async function setBlackout(venueId: string, input: { enabled: boolean; reason?: string }, actor: string): Promise<VenueSettings> {
  return withTx(async (tx) => {
    await loadVenue(venueId, tx.client, true);
    const reason = input.enabled ? input.reason?.trim() || null : null;
    await tx.query('UPDATE venues SET blackout = $2, blackout_reason = $3 WHERE id = $1', [venueId, input.enabled, reason]);
    await audit(tx, {
      venueId,
      actor,
      action: input.enabled ? 'venue.blackout_on' : 'venue.blackout_off',
      entity: 'venue',
      entityId: venueId,
      data: { reason },
    });
    return settingsOf(venueId, tx.client);
  });
}

/** Replace the whole weekly schedule atomically; overlapping shifts are rejected. */
export async function replaceShifts(venueId: string, input: ReplaceShifts, actor: string): Promise<ShiftDto[]> {
  const overlap = findShiftOverlap(input.shifts);
  if (overlap) {
    throw badRequest('SHIFT_OVERLAP', 'Shifts overlap', { shifts: overlap.map(toShiftDto) });
  }
  return withTx(async (tx) => {
    await loadVenue(venueId, tx.client, true);
    await tx.query('DELETE FROM operating_shifts WHERE venue_id = $1', [venueId]);
    for (const s of input.shifts) {
      await tx.query('INSERT INTO operating_shifts (venue_id, day_of_week, open_time, close_time) VALUES ($1,$2,$3,$4)', [
        venueId,
        s.dayOfWeek,
        s.openTime,
        s.closeTime,
      ]);
    }
    await audit(tx, { venueId, actor, action: 'shifts.replaced', entity: 'venue', entityId: venueId, data: { shifts: input.shifts } });
    return (await getShifts(venueId, tx.client)).map(toShiftDto);
  });
}

// ---------------------------------------------------------------- tables

/** Active (inventory-holding) reservations that have not ended yet, per table. */
async function upcomingCounts(db: Queryable, venueId: string, tableId?: string): Promise<Map<string, number>> {
  const rows = await query<{ table_id: string; n: number }>(
    `SELECT table_id, count(*)::int AS n FROM reservations
     WHERE venue_id = $1 AND table_id IS NOT NULL AND status = ANY($2::reservation_status[]) AND end_at > $3
       AND ($4::uuid IS NULL OR table_id = $4)
     GROUP BY table_id`,
    [venueId, ACTIVE, clock.now(), tableId ?? null],
    db,
  );
  return new Map(rows.map((r) => [r.table_id, r.n]));
}

async function tableDto(db: Queryable, t: TableRow): Promise<DiningTableDto> {
  const counts = await upcomingCounts(db, t.venue_id, t.id);
  return toTableDto(t, counts.get(t.id) ?? 0);
}

export async function listTables(venueId: string): Promise<DiningTableDto[]> {
  const pool = getPool();
  const rows = await query<TableRow>(
    'SELECT * FROM dining_tables WHERE venue_id = $1 AND archived_at IS NULL ORDER BY dining_zone, table_number',
    [venueId],
    pool,
  );
  const counts = await upcomingCounts(pool, venueId);
  return rows.map((t) => toTableDto(t, counts.get(t.id) ?? 0));
}

async function assertTableNumberFree(tx: Tx, venueId: string, tableNumber: string, exceptId?: string): Promise<void> {
  const clash = await tx.one(
    `SELECT id FROM dining_tables WHERE venue_id = $1 AND table_number = $2 AND archived_at IS NULL
       AND ($3::uuid IS NULL OR id <> $3)`,
    [venueId, tableNumber, exceptId ?? null],
  );
  if (clash) throw conflict('DUPLICATE_TABLE_NUMBER', `Table ${tableNumber} already exists`);
}

export async function createTable(venueId: string, input: CreateTable, actor: string): Promise<DiningTableDto> {
  return withTx(async (tx) => {
    await loadVenue(venueId, tx.client, true);
    await assertTableNumberFree(tx, venueId, input.tableNumber);
    const t = (await tx.one<TableRow>(
      `INSERT INTO dining_tables (venue_id, table_number, dining_zone, min_capacity, max_capacity, status_changed_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [venueId, input.tableNumber, input.diningZone, input.minCapacity, input.maxCapacity, clock.now()],
    ))!;
    await audit(tx, { venueId, actor, action: 'table.created', entity: 'table', entityId: t.id, data: input });
    tx.emit({ type: 'table.changed', venueId, tableIds: [t.id] });
    return toTableDto(t, 0);
  });
}

/** Lock a live table and check the caller may manage its venue. */
async function lockTableFor(tx: Tx, staff: StaffUser | undefined, tableId: string): Promise<TableRow> {
  const t = await lockTable(tx, tableId);
  assertVenueAccess(staff, t.venue_id);
  return t;
}

export async function updateTable(staff: StaffUser | undefined, tableId: string, input: UpdateTable, actor: string): Promise<DiningTableDto> {
  return withTx(async (tx) => {
    const t = await lockTableFor(tx, staff, tableId);
    const next = {
      tableNumber: input.tableNumber ?? t.table_number,
      diningZone: input.diningZone ?? t.dining_zone,
      minCapacity: input.minCapacity ?? t.min_capacity,
      maxCapacity: input.maxCapacity ?? t.max_capacity,
    };
    if (next.maxCapacity < next.minCapacity) {
      throw badRequest('INVALID_CAPACITY', 'max_capacity must be >= min_capacity');
    }
    if (next.tableNumber !== t.table_number) await assertTableNumberFree(tx, t.venue_id, next.tableNumber, t.id);

    // Capacity changes must still fit every party already booked on this table (active, not yet ended).
    const broken = await tx.query<{ id: string; party_size: number; start_at: Date }>(
      `SELECT id, party_size, start_at FROM reservations
       WHERE table_id = $1 AND status = ANY($2::reservation_status[]) AND end_at > $3
         AND (party_size > $4 OR party_size < $5)
       ORDER BY start_at LIMIT 20`,
      [t.id, ACTIVE, clock.now(), next.maxCapacity, next.minCapacity],
    );
    if (broken.length > 0) {
      throw conflict('TABLE_HAS_BOOKINGS', 'The new capacity does not fit existing bookings on this table', {
        reservations: broken.map((r) => ({ id: r.id, partySize: r.party_size, startAt: new Date(r.start_at).toISOString() })),
      });
    }

    const updated = (await tx.one<TableRow>(
      `UPDATE dining_tables SET table_number = $2, dining_zone = $3, min_capacity = $4, max_capacity = $5
       WHERE id = $1 RETURNING *`,
      [t.id, next.tableNumber, next.diningZone, next.minCapacity, next.maxCapacity],
    ))!;
    await audit(tx, {
      venueId: t.venue_id,
      actor,
      action: 'table.updated',
      entity: 'table',
      entityId: t.id,
      data: { before: { tableNumber: t.table_number, diningZone: t.dining_zone, minCapacity: t.min_capacity, maxCapacity: t.max_capacity }, after: next },
    });
    tx.emit({ type: 'table.changed', venueId: t.venue_id, tableIds: [t.id] });
    return tableDto(tx.client, updated);
  });
}

/** Soft delete (archived_at) so historical reservations/orders keep their table reference. */
export async function archiveTable(staff: StaffUser | undefined, tableId: string, actor: string): Promise<void> {
  await withTx(async (tx) => {
    const t = await lockTableFor(tx, staff, tableId);
    const n = (await upcomingCounts(tx.client, t.venue_id, t.id)).get(t.id) ?? 0;
    if (n > 0) {
      throw conflict('TABLE_HAS_BOOKINGS', `Table ${t.table_number} has ${n} active or upcoming booking(s)`, { count: n });
    }
    await tx.query('UPDATE dining_tables SET archived_at = $2 WHERE id = $1', [t.id, clock.now()]);
    await audit(tx, { venueId: t.venue_id, actor, action: 'table.archived', entity: 'table', entityId: t.id, data: { tableNumber: t.table_number } });
    tx.emit({ type: 'table.changed', venueId: t.venue_id, tableIds: [t.id] });
  });
}

// ---------------------------------------------------------------- menu & audit

export async function listMenu(venueId: string): Promise<MenuItemDto[]> {
  const rows = await query('SELECT * FROM menu_items WHERE venue_id = $1 ORDER BY category, sort_order, name', [venueId]);
  return rows.map(toMenuItemDto);
}

export async function createMenuItem(venueId: string, input: CreateMenuItem, actor: string): Promise<MenuItemDto> {
  return withTx(async (tx) => {
    await loadVenue(venueId, tx.client);
    const row = await tx.one('INSERT INTO menu_items (venue_id, name, category, price_paise) VALUES ($1,$2,$3,$4) RETURNING *', [
      venueId,
      input.name,
      input.category,
      input.pricePaise,
    ]);
    await audit(tx, { venueId, actor, action: 'menu_item.created', entity: 'menu_item', entityId: row.id, data: input });
    return toMenuItemDto(row);
  });
}

export async function listAudit(venueId: string): Promise<AuditLogDto[]> {
  const rows = await query('SELECT * FROM audit_logs WHERE venue_id = $1 ORDER BY created_at DESC, id LIMIT 100', [venueId]);
  return rows.map(toAuditLogDto);
}
