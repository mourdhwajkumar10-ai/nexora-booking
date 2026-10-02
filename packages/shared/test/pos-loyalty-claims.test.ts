import { describe, expect, it } from 'vitest';
import { chooseGuestCredit, classifyAdjustment, eligibleSpendCents, findReservationForCheck, type LinkReservation } from '../src/pos.ts';
import {
  computeEarn,
  earnAllowedForCheck,
  effectiveTier,
  planEarnAdjustment,
  planVoucherCapture,
  planVoucherHold,
  planVoucherRelease,
  settleAt,
  tierFor,
  writeOffPoints,
  type BoosterRule,
} from '../src/loyalty.ts';
import { matchClaim, type ClaimCandidateCheck } from '../src/claims.ts';

const at = (iso: string) => Date.parse(iso);

describe('BR-13 adjustment attribution', () => {
  const mappings = { 'vr-guest': 'GUEST', 'vr-kitchen': 'KITCHEN' } as const;
  const base = { mappings, occurredAtMs: at('2026-06-15T23:30:00Z'), fireDataAvailable: true };
  it('counts only guest-attributed, post-fire returns', () => {
    expect(classifyAdjustment({ ...base, kind: 'void', reasonRef: 'vr-guest', firedAtMs: at('2026-06-15T23:10:00Z') })).toEqual({ attributionClass: 'GUEST', firedBefore: true, countsAsGuestReturn: true });
    expect(classifyAdjustment({ ...base, kind: 'void', reasonRef: 'vr-guest', firedAtMs: null })).toEqual({ attributionClass: 'GUEST', firedBefore: false, countsAsGuestReturn: false });
    expect(classifyAdjustment({ ...base, kind: 'refund', reasonRef: 'vr-guest', firedAtMs: at('2026-06-15T23:10:00Z') }).countsAsGuestReturn).toBe(true);
  });
  it('never blames the guest for kitchen, unmapped or promotional adjustments', () => {
    expect(classifyAdjustment({ ...base, kind: 'void', reasonRef: 'vr-kitchen', firedAtMs: at('2026-06-15T23:10:00Z') }).countsAsGuestReturn).toBe(false);
    expect(classifyAdjustment({ ...base, kind: 'void', reasonRef: 'unknown', firedAtMs: null }).attributionClass).toBe('UNMAPPED');
    expect(classifyAdjustment({ ...base, kind: 'discount', reasonRef: null, firedAtMs: null }).attributionClass).toBe('PROMOTIONAL');
  });
  it('is neutral when the provider has no fire data', () => {
    expect(classifyAdjustment({ ...base, fireDataAvailable: false, kind: 'comp', reasonRef: 'vr-guest', firedAtMs: at('2026-06-15T23:10:00Z') })).toEqual({ attributionClass: 'GUEST', firedBefore: null, countsAsGuestReturn: false });
  });
});

describe('BR-12 eligible spend', () => {
  it('excludes voided and gift-card items and allocates check-level discounts', () => {
    const items = [
      { id: 'i1', grossCents: 3000, voided: false, category: 'FOOD' },
      { id: 'i2', grossCents: 6000, voided: false, category: 'WINE' },
      { id: 'i3', grossCents: 5000, voided: false, category: 'GIFT_CARD' },
      { id: 'i4', grossCents: 1000, voided: true, category: 'FOOD' },
    ];
    const adjustments = [
      { kind: 'discount' as const, itemId: null, amountCents: 1400 },
      { kind: 'comp' as const, itemId: 'i1', amountCents: 1000 },
      { kind: 'refund' as const, itemId: 'i3', amountCents: 500 },
      { kind: 'void' as const, itemId: 'i4', amountCents: 1000 },
    ];
    expect(eligibleSpendCents(items, adjustments)).toBe(7100);
  });
  it('rounds allocations half away from zero and never goes negative', () => {
    const items = [
      { id: 'a', grossCents: 100, voided: false, category: null },
      { id: 'b', grossCents: 100, voided: false, category: 'GIFT_CARD' },
    ];
    expect(eligibleSpendCents(items, [{ kind: 'discount', itemId: null, amountCents: 1 }])).toBe(99);
    expect(eligibleSpendCents(items, [{ kind: 'comp', itemId: 'a', amountCents: 500 }])).toBe(0);
    expect(eligibleSpendCents([{ id: 'x', grossCents: 900, voided: true, category: null }], [])).toBe(0);
  });
});

describe('BR-14 check linking', () => {
  const r1: LinkReservation = { id: 'R1', tableIds: ['t1'], startsAtMs: at('2026-06-15T23:00:00Z'), seatedAtMs: at('2026-06-15T23:05:00Z'), completedAtMs: null, turnMinutes: 90, status: 'seated' };
  const r2: LinkReservation = { id: 'R2', tableIds: ['t1'], startsAtMs: at('2026-06-16T01:00:00Z'), seatedAtMs: null, completedAtMs: null, turnMinutes: 90, status: 'confirmed' };
  it('links checks by table and time window', () => {
    expect(findReservationForCheck({ tableId: 't1', openedAtMs: at('2026-06-15T23:12:00Z') }, [r1, r2])).toBe('R1');
    expect(findReservationForCheck({ tableId: 't1', openedAtMs: at('2026-06-16T00:55:00Z') }, [r1, r2])).toBe('R2');
    expect(findReservationForCheck({ tableId: 't1', openedAtMs: at('2026-06-15T22:50:00Z') }, [r1, r2])).toBeNull();
    expect(findReservationForCheck({ tableId: null, openedAtMs: at('2026-06-15T23:12:00Z') }, [r1])).toBeNull();
    expect(findReservationForCheck({ tableId: 't2', openedAtMs: at('2026-06-15T23:12:00Z') }, [r1])).toBeNull();
  });
  it('credits the highest-priority signal', () => {
    expect(chooseGuestCredit({ reservationGuestId: 'g1', cardFingerprintGuestId: 'g2' })).toEqual({ guestId: 'g2', method: 'card_fingerprint', confidence: 0.99 });
    expect(chooseGuestCredit({ staffGuestId: 'g3', claimGuestId: 'g4' })).toEqual({ guestId: 'g3', method: 'staff', confidence: 1 });
    expect(chooseGuestCredit({})).toBeNull();
  });
});

describe('BR-15 earn', () => {
  const rule = (over: Partial<BoosterRule>): BoosterRule => ({
    id: 'x',
    venueId: null,
    pointsPerDollar: 2,
    daysOfWeek: [1, 2],
    startMinute: 1020,
    endMinute: 1140,
    firstVisitOnly: false,
    monthlyBudgetPoints: 1000,
    createdAtMs: 1,
    active: true,
    ...over,
  });
  const boosters = [
    rule({ id: 'b1' }),
    rule({ id: 'b2', venueId: 'v1', pointsPerDollar: 3, daysOfWeek: [1], endMinute: 1080, monthlyBudgetPoints: 100, createdAtMs: 2 }),
    rule({ id: 'b3', pointsPerDollar: 4, active: false }),
    rule({ id: 'b4', pointsPerDollar: 4, firstVisitOnly: true }),
  ];
  const input = { eligibleCents: 7150, basePointsPerDollar: 1, venueId: 'v1', localDayOfWeek: 1, localMinuteOfDay: 1050, isFirstVisitAtVenue: false, boosters, boosterUsedThisMonth: { b2: 50 } };
  it('awards base points plus the best booster capped by its budget', () => {
    expect(computeEarn(input)).toEqual({ basePoints: 71, booster: { ruleId: 'b2', points: 50 }, totalPoints: 121 });
  });
  it('falls through to the next booster when the best one is out of budget', () => {
    expect(computeEarn({ ...input, boosterUsedThisMonth: { b2: 100 } }).booster).toEqual({ ruleId: 'b1', points: 142 });
    expect(computeEarn({ ...input, localMinuteOfDay: 1100 }).booster?.ruleId).toBe('b1');
    expect(computeEarn({ ...input, localDayOfWeek: 2 }).booster?.ruleId).toBe('b1');
    expect(computeEarn({ ...input, isFirstVisitAtVenue: true }).booster).toEqual({ ruleId: 'b4', points: 284 });
  });
  it('awards nothing under one dollar', () => {
    expect(computeEarn({ ...input, eligibleCents: 99 })).toEqual({ basePoints: 0, booster: null, totalPoints: 0 });
  });
  it('plans adjustments and small write-offs', () => {
    expect(planEarnAdjustment('pending', 71, 51)).toEqual([{ type: 'earn_adjust_pending', pendingDelta: -20, availableDelta: 0, heldDelta: 0 }]);
    expect(planEarnAdjustment('settled', 71, 51)).toEqual([{ type: 'earn_reverse', pendingDelta: 0, availableDelta: -20, heldDelta: 0 }]);
    expect(planEarnAdjustment('settled', 71, 80)).toEqual([{ type: 'earn_adjust', pendingDelta: 0, availableDelta: 9, heldDelta: 0 }]);
    expect(planEarnAdjustment('settled', 71, 71)).toEqual([]);
    expect(writeOffPoints(-120)).toBe(120);
    expect(writeOffPoints(-500)).toBe(0);
    expect(writeOffPoints(50)).toBe(0);
  });
  it('settles after 72 hours and allows earn from 14 days before enrollment', () => {
    expect(settleAt(0)).toBe(72 * 3_600_000);
    const enrolled = at('2026-06-15T00:00:00Z');
    expect(earnAllowedForCheck(enrolled - 14 * 86_400_000, enrolled)).toBe(true);
    expect(earnAllowedForCheck(enrolled - 15 * 86_400_000, enrolled)).toBe(false);
  });
});

describe('BR-16 tiers and BR-17 vouchers', () => {
  it('computes tiers from visits or spend and keeps last year tier', () => {
    expect(tierFor(5, 74_999)).toBe('member');
    expect(tierFor(6, 0)).toBe('regular');
    expect(tierFor(0, 75_000)).toBe('regular');
    expect(tierFor(15, 0)).toBe('insider');
    expect(tierFor(0, 250_000)).toBe('insider');
    expect(effectiveTier('member', 'insider')).toBe('insider');
    expect(effectiveTier('regular', 'member')).toBe('regular');
  });
  it('holds, captures and releases voucher points', () => {
    expect(planVoucherHold(1000, 1500, 0, true)).toEqual({ ok: true, points: 1000, deltas: [{ type: 'redeem_hold', pendingDelta: 0, availableDelta: -1000, heldDelta: 1000 }] });
    expect(planVoucherHold(1000, 999, 0, true)).toEqual({ ok: false, error: 'INSUFFICIENT_POINTS' });
    expect(planVoucherHold(700, 5000, 0, true)).toEqual({ ok: false, error: 'INVALID_DENOMINATION' });
    expect(planVoucherHold(500, 5000, 3, true)).toEqual({ ok: false, error: 'TOO_MANY_ACTIVE_VOUCHERS' });
    expect(planVoucherHold(500, 5000, 0, false)).toEqual({ ok: false, error: 'ACCOUNT_NOT_ACTIVE' });
    expect(planVoucherCapture(1000)).toEqual([{ type: 'redeem_capture', pendingDelta: 0, availableDelta: 0, heldDelta: -1000 }]);
    expect(planVoucherRelease(1000)).toEqual([{ type: 'redeem_release', pendingDelta: 0, availableDelta: 1000, heldDelta: -1000 }]);
  });
});

describe('BR-18 receipt claims', () => {
  const check = (over: Partial<ClaimCandidateCheck>): ClaimCandidateCheck => ({
    id: 'c',
    businessDate: '2026-06-10',
    status: 'closed',
    totalCents: 0,
    totalBeforeTipCents: 0,
    checkNumber: null,
    cardLast4s: [],
    hasCardPayment: true,
    creditedAccountId: null,
    ...over,
  });
  const candidates = [
    check({ id: 'c1', totalCents: 8450, totalBeforeTipCents: 7150, checkNumber: '104', cardLast4s: ['4242'] }),
    check({ id: 'c2', totalCents: 3100, totalBeforeTipCents: 3100, checkNumber: '105', hasCardPayment: false }),
    check({ id: 'c3', totalCents: 8450, totalBeforeTipCents: 8450, checkNumber: '106', cardLast4s: ['1111'] }),
    check({ id: 'c4', status: 'open', totalCents: 2000, totalBeforeTipCents: 2000 }),
    check({ id: 'c5', totalCents: 20000, totalBeforeTipCents: 20000, checkNumber: '107', hasCardPayment: false }),
  ];
  const ctx = { accountId: 'a1', todayBusinessDate: '2026-06-12', claimsTodayByAccount: 0 };
  const claim = (over: object) => ({ businessDate: '2026-06-10', totalCents: 0, last4: null, checkNumber: null, ...over });
  it('matches unique checks by total (before or after tip) and card digits', () => {
    expect(matchClaim(claim({ totalCents: 7150, last4: '4242' }), candidates, ctx)).toEqual({ status: 'matched', checkId: 'c1' });
    expect(matchClaim(claim({ totalCents: 8450, last4: '1111' }), candidates, ctx)).toEqual({ status: 'matched', checkId: 'c3' });
    expect(matchClaim(claim({ totalCents: 8450 }), candidates, ctx)).toEqual({ status: 'manual_review', reason: 'ambiguous', checkIds: ['c1', 'c3'] });
  });
  it('applies cash rules', () => {
    expect(matchClaim(claim({ totalCents: 3100 }), candidates, ctx)).toEqual({ status: 'rejected', reason: 'check_number_required' });
    expect(matchClaim(claim({ totalCents: 3100, checkNumber: '105' }), candidates, ctx)).toEqual({ status: 'matched', checkId: 'c2' });
    expect(matchClaim(claim({ totalCents: 20000, checkNumber: '107' }), candidates, ctx)).toEqual({ status: 'manual_review', reason: 'cash_over_limit', checkIds: ['c5'] });
  });
  it('enforces limits and ownership', () => {
    expect(matchClaim(claim({ totalCents: 7150 }), candidates, { ...ctx, claimsTodayByAccount: 3 })).toEqual({ status: 'rejected', reason: 'rate_limited' });
    expect(matchClaim(claim({ businessDate: '2026-06-13', totalCents: 7150 }), candidates, ctx)).toEqual({ status: 'rejected', reason: 'future_date' });
    expect(matchClaim(claim({ totalCents: 7150, last4: '4242' }), candidates, { ...ctx, todayBusinessDate: '2026-09-20' })).toEqual({ status: 'rejected', reason: 'too_old' });
    expect(matchClaim(claim({ totalCents: 7150 }), candidates, { ...ctx, todayBusinessDate: '2026-06-30' })).toEqual({ status: 'rejected', reason: 'last4_required' });
    const owned = [check({ id: 'c9', totalCents: 5000, totalBeforeTipCents: 5000, creditedAccountId: 'a2' })];
    expect(matchClaim(claim({ totalCents: 5000 }), owned, ctx)).toEqual({ status: 'rejected', reason: 'already_claimed' });
    expect(matchClaim(claim({ totalCents: 5000 }), [check({ id: 'c9', totalCents: 5000, totalBeforeTipCents: 5000, creditedAccountId: 'a1' })], ctx)).toEqual({ status: 'rejected', reason: 'already_credited' });
    expect(matchClaim(claim({ totalCents: 9999 }), candidates, ctx)).toEqual({ status: 'rejected', reason: 'no_match' });
    expect(matchClaim(claim({ totalCents: 2000 }), candidates, ctx)).toEqual({ status: 'rejected', reason: 'no_match' });
  });
});
