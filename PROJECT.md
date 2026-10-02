# Project: Nexora Dual-Sided Restaurant Reservation, Floor Management & Multi-Market Platform

## Architecture
Nexora is a TypeScript monorepo providing end-to-end restaurant guest booking, host floor triage, KDS, POS, and CRM capabilities across dual markets (US/USD and India/INR).
- **`packages/shared` (`@nexora/shared`)**: Canonical pure domain engine implementing business rules BR-01 through BR-35, 8-state reservation finite state machine, dynamic turn time calculation, multi-table allocation, fair void attribution, dwell timer calculation, multi-market currency models, Zod validation schemas, and real-time event definitions.
- **`apps/api` (`@nexora/api`)**: Fastify 5 REST and WebSocket server with PostgreSQL 16 connection pooling, transactional event emission, dual-market venue configuration, dynamic dwell alerts, and POS webhook ingestion with fair void attribution.
- **`apps/web` (`@nexora/web`)**: Next.js 16 (React 19) App Router frontend with Tailwind CSS v4, providing Guest booking & 8-state live tracker, Host floor management with dynamic dwell alerts & multi-table visibility, and POS/Manager order adjustments with profile metric protection.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | F-BR01 | Minor-unit integer money arithmetic (cents/paise) with roundHalfAwayFromZero and bps calculation | M1 | Plan Pack BR-01 |
| 2 | F-BR02 | UTC instant and local minute time conversions with 04:00 service date cutoff and DST handling | M1 | Plan Pack BR-02 |
| 3 | F-BR03 | 15-minute slot grid generation and shift capacity formula N_max = floor((last - open) / (turn + reset)) + 1 | M1 | Plan Pack BR-03 / R-06 |
| 4 | F-BR04 | Booking window days and minimum lead time validation | M1 | Plan Pack BR-04 |
| 5 | F-BR05 | Dynamic party-size turn times (1-2 covers = 75m, 3-4 covers = 90m, 5+ = 120m) with specificity scoring | M1 | Plan Pack BR-05 |
| 6 | F-BR06 | Best-fit table allocation with seat differential minimization and multi-table combination matching | M1 | Plan Pack BR-06 |
| 7 | F-BR07 | Reservation creation validation and collision checking | M1 | Plan Pack BR-07 |
| 8 | F-BR08 | 8-state reservation lifecycle (REQUESTED, CONFIRMED, ARRIVED, SEATED, LATE, COMPLETED, CANCELLED, NO_SHOW) | M1 | Plan Pack BR-08, Redline v2 §11 |
| 9 | F-BR09 | Table floor status transitions (available, occupied, bussing, blocked) with derived upcoming badge | M1 | Plan Pack BR-09 |
| 10 | F-BR10 | Dynamic dwell alert timer: 100% turn duration = amber, ceil(125% turn duration) = red | M1 | Plan Pack BR-10, Redline v2 §10 |
| 11 | F-BR11 | Waitlist quote algorithm incorporating table free times and reset buffer T_reset | M1 | Plan Pack BR-11 |
| 12 | F-BR12 | Eligible spend calculation excluding voids, comps, tips, and taxes | M1 | Plan Pack BR-12 |
| 13 | F-BR13 | Fair void attribution (GUEST, KITCHEN, SERVER_ENTRY, PROMOTIONAL, SYSTEM, UNMAPPED) | M1 | Plan Pack BR-13, Redline v2 §4.2 |
| 14 | F-BR14 | POS check linking to reservations via table ID and time window | M1 | Plan Pack BR-14 |
| 15 | F-BR15..17 | Loyalty earn calculation, deficit write-off, tier progression, and voucher lifecycle | M1 | Plan Pack BR-15..17 |
| 16 | F-BR18 | Post-dining receipt claim verification and rate limiting | M1 | Plan Pack BR-18 |
| 17 | F-BR19..21 | Deterministic guest identity merge and SMS consent / quiet-hours evaluation | M1 | Plan Pack BR-19..21 |
| 18 | F-BR22..25 | Guest profile statistics (median, party size, lift), holdout bucketing, device hashing | M1 | Plan Pack BR-22..25 |
| 19 | F-BR31..35 | Luhn mod 32 code generation, E.164 phone normalization, email normalization | M1 | Plan Pack BR-31..35 |
| 20 | F-GOLDEN | 7 Golden test suites (95 Vitest tests) passing 100% in packages/shared | M1 | Plan Pack / ORIGINAL_REQUEST R1 |
| 21 | F-CURR | Dual-market currency formatting for USD ($) and INR (₹) in shared domain | M1 | ORIGINAL_REQUEST R2 |
| 22 | F-DB-SCHEMA | PostgreSQL schema upgrade for 8 reservation states, venue currency/locale, and void classes | M2 | Redline v2 / ORIGINAL_REQUEST R2 |
| 23 | F-API-VENUES | Dual-market venue endpoints supporting USD ($) and INR (₹) configuration | M2 | ORIGINAL_REQUEST R2 |
| 24 | F-API-RES | Backend reservation service supporting ARRIVED and LATE states, dynamic turn times, T_reset | M2 | ORIGINAL_REQUEST R1, R2 |
| 25 | F-API-VOID | POS webhook and order adjustment handling with fair void attribution (isolating kitchen/server errors) | M2 | ORIGINAL_REQUEST R2 |
| 26 | F-API-DWELL | Floor status API exposing dynamic dwell timers (100% amber, 125% red) based on predicted duration | M2 | ORIGINAL_REQUEST R2 |
| 27 | F-API-COMBO | Multi-table combination allocation and party grouping in floor and reservation services | M2 | ORIGINAL_REQUEST R2 |
| 28 | F-UI-GUEST | Mobile-responsive guest booking flow with date, time, party size, and seating preference | M3 | ORIGINAL_REQUEST R3 |
| 29 | F-UI-TRACK | Live guest booking tracker displaying all 8 states (CONFIRMED -> ARRIVED -> SEATED -> COMPLETED / LATE) | M3 | ORIGINAL_REQUEST R3 |
| 30 | F-UI-FLOOR | Host floor view with real-time table status tiles, multi-table indicators, arrival quick-actions | M3 | ORIGINAL_REQUEST R3 |
| 31 | F-UI-DWELL | Host floor dynamic dwell color alerts (amber >= 100%, red >= 125% of predicted turn time) | M3 | ORIGINAL_REQUEST R3 |
| 32 | F-UI-POS | POS/Manager interface for order adjustments with fair void classification demonstration | M3 | ORIGINAL_REQUEST R3 |
| 33 | F-UI-MARKET | Multi-market currency display formatting ($ for USD venues, ₹ for INR venues) | M3 | ORIGINAL_REQUEST R3 |
| 34 | F-E2E-TIER1 | Tier 1 Feature Coverage E2E test suite (isolated feature verification) | M4 | Project Pattern Dual Track |
| 35 | F-E2E-TIER2 | Tier 2 Boundary & Corner Case E2E test suite (limits, empty inputs, edge cases) | M4 | Project Pattern Dual Track |
| 36 | F-E2E-TIER3 | Tier 3 Cross-Feature Combination E2E test suite (pairwise interactions) | M4 | Project Pattern Dual Track |
| 37 | F-E2E-TIER4 | Tier 4 Real-World Application Scenario E2E test suite (end-to-end client journeys) | M4 | Project Pattern Dual Track |
| 38 | F-E2E-TIER5 | Tier 5 Adversarial Coverage Hardening test suite | M4 | Project Pattern Dual Track |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Core Domain Engine & Golden Test Harness | Port BR-01..BR-35, 8-state FSM, dynamic turn times, multi-table allocation, fair void attribution, dual currency (USD/INR), and golden tests to `packages/shared`. Add `check` script. | none | DONE (159/159 tests pass, clean audit) |
| M2 | Backend API & Multi-Market Engine | Update database migrations, venues dual-currency (USD/INR), reservation lifecycle (ARRIVED/LATE), fair void attribution in POS service, and dynamic dwell alert calculation in `apps/api`. | M1 | DONE (Dual-market schema, lifecycle endpoints, POS void attribution & demo endpoints) |
| M3 | Client-Showcase UI Journeys | Implement 8-state live tracker, mobile booking flow, host floor tiles with dynamic dwell alerts & multi-table visibility, POS void interface, and multi-currency UI in `apps/web`. | M1, M2 | DONE (Live tracker, host floor badges & timers, POS & Fair Void demo UI, USD/INR dual market) |
| M4 | E2E Test Suite & Final Verification | Pass 100% E2E test suite (Tiers 1-4), execute Tier 5 adversarial hardening, verify complete build, clean typechecks, and client demo flows. | M1, M2, M3 | DONE (96/96 E2E tests pass, 0 type errors across monorepo, clean Next.js 16 build) |

## Interface Contracts

### `packages/shared` ↔ `apps/api`
- **Reservation FSM**:
  - `ReservationStatus = 'REQUESTED' | 'CONFIRMED' | 'ARRIVED' | 'SEATED' | 'LATE' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW'` (or lowercase equivalent with canonical mapping).
  - `applyReservationEvent(snapshot, event, context): TransitionResult`
- **Dynamic Turn Times**:
  - `resolveTurnMinutes(rules: ReadonlyArray<TurnRule>, query: TurnQuery, fallback?: number): number`
  - Defaults: 1-2 covers -> 75m, 3-4 covers -> 90m, 5+ covers -> 120m.
- **Fair Void Attribution**:
  - `classifyAdjustment(input: ClassifyInput): ClassifyResult`
  - `AttributionClass = 'GUEST' | 'KITCHEN' | 'SERVER_ENTRY' | 'PROMOTIONAL' | 'SYSTEM' | 'UNMAPPED'`
  - Only `countsAsGuestReturn = true` increments `guest_profiles.total_voids_count`.
- **Dynamic Dwell Alerts**:
  - `timerState(seatedAtMs: number, turnMinutes: number, nowMs: number): { elapsedMinutes: number; level: 'normal' | 'amber' | 'red' }`
  - Amber at $\ge 1.0 \times \text{turnMinutes}$, Red at $\ge \lceil 1.25 \times \text{turnMinutes} \rceil$.
- **Multi-Market Money**:
  - `formatMoney(amount: number, currency: 'USD' | 'INR'): string`
  - USD formats as `$XX.XX`, INR formats as `₹XX`.

### `apps/api` ↔ `apps/web`
- **Public & Admin REST Endpoints**:
  - `GET /api/v1/venues`: Returns venue array including `currency: 'USD' | 'INR'`, `locale: 'en-US' | 'en-IN'`.
  - `POST /api/v1/reservations`: Accepts booking request, returns reservation with `publicToken`, `turnMinutes`, `status`.
  - `GET /api/v1/reservations/track/:token`: Returns live reservation with status (`CONFIRMED`, `ARRIVED`, `SEATED`, `LATE`, `COMPLETED`, etc.), `turnMinutes`, and timestamp history.
  - `PATCH /api/v1/reservations/:id/status`: Transitions reservation (e.g. to `ARRIVED`, `SEATED`, `LATE`, `COMPLETED`).
  - `GET /api/v1/floor/tables`: Returns tables with occupancy, multi-table grouping, seatedAt timestamp, predicted turnMinutes, and computed `dwellLevel` (`normal`, `amber`, `red`).
  - `POST /api/v1/webhooks/pos`: Processes POS adjustments with `reason` and `attributionClass`, shielding guest profiles from kitchen/server errors.
- **Socket.IO Real-time Events**:
  - `reservation:changed`: Emitted when status changes (including `ARRIVED` and `LATE`).
  - `floor:changed`: Emitted on seating, bussing, clearing, or dwell alerts.

## Code Layout
- `packages/shared/src/`:
  - `money.ts`: Minor-unit money math, USD ($) and INR (₹) formatting.
  - `time.ts`: Instants, local minute offsets, DST, 04:00 service date.
  - `turn.ts`: Dynamic turn-time resolution and rule validation.
  - `availability.ts`: Slot grid, best-fit allocation, multi-table combinations.
  - `reservation.ts`: 8-state finite state machine, transitions, effects.
  - `floor.ts`: Floor transitions, dynamic dwell timerState (100% amber, 125% red), waitlist quoting.
  - `pos.ts`: Fair void attribution, eligible spend, check linking.
  - `loyalty.ts`: Multi-market tier progression, points conversion.
  - `claims.ts`, `identity.ts`, `consent.ts`, `stats.ts`, `codes.ts`, `contact.ts`, `node-crypto.ts`.
  - `constants.ts`, `schemas.ts`, `realtime.ts`, `index.ts`.
- `packages/shared/test/`:
  - All 7 golden test suites (95 tests) from Plan Pack reference.
- `apps/api/src/`:
  - `db/migrations/`: PostgreSQL migration files for dual-currency venues, 8-state reservation status, void classes.
  - `db/seed.ts`: Seed data with dual-market venues (USD and INR).
  - `modules/reservations/`: Lifecycle handling with ARRIVED/LATE, dynamic turn times.
  - `modules/pos/`: Webhook processing with fair void classification.
  - `modules/floor/`: Dynamic dwell calculations via `timerState`.
- `apps/web/`:
  - `app/(consumer)/booking/`: Guest booking journey.
  - `app/(consumer)/booking/[token]/`: Live guest booking tracker (8 states).
  - `app/(admin)/floor/`: Host floor plan with dynamic dwell alert badges and multi-table party visibility.
  - `app/(admin)/pos/`: POS order management and fair void demonstration.
  - `lib/format.ts`: Multi-currency formatting supporting both `$` and `₹`.
- `tests/e2e/`:
  - E2E testing harness and test suites across Tiers 1-4.
