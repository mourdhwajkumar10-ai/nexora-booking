/**
 * CRM auto-tag rules (ARCHITECTURE §8). Bus handlers run after the originating COMMIT, so each
 * opens its own transaction. Tags are inserted idempotently and never removed automatically.
 */
import { WALK_IN_BUFFER_MINS } from '@nexora/shared';
import { withTx, type Tx } from '../../db/pool';
import type { on as onFn } from '../../lib/bus';
import { addAutoTag, ensureGuestRows } from '../loyalty/service';

export const AUTO_TAG_RULES = {
  WINE_LINE_MIN_PAISE: 5_000_00, // a WINE line priced >= ₹5,000
  TOP_SPENDER_LIFETIME_PAISE: 1_00_000_00, // lifetime >= ₹1,00,000
  TOP_SPENDER_SINGLE_BILL_PAISE: 15_000_00, // or one bill >= ₹15,000
  REGULAR_MIN_VISITS: 5,
  SLOW_PACING_EXTRA_MINS: WALK_IN_BUFFER_MINS, // seated duration > turnaround + 15
  SLOW_PACING_MIN_COUNT: 2,
  LATE_CANCEL_WINDOW_HOURS: 2,
  LATE_CANCEL_MIN_COUNT: 2,
  FREQUENT_COMPLAINTS_MIN_VOIDS: 3,
} as const;

const R = AUTO_TAG_RULES;

export async function tagsOnOrderBilled(tx: Tx, e: { orderId: string; guestId: string; netPaise: number }): Promise<void> {
  await ensureGuestRows(tx, e.guestId);
  const p = await tx.one<{ lifetime_spend_paise: number }>(
    'UPDATE guest_profiles SET lifetime_spend_paise = lifetime_spend_paise + $2 WHERE guest_id = $1 RETURNING lifetime_spend_paise',
    [e.guestId, e.netPaise],
  );
  const wine = await tx.one(
    `SELECT 1 FROM pos_order_items WHERE order_id = $1 AND category = 'WINE' AND NOT is_voided AND unit_price_paise >= $2 LIMIT 1`,
    [e.orderId, R.WINE_LINE_MIN_PAISE],
  );
  if (wine) await addAutoTag(tx, e.guestId, 'WINE_CONNOISSEUR');
  if ((p?.lifetime_spend_paise ?? 0) >= R.TOP_SPENDER_LIFETIME_PAISE || e.netPaise >= R.TOP_SPENDER_SINGLE_BILL_PAISE) {
    await addAutoTag(tx, e.guestId, 'TOP_SPENDER');
  }
}

export async function tagsOnCompleted(tx: Tx, guestId: string): Promise<void> {
  const p = await tx.one<{ total_visits: number }>('SELECT total_visits FROM guest_profiles WHERE guest_id = $1', [guestId]);
  if ((p?.total_visits ?? 0) >= R.REGULAR_MIN_VISITS) await addAutoTag(tx, guestId, 'REGULAR');
  const slow = await tx.one<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM reservations r JOIN venues v ON v.id = r.venue_id
     WHERE r.guest_id = $1 AND r.status = 'COMPLETED' AND r.seated_at IS NOT NULL AND r.completed_at IS NOT NULL
       AND r.completed_at - r.seated_at > make_interval(mins => v.turnaround_mins + $2)`,
    [guestId, R.SLOW_PACING_EXTRA_MINS],
  );
  if ((slow?.n ?? 0) >= R.SLOW_PACING_MIN_COUNT) await addAutoTag(tx, guestId, 'SLOW_PACING');
}

export async function tagsOnCancelled(tx: Tx, guestId: string): Promise<void> {
  const late = await tx.one<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM reservations
     WHERE guest_id = $1 AND status = 'CANCELLED' AND cancelled_at IS NOT NULL
       AND cancelled_at >= start_at - make_interval(hours => $2)`,
    [guestId, R.LATE_CANCEL_WINDOW_HOURS],
  );
  if ((late?.n ?? 0) >= R.LATE_CANCEL_MIN_COUNT) await addAutoTag(tx, guestId, 'LATE_CANCELLER');
}

export async function tagsOnAdjusted(tx: Tx, guestId: string): Promise<void> {
  const p = await tx.one<{ total_voids_count: number }>('SELECT total_voids_count FROM guest_profiles WHERE guest_id = $1', [guestId]);
  if ((p?.total_voids_count ?? 0) >= R.FREQUENT_COMPLAINTS_MIN_VOIDS) await addAutoTag(tx, guestId, 'FREQUENT_COMPLAINTS');
}

export function registerAutoTagHandlers(on: typeof onFn): void {
  on('order.billed', async (e) => {
    if (!e.guestId) return;
    const guestId = e.guestId;
    await withTx((tx) => tagsOnOrderBilled(tx, { orderId: e.orderId, guestId, netPaise: e.netPaise }));
  });
  on('reservation.changed', async (e) => {
    if (e.to === 'COMPLETED') await withTx((tx) => tagsOnCompleted(tx, e.guestId));
    else if (e.to === 'CANCELLED') await withTx((tx) => tagsOnCancelled(tx, e.guestId));
  });
  on('order.adjusted', async (e) => {
    if (!e.guestId) return;
    const guestId = e.guestId;
    await withTx((tx) => tagsOnAdjusted(tx, guestId));
  });
}
