/** Gift cards (E4-S6): issue, reload, authorize (120 s hold) and hold expiry. */
import { GIFT_CARD_HOLD_SECS, type GiftCardDto } from '@nexora/shared';
import { query, type Tx } from '../../db/pool';
import { clock } from '../../lib/clock';
import { hashGiftCard, randomDigits } from '../../lib/crypto';
import { AppError, conflict } from '../../lib/errors';
import { iso } from '../../lib/http';

export interface GiftCardRow {
  id: string;
  card_number_hash: string;
  last4: string;
  current_balance_paise: number;
  purchased_by: string | null;
  created_at: Date;
}

export const giftCardNotFound = () => new AppError(404, 'GIFT_CARD_NOT_FOUND', 'Gift card not found');

export function toGiftCardDto(r: any, cardNumber?: string): GiftCardDto {
  return {
    id: r.id,
    last4: r.last4,
    balancePaise: r.current_balance_paise,
    purchasedBy: r.purchaser_name ?? null,
    createdAt: iso(r.created_at)!,
    ...(cardNumber ? { cardNumber } : {}),
  };
}

export const GIFT_CARD_SELECT = `SELECT gc.*, NULLIF(TRIM(g.first_name || ' ' || g.last_name), '') AS purchaser_name
  FROM gift_cards gc LEFT JOIN guests g ON g.id = gc.purchased_by`;

export async function issueGiftCard(tx: Tx, amountPaise: number, purchasedBy: string | null): Promise<GiftCardDto> {
  for (let i = 0; i < 5; i++) {
    const cardNumber = `6011${randomDigits(12)}`;
    const row = await tx.one<GiftCardRow>(
      `INSERT INTO gift_cards (card_number_hash, last4, current_balance_paise, purchased_by, created_at)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (card_number_hash) DO NOTHING RETURNING *`,
      [hashGiftCard(cardNumber), cardNumber.slice(-4), amountPaise, purchasedBy, clock.now()],
    );
    if (!row) continue;
    await tx.query(`INSERT INTO gift_card_ledger (gift_card_id, kind, delta_paise, created_at) VALUES ($1,'PURCHASE',$2,$3)`, [
      row.id,
      amountPaise,
      clock.now(),
    ]);
    const full = await tx.one(`${GIFT_CARD_SELECT} WHERE gc.id = $1`, [row.id]);
    return toGiftCardDto(full, cardNumber); // the only time the full number leaves the server
  }
  throw new Error('Could not allocate a unique gift card number');
}

/** Lock a card by its number. */
export async function lockCardByNumber(tx: Tx, cardNumber: string): Promise<GiftCardRow | null> {
  return tx.one<GiftCardRow>('SELECT * FROM gift_cards WHERE card_number_hash = $1 FOR UPDATE', [hashGiftCard(cardNumber)]);
}

/** balance − active (HELD, unexpired) holds. Call with the card row locked. */
export async function availableOnCard(tx: Tx, card: GiftCardRow): Promise<number> {
  const h = await tx.one<{ held: number }>(
    `SELECT COALESCE(SUM(amount_paise), 0)::bigint AS held FROM gift_card_holds WHERE gift_card_id = $1 AND status = 'HELD' AND expires_at > $2`,
    [card.id, clock.now()],
  );
  return card.current_balance_paise - (h?.held ?? 0);
}

export async function createGiftCardHold(
  tx: Tx,
  card: GiftCardRow,
  amountPaise: number,
  orderId: string | null,
): Promise<{ id: string; hold_token: string; expires_at: Date; available: number }> {
  const available = await availableOnCard(tx, card);
  if (amountPaise > available) throw conflict('INSUFFICIENT_FUNDS', 'Insufficient gift card balance', { availablePaise: available });
  const hold = (await tx.one(
    `INSERT INTO gift_card_holds (gift_card_id, order_id, amount_paise, expires_at, created_at) VALUES ($1,$2,$3,$4,$5)
     RETURNING id, hold_token, expires_at`,
    [card.id, orderId, amountPaise, new Date(clock.now().getTime() + GIFT_CARD_HOLD_SECS * 1000), clock.now()],
  ))!;
  return { ...hold, available: available - amountPaise };
}

/** Job `hold-expiry`: release gift card and loyalty holds past `expires_at`. */
export async function releaseExpiredHolds(): Promise<void> {
  const now = clock.now();
  await query(`UPDATE gift_card_holds SET status = 'RELEASED' WHERE status = 'HELD' AND expires_at <= $1`, [now]);
  await query(`UPDATE loyalty_holds SET status = 'RELEASED' WHERE status = 'HELD' AND expires_at <= $1`, [now]);
}
