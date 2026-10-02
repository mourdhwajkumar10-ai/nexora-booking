# Nexora Test Infrastructure Specification (`TEST_INFRA.md`)

## 1. Test Philosophy: Opaque-Box, Requirement-Driven Testing

The Nexora test infrastructure operates on an **opaque-box, requirement-driven testing philosophy**. Tests treat the platform components (domain engine, backend API services, and user interfaces) strictly as implementations of the authoritative specifications set forth in:
- **`ORIGINAL_REQUEST.md`**: Authoritative User Requirements and Acceptance Criteria
- **`PROJECT.md`**: Master Architecture, Feature Inventory, and Interface Contracts
- **Redline v2 Specification** (`DOC-20261001-WA0002.docx.pdf`): Enterprise Architecture, Rules, and Thresholds
- **Plan Pack Reference Specifications** (`Restaurant-Platform-Implementation-Plan-Pack/restaurant-platform-plan/docs/`): Decisions, Data Model, API Contracts, and Business Rules BR-01 through BR-35

### Core Tenets:
1. **Specification as Single Source of Truth**: Tests assert against documented mathematical formulas, state transition matrices, and business rule contracts, never private implementation internals.
2. **Authoritative Output Derivation**: Expected outputs are derived directly from the mathematical definitions in the specification and validated against the reference oracle implementation in `Restaurant-Platform-Implementation-Plan-Pack/restaurant-platform-plan/reference/domain/`.
3. **Progressive Testability**: Tests are structured in progressive tiers (Tiers 1 through 4, plus Tier 5 adversarial hardening) so that each milestone can be verified independently and deterministically without cross-milestone circular dependencies.
4. **Hermetic Independence**: Every test case sets up its own isolated context, uses explicit deterministic inputs (frozen clock, explicit party size, configured venues), asserts on observable outputs, and leaves zero persistent side effects.

---

## 2. Test Architecture & Directory Layout

The E2E test suite lives in `tests/e2e/` at the project root:

```
tests/e2e/
├── helpers/
│   ├── oracle.ts                             # Authoritative domain adapter & oracle bridge
│   └── client-simulator.ts                   # Simulates Guest, Host Floor, and POS interactions
├── tier1-features/
│   ├── booking-lifecycle.test.ts             # 8-state reservation lifecycle FSM (F-BR08)
│   ├── dynamic-turn-times.test.ts            # Dynamic turn time resolution & specificity (F-BR05)
│   ├── dwell-alerts.test.ts                  # Proportional dwell alert thresholds (F-BR10)
│   ├── fair-void-attribution.test.ts         # Fair void attribution & guest protection (F-BR13)
│   ├── dual-market-currency.test.ts          # Multi-market USD ($) & INR (₹) formatting (F-CURR)
│   └── table-allocation.test.ts              # Best-fit table & combination allocation (F-BR06, F-BR03)
├── tier2-boundaries/
│   ├── party-size-boundaries.test.ts         # Boundary party sizes (1, 2, 3, 4, 5, extreme)
│   ├── dwell-threshold-seconds.test.ts       # Exact second-by-second dwell escalations
│   ├── void-timing-boundaries.test.ts        # Fire vs void timestamp edge cases & missing data
│   ├── time-cutoff-and-lead-time.test.ts     # 04:00 cutoff, lead times, booking horizons, DST
│   └── money-rounding-extremes.test.ts       # Half-away-from-zero, basis points, 32-bit limits
├── tier3-pairwise/
│   ├── multi-table-dwell-turn.test.ts        # Combination tables + dynamic turn + dwell alerts
│   ├── void-spend-loyalty.test.ts            # Kitchen/server void isolation + spend + loyalty
│   ├── dual-market-pricing-and-cancellation.test.ts # US vs India cancellation fee evaluation
│   └── lifecycle-floor-synchronization.test.ts # Reservation FSM synced with physical table states
├── tier4-journeys/
│   ├── journey-guest-booking-to-completion.test.ts  # Demo 1: Full booking -> seating -> dwell -> complete
│   ├── journey-late-arrival-triage.test.ts          # Demo 2: Grace period expiry -> LATE -> check-in
│   ├── journey-pos-kitchen-error-protection.test.ts # Demo 3: Kitchen error void -> profile protected
│   └── journey-dual-market-venue-operations.test.ts # Demo 4: Parallel US ($) & India (₹) operations
├── tier5-adversarial/
│   └── adversarial-hardening.test.ts         # Injection, special chars, out-of-order events
└── vitest.config.ts                          # Vitest configuration for E2E test execution
```

---

## 3. Test Runner & Execution Commands

### Test Execution Commands:
- **Run all E2E test suites (Tiers 1–5)**:
  ```bash
  cmd /c npm run test:e2e
  ```
  *(or `cmd /c npx vitest run tests/e2e`)*

- **Run individual tiers**:
  ```bash
  cmd /c npx vitest run tests/e2e/tier1-features
  cmd /c npx vitest run tests/e2e/tier2-boundaries
  cmd /c npx vitest run tests/e2e/tier3-pairwise
  cmd /c npx vitest run tests/e2e/tier4-journeys
  cmd /c npx vitest run tests/e2e/tier5-adversarial
  ```

- **Run specific test suite**:
  ```bash
  cmd /c npx vitest run tests/e2e/tier4-journeys/journey-guest-booking-to-completion.test.ts
  ```

- **Typecheck test suite**:
  ```bash
  cmd /c npm run check
  ```

### Toolchain & Environment Requirements:
- **Node.js**: `>= 20.0.0` (active version: `v22.14.0`)
- **TypeScript**: `^5.9.0`
- **Test Runner**: `vitest@3.2.7`
- **OS**: Windows (all CLI commands must be executed via `cmd /c` to satisfy PowerShell execution policy constraints)

---

## 4. Feature Inventory to Test Tier Mapping

Every feature identified in `PROJECT.md § Feature Inventory` is mapped to one or more tiers:

| Feature ID | Description | Primary Tier | Test File |
|---|---|---|---|
| **F-BR01** | Minor-unit money arithmetic (cents/paise), roundHalfAwayFromZero, bps | Tier 1, 2 | `dual-market-currency.test.ts`, `money-rounding-extremes.test.ts` |
| **F-BR02** | UTC instant/local minute time conversions, 04:00 service cutoff, DST | Tier 1, 2 | `time-cutoff-and-lead-time.test.ts` |
| **F-BR03** | 15-min slot grid, shift capacity formula $N_{max} = \lfloor (T_{last}-T_{open})/(T_{turn}+T_{reset})\rfloor + 1$ | Tier 1 | `table-allocation.test.ts` |
| **F-BR04** | Booking window days and minimum lead time validation | Tier 2 | `time-cutoff-and-lead-time.test.ts` |
| **F-BR05** | Dynamic party-size turn times (1-2: 75m, 3-4: 90m, 5+: 120m), specificity scoring | Tier 1, 2 | `dynamic-turn-times.test.ts`, `party-size-boundaries.test.ts` |
| **F-BR06** | Best-fit table allocation with seat differential minimization & combinations | Tier 1, 3 | `table-allocation.test.ts`, `multi-table-dwell-turn.test.ts` |
| **F-BR07** | Reservation creation validation & collision checking | Tier 1, 4 | `table-allocation.test.ts`, `journey-guest-booking-to-completion.test.ts` |
| **F-BR08** | 8-state reservation lifecycle (`REQUESTED`..`NO_SHOW`), transitions & actors | Tier 1, 4 | `booking-lifecycle.test.ts`, `journey-guest-booking-to-completion.test.ts`, `journey-late-arrival-triage.test.ts` |
| **F-BR09** | Table floor status transitions (`AVAILABLE`, `OCCUPIED`, `BUSSING`, `BLOCKED`) | Tier 1, 3 | `table-allocation.test.ts`, `lifecycle-floor-synchronization.test.ts` |
| **F-BR10** | Dynamic dwell alert timer (100% turn = amber, ceil(125% turn) = red) | Tier 1, 2, 4 | `dwell-alerts.test.ts`, `dwell-threshold-seconds.test.ts`, `journey-guest-booking-to-completion.test.ts` |
| **F-BR11** | Waitlist quote algorithm with table free times & $T_{reset}$ buffer | Tier 1 | `table-allocation.test.ts` |
| **F-BR12** | Eligible spend calculation excluding voids, comps, tips, and taxes | Tier 1, 3 | `fair-void-attribution.test.ts`, `void-spend-loyalty.test.ts` |
| **F-BR13** | Fair void attribution (`GUEST`, `KITCHEN`, `SERVER_ENTRY`, `PROMOTIONAL`, etc.) | Tier 1, 2, 3, 4 | `fair-void-attribution.test.ts`, `void-timing-boundaries.test.ts`, `void-spend-loyalty.test.ts`, `journey-pos-kitchen-error-protection.test.ts` |
| **F-BR14** | POS check linking to reservations via table ID and time window | Tier 3, 4 | `void-spend-loyalty.test.ts`, `journey-pos-kitchen-error-protection.test.ts` |
| **F-BR15..17** | Loyalty earn, deficit write-off, tier progression | Tier 3 | `void-spend-loyalty.test.ts` |
| **F-BR18** | Post-dining receipt claim verification and rate limiting | Tier 3 | `void-spend-loyalty.test.ts` |
| **F-BR19..21** | Deterministic guest identity merge and SMS consent / quiet-hours | Tier 2, 5 | `time-cutoff-and-lead-time.test.ts`, `adversarial-hardening.test.ts` |
| **F-BR22..25** | Guest profile statistics (median, party size, lift), holdout bucketing | Tier 3, 4 | `void-spend-loyalty.test.ts`, `journey-pos-kitchen-error-protection.test.ts` |
| **F-BR31..35** | Luhn mod 32 code generation, E.164 phone normalization, email normalization | Tier 2, 5 | `party-size-boundaries.test.ts`, `adversarial-hardening.test.ts` |
| **F-GOLDEN** | 7 Golden test suites passing 100% | Reference | Verified against reference domain engine |
| **F-CURR** | Dual-market currency formatting for USD (`$`) and INR (`₹`) | Tier 1, 3, 4 | `dual-market-currency.test.ts`, `dual-market-pricing-and-cancellation.test.ts`, `journey-dual-market-venue-operations.test.ts` |
| **F-DB-SCHEMA** | PostgreSQL schema upgrade (8 states, venue currency/locale, void classes) | Tier 1, 4 | All tiers assert on canonical 8-state model and void classes |
| **F-API-VENUES** | Dual-market venue endpoints supporting USD (`$`) and INR (`₹`) | Tier 1, 4 | `dual-market-currency.test.ts`, `journey-dual-market-venue-operations.test.ts` |
| **F-API-RES** | Backend reservation service supporting `ARRIVED`/`LATE` states, dynamic turns | Tier 1, 4 | `booking-lifecycle.test.ts`, `journey-guest-booking-to-completion.test.ts`, `journey-late-arrival-triage.test.ts` |
| **F-API-VOID** | POS webhook handling with fair void attribution (protecting diner profile) | Tier 1, 4 | `fair-void-attribution.test.ts`, `journey-pos-kitchen-error-protection.test.ts` |
| **F-API-DWELL** | Floor status API exposing dynamic dwell timers (100% amber, 125% red) | Tier 1, 2 | `dwell-alerts.test.ts`, `dwell-threshold-seconds.test.ts` |
| **F-API-COMBO** | Multi-table combination allocation and party grouping | Tier 1, 3 | `table-allocation.test.ts`, `multi-table-dwell-turn.test.ts` |
| **F-UI-GUEST** | Mobile-responsive guest booking flow | Tier 4 | `journey-guest-booking-to-completion.test.ts` |
| **F-UI-TRACK** | Live guest booking tracker displaying all 8 states | Tier 4 | `journey-guest-booking-to-completion.test.ts`, `journey-late-arrival-triage.test.ts` |
| **F-UI-FLOOR** | Host floor view with status tiles, multi-table indicators, arrival quick actions | Tier 4 | `journey-guest-booking-to-completion.test.ts`, `journey-late-arrival-triage.test.ts` |
| **F-UI-DWELL** | Host floor dynamic dwell color alerts (amber $\ge 100\%$, red $\ge 125\%$) | Tier 4 | `journey-guest-booking-to-completion.test.ts` |
| **F-UI-POS** | POS/Manager order adjustments with fair void demonstration | Tier 4 | `journey-pos-kitchen-error-protection.test.ts` |
| **F-UI-MARKET** | Multi-market currency display formatting (`$` vs `₹`) | Tier 4 | `journey-dual-market-venue-operations.test.ts` |
| **F-E2E-TIER1** | Tier 1 Feature Coverage E2E test suite | Tier 1 | `tests/e2e/tier1-features/*.test.ts` |
| **F-E2E-TIER2** | Tier 2 Boundary & Corner Case E2E test suite | Tier 2 | `tests/e2e/tier2-boundaries/*.test.ts` |
| **F-E2E-TIER3** | Tier 3 Cross-Feature Combination E2E test suite | Tier 3 | `tests/e2e/tier3-pairwise/*.test.ts` |
| **F-E2E-TIER4** | Tier 4 Real-World Application Scenario E2E test suite | Tier 4 | `tests/e2e/tier4-journeys/*.test.ts` |
| **F-E2E-TIER5** | Tier 5 Adversarial Coverage Hardening test suite | Tier 5 | `tests/e2e/tier5-adversarial/*.test.ts` |

---

## 5. Acceptance Criteria Verification Matrix

The test suite directly verifies the mandatory acceptance criteria defined in `ORIGINAL_REQUEST.md`:

| Acceptance Criterion | Verification Test Suite | Assertions & Invariants |
|---|---|---|
| **AC-1: 8-State Lifecycle**<br>Transition through `CONFIRMED` $\to$ `ARRIVED` $\to$ `SEATED` $\to$ `COMPLETED` (or `LATE`), verified on guest tracking | `journey-guest-booking-to-completion.test.ts`<br>`journey-late-arrival-triage.test.ts`<br>`booking-lifecycle.test.ts` | - Instant booking validates slot and creates `CONFIRMED`.<br>- Arriving guest sets `ARRIVED` with arrival timestamp.<br>- Host seating action sets `SEATED`, updates floor table to `OCCUPIED`.<br>- Check payment sets `COMPLETED`, updates floor table to `BUSSING`.<br>- Delayed party beyond 15m grace auto-transitions to `LATE`. |
| **AC-2: Floor Dynamic Dwell Warnings**<br>Table seated past 100% displays amber, and past 125% displays red | `dwell-alerts.test.ts`<br>`dwell-threshold-seconds.test.ts`<br>`journey-guest-booking-to-completion.test.ts` | - For $T_{turn} = 90$ min: $\Delta t < 90\text{m} \implies \text{'normal'}$, $90\text{m} \le \Delta t < 113\text{m} \implies \text{'amber'}$, $\Delta t \ge 113\text{m} \implies \text{'red'}$.<br>- Exact second boundary assertions at $T_{turn}$ and $\lceil 1.25 \times T_{turn} \rceil$. |
| **AC-3: Fair Void Attribution**<br>POS adjustment categorized as `KITCHEN` or `SERVER_ENTRY` does NOT increment diner profile void counter | `fair-void-attribution.test.ts`<br>`void-timing-boundaries.test.ts`<br>`journey-pos-kitchen-error-protection.test.ts` | - `countsAsGuestReturn` is strictly `false` for `KITCHEN` and `SERVER_ENTRY`.<br>- Profile `total_voids_count` / `guest_returns_count` is 0.<br>- Net eligible spend and loyalty points deduct voided amounts without penalizing guest metrics. |
| **AC-4: Multi-Market Currency**<br>USD demo venue formats `$`, INR demo venue formats `₹` | `dual-market-currency.test.ts`<br>`journey-dual-market-venue-operations.test.ts`<br>`dual-market-pricing-and-cancellation.test.ts` | - Venue configured with `currency: 'USD'` renders `$XX.XX` using integer cents.<br>- Venue configured with `currency: 'INR'` renders `₹XX` or `₹XX.XX` using integer paise.<br>- Correct localized thousand separators (`en-US` vs `en-IN`). |

---

## 6. Coverage Thresholds & Quality Gates

To guarantee enterprise rigor and client demo readiness, the test suite must adhere to the following quality gates:

1. **Pass Rate**: 100% of all E2E test suites in Tiers 1 through 5 must pass.
2. **Deterministic Execution**: Zero flakiness; all timers and time-dependent calculations use explicit timestamps or frozen clock instances.
3. **Type Safety**: Full TypeScript compilation pass (`tsc --noEmit` / `npm run check`) with zero errors across all test files.
4. **Adversarial Resilience**: Safe handling of boundary party sizes, negative money values, extreme basis points, and special characters.
