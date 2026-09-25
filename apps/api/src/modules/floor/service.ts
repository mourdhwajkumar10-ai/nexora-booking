import type { AddOrderItemInput, FloorTable, OrderDetail, OrderStatus, StaffUser, TableStatusInput } from '@nexora/shared';
import type { z } from 'zod';
import { queryOne, withTx } from '../../db/pool';
import { audit } from '../../core/audit';
import { OPEN_ORDER_STATUSES, loadOrderDetail, lockOrder, recalcOrderTotals, transitionOrder, type OrderRow } from '../../core/orders';
import { lockTable, setTableStatus } from '../../core/tables';
import { assertVenueAccess } from '../../lib/auth';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { clock } from '../../lib/clock';
import { buildFloorSnapshot } from './snapshot';

/** Statuses a host may set through POST /admin/orders/:id/status (KDS progression only). */
export const KDS_STATUSES: OrderStatus[] = ['RECEIVED', 'PREPARING', 'SERVED'];

export async function floorTable(venueId: string, tableId: string): Promise<FloorTable> {
  const snap = await buildFloorSnapshot(venueId, { tableId });
  if (!snap.tables[0]) throw notFound('Table');
  return snap.tables[0];
}

/** Block / unblock / mark clean (E3-S3). */
export async function changeTableStatus(
  staff: StaffUser | undefined,
  tableId: string,
  input: z.infer<typeof TableStatusInput>,
  actor: string,
): Promise<FloorTable> {
  const venueId = await withTx(async (tx) => {
    const table = await lockTable(tx, tableId);
    assertVenueAccess(staff, table.venue_id);
    if (table.status === 'OCCUPIED') {
      // Blocking is never allowed; bussing a seated table must go through "complete" (booking module).
      const seated = await tx.one(`SELECT id FROM reservations WHERE table_id = $1 AND status = 'SEATED' LIMIT 1`, [table.id]);
      if (input.status === 'BLOCKED' || seated) {
        throw conflict('TABLE_OCCUPIED', `Table ${table.table_number} is occupied${seated ? '; complete the seating first' : ''}`);
      }
    }
    const from = table.status;
    const updated = await setTableStatus(tx, table, input.status);
    if (from !== updated.status) {
      await audit(tx, {
        venueId: table.venue_id,
        actor,
        action: 'table.status',
        entity: 'table',
        entityId: table.id,
        data: { from, to: updated.status, reason: input.reason ?? null },
      });
    }
    return table.venue_id;
  });
  return floorTable(venueId, tableId);
}

export async function getTableOrder(staff: StaffUser | undefined, tableId: string): Promise<OrderDetail> {
  const t = await queryOne('SELECT id, venue_id FROM dining_tables WHERE id = $1', [tableId]);
  if (!t) throw notFound('Table');
  assertVenueAccess(staff, t.venue_id);
  const o = await queryOne(`SELECT id FROM pos_orders WHERE table_id = $1 AND status NOT IN ('BILLED', 'VOIDED') ORDER BY placed_at DESC LIMIT 1`, [tableId]);
  if (!o) throw notFound('Open order');
  return loadOrderDetail(o.id);
}

export async function getOrder(staff: StaffUser | undefined, orderId: string): Promise<OrderDetail> {
  const o = await queryOne('SELECT venue_id FROM pos_orders WHERE id = $1', [orderId]);
  if (!o) throw notFound('Order');
  assertVenueAccess(staff, o.venue_id);
  return loadOrderDetail(orderId);
}

function assertOpenForItems(o: OrderRow): void {
  // Items may be added until settlement starts: PARTIALLY_PAID has tenders captured against the old total.
  if (!OPEN_ORDER_STATUSES.includes(o.status) || o.status === 'PARTIALLY_PAID') {
    throw conflict('ORDER_CLOSED', `Order is ${o.status}; items can no longer be added`);
  }
}

export async function addOrderItem(
  staff: StaffUser | undefined,
  orderId: string,
  input: z.infer<typeof AddOrderItemInput>,
): Promise<OrderDetail> {
  await withTx(async (tx) => {
    const o = await lockOrder(tx, orderId);
    assertVenueAccess(staff, o.venue_id);
    assertOpenForItems(o);
    let { itemName, category, unitPricePaise } = input;
    if (input.menuItemId) {
      const m = await tx.one('SELECT * FROM menu_items WHERE id = $1 AND venue_id = $2', [input.menuItemId, o.venue_id]);
      if (!m) throw notFound('Menu item');
      if (!m.is_available) throw conflict('MENU_ITEM_UNAVAILABLE', `${m.name} is currently unavailable`);
      itemName = m.name;
      category = m.category;
      unitPricePaise = m.price_paise;
    }
    await tx.query(
      `INSERT INTO pos_order_items (order_id, item_name, category, quantity, unit_price_paise, notes, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [o.id, itemName, category, input.quantity, unitPricePaise, input.notes ?? null, clock.now()],
    );
    await recalcOrderTotals(tx, o.id);
  });
  return loadOrderDetail(orderId);
}

export async function deleteOrderItem(staff: StaffUser | undefined, orderId: string, itemId: string): Promise<OrderDetail> {
  await withTx(async (tx) => {
    const o = await lockOrder(tx, orderId);
    assertVenueAccess(staff, o.venue_id);
    if (o.status !== 'PLACED') {
      throw conflict('ORDER_ALREADY_SENT', 'The kitchen has already received this order; void the item instead');
    }
    const del = await tx.one('DELETE FROM pos_order_items WHERE id = $1 AND order_id = $2 RETURNING id', [itemId, o.id]);
    if (!del) throw notFound('Order item');
    await recalcOrderTotals(tx, o.id);
  });
  return loadOrderDetail(orderId);
}

export async function setOrderStatus(staff: StaffUser | undefined, orderId: string, to: OrderStatus): Promise<OrderDetail> {
  if (!KDS_STATUSES.includes(to)) {
    throw badRequest('INVALID_ORDER_STATUS', `Status ${to} cannot be set here; allowed: ${KDS_STATUSES.join(', ')}`);
  }
  await withTx(async (tx) => {
    const o = await lockOrder(tx, orderId);
    assertVenueAccess(staff, o.venue_id);
    await transitionOrder(tx, o, to);
  });
  return loadOrderDetail(orderId);
}
