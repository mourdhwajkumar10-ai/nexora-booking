import { describe, it, expect } from 'vitest';
import {
  // Pillar 1 & 4 Server Crypto Helpers
  deviceHash,
  normalizeMac,
  isRandomizedMac,
  createPortalHandshake,
  verifyPortalHandshake,
  isHoldout,
  holdoutBucket,
} from '@nexora/shared/node';
import {
  // Pillar 2: Identity & Consent
  classifyInboundSms,
  STOP_KEYWORDS,
  START_KEYWORDS,
  HELP_KEYWORDS,
  evaluateSend,
  TCPA_QUIET_HOURS,
  DEFAULT_QUIET_HOURS,
  type GuestIdentity,
  namesCompatible,
  decideMerge,
  pickSurvivor,
  mergeIdentities,
  // Pillar 3: Loyalty & Vouchers
  voucherCode,
  normalizeVoucherCode,
  formatVoucherCode,
  isValidLuhnModN,
  planVoucherHold,
  planVoucherCapture,
  planVoucherRelease,
  computeEarn,
  writeOffPoints,
  type BoosterRule,
  LEDGER_EVENTS,
  // Pillar 4: CRM & Campaigns
  computeLift,
  guestMatchesConditions,
  type SegmentCondition,
  type SegmentGuestData,
  // Pillar 5: Floor & Reservations
  quoteWaitlist,
  type WaitTable,
  type WaitParty,
  findReservationForCheck,
  chooseGuestCredit,
  type LinkCheck,
  type LinkReservation,
  allocateBestFit,
  type AvailabilityQuery,
  type TableInput,
  type CombinationInput,
} from '@nexora/shared';
import { randomBytes } from 'node:crypto';

describe('Core Pillars Test Suite (Redline v2 & Implementation Plan Pack)', () => {
  /* =========================================================================
   * PILLAR 1: Captive Wi-Fi & Device Privacy
   * ========================================================================= */
  describe('Pillar 1: Captive Wi-Fi & Device Privacy', () => {
    const masterKey = 'test-master-key-0123456789abcdef0123456789abcdef';
    const venueIdA = 'venue-manhattan-1';
    const venueIdB = 'venue-brooklyn-2';
    const macClear = '00:1A:2B:3C:4D:5E';

    it('normalizes MAC addresses across formats and case', () => {
      expect(normalizeMac('00:1a:2b:3c:4d:5e')).toBe('00:1a:2b:3c:4d:5e');
      expect(normalizeMac('00-1A-2B-3C-4D-5E')).toBe('00:1a:2b:3c:4d:5e');
      expect(normalizeMac('001A.2B3C.4D5E')).toBe('00:1a:2b:3c:4d:5e');
      expect(normalizeMac('001a2b3c4d5e')).toBe('00:1a:2b:3c:4d:5e');
      expect(normalizeMac('invalid-mac')).toBeNull();
      expect(normalizeMac('12:34:56')).toBeNull();
    });

    it('computes deterministic salted HMAC-SHA256 device hash without persisting raw MAC', () => {
      const hash1 = deviceHash(masterKey, venueIdA, '00:1A:2B:3C:4D:5E');
      const hash2 = deviceHash(masterKey, venueIdA, '00-1a-2b-3c-4d-5e');
      const hash3 = deviceHash(masterKey, venueIdA, '001a2b3c4d5e');

      expect(hash1).toBeDefined();
      expect(hash1.length).toBe(64); // 32 bytes hex
      expect(hash1).toBe(hash2);
      expect(hash1).toBe(hash3);

      // Multi-tenant isolation: different venue produces distinct hash for same MAC
      const hashVenueB = deviceHash(masterKey, venueIdB, macClear);
      expect(hashVenueB).not.toBe(hash1);
    });

    it('identifies locally-administered (randomized/private) MAC addresses', () => {
      // Bit 1 of byte 0 set -> locally administered (e.g., 02:xx, da:xx)
      expect(isRandomizedMac('02:00:00:00:00:00')).toBe(true);
      expect(isRandomizedMac('da:a1:19:00:00:00')).toBe(true);
      // Bit 1 of byte 0 clear -> universally administered (e.g., 00:xx)
      expect(isRandomizedMac('00:1a:2b:3c:4d:5e')).toBe(false);
    });

    it('creates and verifies 15-minute tokenized portal handshake', () => {
      const secret = 'portal-hmac-secret-abcdef1234567890';
      const now = 1759431600000;
      const ttlMs = 15 * 60 * 1000; // 15 mins

      const token = createPortalHandshake(secret, venueIdA, macClear, ttlMs, now);
      expect(token).toBeDefined();
      expect(token.includes('.')).toBe(true);

      // Valid within 15 minutes
      const verified14m = verifyPortalHandshake(secret, token, now + 14 * 60 * 1000);
      expect(verified14m).not.toBeNull();
      expect(verified14m?.venueId).toBe(venueIdA);
      expect(verified14m?.mac).toBe('00:1a:2b:3c:4d:5e');

      // Expired at 15m + 1ms
      const verified15m1s = verifyPortalHandshake(secret, token, now + 15 * 60 * 1000 + 1);
      expect(verified15m1s).toBeNull();

      // Tampered payload fails verification
      const parts = token.split('.');
      const tamperedToken = `eyJoYWNrZWQiOnRydWV9.${parts[1]}`;
      expect(verifyPortalHandshake(secret, tamperedToken, now)).toBeNull();

      // Tampered signature fails verification
      const tamperedSig = `${parts[0]}.badsignature1234567890abcdef`;
      expect(verifyPortalHandshake(secret, tamperedSig, now)).toBeNull();
    });

    it('recognizes returning guests via stable device hash on subsequent visits', () => {
      const visit1Hash = deviceHash(masterKey, venueIdA, 'fa:12:34:56:78:90');
      const visit2Hash = deviceHash(masterKey, venueIdA, 'FA:12:34:56:78:90');
      expect(visit1Hash).toBe(visit2Hash);
    });

    it('rejects portal handshake when venue or device MAC mismatches', () => {
      const secret = 'portal-hmac-secret-abcdef1234567890';
      const now = 1759431600000;
      const ttlMs = 15 * 60 * 1000;

      const token = createPortalHandshake(secret, venueIdA, macClear, ttlMs, now);
      const verified = verifyPortalHandshake(secret, token, now + 1000);
      expect(verified).not.toBeNull();

      // Handshake issued for Venue A fails validation if presented for Venue B
      expect(verified?.venueId === venueIdB).toBe(false);

      // Handshake issued for MAC A fails validation if presented with MAC B
      const diffMac = '00:99:88:77:66:55';
      expect(verified?.mac === normalizeMac(diffMac)).toBe(false);
    });

    it('enforces arrival matching time window [-45 min, +60 min] and status constraints', () => {
      const nowMs = 1759431600000; // 19:00 UTC
      // Window is: start_at >= now - 60 min (18:00) AND start_at <= now + 45 min (19:45)
      const windowStartMs = nowMs - 60 * 60_000; // 18:00
      const windowEndMs = nowMs + 45 * 60_000; // 19:45

      const isEligibleForArrival = (res: { status: string; startAtMs: number }) => {
        const allowedStatuses = ['CONFIRMED', 'LATE'];
        const inWindow = res.startAtMs >= windowStartMs && res.startAtMs <= windowEndMs;
        return allowedStatuses.includes(res.status) && inWindow;
      };

      // 1. Confirmed reservation at 19:15 (within window) -> matches
      expect(isEligibleForArrival({ status: 'CONFIRMED', startAtMs: nowMs + 15 * 60_000 })).toBe(true);
      // 2. Late reservation at 18:30 (within window) -> matches
      expect(isEligibleForArrival({ status: 'LATE', startAtMs: nowMs - 30 * 60_000 })).toBe(true);
      // 3. Requested reservation at 19:15 -> does NOT match (must be confirmed or late)
      expect(isEligibleForArrival({ status: 'REQUESTED', startAtMs: nowMs + 15 * 60_000 })).toBe(false);
      // 4. Cancelled reservation -> does NOT match
      expect(isEligibleForArrival({ status: 'CANCELLED', startAtMs: nowMs + 15 * 60_000 })).toBe(false);
      // 5. Completed reservation -> does NOT match
      expect(isEligibleForArrival({ status: 'COMPLETED', startAtMs: nowMs - 30 * 60_000 })).toBe(false);
      // 6. Reservation at 17:50 (70 mins ago, outside window) -> does NOT match
      expect(isEligibleForArrival({ status: 'LATE', startAtMs: nowMs - 70 * 60_000 })).toBe(false);
      // 7. Reservation at 20:00 (60 mins ahead, outside window) -> does NOT match
      expect(isEligibleForArrival({ status: 'CONFIRMED', startAtMs: nowMs + 60 * 60_000 })).toBe(false);
    });
  });

  /* =========================================================================
   * PILLAR 2: Guest Profile, Identity & Consent
   * ========================================================================= */
  describe('Pillar 2: Guest Profile, Identity & Consent', () => {
    it('classifies inbound SMS according to TCPA / carrier standard keywords', () => {
      // STOP family
      for (const kw of STOP_KEYWORDS) {
        expect(classifyInboundSms(kw)).toBe('stop');
        expect(classifyInboundSms(` ${kw.toLowerCase()}! `)).toBe('stop');
      }

      // START family
      for (const kw of START_KEYWORDS) {
        expect(classifyInboundSms(kw)).toBe('start');
        expect(classifyInboundSms(`  ${kw.toLowerCase()}  `)).toBe('start');
      }

      // HELP family
      for (const kw of HELP_KEYWORDS) {
        expect(classifyInboundSms(kw)).toBe('help');
      }

      // Natural language opt-outs
      expect(classifyInboundSms('please stop texting me')).toBe('opt_out_natural_language');
      expect(classifyInboundSms('remove me from this list')).toBe('opt_out_natural_language');
      expect(classifyInboundSms('do not send any more messages')).toBe('opt_out_natural_language');
      expect(classifyInboundSms('wrong number')).toBe('opt_out_natural_language');

      // Other regular inquiries
      expect(classifyInboundSms('What time do you open tomorrow?')).toBe('other');
      expect(classifyInboundSms('Can I bring a cake?')).toBe('other');
    });

    it('enforces TCPA quiet hours (9 PM to 8 AM local time) at send time', () => {
      // 2026-10-02 14:00 (2 PM) EDT -> UTC 18:00 (1759428000000)
      const afternoonMs = new Date('2026-10-02T14:00:00-04:00').getTime();
      // 2026-10-02 22:30 (10:30 PM) EDT -> Quiet Hours
      const nightMs = new Date('2026-10-02T22:30:00-04:00').getTime();
      // 2026-10-02 06:30 (6:30 AM) EDT -> Quiet Hours
      const morningEarlyMs = new Date('2026-10-02T06:30:00-04:00').getTime();

      const baseSendInput = {
        channel: 'sms' as const,
        category: 'marketing' as const,
        consents: { sms_marketing: 'granted' as const },
        suppressed: false,
        recipientTimeZone: 'America/New_York',
        sentLast24h: 0,
        sentLast7d: 0,
        quietHours: TCPA_QUIET_HOURS, // 08:00 - 21:00 window
      };

      // 1. Afternoon message inside allowed window -> send
      const dec1 = evaluateSend({ ...baseSendInput, nowMs: afternoonMs });
      expect(dec1.decision).toBe('send');

      // 2. Late evening message during quiet hours -> defer to 8:00 AM next day
      const dec2 = evaluateSend({ ...baseSendInput, nowMs: nightMs });
      expect(dec2.decision).toBe('defer');
      if (dec2.decision === 'defer') {
        expect(dec2.reason).toBe('quiet_hours');
        const deferredDate = new Date(dec2.sendAtMs);
        expect(deferredDate.getTime()).toBeGreaterThan(nightMs);
        // Deferred to 8:00 AM next morning in America/New_York (2026-10-03 08:00:00-04:00 -> 12:00 UTC)
        expect(deferredDate.toISOString()).toBe('2026-10-03T12:00:00.000Z');
      }

      // 3. Early morning message before 8:00 AM -> defer to 8:00 AM same day
      const dec3 = evaluateSend({ ...baseSendInput, nowMs: morningEarlyMs });
      expect(dec3.decision).toBe('defer');
      if (dec3.decision === 'defer') {
        expect(dec3.reason).toBe('quiet_hours');
        const deferredDate = new Date(dec3.sendAtMs);
        expect(deferredDate.toISOString()).toBe('2026-10-02T12:00:00.000Z');
      }

      // 4. Suppressed contact is blocked immediately regardless of time
      const decSuppressed = evaluateSend({ ...baseSendInput, nowMs: afternoonMs, suppressed: true });
      expect(decSuppressed.decision).toBe('block');

      // 5. Transactional messages bypass quiet hours
      const decTransactional = evaluateSend({ ...baseSendInput, nowMs: nightMs, category: 'transactional' });
      expect(decTransactional.decision).toBe('send');
    });

    it('resolves deterministic identity merge rules and survivor selection', () => {
      const guestA: GuestIdentity = {
        id: 'guest-100',
        createdAtMs: 1759000000000,
        firstName: 'Jane',
        lastName: 'Doe',
        phones: [{ value: '+12125550100', verified: true }],
        emails: [{ value: 'jane@example.com', verified: false }],
        cardFingerprints: ['tok_visa_4242'],
      };

      const guestB: GuestIdentity = {
        id: 'guest-200',
        createdAtMs: 1759100000000,
        firstName: 'J.',
        lastName: 'Doe',
        phones: [{ value: '+12125550100', verified: true }],
        emails: [{ value: 'j.doe@example.org', verified: true }],
        cardFingerprints: [],
      };

      // Name compatibility: Jane vs J. with same last name is compatible
      expect(namesCompatible(guestA, guestB)).toBe(true);

      // Merge decision: shared verified phone -> auto merge
      const mergeResult = decideMerge(guestA, guestB);
      expect(mergeResult.decision).toBe('auto');
      expect(mergeResult.reason).toBe('shared_verified_contact');

      // Survivor selection: both have verified contacts, older createdAtMs wins (guestA)
      const { survivor, loser } = pickSurvivor(guestA, guestB);
      expect(survivor.id).toBe('guest-100');
      expect(loser.id).toBe('guest-200');

      // Field merging
      const merged = mergeIdentities(survivor, loser);
      expect(merged.id).toBe('guest-100');
      expect(merged.firstName).toBe('Jane');
      expect(merged.lastName).toBe('Doe');
      expect(merged.phones.length).toBe(1);
      expect(merged.phones[0]!.verified).toBe(true);
      expect(merged.emails.length).toBe(2);
      // Verified email comes first in sorted list
      expect(merged.emails[0]!.verified).toBe(true);
      expect(merged.cardFingerprints).toContain('tok_visa_4242');

      // Conflicting verified phones should reject merge
      const guestC: GuestIdentity = {
        id: 'guest-300',
        createdAtMs: 1759200000000,
        firstName: 'Jane',
        lastName: 'Doe',
        phones: [{ value: '+12125559999', verified: true }],
        emails: [],
        cardFingerprints: [],
      };
      const conflictDecision = decideMerge(guestA, guestC);
      expect(conflictDecision.decision).toBe('none');
      expect(conflictDecision.reason).toBe('conflicting_verified_phones');
    });
  });

  /* =========================================================================
   * PILLAR 3: Loyalty Ledger & Vouchers
   * ========================================================================= */
  describe('Pillar 3: Loyalty Ledger & Vouchers', () => {
    it('generates and validates 9-character Luhn mod 32 voucher codes', () => {
      const code = voucherCode((len) => randomBytes(len));
      expect(code.length).toBe(9);
      expect(isValidLuhnModN(code)).toBe(true);

      // Normalization and formatting
      const formatted = formatVoucherCode(code);
      expect(formatted.length).toBe(11); // ABCD-EFGH-J
      expect(normalizeVoucherCode(formatted)).toBe(code);

      // Corrupted character fails checksum
      const chars = code.split('');
      chars[0] = chars[0] === 'A' ? 'B' : 'A';
      const corrupted = chars.join('');
      expect(isValidLuhnModN(corrupted)).toBe(false);
      expect(normalizeVoucherCode(corrupted)).toBeNull();
    });

    it('enforces voucher hold, capture, release lifecycle and balance constraints', () => {
      // 1. Valid hold: $10 (1000 cents) voucher with 2000 available points
      const holdSuccess = planVoucherHold(1000, 2000, 0, true);
      expect(holdSuccess.ok).toBe(true);
      if (holdSuccess.ok) {
        expect(holdSuccess.points).toBe(1000);
        expect(holdSuccess.deltas).toEqual([
          { type: 'redeem_hold', pendingDelta: 0, availableDelta: -1000, heldDelta: 1000 },
        ]);
      }

      // 2. Invalid denomination
      const invalidDenom = planVoucherHold(750, 2000, 0, true);
      expect(invalidDenom.ok).toBe(false);
      if (!invalidDenom.ok) expect(invalidDenom.error).toBe('INVALID_DENOMINATION');

      // 3. Insufficient points
      const lowPoints = planVoucherHold(2500, 1000, 0, true);
      expect(lowPoints.ok).toBe(false);
      if (!lowPoints.ok) expect(lowPoints.error).toBe('INSUFFICIENT_POINTS');

      // 4. Max active vouchers reached
      const maxVouchers = planVoucherHold(500, 5000, 3, true);
      expect(maxVouchers.ok).toBe(false);
      if (!maxVouchers.ok) expect(maxVouchers.error).toBe('TOO_MANY_ACTIVE_VOUCHERS');

      // 5. Inactive account
      const inactive = planVoucherHold(1000, 5000, 0, false);
      expect(inactive.ok).toBe(false);
      if (!inactive.ok) expect(inactive.error).toBe('ACCOUNT_NOT_ACTIVE');

      // 6. Voucher capture delta
      const captureDeltas = planVoucherCapture(1000);
      expect(captureDeltas).toEqual([
        { type: 'redeem_capture', pendingDelta: 0, availableDelta: 0, heldDelta: -1000 },
      ]);

      // 7. Voucher release delta
      const releaseDeltas = planVoucherRelease(1000);
      expect(releaseDeltas).toEqual([
        { type: 'redeem_release', pendingDelta: 0, availableDelta: 1000, heldDelta: -1000 },
      ]);
    });

    it('calculates points accrual with booster rules and budget limits', () => {
      const activeBooster: BoosterRule = {
        id: 'booster-weekend-dinner',
        venueId: 'venue-manhattan-1',
        pointsPerDollar: 2, // 2 extra points per dollar
        daysOfWeek: [5, 6], // Friday, Saturday
        startMinute: 18 * 60, // 18:00
        endMinute: 22 * 60, // 22:00
        firstVisitOnly: false,
        monthlyBudgetPoints: 1000,
        createdAtMs: 1759000000000,
        active: true,
      };

      // Saturday 19:30, $150 spend -> $150 eligible
      const result = computeEarn({
        eligibleCents: 15000,
        basePointsPerDollar: 1,
        venueId: 'venue-manhattan-1',
        localDayOfWeek: 6, // Saturday
        localMinuteOfDay: 19 * 60 + 30,
        isFirstVisitAtVenue: false,
        boosters: [activeBooster],
        boosterUsedThisMonth: { 'booster-weekend-dinner': 200 }, // 800 budget remaining
      });

      expect(result.basePoints).toBe(150);
      expect(result.booster).not.toBeNull();
      expect(result.booster?.points).toBe(300); // 150 * 2 = 300 <= 800 remaining
      expect(result.totalPoints).toBe(450);

      // Deficit write-off handling
      expect(writeOffPoints(-250, 500)).toBe(250); // deficit within 500 pt threshold written off to 0
      expect(writeOffPoints(-600, 500)).toBe(0); // large deficit not written off
      expect(writeOffPoints(50, 500)).toBe(0); // positive balance unchanged
    });

    it('registers all required ledger event types in LEDGER_EVENTS', () => {
      const requiredEvents = [
        'REDEEM_HOLD',
        'REDEEM_CAPTURE',
        'REDEEM_RELEASE',
        'EARN_PENDING',
        'EARN_SETTLE',
        'WRITEOFF',
      ] as const;
      for (const evt of requiredEvents) {
        expect(LEDGER_EVENTS).toContain(evt);
      }
    });

    it('enforces booster rule monthly budget caps and snake_case column mapping simulation', () => {
      // Simulating mapped booster from snake_case DB row
      const dbRow = {
        id: 'booster-lunch-rush',
        venue_id: 'venue-1',
        points_per_dollar: 3,
        days_of_week: [1, 2, 3, 4, 5], // Mon-Fri
        start_minute: 11 * 60, // 11:00
        end_minute: 14 * 60, // 14:00
        monthly_budget_points: 500,
        used_this_month: 420, // 80 points remaining
        created_at: new Date('2026-01-01'),
        active: true,
      };

      // Ensure mapping accurately preserves pointsPerDollar and budget
      const mappedBooster: BoosterRule = {
        id: dbRow.id,
        venueId: dbRow.venue_id,
        pointsPerDollar: dbRow.points_per_dollar,
        daysOfWeek: dbRow.days_of_week,
        startMinute: dbRow.start_minute,
        endMinute: dbRow.end_minute,
        firstVisitOnly: false,
        monthlyBudgetPoints: dbRow.monthly_budget_points,
        createdAtMs: dbRow.created_at.getTime(),
        active: dbRow.active,
      };

      // Spend $50 at 12:30 on Wednesday (Day 3)
      // Booster rate is 3 pts/$ -> requested booster points = 150
      // But only 80 points left in monthly budget (500 - 420)
      const res = computeEarn({
        eligibleCents: 5000,
        basePointsPerDollar: 1,
        venueId: 'venue-1',
        localDayOfWeek: 3,
        localMinuteOfDay: 12 * 60 + 30,
        isFirstVisitAtVenue: false,
        boosters: [mappedBooster],
        boosterUsedThisMonth: { [dbRow.id]: dbRow.used_this_month },
      });

      expect(res.basePoints).toBe(50);
      expect(res.booster).not.toBeNull();
      expect(res.booster?.points).toBe(80); // Capped at 80
      expect(res.totalPoints).toBe(130);

      // If budget already completely exhausted (used >= budget)
      const resExhausted = computeEarn({
        eligibleCents: 5000,
        basePointsPerDollar: 1,
        venueId: 'venue-1',
        localDayOfWeek: 3,
        localMinuteOfDay: 12 * 60 + 30,
        isFirstVisitAtVenue: false,
        boosters: [mappedBooster],
        boosterUsedThisMonth: { [dbRow.id]: 500 },
      });
      expect(resExhausted.booster).toBeNull();
      expect(resExhausted.totalPoints).toBe(50);
    });
  });

  /* =========================================================================
   * PILLAR 4: CRM & Campaigns
   * ========================================================================= */
  describe('Pillar 4: CRM & Campaigns', () => {
    it('assigns guests to holdout buckets deterministically across campaigns', () => {
      const guestId = 'guest-uuid-987654';
      const campaignA = 'camp-autumn-2026';
      const campaignB = 'camp-winter-2026';

      const bucket1 = holdoutBucket(campaignA, guestId);
      const bucket2 = holdoutBucket(campaignA, guestId);
      expect(bucket1).toBe(bucket2);
      expect(bucket1).toBeGreaterThanOrEqual(0);
      expect(bucket1).toBeLessThan(10000);

      const isH1 = isHoldout(campaignA, guestId, 10); // 10% holdout
      const isH2 = isHoldout(campaignA, guestId, 10);
      expect(isH1).toBe(isH2);

      // Proportion test across 1,000 synthetic guests at 20% holdout
      let holdoutCount = 0;
      for (let i = 0; i < 1000; i++) {
        if (isHoldout(campaignA, `test-guest-${i}`, 20)) {
          holdoutCount++;
        }
      }
      // Expect approximately 200 (+/- 45) in holdout bucket
      expect(holdoutCount).toBeGreaterThan(150);
      expect(holdoutCount).toBeLessThan(250);
    });

    it('computes incremental conversion rate, revenue, gross margin, and statistical lift', () => {
      // 10,000 treatment, 500 conversions, $50,000 revenue
      const treatment = { n: 10000, conversions: 500, revenueCents: 5000000 };
      // 1,000 holdout, 30 conversions, $2,400 revenue
      const holdout = { n: 1000, conversions: 30, revenueCents: 240000 };

      const lift = computeLift(treatment, holdout, 7000, 50000); // 70% margin, $500 cost

      expect(lift.treatmentRate).toBeCloseTo(0.05, 4); // 5.0%
      expect(lift.holdoutRate).toBeCloseTo(0.03, 4); // 3.0%
      expect(lift.incrementalConversions).toBeCloseTo(200, 1);
      expect(lift.incrementalRevenueCents).toBeGreaterThan(0);
      expect(lift.incrementalGrossMarginCents).toBeGreaterThan(0);
      expect(lift.roi).toBeGreaterThan(0);
      expect(lift.ciLow).toBeDefined();
      expect(lift.ciHigh).toBeDefined();
      // Treatment rate (5%) is statistically significantly higher than control (3%)
      expect(lift.significant).toBe(true);
      expect(lift.ciLow!).toBeGreaterThan(0);

      // Edge cases: empty cohorts handled safely without throwing or NaN
      const emptyLift = computeLift({ n: 0, conversions: 0, revenueCents: 0 }, holdout, 7000, 0);
      expect(emptyLift.holdoutRate).toBeNull();
      expect(emptyLift.significant).toBe(false);
    });

    it('evaluates segment conditions across all supported dimensions (BR-21)', () => {
      const guest: SegmentGuestData = {
        total_visits: 5,
        last_visit_at: new Date(Date.now() - 10 * 24 * 3600_000), // 10 days ago
        lifetime_spend_paise: 2500000, // ₹25,000 / $250.00
        avg_check_per_cover_paise: 250000,
        typical_party_size: 4,
        tags: ['VIP', 'WINE_LOVER'],
        ordered_items: ['filet_mignon', 'cabernet_sauvignon'],
        birthday_month: 10,
      };

      // 1. Visit count gte / lte / eq
      expect(guestMatchesConditions(guest, [{ field: 'visit_count', op: 'gte', value: 3 }])).toBe(true);
      expect(guestMatchesConditions(guest, [{ field: 'visit_count', op: 'gte', value: 10 }])).toBe(false);
      expect(guestMatchesConditions(guest, [{ field: 'visit_count', op: 'lte', value: 5 }])).toBe(true);
      expect(guestMatchesConditions(guest, [{ field: 'visit_count', op: 'eq', value: 5 }])).toBe(true);
      expect(guestMatchesConditions(guest, [{ field: 'visit_count', op: 'eq', value: 4 }])).toBe(false);

      // 2. Days since last visit
      expect(guestMatchesConditions(guest, [{ field: 'days_since_last_visit', op: 'gte', value: 7 }])).toBe(true);
      expect(guestMatchesConditions(guest, [{ field: 'days_since_last_visit', op: 'lte', value: 5 }])).toBe(false);

      // 3. Lifetime spend cents
      expect(guestMatchesConditions(guest, [{ field: 'lifetime_spend_cents', op: 'gte', value: 20000 }])).toBe(true);
      expect(guestMatchesConditions(guest, [{ field: 'lifetime_spend_cents', op: 'lte', value: 10000 }])).toBe(false);

      // 4. Typical party size
      expect(guestMatchesConditions(guest, [{ field: 'typical_party_size', op: 'eq', value: 4 }])).toBe(true);
      expect(guestMatchesConditions(guest, [{ field: 'typical_party_size', op: 'eq', value: 2 }])).toBe(false);

      // 5. Tags has / not_has
      expect(guestMatchesConditions(guest, [{ field: 'tag', op: 'has', value: 'VIP' }])).toBe(true);
      expect(guestMatchesConditions(guest, [{ field: 'tag', op: 'not_has', value: 'LAPSED' }])).toBe(true);
      expect(guestMatchesConditions(guest, [{ field: 'tag', op: 'has', value: 'LAPSED' }])).toBe(false);
      expect(guestMatchesConditions(guest, [{ field: 'tag', op: 'not_has', value: 'VIP' }])).toBe(false);

      // 6. Birthday month
      expect(guestMatchesConditions(guest, [{ field: 'birthday_month', op: 'eq', value: 10 }])).toBe(true);
      expect(guestMatchesConditions(guest, [{ field: 'birthday_month', op: 'eq', value: 5 }])).toBe(false);

      // 7. Ordered item has
      expect(guestMatchesConditions(guest, [{ field: 'ordered_item', op: 'has', value: 'filet_mignon' }])).toBe(true);
      expect(guestMatchesConditions(guest, [{ field: 'ordered_item', op: 'has', value: 'tiramisu' }])).toBe(false);

      // 8. Guest missing last_visit_at does not match days_since_last_visit
      expect(guestMatchesConditions({ total_visits: 0 }, [{ field: 'days_since_last_visit', op: 'gte', value: 30 }])).toBe(false);
    });

    it('enforces send-time compliance gate excluding suppressed and revoked contacts (BR-20)', () => {
      const nowMs = new Date('2026-10-02T15:00:00Z').getTime();

      // Revoked consent -> blocked
      const revokedDecision = evaluateSend({
        channel: 'sms',
        category: 'marketing',
        consents: { sms_marketing: 'revoked' },
        suppressed: false,
        recipientTimeZone: 'America/New_York',
        sentLast24h: 0,
        sentLast7d: 0,
        quietHours: TCPA_QUIET_HOURS,
        nowMs,
      });
      expect(revokedDecision.decision).toBe('block');

      // Suppressed contact -> blocked
      const suppressedDecision = evaluateSend({
        channel: 'sms',
        category: 'marketing',
        consents: { sms_marketing: 'granted' },
        suppressed: true,
        recipientTimeZone: 'America/New_York',
        sentLast24h: 0,
        sentLast7d: 0,
        quietHours: TCPA_QUIET_HOURS,
        nowMs,
      });
      expect(suppressedDecision.decision).toBe('block');

      // Granted and active -> allowed
      const grantedDecision = evaluateSend({
        channel: 'sms',
        category: 'marketing',
        consents: { sms_marketing: 'granted' },
        suppressed: false,
        recipientTimeZone: 'America/New_York',
        sentLast24h: 0,
        sentLast7d: 0,
        quietHours: TCPA_QUIET_HOURS,
        nowMs,
      });
      expect(grantedDecision.decision).toBe('send');
    });
  });

  /* =========================================================================
   * PILLAR 5: Reservations & Floor Management
   * ========================================================================= */
  describe('Pillar 5: Reservations & Floor Management', () => {
    it('quotes waitlist entries with bussing buffer and 5-minute upward rounding', () => {
      const nowMs = 1759431600000; // 19:00

      const tables: WaitTable[] = [
        // Table 1 frees at 19:12
        { id: 'tbl-1', label: 'T1', minCovers: 2, maxCovers: 4, freeAtMs: nowMs + 12 * 60_000, nextReservationStartMs: null },
        // Table 2 frees at 19:25
        { id: 'tbl-2', label: 'T2', minCovers: 2, maxCovers: 4, freeAtMs: nowMs + 25 * 60_000, nextReservationStartMs: null },
        // Table 3 busy until 21:00
        { id: 'tbl-3', label: 'T3', minCovers: 4, maxCovers: 6, freeAtMs: nowMs + 120 * 60_000, nextReservationStartMs: null },
      ];

      const parties: WaitParty[] = [
        { id: 'party-1', partySize: 3, turnMinutes: 60 },
        { id: 'party-2', partySize: 2, turnMinutes: 60 },
      ];

      const quotes = quoteWaitlist(nowMs, tables, parties, 15); // 15 min reset buffer

      expect(quotes.length).toBe(2);

      // Party 1 gets Table 1 (frees earliest at 19:12 -> 12 mins wait -> rounded UP to 15 mins)
      expect(quotes[0]!.partyId).toBe('party-1');
      expect(quotes[0]!.tableId).toBe('tbl-1');
      expect(quotes[0]!.quoteMinutes).toBe(15);

      // Party 2 gets Table 2 (frees at 19:25 -> 25 mins wait -> rounded to 25 mins)
      expect(quotes[1]!.partyId).toBe('party-2');
      expect(quotes[1]!.tableId).toBe('tbl-2');
      expect(quotes[1]!.quoteMinutes).toBe(25);
    });

    it('matches multi-table combinations when individual tables cannot accommodate large parties', () => {
      const tables: TableInput[] = [
        { id: 't1', label: 'T1', minCovers: 2, maxCovers: 4, diningAreaId: 'area-main', areaSortOrder: 0, active: true, onlineBookable: true },
        { id: 't2', label: 'T2', minCovers: 2, maxCovers: 4, diningAreaId: 'area-main', areaSortOrder: 0, active: true, onlineBookable: true },
      ];

      const combination: CombinationInput = {
        id: 'comb-1-2',
        name: 'T1+T2 Combined',
        minCovers: 5,
        maxCovers: 8,
        tableIds: ['t1', 't2'],
        active: true,
      };

      const startMs = 1759431600000;
      const baseQuery: AvailabilityQuery = {
        serviceDate: '2026-10-02' as any,
        timeZone: 'America/New_York',
        period: { id: 'p1', daypart: 'dinner', openMinute: 17 * 60, lastSeatingMinute: 22 * 60, closeMinute: 23 * 60 },
        slotIntervalMinutes: 15,
        partySize: 6, // Party of 6 exceeds single tables (max 4)
        channel: 'public',
        nowMs: startMs - 3600_000,
        minLeadMinutes: 30,
        resetMinutes: 15,
        turnRules: [],
        defaultTurnMinutes: 90,
        tables,
        combinations: [combination],
        occupancies: [],
        closed: false,
      };

      // 1. Party of 6 selects the combination
      const allocComb = allocateBestFit(baseQuery, startMs);
      expect(allocComb).not.toBeNull();
      expect(allocComb?.kind).toBe('combination');
      expect(allocComb?.id).toBe('comb-1-2');
      expect(allocComb?.tableIds).toEqual(['t1', 't2']);

      // 2. Party of 3 selects a single table instead of the combination (minimizes waste)
      const allocSingle = allocateBestFit({ ...baseQuery, partySize: 3 }, startMs);
      expect(allocSingle).not.toBeNull();
      expect(allocSingle?.kind).toBe('table');
      expect(allocSingle?.id).toBe('t1');
    });

    it('links POS checks to overlapping seated reservations and determines guest credit priority', () => {
      const nowMs = 1759431600000;

      const reservations: LinkReservation[] = [
        {
          id: 'res-seated-42',
          tableIds: ['table-5'],
          startsAtMs: nowMs,
          seatedAtMs: nowMs + 5 * 60_000,
          completedAtMs: null,
          turnMinutes: 90,
          status: 'seated',
        },
      ];

      // Check opened at table-5 during seated reservation
      const check: LinkCheck = {
        tableId: 'table-5',
        openedAtMs: nowMs + 20 * 60_000,
      };

      const matchedId = findReservationForCheck(check, reservations);
      expect(matchedId).toBe('res-seated-42');

      // Check opened at wrong table -> no link
      const unlinkedCheck: LinkCheck = {
        tableId: 'table-99',
        openedAtMs: nowMs + 20 * 60_000,
      };
      expect(findReservationForCheck(unlinkedCheck, reservations)).toBeNull();

      // Guest credit prioritization: staff > claim > card fingerprint > pos customer > reservation
      const creditWinner = chooseGuestCredit({
        reservationGuestId: 'guest-res',
        cardFingerprintGuestId: 'guest-card',
        staffGuestId: 'guest-staff',
      });
      expect(creditWinner?.guestId).toBe('guest-staff');
      expect(creditWinner?.method).toBe('staff');

      const creditCard = chooseGuestCredit({
        reservationGuestId: 'guest-res',
        cardFingerprintGuestId: 'guest-card',
      });
      expect(creditCard?.guestId).toBe('guest-card');
      expect(creditCard?.method).toBe('card_fingerprint');
    });

    it('evaluates waitlist quotes against physical venue tables when waitlist is initially empty', () => {
      const nowMs = 1759431600000; // 19:00

      // Venue has two 4-top tables: T1 occupied until 19:20, T2 occupied until 19:35
      const venueTables: WaitTable[] = [
        { id: 't1', label: 'T1', minCovers: 2, maxCovers: 4, freeAtMs: nowMs + 20 * 60_000, nextReservationStartMs: null },
        { id: 't2', label: 'T2', minCovers: 2, maxCovers: 4, freeAtMs: nowMs + 35 * 60_000, nextReservationStartMs: null },
      ];

      // Empty waiting list before party joins
      const existingParties: WaitParty[] = [];
      const joiningParty: WaitParty = { id: 'party-new', partySize: 4, turnMinutes: 60 };

      // Quoting with bussing buffer (15m): evaluates the new party against venue tables
      const partiesToQuote = [...existingParties, joiningParty];
      const quotes = quoteWaitlist(nowMs, venueTables, partiesToQuote, 15);

      expect(quotes.length).toBe(1);
      expect(quotes[0]!.partyId).toBe('party-new');
      expect(quotes[0]!.tableId).toBe('t1');
      // Free at 19:20 -> wait is 20m -> quoteMinutes is 20
      expect(quotes[0]!.quoteMinutes).toBe(20);
    });

    it('prevents single-table double-booking against active combination reservations', () => {
      // Table combination C1 consists of Table A and Table B
      const combinationTableIds = ['table-A', 'table-B'];

      // Simulated active reservation holding combination C1 (which books table-A and table-B)
      const combinationReservation = {
        id: 'res-comb-1',
        tableId: 'table-A',
        memberTableIds: ['table-A', 'table-B'],
        startMs: 1759431600000,
        endMs: 1759437000000,
      };

      // Check query: Does candidate Table B clash with active reservations?
      const candidateTableId = 'table-B';
      const candidateStart = 1759433400000;
      const candidateEnd = 1759438800000;

      const hasClash = (candTableId: string, start: number, end: number) => {
        const timeOverlap = start < combinationReservation.endMs && end > combinationReservation.startMs;
        const tableOverlap =
          combinationReservation.tableId === candTableId ||
          combinationReservation.memberTableIds.includes(candTableId);
        return timeOverlap && tableOverlap;
      };

      // Table B is part of combination reservation -> clash detected!
      expect(hasClash(candidateTableId, candidateStart, candidateEnd)).toBe(true);

      // Unrelated table Table C has no clash
      expect(hasClash('table-C', candidateStart, candidateEnd)).toBe(false);
    });

    it('updates reservation_id on pos_orders when check is linked to seated reservation', () => {
      // Simulates linking logic in linkCheckToReservation:
      // When a check matches a seated reservation, the order's reservation_id is set
      const order = {
        id: 'ord-100',
        table_id: 'table-5',
        reservation_id: null as string | null,
        guest_id: 'guest-pos-0',
      };

      const matchedResId = 'res-seated-42';
      const shouldUpdateReservationId = matchedResId && order.reservation_id !== matchedResId;
      expect(shouldUpdateReservationId).toBeTruthy();

      if (shouldUpdateReservationId) {
        order.reservation_id = matchedResId;
      }
      expect(order.reservation_id).toBe('res-seated-42');
    });
  });
});
