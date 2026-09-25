# Walkthrough — Frontend Portals, Admin Console & Backend Test Completion

All requested modules and routes across Sprint B1 (Consumer Portal), Sprint B2 (Admin Console Shell, Interactive Floor Plan, Triage Queue, Reservations, Guests CRM, Settings, Activity, and Payments), and Sprint A4 (Backend Test Suites for Guest Intelligence & Commerce) have been implemented, tested, and verified.

---

## 1. Summary of Completed Sprints & Deliverables

### Sprint B1: Consumer Portal
- **`apps/web/app/(consumer)/booking/[token]/page.tsx` & `tracker-client.tsx`**:
  - Live status progression timeline (`Requested` → `Confirmed` → `Seated` → `Completed`, with `Cancelled`/`Declined` branches).
  - Real-time updates via Socket.IO (`booking:join` & `booking:status`) + 10s polling fallback.
  - Table assignment reveal once confirmed.
  - Cancellation dialog with phone last-4 validation (`CancelBookingInput`) and 403 `PHONE_MISMATCH` protection.
  - "Pick another time" CTA linking back to `/r/[slug]`.
- **`apps/web/app/wifi/[slug]/page.tsx` & `wifi-client.tsx`**:
  - Captive Wi-Fi onboarding with venue branding from `GET /api/v1/wifi/:slug`.
  - Step 1: Guest information form, mandatory terms consent, and marketing opt-in.
  - Step 2: 6-digit OTP verification with countdown timer and developer test banner displaying `devCode`.
  - Step 3: Connected screen displaying network performance, loyalty tier badge, and recognized reservation card with table assignment.

### Sprint B2: Admin Console
- **`apps/web/proxy.ts`**:
  - Next.js 16 canonical Proxy (Middleware) protecting `/admin/*` routes with optimistic session verification.
- **`apps/web/app/admin/login/page.tsx`**:
  - Login page with centered Nexora logo, email/password validation, and quick demo login presets (`Manager`, `Host`, `Org Admin`).
- **`apps/web/app/admin/[venueId]/layout.tsx` & `console-shell.tsx`**:
  - Server validation of staff session (`/auth/me`) and venue access (`/admin/venues/:venueId`).
  - Left navigation sidebar with venue switcher dropdown.
  - Top header with realtime connection indicator (Live / Connecting / Offline), live unacknowledged alerts bell with drawer and acknowledge action, user profile badge, and logout.
- **`apps/web/app/admin/[venueId]/floor/page.tsx` & `components/admin/floor/*`**:
  - Interactive floor plan dashboard subscribed to realtime floor/order/reservation events.
  - Summary KPIs: seated covers / capacity, status breakdown counts.
  - Zone grouping (`MAIN`, `PATIO`, `BAR`, `MEZZANINE`, `PRIVATE`).
  - Table tiles with live server-offset dwell clock (`useServerNow()`, amber at 30m, red pulsing at 45m with `prefers-reduced-motion` support).
  - Walk-in dialog with real-time collision detection against upcoming reservations (`/walk-ins/check`) and alternative table suggestions.
  - Table status dialog for blocking, unblocking, and marking clean.
- **`apps/web/components/admin/order-drawer.tsx`**:
  - Slide-out sheet for table checks with KDS status progression (`PLACED` → `RECEIVED` → `PREPARING` → `SERVED`).
  - Add/delete items, folio breakdown (Gross, Discount, Net, Paid).
  - Split-tender settlement supporting `CASH`, `CARD`, `GIFT_CARD`, `POINTS`, and `WALLET` with simulator toggles.
- **`apps/web/app/admin/[venueId]/triage/page.tsx`**:
  - Oldest-first triage queue with live countdown timers and auto-escalation alert banner.
  - Instant Approve and Decline with reason dialog.
- **`apps/web/app/admin/[venueId]/reservations/page.tsx`**:
  - Date and status filters (`ALL`, `REQUESTED`, `CONFIRMED`, `SEATED`, `COMPLETED`, `CANCELLED`, `NO_SHOW`).
  - Search filter by guest name, phone, or token.
  - Status actions: Seat, No-show, Cancel, and Reassign Table modal.
  - Host phone booking modal.
- **`apps/web/app/admin/[venueId]/guests/page.tsx` & `[guestId]/page.tsx`**:
  - Guest directory with live search.
  - Full CRM profile: Loyalty status, visit metrics, void metrics, preferences editor, tag management, Wi-Fi device history, dish affinities, wallet preloading modal, and loyalty ledger.
- **`apps/web/app/admin/[venueId]/settings/page.tsx`**:
  - Venue profile configuration and emergency blackout toggle.
  - Weekly operating shifts manager with 15-minute slot boundary validation and overlap prevention.
  - Dining tables CRUD with upcoming reservation safety checks.
- **`apps/web/app/admin/[venueId]/activity/page.tsx`**:
  - Notifications log (mock SMS / WhatsApp).
  - POS Webhooks Dead Letter Queue (DLQ) with manager replay action.
  - Interactive POS webhook simulator for `ticket.updated`, `order.item_voided`, `order.comp_applied`, `order.refunded`.
  - Audit log table.
- **`apps/web/app/admin/[venueId]/payments/page.tsx`**:
  - Gift cards hub: list active cards with balance and last-4.
  - Issue gift card modal with 16-digit card number graphic and copy action.
  - Reload gift card modal.

### Sprint A4: Backend Test Suites
- `apps/api/test/guests.test.ts`: 18 tests passing.
- `apps/api/test/wifi.test.ts`: 12 tests passing.
- `apps/api/test/pos.test.ts`: 12 tests passing.
- `apps/api/test/loyalty.test.ts`: 9 tests passing.

---

## 2. Verification Results

1. **Frontend TypeScript Check**:
   - `npm --prefix apps/web run typecheck`: **Exit code 0, 0 errors**.
2. **Next.js Production Build**:
   - `npm --prefix apps/web run build -- --webpack`: **Exit code 0, all 14 routes compiled**.
3. **Backend TypeScript Check**:
   - `npx tsc -p apps/api/tsconfig.json --noEmit`: **Exit code 0, 0 errors**.
4. **Backend Vitest Suite**:
   - `npm --prefix apps/api test`: **All 9 test files passed, 151 passed (151)**.
