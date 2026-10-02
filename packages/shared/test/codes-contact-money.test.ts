import { describe, expect, it } from 'vitest';
import {
  CODE_ALPHABET,
  confirmationCode,
  formatVoucherCode,
  isValidLuhnModN,
  normalizeVoucherCode,
  voucherCode,
} from '../src/codes.ts';
import { isSmsCapable, maskPhone, normalizeEmail, normalizePhone } from '../src/contact.ts';
import { applyBps, formatUsd, lineGrossCents, parseDollars } from '../src/money.ts';

const fixedBytes = (values: number[]) => (n: number) => Uint8Array.from(values.slice(0, n));

describe('codes', () => {
  it('maps bytes to the 32-symbol alphabet without bias', () => {
    expect(CODE_ALPHABET).toHaveLength(32);
    expect(confirmationCode(fixedBytes([0, 1, 2, 3, 4, 5]))).toBe('234567');
    expect(confirmationCode(fixedBytes([31, 63, 255, 32, 8, 100]))).toBe('ZZZ2A6');
  });
  it('generates voucher codes that pass the Luhn mod 32 check', () => {
    const code = voucherCode(fixedBytes([10, 20, 30, 40, 50, 60, 70, 80]));
    expect(code).toHaveLength(9);
    expect(isValidLuhnModN(code)).toBe(true);
    expect(normalizeVoucherCode(formatVoucherCode(code).toLowerCase())).toBe(code);
  });
  it('detects every single-character substitution', () => {
    const code = voucherCode(fixedBytes([1, 2, 3, 4, 5, 6, 7, 8]));
    for (let i = 0; i < code.length; i++) {
      for (const ch of CODE_ALPHABET) {
        if (ch === code[i]) continue;
        const bad = code.slice(0, i) + ch + code.slice(i + 1);
        expect(isValidLuhnModN(bad)).toBe(false);
      }
    }
  });
  it('rejects malformed voucher input', () => {
    expect(normalizeVoucherCode('ABC')).toBeNull();
    expect(normalizeVoucherCode('OOOO-OOOO-O')).toBeNull();
  });
});

describe('contact normalization', () => {
  it('normalizes US formats to E.164', () => {
    for (const input of ['(212) 555-0142', '212.555.0142', '1-212-555-0142', '+1 212 555 0142', '2125550142']) {
      expect(normalizePhone(input)).toBe('+12125550142');
    }
  });
  it('keeps valid international numbers', () => {
    expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958');
  });
  it('rejects invalid numbers', () => {
    for (const input of ['555-0142', '(011) 555-0142', '+1 911 555 0142', '212-411-0142', 'abc', '', '+0123', '212555014']) {
      expect(normalizePhone(input)).toBeNull();
    }
    expect(normalizePhone(null)).toBeNull();
  });
  it('allows SMS only to +1 numbers in MVP', () => {
    expect(isSmsCapable('+12125550142')).toBe(true);
    expect(isSmsCapable('+442079460958')).toBe(false);
  });
  it('normalizes emails without provider-specific rules', () => {
    expect(normalizeEmail('  Maya.Lee@Example.COM ')).toBe('maya.lee@example.com');
    expect(normalizeEmail('bad@')).toBeNull();
    expect(normalizeEmail('a@b')).toBeNull();
  });
  it('masks phones for staff display', () => {
    expect(maskPhone('+12125550142')).toBe('+1 ••• ••• 0142');
  });
});

describe('BR-01 money', () => {
  it('parses and formats dollars as integer cents', () => {
    expect(parseDollars('12.5')).toBe(1250);
    expect(parseDollars('12')).toBe(1200);
    expect(parseDollars('0.07')).toBe(7);
    expect(parseDollars('-3.10')).toBe(-310);
    expect(() => parseDollars('1.234')).toThrow('Invalid dollar amount');
    expect(formatUsd(123456)).toBe('$1,234.56');
    expect(formatUsd(-5)).toBe('-$0.05');
  });
  it('rounds half away from zero', () => {
    expect(applyBps(1000, 7000)).toBe(700);
    expect(applyBps(15, 5000)).toBe(8);
    expect(applyBps(-15, 5000)).toBe(-8);
    expect(lineGrossCents(1.5, 1299)).toBe(1949);
  });
});
