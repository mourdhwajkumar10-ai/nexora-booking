import { TABLE_TRANSITIONS, assertTransition, type TableStatus } from '@nexora/shared';
import type { Tx } from '../db/pool';
import { clock } from '../lib/clock';
import { notFound } from '../lib/errors';

export interface TableRow {
  id: string;
  venue_id: string;
  table_number: string;
  dining_zone: string;
  min_capacity: number;
  max_capacity: number;
  status: TableStatus;
  status_changed_at: Date;
  archived_at: Date | null;
  created_at: Date;
}

/** Row-level lock on a physical table (serialises bookings/seatings for that table). */
export async function lockTable(tx: Tx, id: string): Promise<TableRow> {
  const t = await tx.one<TableRow>('SELECT * FROM dining_tables WHERE id = $1 AND archived_at IS NULL FOR UPDATE', [id]);
  if (!t) throw notFound('Table');
  return t;
}

/**
 * Change the physical table status with FSM validation, and emit `table.changed`.
 * No-op if already in the target status.
 */
export async function setTableStatus(tx: Tx, table: TableRow, to: TableStatus): Promise<TableRow> {
  if (table.status === to) return table;
  assertTransition('table', TABLE_TRANSITIONS, table.status, to);
  const updated = (await tx.one<TableRow>('UPDATE dining_tables SET status = $2, status_changed_at = $3 WHERE id = $1 RETURNING *', [
    table.id,
    to,
    clock.now(),
  ]))!;
  tx.emit({ type: 'table.changed', venueId: table.venue_id, tableIds: [table.id] });
  return updated;
}
