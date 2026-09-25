/**
 * Two-phase split-tender settlement (E4-S7).
 *  Phase 1 (one tx): validate, authorize holds for gift cards / points / wallet.
 *  Card step: external card/cash (simulated; `simulateDecline`).
 *  Phase 2 (one tx): capture every hold atomically, mark the order BILLED, emit `order.billed`.
 * Any tender failure releases all holds and leaves the order PARTIALLY_PAID (a business outcome).
 */
import {
  GIFT_CARD_HOLD_SECS,
  formatINR,
  pointsToPaise,
  type SettleResult,
  type StaffUser,
  type TenderInput,
} from '@nexora/shared';
import { queryOne, withTx, type Tx } from '../../db/pool';
import { audit } from '../../core/audit';
import { loadOrderDetail, lockOrder, transitionOrder, type OrderRow } from '../../core/orders';
import { assertVenueAccess } from '../../lib/auth';
import { clock } from '../../lib/clock';
import { badRequest, conflict } from '../../lib/errors';
import { availableOnCard, lockCardByNumber } from './giftcards';
import { insertLedger, lockAccount } from './service';

class TenderFailure extends Error {}

export const tenderValuePaise = (t: TenderInput): number => (t.type === 'POINTS' ? pointsToPaise(t.points) : t.amountPaise);

interface Holds {
  gift: string[];
  loyalty: string[];
}

async function releaseHolds(tx: Tx, holds: Holds): Promise<void> {
  if (holds.gift.length) await tx.query(`UPDATE gift_card_holds SET status = 'RELEASED' WHERE id = ANY($1) AND status = 'HELD'`, [holds.gift]);
  if (holds.loyalty.length) await tx.query(`UPDATE loyalty_holds SET status = 'RELEASED' WHERE id = ANY($1) AND status = 'HELD'`, [holds.loyalty]);
}

/** Release holds and park the order in PARTIALLY_PAID (from SERVED; stays PARTIALLY_PAID otherwise). */
async function markFailed(tx: Tx, order: OrderRow, holds: Holds): Promise<void> {
  await releaseHolds(tx, holds);
  if (order.status === 'SERVED') await transitionOrder(tx, order, 'PARTIALLY_PAID');
}

async function failedResult(orderId: string, reason: string, outstanding: number): Promise<SettleResult> {
  return {
    order: await loadOrderDetail(orderId),
    outcome: 'PARTIALLY_PAID',
    message: `Tender Failed: ${reason}. Folio Remaining: ${formatINR(outstanding)}`,
    pointsEarned: 0,
  };
}

export async function settleOrder(orderId: string, tenders: TenderInput[], staff: StaffUser | undefined, actor: string): Promise<SettleResult> {
  const holdExpiry = () => new Date(clock.now().getTime() + GIFT_CARD_HOLD_SECS * 1000);

  // ---------------- phase 1: authorize
  const p1 = await withTx(async (tx) => {
    const order = await lockOrder(tx, orderId);
    assertVenueAccess(staff, order.venue_id);
    if (order.status !== 'SERVED' && order.status !== 'PARTIALLY_PAID') {
      throw conflict('ORDER_NOT_READY', `Order is ${order.status}; it must be SERVED before settlement`);
    }
    const outstanding = order.net_paise - order.paid_paise;
    const tendered = tenders.reduce((s, t) => s + tenderValuePaise(t), 0);
    if (tendered !== outstanding) {
      throw badRequest('TENDER_MISMATCH', `Tenders total ${formatINR(tendered)} but ${formatINR(outstanding)} is outstanding`, {
        outstandingPaise: outstanding,
        tenderedPaise: tendered,
      });
    }
    const holds: Holds = { gift: [], loyalty: [] };
    try {
      for (const t of tenders) {
        if (t.type === 'GIFT_CARD') {
          if (t.simulateTimeout) throw new TenderFailure('Gift Card Unreachable');
          const card = await lockCardByNumber(tx, t.cardNumber);
          if (!card) throw new TenderFailure('Gift Card Not Found');
          if ((await availableOnCard(tx, card)) < t.amountPaise) throw new TenderFailure('Insufficient Gift Card Balance');
          const h = await tx.one(
            `INSERT INTO gift_card_holds (gift_card_id, order_id, amount_paise, expires_at, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
            [card.id, order.id, t.amountPaise, holdExpiry(), clock.now()],
          );
          holds.gift.push(h!.id);
        } else if (t.type === 'POINTS' || t.type === 'WALLET') {
          if (!order.guest_id) throw new TenderFailure('No Loyalty Account On This Check');
          const acct = await lockAccount(tx, order.guest_id);
          const held = await tx.one<{ v: number }>(
            `SELECT COALESCE(SUM(amount), 0)::bigint AS v FROM loyalty_holds WHERE account_id = $1 AND kind = $2 AND status = 'HELD' AND expires_at > $3`,
            [acct.id, t.type, clock.now()],
          );
          const amount = t.type === 'POINTS' ? t.points : t.amountPaise;
          const balance = t.type === 'POINTS' ? acct.points_balance : acct.wallet_balance_paise;
          if (balance - (held?.v ?? 0) < amount) throw new TenderFailure(t.type === 'POINTS' ? 'Insufficient Points' : 'Insufficient Wallet Balance');
          const h = await tx.one(
            `INSERT INTO loyalty_holds (account_id, order_id, kind, amount, expires_at, created_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [acct.id, order.id, t.type, amount, holdExpiry(), clock.now()],
          );
          holds.loyalty.push(h!.id);
        }
      }
    } catch (err) {
      if (!(err instanceof TenderFailure)) throw err;
      await markFailed(tx, order, holds);
      await audit(tx, { venueId: order.venue_id, actor, action: 'order.settle_failed', entity: 'order', entityId: order.id, data: { reason: err.message } });
      return { ok: false as const, reason: err.message, outstanding };
    }
    return { ok: true as const, holds, outstanding };
  });
  if (!p1.ok) return failedResult(orderId, p1.reason, p1.outstanding);
  const { holds, outstanding } = p1;

  const fail = async (reason: string): Promise<SettleResult> => {
    await withTx(async (tx) => {
      const order = await lockOrder(tx, orderId);
      await markFailed(tx, order, holds);
      await audit(tx, { venueId: order.venue_id, actor, action: 'order.settle_failed', entity: 'order', entityId: order.id, data: { reason } });
    });
    return failedResult(orderId, reason, outstanding);
  };

  // ---------------- external card step (simulated processor)
  if (tenders.some((t) => t.type === 'CARD' && t.simulateDecline)) return fail('Card Declined');

  // ---------------- phase 2: capture
  try {
    await withTx(async (tx) => {
      const order = await lockOrder(tx, orderId);
      if ((order.status !== 'SERVED' && order.status !== 'PARTIALLY_PAID') || order.net_paise - order.paid_paise !== outstanding) {
        throw new TenderFailure('Check Changed During Settlement');
      }
      const giftHolds = holds.gift.length
        ? await tx.query('SELECT * FROM gift_card_holds WHERE id = ANY($1) ORDER BY id FOR UPDATE', [holds.gift])
        : [];
      const loyaltyHolds = holds.loyalty.length
        ? await tx.query('SELECT * FROM loyalty_holds WHERE id = ANY($1) ORDER BY id FOR UPDATE', [holds.loyalty])
        : [];
      if ([...giftHolds, ...loyaltyHolds].some((h) => h.status !== 'HELD')) throw new TenderFailure('Authorization Expired');

      for (const h of giftHolds) {
        await tx.one('SELECT id FROM gift_cards WHERE id = $1 FOR UPDATE', [h.gift_card_id]);
        await tx.query('UPDATE gift_cards SET current_balance_paise = current_balance_paise - $2 WHERE id = $1', [h.gift_card_id, h.amount_paise]);
        await tx.query(`INSERT INTO gift_card_ledger (gift_card_id, kind, delta_paise, reference_id, created_at) VALUES ($1,'REDEEM',$2,$3,$4)`, [
          h.gift_card_id,
          -h.amount_paise,
          order.id,
          clock.now(),
        ]);
        await tx.query(`UPDATE gift_card_holds SET status = 'CAPTURED' WHERE id = $1`, [h.id]);
      }
      for (const h of loyaltyHolds) {
        if (h.kind === 'POINTS') {
          await tx.query('UPDATE loyalty_accounts SET points_balance = points_balance - $2 WHERE id = $1', [h.account_id, h.amount]);
          await insertLedger(tx, {
            accountId: h.account_id,
            eventType: 'REDEMPTION',
            pointsDelta: -h.amount,
            amountPaise: pointsToPaise(h.amount),
            referenceType: 'ORDER',
            referenceId: order.id,
            note: 'Points redeemed at settlement',
          });
        } else {
          await tx.query('UPDATE loyalty_accounts SET wallet_balance_paise = wallet_balance_paise - $2 WHERE id = $1', [h.account_id, h.amount]);
          await insertLedger(tx, {
            accountId: h.account_id,
            eventType: 'REDEMPTION',
            amountPaise: h.amount,
            referenceType: 'ORDER',
            referenceId: order.id,
            note: 'Wallet spent at settlement',
          });
        }
        await tx.query(`UPDATE loyalty_holds SET status = 'CAPTURED' WHERE id = $1`, [h.id]);
      }

      const paid = (await tx.one<OrderRow>('UPDATE pos_orders SET paid_paise = net_paise WHERE id = $1 RETURNING *', [order.id]))!;
      const billed = await transitionOrder(tx, paid, 'BILLED');
      await audit(tx, {
        venueId: order.venue_id,
        actor,
        action: 'order.settle',
        entity: 'order',
        entityId: order.id,
        data: { tenders: tenders.map((t) => ({ type: t.type, valuePaise: tenderValuePaise(t) })) },
      });
      tx.emit({
        type: 'order.billed',
        venueId: billed.venue_id,
        orderId: billed.id,
        tableId: billed.table_id,
        guestId: billed.guest_id,
        reservationId: billed.reservation_id,
        netPaise: billed.net_paise,
      });
    });
  } catch (err) {
    if (err instanceof TenderFailure) return fail(err.message);
    throw err;
  }

  // Handlers (accrual) have run by the time withTx resolves: read what was earned.
  const earned = await queryOne<{ pts: number }>(
    `SELECT COALESCE(SUM(points_delta), 0)::bigint AS pts FROM loyalty_ledger WHERE event_type = 'ACCRUAL' AND reference_type = 'ORDER' AND reference_id = $1`,
    [orderId],
  );
  return { order: await loadOrderDetail(orderId), outcome: 'BILLED', message: null, pointsEarned: earned?.pts ?? 0 };
}
