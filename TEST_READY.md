# Test Suite Readiness Report (`TEST_READY.md`)

## 1. Overview & Execution Command

The comprehensive, requirement-driven, opaque-box E2E test suite for the Nexora hospitality platform is **fully ready and operational**. All 20 test files across Tiers 1 through 5 pass with a 100% pass rate.

### Primary Test Runner Command:
```bash
cmd /c npm run test:e2e
```
*(Alternative: `cmd /c npx vitest run tests/e2e`)*

### Environment & Toolchain:
- **Node.js**: `v22.14.0` (>= 20.0.0 supported)
- **TypeScript**: `5.9.0`
- **Test Framework**: `Vitest 3.2.7`
- **Execution Target**: `tests/e2e/` (Tiers 1–5)
- **Status**: **20 passed (20), 96 passed (96), 0 failed**

---

## 2. Test Suite Breakdown by Tier

| Tier | Category | File Count | Tests | Status | Scope & Features Covered |
|---|---|---|---|---|---|
| **Tier 1** | Feature Coverage | 6 files | 42 tests | **PASS** | Isolated verification of core features: 8-State FSM (F-BR08), Dynamic Turn Times (F-BR05), Dwell Alerts (F-BR10), Fair Void Attribution (F-BR13), Dual-Market Currency Math & Formatting (F-CURR/F-BR01), Table Allocation & Capacity $N_{max}$ (F-BR06/F-BR03). |
| **Tier 2** | Boundary & Corner Cases | 5 files | 41 tests | **PASS** | Boundary verification: Party size tiers (1, 2, 3, 4, 5, 50, 51+ covers), exact second-by-second dwell alert boundaries (at $T_{turn} - 1\text{s}$ vs $T_{turn}$, and $\lceil 1.25 \times T_{turn}\rceil - 1\text{s}$ vs $\lceil 1.25 \times T_{turn}\rceil$), void timing millisecond boundaries, 04:00 AM service date cutoff, lead times, DST shifts, half-away rounding, and 32-bit integer limits. |
| **Tier 3** | Cross-Feature Combinations | 4 files | 5 tests | **PASS** | Pairwise interaction tests: Multi-table combination allocation + dynamic turn times + dwell escalation; Fair void attribution + eligible spend calculation + loyalty point accrual + profile protection; Dual-market pricing + cancellation policy fees in USD vs INR; Floor status synchronization with reservation lifecycle. |
| **Tier 4** | Real-World Application Scenarios | 4 files | 4 tests | **PASS** | Complete client showcase journeys: Guest booking through live 8-state tracker to table completion; Grace period expiry, LATE state transition, and host arrival triage; Live POS order dining with kitchen error voids and guest profile shielding; Parallel US ($) and India (₹) multi-market venue operations. |
| **Tier 5** | Adversarial Hardening | 1 file | 4 tests | **PASS** | Adversarial verification: SQL injection and XSS payloads in guest names, allergy notes, and requests; Non-Latin Unicode / Emoji inputs; Out-of-order contradictory state events; 1-billion dollar and 100-crore rupee extreme money values. |
| **Total** | **All Tiers** | **20 files** | **96 tests** | **100% PASS** | **Fully Verified & Operational** |

---

## 3. Acceptance Criteria Verification Summary

The test suite provides 100% verified coverage for the four core acceptance criteria from `ORIGINAL_REQUEST.md`:

1. **8-State Reservation Lifecycle (`CONFIRMED` $\to$ `ARRIVED` $\to$ `SEATED` $\to$ `COMPLETED` / `LATE`)**:
   - Verified in `tier4-journeys/journey-guest-booking-to-completion.test.ts`
   - Verified in `tier4-journeys/journey-late-arrival-triage.test.ts`
   - Verified in `tier1-features/booking-lifecycle.test.ts`
   - **Result**: **PASSED** (all 8 states transition deterministically; live tracking reflects every state change in sequence).

2. **Host Floor Dynamic Dwell Warnings (100% Amber, 125% Red)**:
   - Verified in `tier1-features/dwell-alerts.test.ts`
   - Verified in `tier2-boundaries/dwell-threshold-seconds.test.ts`
   - Verified in `tier4-journeys/journey-guest-booking-to-completion.test.ts`
   - **Result**: **PASSED** (tested at 75m, 90m, and 120m turns; exact second boundary transitions at $T_{turn}$ and $\lceil 1.25 \times T_{turn} \rceil$).

3. **Fair Void Attribution (Zero Guest Profile Penalization for Kitchen/Server Voids)**:
   - Verified in `tier1-features/fair-void-attribution.test.ts`
   - Verified in `tier2-boundaries/void-timing-boundaries.test.ts`
   - Verified in `tier3-pairwise/void-spend-loyalty.test.ts`
   - Verified in `tier4-journeys/journey-pos-kitchen-error-protection.test.ts`
   - **Result**: **PASSED** (`countsAsGuestReturn` is strictly false for `KITCHEN` and `SERVER_ENTRY`; diner CRM profile shows 0 return strikes and 0 return value).

4. **Multi-Market Dual Currency Formatting (USD `$` vs. INR `₹`)**:
   - Verified in `tier1-features/dual-market-currency.test.ts`
   - Verified in `tier3-pairwise/dual-market-pricing-and-cancellation.test.ts`
   - Verified in `tier4-journeys/journey-dual-market-venue-operations.test.ts`
   - **Result**: **PASSED** (USD formatted as `$XX.XX` using integer cents; INR formatted as `₹XX` or `₹XX.XX` using integer paise and localized Indian number system grouping).

---

## 4. Test Case Inventory

### Tier 1: Feature Coverage (`tests/e2e/tier1-features/`)
- `booking-lifecycle.test.ts`:
  1. `verifies all 8 states exist in the state machine transition definitions`
  2. `executes canonical happy path: requested -> confirmed -> arrived -> seated -> completed`
  3. `handles running late flow: confirmed -> mark_late -> arrived -> seated`
  4. `allows seating a late party directly without explicit intermediate arrive event`
  5. `prevents illegal transitions: completed cannot transition to seated or arrived`
  6. `prevents illegal transitions: cancelled cannot be seated`
  7. `allows no_show to be reinstated to arrived on the same date`
  8. `enforces actor permission checks (e.g. guests cannot seat parties)`
- `dynamic-turn-times.test.ts`:
  1. `resolves 1-2 covers to 75 minutes by default`
  2. `resolves 3-4 covers to 90 minutes by default`
  3. `resolves 5+ covers to 120 minutes by default`
  4. `prefers higher specificity score (daypart + area > daypart > area > global)`
  5. `breaks ties by narrower party range when specificity scores are equal`
  6. `falls back to venue default turn minutes when no rule matches`
- `dwell-alerts.test.ts`:
  1. `evaluates dwell alerts correctly for standard 90-minute turn`
  2. `evaluates dwell alerts correctly for 75-minute turn (1-2 covers)`
  3. `evaluates dwell alerts correctly for 120-minute turn (5+ covers)`
  4. `safely handles non-positive or future seated times by flooring to 0 elapsed minutes`
- `fair-void-attribution.test.ts`:
  1. `guarantees KITCHEN voids do NOT increment guest return counters`
  2. `guarantees SERVER_ENTRY voids do NOT increment guest return counters`
  3. `guarantees PROMOTIONAL and SYSTEM voids do NOT increment guest return counters`
  4. `defaults unmapped reason codes to UNMAPPED without penalizing the guest`
  5. `counts as guest return ONLY when GUEST attribution is post-fire`
  6. `does NOT penalize guest if POS provider lacks fire data`
  7. `never counts discounts as guest returns even if reason maps to GUEST`
- `dual-market-currency.test.ts`:
  1. `formats USD values with $ symbol and 2 decimal places using cents`
  2. `formats INR values with ₹ symbol using paise and localized grouping`
  3. `correctly parses decimal dollar strings into integer cents`
  4. `rejects strings with more than 2 decimal places to prevent float drift`
  5. `validates safe integer cents`
  6. `rounds half away from zero symmetrically across positive and negative values`
  7. `calculates basis points correctly (1 bp = 0.01%)`
  8. `calculates line gross cents from fractional quantities`
- `table-allocation.test.ts`:
  1. `allocates smallest non-negative seat differential (least wasted seats)`
  2. `prefers single physical tables before multi-table combinations when capacities are equal`
  3. `filters out tables where party size is smaller than minCapacity or greater than maxCapacity`
  4. `computes maximum sequential seatings per table accurately with +1 boundary correction`
  5. `returns 1 seating when shift span is shorter than turn + reset`
  6. `returns 0 if last seating is before opening time`
  7. `transitions through available -> occupied -> bussing -> available`
  8. `handles maintenance blocking and unblocking`
  9. `rejects invalid floor transitions`

### Tier 2: Boundary & Corner Cases (`tests/e2e/tier2-boundaries/`)
- `party-size-boundaries.test.ts`:
  1. `verifies exact threshold transition from 2 to 3 covers (75m -> 90m)`
  2. `verifies exact threshold transition from 4 to 5 covers (90m -> 120m)`
  3. `handles minimum party size boundary (1 cover)`
  4. `handles maximum party size boundary for seed rule (50 covers)`
  5. `falls back to venue default for party size exceeding rule range (e.g. 51+ covers)`
  6. `falls back to default for zero or negative party sizes without crashing`
- `dwell-threshold-seconds.test.ts`:
  1. `remains NORMAL at 89m 59s (5,399,000 ms elapsed)`
  2. `flips to AMBER at exactly 90m 00s (5,400,000 ms elapsed)`
  3. `remains AMBER at 90m 01s (5,401,000 ms elapsed)`
  4. `remains AMBER at 112m 59s (6,779,000 ms elapsed)`
  5. `flips to RED at exactly 113m 00s (6,780,000 ms elapsed)`
  6. `remains RED at 113m 01s (6,781,000 ms elapsed)`
  7. `transitions 74m 59s (normal) -> 75m 00s (amber)`
  8. `transitions 93m 59s (amber) -> 94m 00s (red)`
  9. `transitions 119m 59s (normal) -> 120m 00s (amber)`
  10. `transitions 149m 59s (amber) -> 150m 00s (red)`
- `void-timing-boundaries.test.ts`:
  1. `treats occurredAt == firedAt as NOT fired before (pre-fire boundary)`
  2. `treats occurredAt == firedAt + 1ms as fired before (post-fire boundary)`
  3. `treats occurredAt == firedAt - 1ms as pre-fire`
  4. `never counts as guest return when fireDataAvailable is false even if firedAtMs was provided`
  5. `handles null firedAtMs when fireDataAvailable is true (item was never fired)`
  6. `handles null reasonRef gracefully defaulting to UNMAPPED for voids`
  7. `handles null reasonRef defaulting to PROMOTIONAL for discounts`
- `time-cutoff-and-lead-time.test.ts`:
  1. `attributes 03:59:59 AM to the PREVIOUS service date (late night shift)`
  2. `attributes 04:00:00 AM to the CURRENT calendar service date`
  3. `handles post-midnight minute offsets >= 1440`
  4. `handles Spring-Forward non-existent local hour by shifting forward`
  5. `handles Fall-Back ambiguous local hour by selecting earlier instant`
  6. `verifies lead time gate calculation: slot start >= now + minLeadMinutes`
  7. `verifies booking window horizon: today <= serviceDate <= today + windowDays`
- `money-rounding-extremes.test.ts`:
  1. `rounds exact halves away from zero for positive numbers`
  2. `rounds exact halves away from zero for negative numbers (towards -infinity)`
  3. `preserves zero exactly without negative zero artifacts`
  4. `handles 0 bps (0%)`
  5. `handles 10,000 bps (100%)`
  6. `handles >10,000 bps (e.g. 15,000 bps = 150% markup)`
  7. `handles negative bps (-10,000 bps = -100%)`
  8. `handles odd fractional basis point division rounding`
  9. `allows maximum 32-bit signed integer cents amount`
  10. `rejects floating-point non-integers`
  11. `accurately calculates line item gross with rounding`

### Tier 3: Cross-Feature Combinations (`tests/e2e/tier3-pairwise/`)
- `multi-table-dwell-turn.test.ts`:
  1. `coordinates multi-table combination, 120m dynamic turn, and synchronized dwell escalation`
- `void-spend-loyalty.test.ts`:
  1. `correctly calculates eligible spend, accrues points, and shields guest profile from kitchen/server voids`
- `dual-market-pricing-and-cancellation.test.ts`:
  1. `evaluates timely vs late cancellation fees in USD for US venue`
  2. `evaluates timely vs late cancellation fees in INR for India venue`
- `lifecycle-floor-synchronization.test.ts`:
  1. `synchronizes table floor status with reservation lifecycle events from booking to table release`

### Tier 4: Real-World Application Scenarios (`tests/e2e/tier4-journeys/`)
- `journey-guest-booking-to-completion.test.ts`:
  1. `walks through guest booking, live tracking, arrival, host seating, dwell alerts, and completion`
- `journey-late-arrival-triage.test.ts`:
  1. `manages grace period expiry, auto-transition to LATE, guest communication, and eventual seating`
- `journey-pos-kitchen-error-protection.test.ts`:
  1. `guarantees staff mistakes and kitchen defects do not penalize the guest profile in a live dining scenario`
- `journey-dual-market-venue-operations.test.ts`:
  1. `operates parallel US (USD) and India (INR) venues with precise multi-market formatting and loyalty`

### Tier 5: Adversarial Verification (`tests/e2e/tier5-adversarial/`)
- `adversarial-hardening.test.ts`:
  1. `handles XSS and SQL injection payloads in guest names and allergy notes safely`
  2. `handles Unicode, Emoji, and multi-lingual inputs without corruption`
  3. `rejects out-of-order and contradictory state events`
  4. `handles extreme monetary values without overflow`

---

## 5. Instructions for Running Tests

To run the full suite:
```bash
cmd /c npm run test:e2e
```

To run a specific tier (e.g. Tier 4 journeys):
```bash
cmd /c npx vitest run tests/e2e/tier4-journeys
```
