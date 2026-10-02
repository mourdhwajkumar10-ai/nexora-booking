/**
 * BR-01 Money. All amounts are integer minor units (cents for USD, paise for INR).
 * Never use floating-point currency for arithmetic or database storage.
 * Database columns are `integer` (max 2,147,483,647 minor units per value).
 */
export type Cents = number;
export type Paise = number;
export type MinorUnit = number;

export type Currency = 'USD' | 'INR';
export type CurrencyCode = Currency;

export interface CurrencyConfig {
  code: Currency;
  symbol: string;
  minorUnitName: 'cents' | 'paise';
  minorUnitRatio: 100;
  locale: 'en-US' | 'en-IN';
}

export const CURRENCY_CONFIGS: Record<Currency, CurrencyConfig> = {
  USD: {
    code: 'USD',
    symbol: '$',
    minorUnitName: 'cents',
    minorUnitRatio: 100,
    locale: 'en-US',
  },
  INR: {
    code: 'INR',
    symbol: '₹',
    minorUnitName: 'paise',
    minorUnitRatio: 100,
    locale: 'en-IN',
  },
};

export function assertCents(value: number, label = 'amount'): Cents {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be an integer number of cents`);
  return value;
}

export const assertPaise = assertCents;

/** Converts a decimal string such as '12.50' or '12' to cents. Rejects more than 2 decimals. */
export function parseDollars(input: string): Cents {
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!m) throw new Error(`Invalid dollar amount: ${input}`);
  const cents = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] ? -cents : cents;
}

export function parseRupees(input: string): Paise {
  const cleaned = input.trim().replace(/^₹\s*/, '');
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!m) throw new Error(`Invalid rupee amount: ${input}`);
  const paise = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] ? -paise : paise;
}

export function parseMoney(input: string, currency: Currency = 'USD'): MinorUnit {
  if (currency === 'USD') return parseDollars(input.trim().replace(/^\$\s*/, ''));
  if (currency === 'INR') return parseRupees(input);
  throw new Error(`Unsupported currency: ${currency}`);
}

export function formatUsd(cents: Cents): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString('en-US');
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

export function formatInr(paise: Paise, options?: { showPaise?: boolean }): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100).toLocaleString('en-IN');
  const hasFraction = abs % 100 !== 0;
  if (options?.showPaise || hasFraction) {
    return `${sign}₹${rupees}.${String(abs % 100).padStart(2, '0')}`;
  }
  return `${sign}₹${rupees}`;
}

export const formatINR = formatInr;

export function formatMoney(amountMinor: MinorUnit, currency: Currency): string {
  return currency === 'USD' ? formatUsd(amountMinor) : formatInr(amountMinor);
}

/** Rounds half away from zero. */
export function roundHalfAwayFromZero(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

/** Applies basis points (1 bp = 0.01%) and rounds half away from zero. */
export function applyBps(cents: Cents, bps: number): Cents {
  return roundHalfAwayFromZero((cents * bps) / 10_000);
}

/** Converts a Square/Toast decimal quantity string like '1.5' times unit price to cents, rounded. */
export function lineGrossCents(quantity: number, unitPriceCents: Cents): Cents {
  return roundHalfAwayFromZero(quantity * unitPriceCents);
}

export const lineGrossPaise = lineGrossCents;
