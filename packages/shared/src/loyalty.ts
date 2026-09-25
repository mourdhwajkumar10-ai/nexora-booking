/**
 * Loyalty rules (Architecture §Dynamic Membership Tier Progression). Money is INR in paise.
 * Follows the doc's tier TABLE (the prose contradicts it; CRITIQUE #11). USD thresholds are converted
 * at a round ₹100 = $1 (e.g. $500 spend -> ₹50,000).
 */
import type { TierLevel } from './constants';
import { POINTS_PER_RUPEE_UNIT } from './constants';

export interface TierRule {
  tier: TierLevel;
  label: string;
  annualSpendPaise: number;
  singlePreloadPaise: number;
  multiplier: number;
  perks: string;
}

export const TIER_RULES: readonly TierRule[] = [
  { tier: 'BASE', label: 'Base Member', annualSpendPaise: 0, singlePreloadPaise: 0, multiplier: 3, perks: 'Standard booking access, automated Wi-Fi check-in' },
  { tier: 'MEMBER', label: 'Club Member', annualSpendPaise: 50_000_00, singlePreloadPaise: 25_000_00, multiplier: 4, perks: 'Priority waitlist placement' },
  { tier: 'REGULAR', label: 'Club Regular', annualSpendPaise: 5_00_000_00, singlePreloadPaise: 2_50_000_00, multiplier: 5, perks: 'Prime-time booking access, concierge support, Members’ Night' },
  { tier: 'FRIENDS_AND_FAMILY', label: 'Friends & Family', annualSpendPaise: 10_00_000_00, singlePreloadPaise: 5_00_000_00, multiplier: 7, perks: '24/7 concierge, off-peak table holds, tasting upgrades' },
];

export function tierRule(tier: TierLevel): TierRule {
  return TIER_RULES.find((r) => r.tier === tier)!;
}

const rank = (t: TierLevel) => TIER_RULES.findIndex((r) => r.tier === t);

/** Highest tier unlocked by annual spend or a single preload; never downgrades below `current`. */
export function computeTier(current: TierLevel, annualSpendPaise: number, largestPreloadPaise = 0): TierLevel {
  let best: TierLevel = current;
  for (const r of TIER_RULES) {
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
