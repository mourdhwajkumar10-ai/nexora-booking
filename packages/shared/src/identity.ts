/**
 * BR-19 Identity resolution inside ONE tenant. Guests of different tenants are never compared.
 */

export interface ContactValue {
  value: string;
  verified: boolean;
}

export interface GuestIdentity {
  id: string;
  createdAtMs: number;
  firstName: string | null;
  lastName: string | null;
  phones: ReadonlyArray<ContactValue>;
  emails: ReadonlyArray<ContactValue>;
  cardFingerprints: ReadonlyArray<string>;
}

export type MergeDecision = 'auto' | 'suggest' | 'none';

export type MergeReason =
  | 'conflicting_verified_phones'
  | 'shared_verified_contact'
  | 'shared_contact_one_verified'
  | 'shared_contact_one_verified_name_mismatch'
  | 'shared_unverified_contact'
  | 'shared_unverified_contact_name_mismatch'
  | 'shared_card_fingerprint'
  | 'shared_card_fingerprint_name_mismatch'
  | 'no_shared_identifier';

/** Lowercase, strip diacritics and everything that is not a-z. */
export function normalizeName(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

/**
 * Compatible when last names are equal or either is missing, AND first names are equal,
 * or one is a single initial of the other, or either is missing.
 */
export function namesCompatible(a: Pick<GuestIdentity, 'firstName' | 'lastName'>, b: Pick<GuestIdentity, 'firstName' | 'lastName'>): boolean {
  const fa = normalizeName(a.firstName);
  const fb = normalizeName(b.firstName);
  const la = normalizeName(a.lastName);
  const lb = normalizeName(b.lastName);
  if (la && lb && la !== lb) return false;
  if (fa && fb && fa !== fb) {
    const initialMatch = (fa.length === 1 && fb.startsWith(fa)) || (fb.length === 1 && fa.startsWith(fb));
    if (!initialMatch) return false;
  }
  return true;
}

interface Shared {
  bothVerified: boolean;
  oneVerified: boolean;
}

function sharedContacts(a: ReadonlyArray<ContactValue>, b: ReadonlyArray<ContactValue>): Shared[] {
  const out: Shared[] = [];
  for (const x of a) {
    for (const y of b) {
      if (x.value === y.value) out.push({ bothVerified: x.verified && y.verified, oneVerified: x.verified !== y.verified });
    }
  }
  return out;
}

export function decideMerge(a: GuestIdentity, b: GuestIdentity): { decision: MergeDecision; reason: MergeReason } {
  const vpa = new Set(a.phones.filter((p) => p.verified).map((p) => p.value));
  const vpb = new Set(b.phones.filter((p) => p.verified).map((p) => p.value));
  if (vpa.size > 0 && vpb.size > 0 && ![...vpa].some((v) => vpb.has(v))) {
    return { decision: 'none', reason: 'conflicting_verified_phones' };
  }
  const shared = [...sharedContacts(a.phones, b.phones), ...sharedContacts(a.emails, b.emails)];
  const compatible = namesCompatible(a, b);
  if (shared.some((s) => s.bothVerified)) return { decision: 'auto', reason: 'shared_verified_contact' };
  if (shared.some((s) => s.oneVerified)) {
    return compatible
      ? { decision: 'auto', reason: 'shared_contact_one_verified' }
      : { decision: 'suggest', reason: 'shared_contact_one_verified_name_mismatch' };
  }
  if (shared.length > 0) {
    return compatible
      ? { decision: 'suggest', reason: 'shared_unverified_contact' }
      : { decision: 'none', reason: 'shared_unverified_contact_name_mismatch' };
  }
  if (a.cardFingerprints.some((f) => b.cardFingerprints.includes(f))) {
    return compatible
      ? { decision: 'suggest', reason: 'shared_card_fingerprint' }
      : { decision: 'none', reason: 'shared_card_fingerprint_name_mismatch' };
  }
  return { decision: 'none', reason: 'no_shared_identifier' };
}

function hasVerified(g: GuestIdentity): boolean {
  return g.phones.some((p) => p.verified) || g.emails.some((e) => e.verified);
}

/** Survivor: the record with a verified contact; otherwise the older record; tie -> smaller id. */
export function pickSurvivor(a: GuestIdentity, b: GuestIdentity): { survivor: GuestIdentity; loser: GuestIdentity } {
  const av = hasVerified(a);
  const bv = hasVerified(b);
  if (av !== bv) return av ? { survivor: a, loser: b } : { survivor: b, loser: a };
  if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs < b.createdAtMs ? { survivor: a, loser: b } : { survivor: b, loser: a };
  return a.id < b.id ? { survivor: a, loser: b } : { survivor: b, loser: a };
}

function unionContacts(a: ReadonlyArray<ContactValue>, b: ReadonlyArray<ContactValue>): ContactValue[] {
  const map = new Map<string, boolean>();
  for (const c of [...a, ...b]) map.set(c.value, (map.get(c.value) ?? false) || c.verified);
  return [...map.entries()].map(([value, verified]) => ({ value, verified })).sort((x, y) => Number(y.verified) - Number(x.verified) || (x.value < y.value ? -1 : 1));
}

/** Field survivorship. Names: survivor's non-empty values win, else loser's. Contacts: union, verified first. */
export function mergeIdentities(survivor: GuestIdentity, loser: GuestIdentity): GuestIdentity {
  return {
    id: survivor.id,
    createdAtMs: Math.min(survivor.createdAtMs, loser.createdAtMs),
    firstName: survivor.firstName?.trim() ? survivor.firstName : loser.firstName,
    lastName: survivor.lastName?.trim() ? survivor.lastName : loser.lastName,
    phones: unionContacts(survivor.phones, loser.phones),
    emails: unionContacts(survivor.emails, loser.emails),
    cardFingerprints: [...new Set([...survivor.cardFingerprints, ...loser.cardFingerprints])].sort(),
  };
}
