/** Loyalty accrual on `order.billed` and post-settlement clawback on `order.adjusted` (E4-S5). */
import { clawbackPoints, formatINR, pointsForSpend } from '@nexora/shared';
import { withTx } from '../../db/pool';
import { createAlert } from '../../core/alerts';
import type { DomainEvent } from '../../lib/bus';
import { DEFICIT_FLAG, addFlag, applyTier, insertLedger, lockAccount, removeFlag } from './service';

type Billed = Extract<DomainEvent, { type: 'order.billed' }>;
type Adjusted = Extract<DomainEvent, { type: 'order.adjusted' }>;

export async function accrueForOrder(e: Billed): Promise<void> {
  if (!e.guestId) return;
  const guestId = e.guestId;
  await withTx(async (tx) => {
    const acct = await lockAccount(tx, guestId);
    const already = await tx.one(
      `SELECT 1 FROM loyalty_ledger WHERE account_id = $1 AND event_type = 'ACCRUAL' AND reference_type = 'ORDER' AND reference_id = $2`,
      [acct.id, e.orderId],
    );
    if (already) return;
    // Spend paid with points does not earn points (wallet cash does).
    const redeemed = await tx.one<{ v: number }>(
      `SELECT COALESCE(SUM(amount_paise), 0)::bigint AS v FROM loyalty_ledger
       WHERE account_id = $1 AND event_type = 'REDEMPTION' AND points_delta < 0 AND reference_type = 'ORDER' AND reference_id = $2`,
      [acct.id, e.orderId],
    );
    const eligible = Math.max(0, e.netPaise - (redeemed?.v ?? 0));
    const points = pointsForSpend(eligible, acct.tier_level);
    const annual = acct.annual_spend_paise + e.netPaise;
    const updated = (await tx.one<{ points_balance: number }>(
      'UPDATE loyalty_accounts SET points_balance = points_balance + $2, annual_spend_paise = $3 WHERE id = $1 RETURNING points_balance',
      [acct.id, points, annual],
    ))!;
    await insertLedger(tx, {
      accountId: acct.id,
      eventType: 'ACCRUAL',
      pointsDelta: points,
      amountPaise: eligible,
      referenceType: 'ORDER',
      referenceId: e.orderId,
      note: `Earned on ${formatINR(eligible)} at ${acct.tier_level}`,
    });
    // A negative balance is repaid first by construction (balance is a running sum).
    if (updated.points_balance >= 0) await removeFlag(tx, guestId, DEFICIT_FLAG);
    await applyTier(tx, acct, annual, acct.largest_preload_paise);
  });
}

export async function clawbackForAdjustment(e: Adjusted): Promise<void> {
  if (!e.postSettlement || !e.guestId || e.amountPaise <= 0) return;
  const guestId = e.guestId;
  await withTx(async (tx) => {
    const acct = await lockAccount(tx, guestId);
    const points = clawbackPoints(e.amountPaise, acct.tier_level);
    const updated = (await tx.one<{ points_balance: number }>(
      `UPDATE loyalty_accounts SET points_balance = points_balance - $2, annual_spend_paise = GREATEST(0, annual_spend_paise - $3)
       WHERE id = $1 RETURNING points_balance`,
      [acct.id, points, e.amountPaise],
    ))!;
    await tx.query('UPDATE guest_profiles SET lifetime_spend_paise = GREATEST(0, lifetime_spend_paise - $2) WHERE guest_id = $1', [
      guestId,
      e.amountPaise,
    ]);
    await insertLedger(tx, {
      accountId: acct.id,
      eventType: 'REVERSAL',
      pointsDelta: -points,
      amountPaise: e.amountPaise,
      referenceType: 'ORDER',
      referenceId: e.orderId,
      note: `${e.kind} clawback of ${formatINR(e.amountPaise)}`,
    });
    if (updated.points_balance < 0) {
      await addFlag(tx, guestId, DEFICIT_FLAG);
      const g = await tx.one('SELECT first_name, last_name FROM guests WHERE id = $1', [guestId]);
      await createAlert(tx, {
        venueId: e.venueId,
        kind: 'LOYALTY_DEFICIT',
        severity: 'warning',
        title: 'Loyalty deficit',
        body: `${`${g?.first_name ?? ''} ${g?.last_name ?? ''}`.trim()} is at ${updated.points_balance} points after a post-settlement ${e.kind.toLowerCase()} of ${formatINR(e.amountPaise)}`,
        data: { guestId, orderId: e.orderId, pointsBalance: updated.points_balance },
      });
    }
  });
}
