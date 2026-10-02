/**
 * BR-31 / BR-17 Human-facing codes.
 * Alphabet excludes 0, 1, I and O so codes can be read aloud and typed without confusion.
 * 32 symbols: every random byte maps to a symbol with `byte & 31`, which is unbiased.
 */
export const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export type RandomBytes = (length: number) => Uint8Array;

export function randomCode(length: number, randomBytes: RandomBytes): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i]! & 31];
  return out;
}

/** 6-character reservation confirmation code, unique per venue (retry on collision). */
export function confirmationCode(randomBytes: RandomBytes): string {
  return randomCode(6, randomBytes);
}

/** Luhn mod N (N = 32) check character for `body`. */
export function luhnModNCheckChar(body: string): string {
  const n = CODE_ALPHABET.length;
  let factor = 2;
  let sum = 0;
  for (let i = body.length - 1; i >= 0; i--) {
    const codePoint = CODE_ALPHABET.indexOf(body[i]!);
    if (codePoint < 0) throw new Error(`Invalid character: ${body[i]}`);
    let addend = factor * codePoint;
    factor = factor === 2 ? 1 : 2;
    addend = Math.floor(addend / n) + (addend % n);
    sum += addend;
  }
  const remainder = sum % n;
  return CODE_ALPHABET[(n - remainder) % n]!;
}

export function isValidLuhnModN(code: string): boolean {
  const n = CODE_ALPHABET.length;
  let factor = 1;
  let sum = 0;
  for (let i = code.length - 1; i >= 0; i--) {
    const codePoint = CODE_ALPHABET.indexOf(code[i]!);
    if (codePoint < 0) return false;
    let addend = factor * codePoint;
    factor = factor === 2 ? 1 : 2;
    addend = Math.floor(addend / n) + (addend % n);
    sum += addend;
  }
  return sum % n === 0;
}

/** 9-character voucher code: 8 random characters + 1 Luhn mod 32 check character. */
export function voucherCode(randomBytes: RandomBytes): string {
  const body = randomCode(8, randomBytes);
  return body + luhnModNCheckChar(body);
}

/** Uppercases and strips spaces and hyphens. Returns null when the result is not a valid voucher code. */
export function normalizeVoucherCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, '');
  if (s.length !== 9) return null;
  return isValidLuhnModN(s) ? s : null;
}

/** Display form: 'ABCD-EFGH-J'. */
export function formatVoucherCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
}
