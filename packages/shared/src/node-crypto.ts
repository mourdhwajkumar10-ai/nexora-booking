/**
 * Server-only helpers that need node:crypto. Import from '@platform/domain/node'.
 * NEVER import this file from browser code.
 */
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hmacSha256Hex(key: string | Uint8Array, data: string): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

/** 32 random bytes, base64url. Used for session tokens, manage-booking links, portal attempts. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Tokens are stored hashed (sha256) so a DB leak cannot be replayed. */
export function tokenHash(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export function safeEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** BR-23: deterministic holdout assignment. bucket in [0, 10000). */
export function holdoutBucket(campaignId: string, guestId: string): number {
  const h = sha256Hex(`${campaignId}:${guestId}`);
  return Number.parseInt(h.slice(0, 8), 16) % 10_000;
}

export function isHoldout(campaignId: string, guestId: string, holdoutPct: number): boolean {
  return holdoutBucket(campaignId, guestId) < Math.round(holdoutPct * 100);
}

/** Lowercase colon form 'aa:bb:cc:dd:ee:ff'. Accepts ':', '-', '.' or no separators. */
export function normalizeMac(mac: string): string | null {
  const hex = mac.toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g)!.join(':');
}

/** Locally administered (randomized/private) MAC: bit 1 of the first octet is set. */
export function isRandomizedMac(normalized: string): boolean {
  return (Number.parseInt(normalized.slice(0, 2), 16) & 0b10) !== 0;
}

/**
 * BR-25: venue-specific device hash. The raw MAC is used only in memory for the grant call
 * and is never persisted or logged.
 */
export function deviceHash(masterKey: string, venueId: string, mac: string): string {
  const normalized = normalizeMac(mac);
  if (!normalized) throw new Error('Invalid MAC address');
  const venueKey = createHmac('sha256', masterKey).update(`venue:${venueId}`).digest();
  return createHmac('sha256', venueKey).update(normalized).digest('hex');
}

/** Suppression list key: HMAC with a server pepper so phone numbers cannot be brute-forced from hashes. */
export function contactHmac(pepper: string, contactKey: string): string {
  return hmacSha256Hex(pepper, contactKey);
}

export interface PortalHandshakePayload {
  venueId: string;
  mac: string;
  issuedAtMs: number;
  expiresAtMs: number;
}

/**
 * BR-25: 15-minute tokenized portal handshake.
 * The raw client MAC travels inside this HMAC-signed state token (<= 15 min TTL)
 * and is never persisted to database or logs.
 */
export function createPortalHandshake(secret: string, venueId: string, mac: string, ttlMs = 15 * 60_000, nowMs = Date.now()): string {
  const normMac = normalizeMac(mac) ?? mac.toLowerCase();
  const payload: PortalHandshakePayload = {
    venueId,
    mac: normMac,
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + ttlMs,
  };
  const jsonB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = hmacSha256Hex(secret, jsonB64);
  return `${jsonB64}.${sig}`;
}

export function verifyPortalHandshake(secret: string, token: string, nowMs = Date.now()): PortalHandshakePayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [jsonB64, sig] = parts;
  const expectedSig = hmacSha256Hex(secret, jsonB64);
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expectedSig, 'utf8');
  if (!safeEqual(a, b)) return null;
  try {
    const payload: PortalHandshakePayload = JSON.parse(Buffer.from(jsonB64, 'base64url').toString('utf8'));
    if (!payload.expiresAtMs || nowMs > payload.expiresAtMs) return null;
    return payload;
  } catch {
    return null;
  }
}

/* ---------------- Passwords (scrypt, no native dependency) ---------------- */

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
  keyLength: number;
}

export const DEFAULT_SCRYPT: ScryptParams = { N: 131_072, r: 8, p: 1, keyLength: 64 };

/** Format: scrypt$N$r$p$saltB64url$hashB64url */
export function hashPassword(password: string, params: ScryptParams = DEFAULT_SCRYPT, salt: Buffer = randomBytes(16)): string {
  if (password.length < 12) throw new Error('Password must be at least 12 characters');
  const hash = scryptSync(password.normalize('NFKC'), salt, params.keyLength, { N: params.N, r: params.r, p: params.p, maxmem: 256 * 1024 * 1024 });
  return ['scrypt', params.N, params.r, params.p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4]!, 'base64url');
  const expected = Buffer.from(parts[5]!, 'base64url');
  const actual = scryptSync(password.normalize('NFKC'), salt, expected.length, { N, r, p, maxmem: 256 * 1024 * 1024 });
  return safeEqual(actual, expected);
}

/* ---------------- TOTP (RFC 6238, SHA-1, 30 s) ---------------- */

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function hotp(secret: Uint8Array, counter: number, digits = 6): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(buf).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const code = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(code % 10 ** digits).padStart(digits, '0');
}

export function totp(secret: Uint8Array, unixSeconds: number, digits = 6, stepSeconds = 30): string {
  return hotp(secret, Math.floor(unixSeconds / stepSeconds), digits);
}

/** Accepts the current step and +/- `window` steps. Returns the matched counter or null (store it to prevent reuse). */
export function verifyTotp(secret: Uint8Array, code: string, unixSeconds: number, window = 1): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const counter = Math.floor(unixSeconds / 30);
  for (let w = -window; w <= window; w++) {
    const candidate = hotp(secret, counter + w);
    if (safeEqual(Buffer.from(candidate), Buffer.from(code))) return counter + w;
  }
  return null;
}

export function otpauthUrl(issuer: string, account: string, secretBase32: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

/* ---------------- Webhook signatures ---------------- */

/** Twilio: base64(HMAC-SHA1(authToken, fullUrl + concat(sortedKeys.map(k => k + value)))). */
export function twilioSignature(authToken: string, fullUrl: string, params: Readonly<Record<string, string>>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], fullUrl);
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

/** Square: base64(HMAC-SHA256(signatureKey, notificationUrl + rawBody)). Compute on the RAW body. */
export function squareSignature(signatureKey: string, notificationUrl: string, rawBody: string): string {
  return createHmac('sha256', signatureKey).update(notificationUrl + rawBody, 'utf8').digest('base64');
}

export function verifyBase64Signature(expected: string, provided: string | undefined): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  return safeEqual(a, b);
}
