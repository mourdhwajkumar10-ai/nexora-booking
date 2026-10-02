import { describe, expect, it } from 'vitest';
import { decideMerge, mergeIdentities, namesCompatible, normalizeName, pickSurvivor, type GuestIdentity } from '../src/identity.ts';
import { classifyInboundSms, evaluateSend, nextWindowOpen, type SendInput } from '../src/consent.ts';
import {
  computeLift,
  evaluateTags,
  feeCents,
  holdRequired,
  isGoodStanding,
  median,
  medianIntervalDays,
  percentileThreshold,
  purgeAtMs,
  typicalPartySize,
  type GuestVenueStats,
} from '../src/stats.ts';

const at = (iso: string) => Date.parse(iso);
const PHONE = '+12125550142';

const g = (over: Partial<GuestIdentity>): GuestIdentity => ({
  id: 'a',
  createdAtMs: 1,
  firstName: 'Maya',
  lastName: 'Lee',
  phones: [],
  emails: [],
  cardFingerprints: [],
  ...over,
});

describe('BR-19 identity', () => {
  it('normalizes and compares names', () => {
    expect(normalizeName('José-María ')).toBe('josemaria');
    expect(namesCompatible({ firstName: 'Maya', lastName: 'Lee' }, { firstName: 'M', lastName: 'Lee' })).toBe(true);
    expect(namesCompatible({ firstName: 'Maya', lastName: 'Lee' }, { firstName: 'Maya', lastName: 'Chen' })).toBe(false);
    expect(namesCompatible({ firstName: 'Maya', lastName: null }, { firstName: 'Maria', lastName: 'Lee' })).toBe(false);
    expect(namesCompatible({ firstName: null, lastName: null }, { firstName: 'Maya', lastName: 'Lee' })).toBe(true);
  });
  it('decides merges', () => {
    const v = { value: PHONE, verified: true };
    const u = { value: PHONE, verified: false };
    expect(decideMerge(g({ phones: [v] }), g({ id: 'b', phones: [v] }))).toEqual({ decision: 'auto', reason: 'shared_verified_contact' });
    expect(decideMerge(g({ phones: [v] }), g({ id: 'b', phones: [u] }))).toEqual({ decision: 'auto', reason: 'shared_contact_one_verified' });
    expect(decideMerge(g({ phones: [v] }), g({ id: 'b', firstName: 'Sam', phones: [u] }))).toEqual({ decision: 'suggest', reason: 'shared_contact_one_verified_name_mismatch' });
    const e = { value: 'maya@example.com', verified: false };
    expect(decideMerge(g({ emails: [e] }), g({ id: 'b', emails: [e] }))).toEqual({ decision: 'suggest', reason: 'shared_unverified_contact' });
    expect(decideMerge(g({ emails: [e] }), g({ id: 'b', firstName: 'Sam', emails: [e] }))).toEqual({ decision: 'none', reason: 'shared_unverified_contact_name_mismatch' });
    const ve = { value: 'maya@example.com', verified: true };
    expect(decideMerge(g({ phones: [v], emails: [ve] }), g({ id: 'b', phones: [{ value: '+13125550100', verified: true }], emails: [ve] }))).toEqual({ decision: 'none', reason: 'conflicting_verified_phones' });
    expect(decideMerge(g({ cardFingerprints: ['sq:abc'] }), g({ id: 'b', cardFingerprints: ['sq:abc'] }))).toEqual({ decision: 'suggest', reason: 'shared_card_fingerprint' });
    expect(decideMerge(g({}), g({ id: 'b' }))).toEqual({ decision: 'none', reason: 'no_shared_identifier' });
  });
  it('picks survivors and merges fields', () => {
    const older = g({ id: 'a', createdAtMs: 1, firstName: '', phones: [{ value: PHONE, verified: false }] });
    const newerVerified = g({ id: 'b', createdAtMs: 2, firstName: 'Maya', phones: [{ value: PHONE, verified: true }] });
    expect(pickSurvivor(older, newerVerified).survivor.id).toBe('b');
    expect(pickSurvivor(g({ id: 'x', createdAtMs: 5 }), g({ id: 'y', createdAtMs: 3 })).survivor.id).toBe('y');
    expect(pickSurvivor(g({ id: 'y', createdAtMs: 3 }), g({ id: 'x', createdAtMs: 3 })).survivor.id).toBe('x');
    const merged = mergeIdentities(g({ id: 's', createdAtMs: 9, firstName: ' ', emails: [{ value: 'b@x.com', verified: false }] }), g({ id: 'l', createdAtMs: 4, firstName: 'Maya', emails: [{ value: 'a@x.com', verified: true }, { value: 'b@x.com', verified: true }] }));
    expect(merged).toEqual({
      id: 's',
      createdAtMs: 4,
      firstName: 'Maya',
      lastName: 'Lee',
      phones: [],
      emails: [
        { value: 'a@x.com', verified: true },
        { value: 'b@x.com', verified: true },
      ],
      cardFingerprints: [],
    });
  });
});

describe('BR-20 send gate', () => {
  const base = (over: Partial<SendInput>): SendInput => ({
    channel: 'sms',
    category: 'marketing',
    consents: { sms_marketing: 'granted' },
    suppressed: false,
    nowMs: at('2026-06-15T18:00:00Z'),
    recipientTimeZone: 'America/New_York',
    sentLast24h: 0,
    sentLast7d: 0,
    ...over,
  });
  it('lets transactional messages through unless stopped or suppressed', () => {
    expect(evaluateSend(base({ category: 'transactional', consents: {} }))).toEqual({ decision: 'send' });
    expect(evaluateSend(base({ category: 'transactional', consents: { sms_all: 'revoked' } }))).toEqual({ decision: 'block', reason: 'sms_stopped' });
    expect(evaluateSend(base({ category: 'transactional', suppressed: true }))).toEqual({ decision: 'block', reason: 'suppressed' });
  });
  it('requires marketing consent', () => {
    expect(evaluateSend(base({ consents: {} }))).toEqual({ decision: 'block', reason: 'no_consent' });
    expect(evaluateSend(base({ consents: { sms_marketing: 'revoked' } }))).toEqual({ decision: 'block', reason: 'revoked' });
    expect(evaluateSend(base({}))).toEqual({ decision: 'send' });
  });
  it('defers SMS outside 09:00-20:00 recipient time', () => {
    expect(evaluateSend(base({ nowMs: at('2026-06-16T01:30:00Z') }))).toEqual({ decision: 'defer', reason: 'quiet_hours', sendAtMs: at('2026-06-16T13:00:00Z') });
    expect(evaluateSend(base({ nowMs: at('2026-06-15T11:00:00Z') }))).toEqual({ decision: 'defer', reason: 'quiet_hours', sendAtMs: at('2026-06-15T13:00:00Z') });
    expect(evaluateSend(base({ nowMs: at('2026-11-01T13:30:00Z') }))).toEqual({ decision: 'defer', reason: 'quiet_hours', sendAtMs: at('2026-11-01T14:00:00Z') });
  });
  it('uses the Eastern/Pacific intersection when the zone is unknown', () => {
    expect(evaluateSend(base({ recipientTimeZone: null, nowMs: at('2026-06-15T14:00:00Z') }))).toEqual({ decision: 'defer', reason: 'quiet_hours', sendAtMs: at('2026-06-15T16:00:00Z') });
    expect(nextWindowOpen(at('2026-06-16T03:00:00Z'), ['America/New_York', 'America/Los_Angeles'])).toBe(at('2026-06-16T16:00:00Z'));
  });
  it('enforces frequency caps', () => {
    expect(evaluateSend(base({ sentLast24h: 1 }))).toEqual({ decision: 'block', reason: 'frequency_cap' });
    expect(evaluateSend(base({ sentLast7d: 3 }))).toEqual({ decision: 'block', reason: 'frequency_cap' });
    expect(evaluateSend(base({ channel: 'email', consents: { email_marketing: 'granted' }, sentLast24h: 2, sentLast7d: 2, nowMs: at('2026-06-16T03:00:00Z') }))).toEqual({ decision: 'send' });
  });
  it('handles feedback requests', () => {
    expect(evaluateSend(base({ channel: 'email', category: 'feedback', consents: {} }))).toEqual({ decision: 'send' });
    expect(evaluateSend(base({ channel: 'email', category: 'feedback', consents: { email_feedback: 'revoked' } }))).toEqual({ decision: 'block', reason: 'revoked' });
    expect(evaluateSend(base({ channel: 'email', category: 'feedback', consents: { email_marketing: 'revoked' } }))).toEqual({ decision: 'block', reason: 'revoked' });
    expect(evaluateSend(base({ category: 'feedback', consents: {} }))).toEqual({ decision: 'block', reason: 'no_consent' });
  });
  it('classifies inbound SMS', () => {
    expect(classifyInboundSms('STOP')).toBe('stop');
    expect(classifyInboundSms('stop.')).toBe('stop');
    expect(classifyInboundSms(' Unsubscribe ')).toBe('stop');
    expect(classifyInboundSms('START')).toBe('start');
    expect(classifyInboundSms('help')).toBe('help');
    expect(classifyInboundSms('please stop texting me')).toBe('opt_out_natural_language');
    expect(classifyInboundSms('Wrong number')).toBe('opt_out_natural_language');
    expect(classifyInboundSms('See you at 7!')).toBe('other');
    expect(classifyInboundSms('Can you stop by the table?')).toBe('other');
  });
});

describe('BR-33 stats, BR-22 tags, BR-24 lift, BR-28 fees, BR-29 retention', () => {
  it('computes medians and percentiles', () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([1, 3])).toBe(2);
    expect(median([1, 2])).toBe(1);
    expect(median([3, 1, 2])).toBe(2);
    expect(medianIntervalDays(['2026-01-01', '2026-01-11', '2026-01-11', '2026-02-10'])).toBe(20);
    expect(medianIntervalDays(['2026-01-01'])).toBeNull();
    expect(typicalPartySize([2, 2, 4, 4, 6, 2, 2, 2, 2, 2, 8, 8])).toBe(3);
    expect(percentileThreshold([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 95)).toBe(100);
    expect(percentileThreshold([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 90)).toBe(90);
    expect(percentileThreshold([1, 2, 3, 4], 50)).toBe(2);
    expect(percentileThreshold([], 50)).toBeNull();
  });
  const now = at('2026-06-15T12:00:00Z');
  const DAY = 86_400_000;
  const s = (over: Partial<GuestVenueStats>): GuestVenueStats => ({
    visitCount: 0,
    firstVisitAtMs: null,
    lastVisitAtMs: null,
    visitsLast90d: 0,
    medianIntervalDays: null,
    lifetimeSpendCents: 0,
    avgCheckPerCoverCents: null,
    wineSpendCents: 0,
    totalSpendCents: 0,
    birthdayMonth: null,
    hasAllergies: false,
    manualVip: false,
    ...over,
  });
  const ctx = { nowMs: now, localMonth: 6, vipLifetimeSpendThresholdCents: 50_000, bigSpenderAvgCheckThresholdCents: 9_000 };
  it('evaluates auto-tags', () => {
    expect(evaluateTags(s({ visitCount: 1, firstVisitAtMs: now - 10 * DAY, lastVisitAtMs: now - 10 * DAY }), ctx)).toEqual(['FIRST_TIMER']);
    expect(evaluateTags(s({ visitCount: 5, visitsLast90d: 3, lastVisitAtMs: now - 5 * DAY, medianIntervalDays: 20, wineSpendCents: 3_000, totalSpendCents: 10_000 }), ctx)).toEqual(['REGULAR', 'WINE_LOVER']);
    expect(evaluateTags(s({ visitCount: 4, lastVisitAtMs: now - 100 * DAY, medianIntervalDays: 30 }), ctx)).toEqual(['LAPSED']);
    expect(evaluateTags(s({ visitCount: 4, lastVisitAtMs: now - 100 * DAY, medianIntervalDays: 50 }), ctx)).toEqual([]);
    expect(evaluateTags(s({ visitCount: 2, lastVisitAtMs: now - DAY, lifetimeSpendCents: 60_000 }), ctx)).toEqual(['VIP']);
    expect(evaluateTags(s({ visitCount: 1, firstVisitAtMs: now - 40 * DAY, lastVisitAtMs: now - 40 * DAY, lifetimeSpendCents: 60_000 }), ctx)).toEqual([]);
    expect(evaluateTags(s({ visitCount: 3, lastVisitAtMs: now - DAY, avgCheckPerCoverCents: 9_500, birthdayMonth: 6, hasAllergies: true }), ctx)).toEqual(['BIG_SPENDER', 'BIRTHDAY_THIS_MONTH', 'ALLERGY_ON_FILE']);
  });
  it('computes incrementality against the holdout', () => {
    const r = computeLift({ n: 900, conversions: 90, revenueCents: 900_000 }, { n: 100, conversions: 5, revenueCents: 40_000 }, 7_000, 20_000);
    expect(r.treatmentRate).toBeCloseTo(0.1, 6);
    expect(r.holdoutRate).toBeCloseTo(0.05, 6);
    expect(r.incrementalConversions).toBeCloseTo(45, 6);
    expect(r.incrementalRevenueCents).toBe(540_000);
    expect(r.incrementalGrossMarginCents).toBe(378_000);
    expect(r.roi).toBeCloseTo(17.9, 6);
    expect(r.ciLow).toBeCloseTo(0.0030008, 5);
    expect(r.ciHigh).toBeCloseTo(0.0969992, 5);
    expect(r.significant).toBe(true);
    expect(computeLift({ n: 10, conversions: 1, revenueCents: 0 }, { n: 0, conversions: 0, revenueCents: 0 }, 7_000, 0).holdoutRate).toBeNull();
  });
  it('decides card holds and fees', () => {
    expect(holdRequired('off', 8, 6, false)).toBe(false);
    expect(holdRequired('all', 1, null, true)).toBe(true);
    expect(holdRequired('party_min', 6, 6, true)).toBe(true);
    expect(holdRequired('party_min', 5, 6, true)).toBe(false);
    expect(holdRequired('party_min', 9, null, true)).toBe(false);
    expect(holdRequired('not_good_standing', 2, 6, false)).toBe(true);
    expect(holdRequired('not_good_standing', 2, 6, true)).toBe(false);
    expect(holdRequired('not_good_standing', 6, 6, true)).toBe(true);
    expect(isGoodStanding(1, 0)).toBe(true);
    expect(isGoodStanding(0, 0)).toBe(false);
    expect(isGoodStanding(3, 1)).toBe(false);
    expect(feeCents(2_500, 4)).toBe(10_000);
  });
  it('computes retention deadlines', () => {
    expect(purgeAtMs('pos_raw_event', 0)).toBe(90 * DAY);
    expect(purgeAtMs('consent_record', 0)).toBe(1826 * DAY);
  });
});
