import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  deviceHash,
  hashPassword,
  holdoutBucket,
  hotp,
  isHoldout,
  isRandomizedMac,
  normalizeMac,
  otpauthUrl,
  squareSignature,
  totp,
  twilioSignature,
  verifyPassword,
  verifyTotp,
} from '../src/node-crypto.ts';

const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

describe('HOTP / TOTP (RFC 4226 and RFC 6238 published vectors)', () => {
  it('matches RFC 4226 appendix D', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expected.forEach((code, counter) => expect(hotp(RFC_SECRET, counter)).toBe(code));
  });
  it('matches RFC 6238 appendix B (SHA-1, 8 digits)', () => {
    const vectors: Array<[number, string]> = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [t, code] of vectors) expect(totp(RFC_SECRET, t, 8)).toBe(code);
  });
  it('verifies within a +/-1 step window and returns the counter', () => {
    const code = totp(RFC_SECRET, 59);
    expect(verifyTotp(RFC_SECRET, code, 89)).toBe(1);
    expect(verifyTotp(RFC_SECRET, code, 150)).toBeNull();
    expect(verifyTotp(RFC_SECRET, 'abcdef', 59)).toBeNull();
  });
  it('encodes base32 and otpauth URLs', () => {
    expect(base32Encode(RFC_SECRET)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ').equals(RFC_SECRET)).toBe(true);
    expect(otpauthUrl('Tablekit', 'maya@example.com', 'ABC')).toBe('otpauth://totp/Tablekit%3Amaya%40example.com?secret=ABC&issuer=Tablekit&algorithm=SHA1&digits=6&period=30');
  });
});

describe('passwords (scrypt)', () => {
  const fast = { N: 1024, r: 8, p: 1, keyLength: 64 };
  it('hashes and verifies', () => {
    const stored = hashPassword('correct horse battery staple', fast, Buffer.alloc(16, 7));
    expect(stored.startsWith('scrypt$1024$8$1$')).toBe(true);
    expect(verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(verifyPassword('wrong horse battery staple', stored)).toBe(false);
    expect(verifyPassword('anything', 'bcrypt$garbage')).toBe(false);
  });
  it('rejects short passwords', () => {
    expect(() => hashPassword('short', fast)).toThrow('at least 12');
  });
});

describe('holdouts and device hashing', () => {
  it('assigns holdouts deterministically at the requested rate', () => {
    expect(holdoutBucket('camp-1', 'guest-1')).toBe(holdoutBucket('camp-1', 'guest-1'));
    let holdouts = 0;
    for (let i = 0; i < 10_000; i++) if (isHoldout('camp-1', `guest-${i}`, 10)) holdouts++;
    expect(holdouts).toBeGreaterThan(900);
    expect(holdouts).toBeLessThan(1100);
  });
  it('normalizes MACs and detects randomized addresses', () => {
    expect(normalizeMac('AA-BB-CC-DD-EE-FF')).toBe('aa:bb:cc:dd:ee:ff');
    expect(normalizeMac('aabb.ccdd.eeff')).toBe('aa:bb:cc:dd:ee:ff');
    expect(normalizeMac('xyz')).toBeNull();
    expect(isRandomizedMac('da:a1:19:00:00:01')).toBe(true);
    expect(isRandomizedMac('00:1a:2b:3c:4d:5e')).toBe(false);
  });
  it('hashes devices per venue', () => {
    const a = deviceHash('master', 'venue-1', 'AA:BB:CC:DD:EE:FF');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(deviceHash('master', 'venue-1', 'aa-bb-cc-dd-ee-ff')).toBe(a);
    expect(deviceHash('master', 'venue-2', 'aa:bb:cc:dd:ee:ff')).not.toBe(a);
  });
});

describe('webhook signatures', () => {
  it('reproduces the Twilio documentation example', () => {
    const params = { CallSid: 'CA1234567890ABCDE', Caller: '+14158675309', Digits: '1234', From: '+14158675309', To: '+18005551212' };
    expect(twilioSignature('12345', 'https://mycompany.com/myapp.php?foo=1&bar=2', params)).toBe('RSOYDt4T1cUTdK1PDd93/VVr8B8=');
  });
  it('computes Square signatures over URL + raw body', () => {
    const sig = squareSignature('key', 'https://api.example.com/webhooks/square', '{"a":1}');
    expect(sig).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(squareSignature('key', 'https://api.example.com/webhooks/square/', '{"a":1}')).not.toBe(sig);
  });
});
