# Frontend & Platform Completion Plan (Sprints B1, B2, A4, C)

Implement all missing frontend portals and routes, complete the backend test suite for guest intelligence and commerce, and sync documentation and commits to remote.

## User Review Required

> [!IMPORTANT]
> **Key Architectural Decisions & Grill-Me Design Alignment:**
> 1. **Vercel / Geist Light Design System**: Strict adherence to Nexora tokens in `globals.css` (neutral grayscale `gray-100`..`gray-1000`, 1px hairline borders `border-border`, subtle shadows, tabular figures `tabular-nums` for timestamps and INR currency, and status accents).
> 2. **Realtime Socket + Resilient Polling Fallback**: Consumer tracker connects to `booking:join` with a 10s polling interval fallback; Admin console connects to `venue:join` with server-offset clock synchronization (`useServerNow()`) and 15s polling fallback.
> 3. **Next.js Middleware Gate**: Re-export `proxy` as `middleware.ts` in `apps/web/` to optimistically protect `/admin/:path*` while keeping authoritative server check in `/admin/[venueId]/layout.tsx`.
> 4. **Parallel Agent Execution**: Work will be partitioned across specialized subagents with isolated file boundaries to complete execution rapidly.

---

## Open Questions

> [!NOTE]
> 1. **Admin Mock Mode vs Live DB**: When running without local PostgreSQL running during frontend development, should the Admin console gracefully present informative empty/connect states or fallback mock seeds if backend returns 500/offline? *(Recommended: The console already displays an offline toast with automatic polling retry. We will ensure pages render resilient empty/loading states when the API is unreachable).*
> 2. **Sprint C Scope**: In addition to frontend routes, do you want Playwright E2E tests fully configured and passing against a running local test database, or prioritize complete frontend unit/component type-checking and build verification first? *(Recommended: Complete full frontend implementation, verify `next build` and `tsc --noEmit`, add the A4 vitest suites, and provide Playwright test scripts).*

---

## Proposed Changes

### Component 1: Consumer Portal (Sprint B1)

#### [NEW] [booking/[token]/page.tsx](file:///Users/yudhistherkumar/Downloads/Nexora-booking/apps/web/app/(consumer)/booking/[token]/page.tsx)
- Live reservation tracker page.
- Status progression timeline: `Requested` → `Confirmed` → `Seated` → `Completed`, with distinct visual branches for `Cancelled` and `Declined`.
- Real-time Socket.IO subscription via `booking:join` with fallback 10-second polling to `GET /reservations/:token`.
- Table assignment reveal: automatically displays the assigned table number once status changes to `CONFIRMED`.
- Interactive Cancel Dialog: requires the last 4 digits of the guest phone number (`POST /reservations/:token/cancel`), with inline validation and 403 `PHONE_MISMATCH` handling.
- "Pick another time" CTA when cancelled or declined, redirecting back to `/r/[slug]`.

#### [NEW] [wifi/[slug]/page.tsx](file:///Users/yudhistherkumar/Downloads/Nexora-booking/apps/web/app/wifi/[slug]/page.tsx)
- Captive Wi-Fi registration & authentication portal.
- Venue branding fetch from `GET /wifi/:slug`.
- Step 1: Guest details (First Name, Last Name, Phone, optional Email), mandatory consent checkbox, marketing opt-in checkbox.
- Step 2: 6-digit OTP verification with countdown timer and developer test banner displaying `devCode` returned by `POST /wifi/:slug/otp`.
- Connect submission: calls `POST /wifi/:slug/connect` with MAC address (read from query param or auto-generated mock hardware address).
- Success Screen: displays connected badge, guest loyalty tier badge, and any matched same-day reservation details.

---

### Component 2: Admin Console Core Shell & Floor Management (Sprint B2 - Group 1)

#### [NEW] [middleware.ts](file:///Users/yudhistherkumar/Downloads/Nexora-booking/apps/web/middleware.ts)
- Connect Next.js middleware pipeline to `proxy.ts` to redirect unauthorized users to `/admin/login`.

#### [NEW] [admin/login/page.tsx](file:///Users/yudhistherkumar/Downloads/Nexora-booking/apps/web/app/admin/login/page.tsx)
- Login card with email/password inputs, validation, and submission to `POST /auth/login`.
- One-click demo login presets (Manager, Host, Org Admin) for seamless evaluation.
- Redirection to `next` URL query parameter or `/admin/[firstVenueId]/floor`.

#### [NEW] [admin/[venueId]/layout.tsx](file:///Users/yudhistherkumar/Downloads/Nexora-booking/apps/web/app/admin/[venueId]/layout.tsx)
- Console shell wrapping child pages with `<ConsoleProvider>`.
- Sidebar navigation: Floor, Triage, Reservations, Guests, Payments, Settings, Activity.
- Venue switcher dropdown for multi-venue/org staff.
- Top status bar: Live connection pill (green/amber/red), alerts bell with live count badge and slide-out alerts panel, current user badge, and logout action.

#### [NEW] [admin/[venueId]/floor/page.tsx](file:///Users/yudhistherkumar/Downloads/Nexora-booking/apps/web/app/admin/[venueId]/floor/page.tsx)
- Interactive floor plan dashboard consuming `GET /admin/venues/:venueId/floor`.
- Floor KPI summary: Seated covers / capacity, breakdown counts for Available, Reserved, Occupied, Bussing, Blocked.
- Zone grouping: `MAIN`, `PATIO`, `BAR`, `MEZZANINE`, `PRIVATE`.
- Realtime updates subscribed to `floor:changed`, `order:changed`, `reservation:changed`.

#### [NEW] [components/admin/floor/table-tile.tsx](file:///Users/yudhistherkumar/Downloads/Nexora-booking/apps/web/components/admin/floor/table-tile.tsx)
- Table card displaying table number, capacity, and status-colored styling.
- Live dwell timer driven by synchronized server clock (`useServerNow()`), with amber warning at 30 min and flashing red alert at 45 min (`prefers-reduced-motion` compliant).
- Contextual menu: Seat walk-in, seat reservation, open order drawer, mark clean, block/unblock.

#### [NEW] [components/admin/floor/walk-in-dialog.tsx](file:///Users/yudhistherkumar/Downloads/Nexora-booking/apps/web/components/admin/floor/walk-in-dialog.tsx)
- Walk-in seating modal with live collision checking via `POST /admin/venues/:venueId/walk-ins/check`.
- Shows collision warning when upcoming reservations overlap, with override toggle or suggestions for alternative free tables.
- Submits to `POST /admin/venues/:venueId/walk-ins`.

#### [NEW] [components/admin/floor/table-status-dialog.tsx](file:///Users/yudhistherkumar/Downloads/Nexora-booking/apps/web/components/admin/floor/table-status-dialog.tsx)
- Block, unblock, or mark clean (`BUSSING` → `AVAILABLE`) with optional reason.

#### [NEW] [components/admin/order-drawer.tsx](file:///Users/yudhistherkumar/Downloads/Nexora-booking/apps/web/components/admin/order-drawer.tsx)
- Slide-out sheet for active table orders (`GET /admin/orders/:orderId`).
- Itemized check with unit prices, quantities, notes, line totals, and void status.
- KDS status lifecycle: `PLACED` → `RECEIVED` → `PREPARING` → `SERVED`.
- Add menu item / custom item dialog.
- Split-tender settlement dialog supporting Cash, Card, Gift Card, Points, and Wallet, with simulator decline/timeout toggles (`POST /admin/orders/:orderId/settle`).

---

### Component 3: Admin Console Triage, Reservations, CRM & Settings (Sprint B2 - Group 2)

#### [NEW] [admin/[venueId]/triage/page.tsx](file:///Users/yudhistherkumar/Downloads/Nexora-booking/apps/web/app/admin/[venueId]/triage/page.tsx)
- Queue of `REQUESTED` bookings sorted oldest first (`GET /admin/venues/:venueId/triage`).
- Cards displaying guest loyalty tier, auto-tags, allergies (in high-visibility warning style), notes, party size, and requested slot.
- Live countdown to the triage auto-escalation deadline.
- Instant "Approve" (auto-assigns table, enqueues SMS confirmation) and "Decline" with reason dialog.

#### [NEW] [admin/[venueId]/reservations/page.tsx](file:///Users/yudhistherkumar/Downloads/Nexora-booking/apps/web/app/admin/[venueId]/reservations/page.tsx)
- Date picker and status filter tabs (`ALL`, `REQUESTED`, `CONFIRMED`, `SEATED`, `COMPLETED`, `CANCELLED`, `NO_SHOW`).
- Search by guest name, phone, or token.
- Action triggers: Seat, Mark No-show, Cancel, and Reassign Table modal.
- "New Host Booking" modal (`POST /admin/venues/:venueId/reservations`) supporting manual table selection and phone-in reservation flow.

#### [NEW] [admin/[venueId]/guests/page.tsx](file:///Users/yudhistherkumar/Downloads/Nexora-booking/apps/web/app/admin/[venueId]/guests/page.tsx)
- Searchable guest directory (`GET /admin/guests?q=...`).
- Summary cards showing tier, visit counts, lifetime spend in ₹, and last visit date.

#### [NEW] [admin/[venueId]/guests/[guestId]/page.tsx](file:///Users/yudhistherkumar/Downloads/Nexora-booking/apps/web/app/admin/[venueId]/guests/[guestId]/page.tsx)
- Full CRM Profile view: guest details, loyalty tier, spend multiplier, points balance, wallet balance.
- Inline preferences editor: seating preference, dietary restrictions, allergies (`PATCH /admin/guests/:guestId`).
- Tag manager: view auto vs. manual tags, add tag, delete tag.
- Connected Wi-Fi devices list (MAC addresses with first/last seen).
- Item affinities (favorite dishes).
- Wallet Preload action modal (`POST /admin/guests/:guestId/wallet/preload`).
- Loyalty transaction ledger table (`GET /admin/guests/:guestId/loyalty/ledger`).
- Reservation history list.

#### [NEW] [admin/[venueId]/settings/page.tsx](file:///Users/yudhistherkumar/Downloads/Nexora-booking/apps/web/app/admin/[venueId]/settings/page.tsx)
- Venue configuration form (manager-only): name, description, turnaround minutes (validated multiples of 15), grace period, triage timeout, upsize fallback toggle.
- Blackout toggle with reason input.
- Weekly Operating Shifts Manager: visual schedule editor across Monday–Sunday with 15-minute slot boundary validation and overlap prevention (`PUT /admin/venues/:venueId/shifts`).
- Dining Tables CRUD: create table, edit capacities/zones, soft-delete with validation against active bookings.

#### [NEW] [admin/[venueId]/activity/page.tsx](file:///Users/yudhistherkumar/Downloads/Nexora-booking/apps/web/app/admin/[venueId]/activity/page.tsx)
- Notifications log displaying mock SMS and WhatsApp transmissions.
- POS Webhook Dead Letter Queue (DLQ) with attempt counts, errors, and manager "Replay" action.
- Interactive POS Webhook Simulator: test `ticket.updated`, `order.item_voided`, `order.comp_applied`, `order.refunded`, with duplicate idempotency testing and configurable failure counts (`failTimes`).
- Audit log viewing the latest 100 system operations.

#### [NEW] [admin/[venueId]/payments/page.tsx](file:///Users/yudhistherkumar/Downloads/Nexora-booking/apps/web/app/admin/[venueId]/payments/page.tsx)
- Gift Cards hub: list active cards with balance and last-4.
- Issue gift card modal: generates 16-digit card number with copy button.
- Reload gift card action.

---

### Component 4: Backend Tests (Sprint A4) & Quality Verification (Sprint C)

#### [NEW] [apps/api/test/guests.test.ts](file:///Users/yudhistherkumar/Downloads/Nexora-booking/apps/api/test/guests.test.ts)
- Test guest profile lookup, preferences patch, tag addition/deletion, auto-tag evaluation on billing/completion, and wallet preloading.

#### [NEW] [apps/api/test/wifi.test.ts](file:///Users/yudhistherkumar/Downloads/Nexora-booking/apps/api/test/wifi.test.ts)
- Test Wi-Fi venue fetch, OTP generation & TTL expiration, brute force attempt limit, connect flow with device MAC association, and guest arrival alert generation.

#### [NEW] [apps/api/test/pos.test.ts](file:///Users/yudhistherkumar/Downloads/Nexora-booking/apps/api/test/pos.test.ts)
- Test HMAC webhook verification, idempotency duplicate detection, item addition, item voiding, comp application, post-settlement refunds, and DLQ replay.

#### [NEW] [apps/api/test/loyalty.test.ts](file:///Users/yudhistherkumar/Downloads/Nexora-booking/apps/api/test/loyalty.test.ts)
- Test spend accrual, points calculation with tier multiplier, clawback on post-settlement refund, negative balance deficit flag, and split tender settlement.

---

## Verification Plan

### Automated Verification
1. **Frontend Type Checking**:
   `npm --prefix apps/web run typecheck`
   Ensure strict TypeScript passing with 0 errors across all newly created routes and components.
2. **Next.js Production Build**:
   `npm --prefix apps/web run build`
   Ensure all consumer and admin pages compile cleanly into production bundles with Turbopack.
3. **Backend Unit/Module Verification**:
   Verify backend modules and test suites with `npm --prefix apps/api test` where database environment is configured.
4. **Git Remote Sync**:
   `git push origin feat/frontend-admin-consumer-completion`
   Push all implemented code, new routes, components, and documentation to the remote repository.
