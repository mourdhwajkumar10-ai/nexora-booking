# Nexora — Architecture

## 1. System overview

```
┌──────────────────────── apps/web (Next.js 16, React 19) ────────────────────────┐
│  Consumer portal  /  /r/[slug]  /booking/[token]  /wifi/[slug]                     │
│  Admin console    /admin/login  /admin/[venueId]/{floor,triage,reservations,…}    │
└───────────────┬──────────────────────────────────────────┬────────────────────────┘
      fetch /api/v1/* (Next rewrite → :4000)       Socket.IO (ws → :4000)
                │                                          │
┌───────────────▼──────────── apps/api (Fastify 5, Node) ──▼────────────────────────┐
│ modules/  auth · ops · venues · booking · floor · guests · wifi · pos · loyalty  │
│ core/     reservations · tables · orders · guests · alerts · notifications · audit│
│ lib/      bus (domain events) · realtime (Socket.IO fan-out) · jobs · clock · auth│
└───────────────┬───────────────────────────────────────────────────────────────────┘
                │ pg (READ COMMITTED + SELECT … FOR UPDATE, EXCLUDE constraint)
         ┌──────▼──────┐
         │ PostgreSQL 16│  pgcrypto · btree_gist
         └─────────────┘
packages/shared — zod schemas, DTO types, enums, FSMs, time/slot math, best-fit, loyalty rules
```

- **Monorepo** with npm workspaces: `packages/shared`, `apps/api`, `apps/web`.
- **Same-origin API:** Next.js rewrites `/api/v1/*` to the API, so the httpOnly session cookie works without CORS problems. Socket.IO connects straight to `:4000`. Cookies are per host, not per port, so the session cookie reaches it on localhost.
- **Domain events:** services call `tx.emit(event)` inside a transaction, and events are published **after COMMIT** (`lib/bus.ts`). `lib/realtime.ts` turns them into Socket.IO messages, and modules subscribe to each other's events (e.g. `order.billed` → loyalty accrual) without importing each other.
- **Workers:** `lib/jobs.ts` is an in-process interval scheduler that runs triage escalation, no-shows, dwell alerts, the notification outbox and webhook retries. `WORKERS=0` turns it off. Tests call `runJob(name)` directly.
- **Clock:** all business logic uses `clock.now()` (`lib/clock.ts`) so tests can freeze and advance time.

## 2. Formulas

The math that went missing from the source PDFs ([C-01](CRITIQUE.md#c-01)):

| Name | Formula | Code |
|---|---|---|
| Release boundary | `T_end = T_start + T_turn` (T_turn = `venues.turnaround_mins`, default 30) | `shared/time.ts` |
| Shift validity | valid ⇔ `T_start ≥ T_open ∧ T_end ≤ T_close` (close ≤ open ⇒ next day) | `validateRequestedSlot` |
| Slot grid | `T_start ∈ {T_open + 15k}`; last slot = `T_close − T_turn` | `generateSlots` |
| Capacity per table | `N_max = ⌊(T_close − T_open) / T_turn⌋` | `maxIntervalsPerShift` |
| Conflict | `[s₁,e₁)` and `[s₂,e₂)` conflict ⇔ `s₁ < e₂ ∧ s₂ < e₁` | `overlaps`, DB `tstzrange('[)') &&` |
| Best fit | candidates: `status ≠ BLOCKED ∧ no conflict ∧ min ≤ P ≤ max`; sort by `D = max − P` ascending, then table number | `bestFitOrder` |
| Elapsed | `Δt = (t_client + offset) − t_seat`, where `offset = serverTime − clientNow` | `elapsedSeconds` |
| Dwell alert | amber ⇔ `Δt ≥ T_turn`; red ⇔ `Δt ≥ T_turn + 15` | `dwellLevel` |
| Walk-in collision | the walk-in at `now` collides with booking `b` on that table ⇔ `b.start < now + T_turn + 15 ∧ now < b.end` | floor module |
| Grace / no-show | CONFIRMED and `now ≥ start + grace (15)` and not seated ⇒ NO_SHOW | booking worker |
| Triage timeout | REQUESTED and `now ≥ created_at + 300 s` ⇒ auto-confirm (Good Standing ∧ table still free) or escalate | booking worker |
| Good Standing | no NO_SHOW in the last 90 days ∧ no `UNRESOLVED_LOYALTY_DEFICIT` flag | booking module |
| Points | `pts = ⌊net_paise / 100⌋ × multiplier(tier)`; 100 pts = ₹1 | `shared/loyalty.ts` |
| Clawback | `pts_back = ⌊voided_paise / 100⌋ × multiplier(tier)`; the balance can go negative (deficit) | `clawbackPoints` |

## 3. State machines (`packages/shared/src/fsm.ts`)

**Reservation:** `REQUESTED → CONFIRMED | CANCELLED`; `CONFIRMED → SEATED | CANCELLED | NO_SHOW`; `SEATED → COMPLETED`.

**Table (physical):** `AVAILABLE → OCCUPIED | BLOCKED`; `OCCUPIED → BUSSING | BLOCKED`; `BUSSING → AVAILABLE | BLOCKED`; `BLOCKED → AVAILABLE`.
Floor status = physical status, except **RESERVED** when physical is AVAILABLE and a CONFIRMED reservation on that table has `start_at − T_turn ≤ now < start_at + grace`.

**Order:** `PLACED → RECEIVED → PREPARING → SERVED → BILLED | PARTIALLY_PAID`; `PARTIALLY_PAID → BILLED`; any open status → `VOIDED`.

Side effects, composed in the module services:

| Action | Reservation | Table | Order | Other |
|---|---|---|---|---|
| Consumer books | ∅ → REQUESTED | — | — | alert/queue via socket |
| Host approves | → CONFIRMED | (derived RESERVED) | — | outbox: `RESERVATION_CONFIRMED` SMS |
| Host rejects / guest aborts | → CANCELLED | — | — | outbox: `RESERVATION_DECLINED` |
| Seat | → SEATED | AVAILABLE → OCCUPIED | open check (PLACED) | `last_visit_at` |
| Walk-in | ∅ → SEATED (source WALK_IN) | → OCCUPIED | open check | collision check |
| Settle | — | — | → BILLED | `order.billed` → loyalty + CRM spend + auto-tags |
| Clear / complete | SEATED → COMPLETED (needs the check BILLED, or no items) | OCCUPIED → BUSSING | — | visits++, SLOW_PACING tag |
| Mark clean | — | BUSSING → AVAILABLE | — | |
| No-show worker | CONFIRMED → NO_SHOW | — | — | `no_show_count++`, alert |

## 4. Data model

Defined in `apps/api/src/db/migrations/001_init.sql`. Money is **integer paise** (BIGINT/INT), and timestamps are `TIMESTAMPTZ`.

| Domain | Tables |
|---|---|
| Venue & inventory | `localities`, `venues`, `operating_shifts`, `dining_tables`, `menu_items`, `staff_users`, `audit_logs` |
| Guests / CRM | `guests`, `guest_profiles`, `guest_tags`, `guest_devices` |
| Reservations | `reservations` (+ EXCLUDE constraint), `reservation_events` |
| POS | `pos_orders` (unique open check per table), `pos_order_items`, `pos_void_logs` |
| Loyalty & value | `loyalty_accounts`, `loyalty_ledger`, `loyalty_holds`, `gift_cards`, `gift_card_holds`, `gift_card_ledger` |
| Wi-Fi | `wifi_otps`, `wifi_sessions` |
| Ops | `alerts`, `notifications_outbox`, `webhook_events` |

## 5. API contract (`/api/v1`)

Request schemas and response types live in `packages/shared/src/schemas.ts`. Errors always look like `{ error: { code, message, details? } }`.
Auth: 🔓 public · 👤 staff (any role) · 🛡 MANAGER. Staff scoped to a venue get **403** on other venues.

### auth / ops (Sprint 0, done)
| Method | Path | Auth | Body → Response |
|---|---|---|---|
| POST | `/auth/login` | 🔓 | `LoginInput` → `MeResponse` (+ sets cookie `nexora_session`) |
| POST | `/auth/logout` | 🔓 | → `{ok}` |
| GET | `/auth/me` | 👤 | → `MeResponse` |
| GET | `/time` | 🔓 | → `{serverTime}` |
| GET | `/admin/venues/:venueId/alerts?all=1` | 👤 | → `AlertDto[]` (unacknowledged unless `all=1`) |
| POST | `/admin/alerts/:id/ack` | 👤 | → `AlertDto` |

### venues (module A1)
| Method | Path | Auth | Body → Response |
|---|---|---|---|
| GET | `/localities` | 🔓 | → `Locality[]` |
| GET | `/venues?locality=<slug>` | 🔓 | → `VenueCard[]` (active only; sorted by rating) |
| GET | `/venues/:slug` | 🔓 | → `VenueDetail` |
| GET | `/admin/venues/:venueId` | 👤 | → `VenueSettings` |
| PATCH | `/admin/venues/:venueId` | 🛡 | `UpdateVenueInput` → `VenueSettings` |
| POST | `/admin/venues/:venueId/blackout` | 👤 | `BlackoutInput` → `VenueSettings` (audit) |
| PUT | `/admin/venues/:venueId/shifts` | 🛡 | `ReplaceShiftsInput` → `ShiftDto[]` |
| GET | `/admin/venues/:venueId/tables` | 👤 | → `DiningTableDto[]` |
| POST | `/admin/venues/:venueId/tables` | 🛡 | `CreateTableInput` → `DiningTableDto` |
| PATCH | `/admin/tables/:tableId` | 🛡 | `UpdateTableInput` → `DiningTableDto`; 409 `TABLE_HAS_BOOKINGS` if downsizing breaks a future booking |
| DELETE | `/admin/tables/:tableId` | 🛡 | → 204; 409 `TABLE_HAS_BOOKINGS` if active/future bookings exist (soft delete) |
| GET | `/admin/venues/:venueId/menu` | 👤 | → `MenuItemDto[]` |
| POST | `/admin/venues/:venueId/menu` | 🛡 | `CreateMenuItemInput` → `MenuItemDto` |
| GET | `/admin/venues/:venueId/audit` | 🛡 | → `AuditLogDto[]` (latest 100) |

### booking (module A2)
| Method | Path | Auth | Body → Response |
|---|---|---|---|
| GET | `/venues/:slug/availability?date&partySize` | 🔓 | → `AvailabilityResponse` |
| POST | `/venues/:slug/reservations` | 🔓 (rate-limited) | `CreateBookingInput` → 201 `PublicReservation`; 409 `SLOT_UNAVAILABLE` `{alternatives}`; 422 `OUTSIDE_HOURS`/`OFF_GRID`/`NO_TABLE_FOR_PARTY`/`VENUE_BLACKOUT`/`TOO_MANY_REQUESTS_FOR_PHONE`; 400 `IN_PAST` |
| GET | `/reservations/:token` | 🔓 | → `PublicReservation` |
| POST | `/reservations/:token/cancel` | 🔓 | `CancelBookingInput` → `PublicReservation` (403 `PHONE_MISMATCH`) |
| GET | `/admin/venues/:venueId/reservations?date&status` | 👤 | → `AdminReservation[]` |
| GET | `/admin/venues/:venueId/triage` | 👤 | → `AdminReservation[]` (REQUESTED, oldest first) |
| POST | `/admin/venues/:venueId/reservations` | 👤 | `HostBookingInput` → 201 `AdminReservation` (phone-in; auto-confirm by default) |
| POST | `/admin/reservations/:id/approve` | 👤 | → `AdminReservation` |
| POST | `/admin/reservations/:id/reject` | 👤 | `ReasonInput` → `AdminReservation` |
| POST | `/admin/reservations/:id/cancel` | 👤 | `ReasonInput` → `AdminReservation` |
| POST | `/admin/reservations/:id/seat` | 👤 | → `AdminReservation` (409 `TABLE_NOT_READY`) |
| POST | `/admin/reservations/:id/no-show` | 👤 | → `AdminReservation` |
| POST | `/admin/reservations/:id/complete` | 👤 | → `AdminReservation` (409 `CHECK_OPEN` if unpaid items) |
| POST | `/admin/reservations/:id/reassign` | 👤 | `ReassignInput` → `AdminReservation` |
| GET | `/admin/venues/:venueId/notifications` | 👤 | → `NotificationDto[]` (latest 100) |

### floor & orders (module A3)
| Method | Path | Auth | Body → Response |
|---|---|---|---|
| GET | `/admin/venues/:venueId/floor` | 👤 | → `FloorSnapshot` |
| POST | `/admin/venues/:venueId/walk-ins/check` | 👤 | `WalkInCheckInput` → `WalkInCheckResponse` |
| POST | `/admin/venues/:venueId/walk-ins` | 👤 | `WalkInInput` → 201 `AdminReservation` (409 `WALK_IN_COLLISION` unless `override`) |
| POST | `/admin/tables/:tableId/status` | 👤 | `TableStatusInput` → `FloorTable` |
| GET | `/admin/tables/:tableId/order` | 👤 | → `OrderDetail` or 404 |
| GET | `/admin/orders/:orderId` | 👤 | → `OrderDetail` |
| POST | `/admin/orders/:orderId/items` | 👤 | `AddOrderItemInput` → `OrderDetail` |
| DELETE | `/admin/orders/:orderId/items/:itemId` | 👤 | → `OrderDetail` (only before the kitchen acknowledges it; afterwards use a void) |
| POST | `/admin/orders/:orderId/status` | 👤 | `OrderStatusInput` (RECEIVED/PREPARING/SERVED) → `OrderDetail` |

### guests / wifi / pos / loyalty (module A4)
| Method | Path | Auth | Body → Response |
|---|---|---|---|
| GET | `/admin/guests?q=` | 👤 | → `GuestSummary[]` (top 50) |
| GET | `/admin/guests/:guestId` | 👤 | → `GuestProfileDto` |
| PATCH | `/admin/guests/:guestId` | 👤 | `UpdateGuestInput` → `GuestProfileDto` |
| POST | `/admin/guests/:guestId/tags` | 👤 | `TagInput` → `GuestProfileDto` |
| DELETE | `/admin/guests/:guestId/tags/:tagName` | 👤 | → `GuestProfileDto` |
| GET | `/admin/guests/:guestId/ledger` | 👤 | → `LedgerEntryDto[]` |
| POST | `/admin/guests/:guestId/wallet/preload` | 🛡 | `WalletPreloadInput` → `GuestProfileDto` |
| GET | `/wifi/:slug` | 🔓 | → `{venue:{name,slug,imageUrl}}` |
| POST | `/wifi/:slug/otp` | 🔓 (rate-limited) | `WifiOtpInput` → `{sent:true, devCode}` (mock OTP) |
| POST | `/wifi/:slug/connect` | 🔓 | `WifiConnectInput` → `WifiConnectResponse` |
| POST | `/webhooks/pos` | HMAC `x-nexora-signature` | `PosWebhookBody` → `{status:'processed'|'duplicate'|'queued'}` |
| POST | `/admin/venues/:venueId/pos/simulate` | 👤 | `PosSimulateInput` → `{status, webhookEventId}` |
| GET | `/admin/venues/:venueId/webhooks` | 👤 | → `WebhookEventDto[]` |
| POST | `/admin/webhooks/:id/replay` | 🛡 | → `WebhookEventDto` |
| POST | `/admin/orders/:orderId/settle` | 👤 | `SettleOrderInput` → `SettleResult` (split tender, 2-phase) |
| POST | `/admin/gift-cards` | 🛡 | `IssueGiftCardInput` → `GiftCardDto` (with `cardNumber` once) |
| GET | `/admin/gift-cards` | 👤 | → `GiftCardDto[]` |
| POST | `/admin/gift-cards/:id/reload` | 🛡 | `{amountPaise}` → `GiftCardDto` |
| POST | `/gift-cards/authorize` | 👤 | `GiftCardAuthorizeInput` → `GiftCardAuthorizeResponse` (120 s hold) |

## 6. Realtime (`packages/shared/src/realtime.ts`)

- Staff: `socket.emit('venue:join', venueId, ack)`. The JWT cookie is verified. Rooms are named `venue:<id>`.
- Consumer: `socket.emit('booking:join', token)`. Rooms are named `booking:<token>`.
- Server → client: `server:time` (every 10 s), `floor:changed`, `reservation:changed`, `order:changed`, `alert:new`, `notification:sent`, `booking:status`.
- Clients treat these as **invalidation signals**: they refetch the snapshot. Consoles also poll every 15 s as a fallback.

## 7. Background workers

| Job | Interval | Owner | Behaviour |
|---|---|---|---|
| `triage-escalation` | 15 s | booking | REQUESTED older than `triage_timeout_secs`: auto-confirm (Good Standing and the table is still free), otherwise set `escalated_at` + `TRIAGE_ESCALATION` alert |
| `grace-no-show` | 30 s | booking | CONFIRMED with `start + grace ≤ now`: NO_SHOW, `no_show_count++`, `NO_SHOW` alert |
| `notification-outbox` | 2 s | booking | PENDING → log `[MOCK SMS] to … : …` → SENT, emit `notification.sent` |
| `dwell-monitor` | 30 s | floor | Seated tables at ≥ turnaround: `DWELL_AMBER` alert; at ≥ turnaround + 15: `DWELL_RED` alert, then auto-migrate the next booking or send a "complimentary beverage" SMS |
| `webhook-retry` | 1 s | pos | FAILED webhooks whose `next_attempt_at ≤ now`: retry on backoff 1 s/5 s/30 s/5 m/1 h, then DEAD + `WEBHOOK_DEAD` alert |
| `hold-expiry` | 10 s | loyalty | Release gift-card and loyalty holds past `expires_at` |

## 8. CRM auto-tag rules

| Tag | Rule | Trigger |
|---|---|---|
| `WINE_CONNOISSEUR` | a billed order has a WINE line priced ≥ ₹5,000 | `order.billed` |
| `TOP_SPENDER` | lifetime spend ≥ ₹1,00,000, or one bill ≥ ₹15,000 | `order.billed` |
| `REGULAR` | total visits ≥ 5 | reservation COMPLETED |
| `VIP` | tier REGULAR or FRIENDS_AND_FAMILY | tier change |
| `SLOW_PACING` | ≥ 2 completed visits where seated duration > turnaround + 15 | reservation COMPLETED |
| `LATE_CANCELLER` | ≥ 2 cancellations within 2 h of start | reservation CANCELLED |
| `FREQUENT_COMPLAINTS` | voids count ≥ 3 | `order.adjusted` |

Auto tags have `is_auto_generated = true`. Staff tags are never removed automatically.

## 9. Security

- Staff passwords use scrypt. Sessions are HS256 JWTs in an `httpOnly, SameSite=Lax` cookie (Secure in production), valid for 12 h.
- Every admin route checks `assertVenueAccess(staff, venueId)` against the entity's venue.
- Rate limits cover login, public booking and the Wi-Fi OTP.
- POS webhooks use HMAC-SHA256 over the raw body (`x-nexora-signature: sha256=<hex>`, secret `POS_WEBHOOK_SECRET`).
- Gift card numbers are stored only as a salted SHA-256 plus the last 4 digits.
- Consumer booking tokens are 128-bit random. Cancelling needs the phone's last 4 digits.

## 10. Conventions for contributors

1. **Transactions:** use `withTx(async (tx) => …)`. Lock with `lockTable` / `lockReservation` / `lockOrder`. Never use REPEATABLE READ for booking.
2. **State changes** go through `transitionReservation`, `setTableStatus` and `transitionOrder`. These validate the FSM, stamp timestamps, write the audit trail and emit events.
3. **Time:** use `clock.now()`, never `new Date()` or SQL `now()` in business logic.
4. **Errors:** throw `AppError` helpers (`conflict`, `notFound`, …). Zod errors become 400 automatically.
5. **Cross-module effects** go through bus events (`on('order.billed', …)` in the module's `init`), not direct imports between modules. The shared `core/` helpers can be imported by anyone.
6. **Money** is always integer paise. **Tests:** see `apps/api/test/helpers.ts`, where the clock is frozen at Fri 2026-10-02 18:00 IST.
