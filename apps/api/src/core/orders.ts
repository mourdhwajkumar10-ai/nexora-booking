import { ORDER_TRANSITIONS, assertTransition, type OrderDetail, type OrderStatus } from '@nexora/shared';
import { getPool, query, queryOne, type Queryable, type Tx } from '../db/pool';
import { clock } from '../lib/clock';
import { conflict, notFound } from '../lib/errors';
import { iso } from '../lib/http';

export interface OrderRow {
  id: string;
  venue_id: string;
  table_id: string;
  reservation_id: string | null;
  guest_id: string | null;
  pos_external_id: string | null;
  status: OrderStatus;
  placed_at: Date;
  received_at: Date | null;
  preparing_at: Date | null;
  served_at: Date | null;
  settled_at: Date | null;
  gross_paise: number;
  discount_paise: number;
  net_paise: number;
  paid_paise: number;
  created_at: Date;
}

export const OPEN_ORDER_STATUSES: OrderStatus[] = ['PLACED', 'RECEIVED', 'PREPARING', 'SERVED', 'PARTIALLY_PAID'];

export async function lockOrder(tx: Tx, id: string): Promise<OrderRow> {
  const o = await tx.one<OrderRow>('SELECT * FROM pos_orders WHERE id = $1 FOR UPDATE', [id]);
  if (!o) throw notFound('Order');
  return o;
}

/** Open the POS check for a seating (PRD: seating initialises the order ticket + timer). */
export async function openOrder(
  tx: Tx,
  o: { venueId: string; tableId: string; reservationId: string | null; guestId: string | null },
): Promise<OrderRow> {
  const existing = await tx.one('SELECT id FROM pos_orders WHERE table_id = $1 AND status NOT IN (\'BILLED\',\'VOIDED\')', [o.tableId]);
  if (existing) throw conflict('TABLE_HAS_OPEN_CHECK', 'This table already has an open check');
  const row = (await tx.one<OrderRow>(
    `INSERT INTO pos_orders (venue_id, table_id, reservation_id, guest_id, status, placed_at, created_at)
     VALUES ($1,$2,$3,$4,'PLACED',$5,$5) RETURNING *`,
    [o.venueId, o.tableId, o.reservationId, o.guestId, clock.now()],
  ))!;
  tx.emit({ type: 'order.changed', venueId: row.venue_id, orderId: row.id, tableId: row.table_id, status: row.status });
  return row;
}

const ORDER_TS: Partial<Record<OrderStatus, string>> = {
  RECEIVED: 'received_at',
  PREPARING: 'preparing_at',
  SERVED: 'served_at',
  BILLED: 'settled_at',
};

export async function transitionOrder(tx: Tx, order: OrderRow, to: OrderStatus): Promise<OrderRow> {
  assertTransition('order', ORDER_TRANSITIONS, order.status, to);
  const col = ORDER_TS[to];
  const updated = (await tx.one<OrderRow>(
    `UPDATE pos_orders SET status = $2${col ? `, ${col} = $3` : ''} WHERE id = $1 RETURNING *`,
    col ? [order.id, to, clock.now()] : [order.id, to],
  ))!;
  tx.emit({ type: 'order.changed', venueId: updated.venue_id, orderId: updated.id, tableId: updated.table_id, status: to });
  return updated;
}

/** gross = all lines; discount = sum of VOID/COMP/REFUND logs; net = max(0, gross - discount). */
export async function recalcOrderTotals(tx: Tx, orderId: string): Promise<OrderRow> {
  const updated = (await tx.one<OrderRow>(
    `UPDATE pos_orders o SET
       gross_paise    = COALESCE((SELECT SUM(quantity * unit_price_paise) FROM pos_order_items WHERE order_id = o.id), 0),
       discount_paise = COALESCE((SELECT SUM(amount_voided_paise) FROM pos_void_logs WHERE order_id = o.id), 0),
       net_paise      = GREATEST(0,
                          COALESCE((SELECT SUM(quantity * unit_price_paise) FROM pos_order_items WHERE order_id = o.id), 0)
                        - COALESCE((SELECT SUM(amount_voided_paise) FROM pos_void_logs WHERE order_id = o.id), 0))
     WHERE o.id = $1 RETURNING *`,
    [orderId],
  ))!;
  tx.emit({ type: 'order.changed', venueId: updated.venue_id, orderId: updated.id, tableId: updated.table_id, status: updated.status });
  return updated;
}

export async function loadOrderDetail(id: string, db: Queryable = getPool()): Promise<OrderDetail> {
  const o = await queryOne(
    `SELECT o.*, t.table_number, g.first_name, g.last_name
     FROM pos_orders o JOIN dining_tables t ON t.id = o.table_id LEFT JOIN guests g ON g.id = o.guest_id
     WHERE o.id = $1`,
    [id],
    db,
  );
  if (!o) throw notFound('Order');
  const items = await query('SELECT * FROM pos_order_items WHERE order_id = $1 ORDER BY created_at, id', [id], db);
  const voids = await query('SELECT * FROM pos_void_logs WHERE order_id = $1 ORDER BY created_at', [id], db);
  return {
    id: o.id,
    venueId: o.venue_id,
    tableId: o.table_id,
    tableNumber: o.table_number,
    reservationId: o.reservation_id,
    guestId: o.guest_id,
    guestName: o.first_name ? `${o.first_name} ${o.last_name}`.trim() : null,
    posExternalId: o.pos_external_id,
    status: o.status,
    placedAt: iso(o.placed_at)!,
    receivedAt: iso(o.received_at),
    preparingAt: iso(o.preparing_at),
    servedAt: iso(o.served_at),
    settledAt: iso(o.settled_at),
    grossPaise: o.gross_paise,
    discountPaise: o.discount_paise,
    netPaise: o.net_paise,
    paidPaise: o.paid_paise,
    items: items.map((i) => ({
      id: i.id,
      itemName: i.item_name,
      category: i.category,
      quantity: i.quantity,
      unitPricePaise: i.unit_price_paise,
      notes: i.notes,
      isVoided: i.is_voided,
      lineTotalPaise: i.quantity * i.unit_price_paise,
    })),
    voids: voids.map((v) => ({
      id: v.id,
      kind: v.kind,
      reason: v.void_reason,
      authorizedBy: v.authorized_by,
      amountPaise: v.amount_voided_paise,
      postSettlement: v.post_settlement,
      createdAt: iso(v.created_at)!,
    })),
    serverTime: clock.now().toISOString(),
  };
}
