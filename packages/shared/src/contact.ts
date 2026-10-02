/**
 * Contact normalization. MVP supports SMS only for North American (+1) numbers.
 * Other E.164 numbers are stored but are never texted.
 */

const NANP_AREA = /^[2-9][0-9]{2}$/;
const NANP_EXCHANGE = /^[2-9][0-9]{2}$/;
const E164 = /^\+[1-9][0-9]{6,14}$/;

/**
 * Returns E.164 ('+12125550142') or null when the input is not a valid number.
 * Accepts '(212) 555-0142', '212.555.0142', '1-212-555-0142', '+1 212 555 0142', '+44 20 7946 0958'.
 */
export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!/^[+0-9().\-\s]+$/.test(trimmed)) return null;
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/[^0-9]/g, '');
  let e164: string;
  if (hasPlus) {
    e164 = `+${digits}`;
  } else if (digits.length === 10) {
    e164 = `+1${digits}`;
  } else if (digits.length === 11 && digits.startsWith('1')) {
    e164 = `+${digits}`;
  } else {
    return null;
  }
  if (!E164.test(e164)) return null;
  if (e164.startsWith('+1')) {
    const national = e164.slice(2);
    if (national.length !== 10) return null;
    const area = national.slice(0, 3);
    const exchange = national.slice(3, 6);
    if (!NANP_AREA.test(area) || area.endsWith('11')) return null;
    if (!NANP_EXCHANGE.test(exchange) || exchange.endsWith('11')) return null;
  }
  return e164;
}

/** True when the platform may send SMS to this E.164 number (MVP: +1 only). */
export function isSmsCapable(e164: string): boolean {
  return /^\+1[2-9][0-9]{9}$/.test(e164);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trims and lowercases. No provider-specific rules (Gmail dots are NOT removed). */
export function normalizeEmail(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  if (s.length > 254 || !EMAIL.test(s)) return null;
  return s;
}

export type ContactKey = `phone:${string}` | `email:${string}`;

export function contactKey(kind: 'phone' | 'email', normalizedValue: string): ContactKey {
  return kind === 'phone' ? `phone:${normalizedValue}` : `email:${normalizedValue}`;
}

/** Masks a phone for staff display: '+1 ••• ••• 0142'. */
export function maskPhone(e164: string): string {
  return `${e164.startsWith('+1') ? '+1' : '+'} ••• ••• ${e164.slice(-4)}`;
}
