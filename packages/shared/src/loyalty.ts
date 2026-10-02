/**
 * Loyalty rules.
 * Combines Plan Pack Reference (BR-15 Earn, BR-16 tiers, BR-17 vouchers)
 * with venue-level INR loyalty rules and tier progression.
 */
import type { TierLevel } from './constants';
import { POINTS_PER_RUPEE_UNIT } from './constants';

/* =========================================================================
 * BR-15 Earn, BR-16 Tiers, BR-17 Vouchers (Plan Pack Reference)
 * ========================================================================= */

export type Tier = 'member' | 'regular' | 'insider';

export interface BoosterRule {
  id: string;
  /** null = every venue of the tenant */
  venueId: string | null;
  /** extra points per whole eligible dollar: 1..4 */
  pointsPerDollar: number;
  /** 0 = Sunday */
  daysOfWeek: ReadonlyArray<number>;
  /** [startMinute, endMinute) local wall clock of check open time */
  startMinute: number;
  endMinute: number;
  firstVisitOnly: boolean;
  monthlyBudgetPoints: number;
  createdAtMs: number;
  active: boolean;
}

export interface EarnInput {
  eligibleCents: number;
  /** 1 for everyone in MVP (Club = 2 in V2) */
  basePointsPerDollar: number;
  venueId: string;
  localDayOfWeek: number;
  localMinuteOfDay: number;
  isFirstVisitAtVenue: boolean;
  boosters: ReadonlyArray<BoosterRule>;
  /** points already awarded this calendar month per booster id */
  boosterUsedThisMonth: Readonly<Record<string, number>>;
}

export interface EarnResult {
  basePoints: number;
  booster: { ruleId: string; points: number } | null;
  totalPoints: number;
}

export function computeEarn(input: EarnInput): EarnResult {
  const dollars = Math.floor(Math.max(0, input.eligibleCents) / 100);
  const basePoints = dollars * input.basePointsPerDollar;
  const matching = input.boosters
    .filter((b) => b.active)
    .filter((b) => b.venueId === null || b.venueId === input.venueId)
    .filter((b) => b.daysOfWeek.includes(input.localDayOfWeek))
    .filter((b) => input.localMinuteOfDay >= b.startMinute && input.localMinuteOfDay < b.endMinute)
    .filter((b) => !b.firstVisitOnly || input.isFirstVisitAtVenue)
    .filter((b) => b.monthlyBudgetPoints - (input.boosterUsedThisMonth[b.id] ?? 0) > 0)
    .sort((a, b) => (b.pointsPerDollar !== a.pointsPerDollar ? b.pointsPerDollar - a.pointsPerDollar : a.createdAtMs - b.createdAtMs));
  let booster: EarnResult['booster'] = null;
  const rule = matching[0];
  if (rule && dollars > 0) {
    const remaining = rule.monthlyBudgetPoints - (input.boosterUsedThisMonth[rule.id] ?? 0);
    booster = { ruleId: rule.id, points: Math.min(dollars * rule.pointsPerDollar, remaining) };
  }
  return { basePoints, booster, totalPoints: basePoints + (booster?.points ?? 0) };
}

export type LedgerEntryType =
  | 'earn_pending'
  | 'earn_adjust_pending'
  | 'earn_settle'
  | 'earn_adjust'
  | 'earn_reverse'
  | 'writeoff'
  | 'redeem_hold'
  | 'redeem_capture'
  | 'redeem_release'
  | 'expire'
  | 'manual_adjust';

export interface LedgerDelta {
  type: LedgerEntryType;
  pendingDelta: number;
  availableDelta: number;
  heldDelta: number;
}

/**
 * Re-computation after a check changes (void/refund/tip edits).
 * `state` = whether this check's earn entries are still pending or already settled.
 */
export function planEarnAdjustment(state: 'pending' | 'settled', currentPoints: number, newPoints: number): LedgerDelta[] {
  const delta = newPoints - currentPoints;
  if (delta === 0) return [];
  if (state === 'pending') return [{ type: 'earn_adjust_pending', pendingDelta: delta, availableDelta: 0, heldDelta: 0 }];
  return [{ type: delta < 0 ? 'earn_reverse' : 'earn_adjust', pendingDelta: 0, availableDelta: delta, heldDelta: 0 }];
}

/** After a reversal: small deficits (> -threshold) are written off (platform-funded) back to 0. */
export function writeOffPoints(availableAfter: number, thresholdPoints = 500): number {
  return availableAfter < 0 && availableAfter > -thresholdPoints ? -availableAfter : 0;
}

export const TIER_RULES = {
  regular: { visits: 6, spendCents: 75_000 },
  insider: { visits: 15, spendCents: 250_000 },
} as const;

/** Tier earned from one calendar year's qualifying visits and eligible spend. */
export function tierFor(visits: number, spendCents: number): Tier {
  if (visits >= TIER_RULES.insider.visits || spendCents >= TIER_RULES.insider.spendCents) return 'insider';
  if (visits >= TIER_RULES.regular.visits || spendCents >= TIER_RULES.regular.spendCents) return 'regular';
  return 'member';
}

const TIER_RANK: Readonly<Record<Tier, number>> = { member: 0, regular: 1, insider: 2 };

/** A tier earned in year Y is kept through the end of Y + 1. */
export function effectiveTier(earnedThisYear: Tier, earnedLastYear: Tier): Tier {
  return TIER_RANK[earnedThisYear] >= TIER_RANK[earnedLastYear] ? earnedThisYear : earnedLastYear;
}

export const VOUCHER_DENOMINATIONS_CENTS: ReadonlyArray<number> = [500, 1000, 2500];
export const MAX_ACTIVE_VOUCHERS = 3;
export const VOUCHER_TTL_DAYS = 30;

export type VoucherCheck =
  | { ok: true; points: number; deltas: LedgerDelta[] }
  | { ok: false; error: 'INVALID_DENOMINATION' | 'INSUFFICIENT_POINTS' | 'TOO_MANY_ACTIVE_VOUCHERS' | 'ACCOUNT_NOT_ACTIVE' };

/** Creating a voucher moves points from available to held (points = cents). */
export function planVoucherHold(valueCents: number, availablePoints: number, activeVouchers: number, accountActive: boolean): VoucherCheck {
  if (!accountActive) return { ok: false, error: 'ACCOUNT_NOT_ACTIVE' };
  if (!VOUCHER_DENOMINATIONS_CENTS.includes(valueCents)) return { ok: false, error: 'INVALID_DENOMINATION' };
  if (activeVouchers >= MAX_ACTIVE_VOUCHERS) return { ok: false, error: 'TOO_MANY_ACTIVE_VOUCHERS' };
  const points = valueCents;
  if (availablePoints < points) return { ok: false, error: 'INSUFFICIENT_POINTS' };
  return { ok: true, points, deltas: [{ type: 'redeem_hold', pendingDelta: 0, availableDelta: -points, heldDelta: points }] };
}

export function planVoucherCapture(points: number): LedgerDelta[] {
  return [{ type: 'redeem_capture', pendingDelta: 0, availableDelta: 0, heldDelta: -points }];
}

export function planVoucherRelease(points: number): LedgerDelta[] {
  return [{ type: 'redeem_release', pendingDelta: 0, availableDelta: points, heldDelta: -points }];
}

/** Settlement: pending points move to available 72 hours after the check closed. */
export const PENDING_HOURS = 72;

export function settleAt(checkClosedAtMs: number): number {
  return checkClosedAtMs + PENDING_HOURS * 3_600_000;
}

/** Earn is allowed for checks closed no earlier than 14 days before enrollment. */
export function earnAllowedForCheck(checkClosedAtMs: number, enrolledAtMs: number): boolean {
  return checkClosedAtMs >= enrolledAtMs - 14 * 86_400_000;
}

/* =========================================================================
 * Venue-Level Loyalty Rules & Tier Progression (Existing Shared Functions)
 * ========================================================================= */

export interface TierRule {
  tier: TierLevel;
  label: string;
  annualSpendPaise: number;
  singlePreloadPaise: number;
  multiplier: number;
  perks: string;
}

export const VENUE_TIER_RULES: readonly TierRule[] = [
  { tier: 'BASE', label: 'Base Member', annualSpendPaise: 0, singlePreloadPaise: 0, multiplier: 3, perks: 'Standard booking access, automated Wi-Fi check-in' },
  { tier: 'MEMBER', label: 'Club Member', annualSpendPaise: 50_000_00, singlePreloadPaise: 25_000_00, multiplier: 4, perks: 'Priority waitlist placement' },
  { tier: 'REGULAR', label: 'Club Regular', annualSpendPaise: 5_00_000_00, singlePreloadPaise: 2_50_000_00, multiplier: 5, perks: 'Prime-time booking access, concierge support, Members’ Night' },
  { tier: 'FRIENDS_AND_FAMILY', label: 'Friends & Family', annualSpendPaise: 10_00_000_00, singlePreloadPaise: 5_00_000_00, multiplier: 7, perks: '24/7 concierge, off-peak table holds, tasting upgrades' },
];

export const TIER_RULES_LIST = VENUE_TIER_RULES;

export function tierRule(tier: TierLevel): TierRule {
  return VENUE_TIER_RULES.find((r) => r.tier === tier)!;
}

const rank = (t: TierLevel) => VENUE_TIER_RULES.findIndex((r) => r.tier === t);

/** Highest tier unlocked by annual spend or a single preload; never downgrades below `current`. */
export function computeTier(current: TierLevel, annualSpendPaise: number, largestPreloadPaise = 0): TierLevel {
  let best: TierLevel = current;
  for (const r of VENUE_TIER_RULES) {
    if ((annualSpendPaise >= r.annualSpendPaise || (r.singlePreloadPaise > 0 && largestPreloadPaise >= r.singlePreloadPaise)) && rank(r.tier) > rank(best)) {
      best = r.tier;
    }
  }
  return best;
}

/** Points earned = floor(net rupees) * multiplier. Net excludes tips, taxes, voids and comps. */
export function pointsForSpend(netPaise: number, tier: TierLevel): number {
  return Math.floor(Math.max(0, netPaise) / 100) * tierRule(tier).multiplier;
}

export function pointsToPaise(points: number): number {
  return Math.floor((points * 100) / POINTS_PER_RUPEE_UNIT);
}

export function paiseToPoints(paise: number): number {
  return Math.ceil((paise * POINTS_PER_RUPEE_UNIT) / 100);
}

/** Post-settlement void clawback: points originally granted on the voided amount. */
export function clawbackPoints(voidedPaise: number, tier: TierLevel): number {
  return pointsForSpend(voidedPaise, tier);
}

export function formatINR(paise: number): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: paise % 100 === 0 ? 0 : 2 }).format(paise / 100);
}
