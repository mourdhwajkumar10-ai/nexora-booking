/**
 * BR-12 Eligible spend, BR-13 adjustment attribution (guest fairness), BR-14 check linking.
 */
import { roundHalfAwayFromZero, type Cents } from './money';

export type AttributionClass = 'GUEST' | 'KITCHEN' | 'SERVER_ENTRY' | 'PROMOTIONAL' | 'SYSTEM' | 'UNMAPPED';
export type AdjustmentKind = 'void' | 'comp' | 'discount' | 'refund';

export interface ClassifyInput {
  kind: AdjustmentKind;
  /** provider reason id (Toast voidReason GUID, discount id, etc.) */
  reasonRef: string | null;
  /** venue mapping reasonRef -> class, maintained in the console (pos_reason_mappings) */
  mappings: Readonly<Record<string, AttributionClass>>;
  /** when the affected item was fired to the kitchen, if known */
  firedAtMs: number | null;
  occurredAtMs: number;
  /** false when the provider does not expose fire data at all */
  fireDataAvailable: boolean;
}

export interface ClassifyResult {
  attributionClass: AttributionClass;
  firedBefore: boolean | null;
  countsAsGuestReturn: boolean;
}

/**
 * Unmapped discounts default to PROMOTIONAL; any other unmapped reason is UNMAPPED (neutral).
 * Only GUEST + fired-before-adjustment + (void|comp|refund) counts against a guest.
 * If the provider has no fire data, nothing counts against a guest.
 */
export function classifyAdjustment(input: ClassifyInput): ClassifyResult {
  const mapped = input.reasonRef !== null ? input.mappings[input.reasonRef] : undefined;
  const attributionClass: AttributionClass = mapped ?? (input.kind === 'discount' ? 'PROMOTIONAL' : 'UNMAPPED');
  let firedBefore: boolean | null;
  if (!input.fireDataAvailable) firedBefore = null;
  else if (input.firedAtMs === null) firedBefore = false;
  else firedBefore = input.firedAtMs < input.occurredAtMs;
  const countsAsGuestReturn = attributionClass === 'GUEST' && firedBefore === true && input.kind !== 'discount';
  return { attributionClass, firedBefore, countsAsGuestReturn };
}

export interface CalcItem {
  id: string;
  grossCents: Cents;
  voided: boolean;
  /** normalized category code, e.g. 'FOOD', 'WINE', 'GIFT_CARD' */
  category: string | null;
}

export interface CalcAdjustment {
  kind: AdjustmentKind;
  /** null = check-level */
  itemId: string | null;
  /** positive number of cents removed from the check (tips excluded) */
  amountCents: Cents;
}

export const DEFAULT_EXCLUDED_CATEGORIES: ReadonlyArray<string> = ['GIFT_CARD'];

/**
 * BR-12: spend that earns loyalty points and counts toward tiers.
 * eligibleGross = non-voided, non-excluded item gross.
 * Item-level discounts/comps/refunds on eligible items are subtracted directly.
 * Check-level discounts/comps/refunds are allocated by eligibleGross / totalGross (rounded half away from zero).
 * Voids are represented by item.voided and are ignored here. Tax, tip and service charges are never included.
 */
export function eligibleSpendCents(items: ReadonlyArray<CalcItem>, adjustments: ReadonlyArray<CalcAdjustment>, excludedCategories: ReadonlyArray<string> = DEFAULT_EXCLUDED_CATEGORIES): Cents {
  const live = items.filter((i) => !i.voided);
  const eligibleIds = new Set(live.filter((i) => i.category === null || !excludedCategories.includes(i.category)).map((i) => i.id));
  const totalGross = live.reduce((s, i) => s + i.grossCents, 0);
  const eligibleGross = live.filter((i) => eligibleIds.has(i.id)).reduce((s, i) => s + i.grossCents, 0);
  let itemLevel = 0;
  let checkLevel = 0;
  for (const a of adjustments) {
    if (a.kind === 'void') continue;
    if (a.itemId === null) checkLevel += a.amountCents;
    else if (eligibleIds.has(a.itemId)) itemLevel += a.amountCents;
  }
  const allocated = totalGross > 0 ? roundHalfAwayFromZero((checkLevel * eligibleGross) / totalGross) : 0;
  return Math.max(0, eligibleGross - itemLevel - allocated);
}

export interface LinkCheck {
  tableId: string | null;
  openedAtMs: number;
}

export interface LinkReservation {
  id: string;
  tableIds: ReadonlyArray<string>;
  startsAtMs: number;
  seatedAtMs: number | null;
  completedAtMs: number | null;
  turnMinutes: number;
  status: 'arrived' | 'late' | 'seated' | 'completed' | 'confirmed';
}

/**
 * BR-14a: a check links to the reservation on the same table whose window contains openedAt.
 * anchor = seatedAt ?? startsAt; window = [anchor - 10 min, completedAt ?? anchor + turn + 30 min].
 * If several match, pick the latest anchor that is <= openedAt + 10 min. No table -> no link.
 */
export function findReservationForCheck(check: LinkCheck, reservations: ReadonlyArray<LinkReservation>): string | null {
  if (check.tableId === null) return null;
  const matches = reservations.filter((r) => {
    if (!r.tableIds.includes(check.tableId as string)) return false;
    const anchor = r.seatedAtMs ?? r.startsAtMs;
    const end = r.completedAtMs ?? anchor + (r.turnMinutes + 30) * 60_000;
    return check.openedAtMs >= anchor - 10 * 60_000 && check.openedAtMs <= end;
  });
  const ranked = matches
    .map((r) => ({ id: r.id, anchor: r.seatedAtMs ?? r.startsAtMs }))
    .filter((x) => x.anchor <= check.openedAtMs + 10 * 60_000)
    .sort((a, b) => b.anchor - a.anchor);
  return ranked[0]?.id ?? null;
}

export type CreditMethod = 'staff' | 'claim' | 'card_fingerprint' | 'pos_customer' | 'reservation';

export interface CreditSignals {
  staffGuestId?: string | null;
  claimGuestId?: string | null;
  cardFingerprintGuestId?: string | null;
  posCustomerGuestId?: string | null;
  reservationGuestId?: string | null;
}

const CREDIT_ORDER: ReadonlyArray<[keyof CreditSignals, CreditMethod, number]> = [
  ['staffGuestId', 'staff', 1],
  ['claimGuestId', 'claim', 1],
  ['cardFingerprintGuestId', 'card_fingerprint', 0.99],
  ['posCustomerGuestId', 'pos_customer', 0.9],
  ['reservationGuestId', 'reservation', 0.8],
];

/** BR-14b: which guest a check is credited to. Highest-priority signal wins. */
export function chooseGuestCredit(signals: CreditSignals): { guestId: string; method: CreditMethod; confidence: number } | null {
  for (const [key, method, confidence] of CREDIT_ORDER) {
    const v = signals[key];
    if (v) return { guestId: v, method, confidence };
  }
  return null;
}
