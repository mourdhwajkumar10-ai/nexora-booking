import { createHash, randomInt } from 'node:crypto';

const GIFT_CARD_SALT = process.env.GIFT_CARD_SALT ?? 'nexora-gc-salt';

/** Salted SHA-256 of a gift card number (gift_cards.card_number_hash). */
export function hashGiftCard(cardNumber: string): string {
  return createHash('sha256').update(`${GIFT_CARD_SALT}:${cardNumber.replace(/\s+/g, '')}`).digest('hex');
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function randomDigits(n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += String(randomInt(0, 10));
  return s;
}
