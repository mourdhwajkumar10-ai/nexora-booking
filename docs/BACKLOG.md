# Nexora — Product Backlog (Scrum)

Work is split into **epics → stories** with acceptance criteria (AC). Each sprint maps to one parallel agent working in its own module folder. Requirement IDs are listed in [REQUIREMENTS.md](REQUIREMENTS.md).

| Sprint | Team / agent | Owns | Status |
|---|---|---|---|
| 0 | Lead | Monorepo, shared contract, schema, seed, core domain layer, auth, realtime, design tokens, docs | ✅ Done |
| A1 | Backend: Venue & Inventory | `apps/api/src/modules/venues/**`, `apps/api/test/venues*.test.ts` | ✅ Done |
| A2 | Backend: Booking Engine | `apps/api/src/modules/booking/**`, `apps/api/test/booking*.test.ts` | ✅ Done |
| A3 | Backend: Floor & Orders | `apps/api/src/modules/floor/**`, `apps/api/test/floor*.test.ts` | ✅ Done |
| A4 | Backend: Guest Intelligence & Commerce | `apps/api/src/modules/{guests,wifi,pos,loyalty}/**`, `apps/api/test/{guests,wifi,pos,loyalty}*.test.ts` | ✅ Done |
| B1 | Frontend: Consumer portal | `apps/web/app/(consumer)/**`, `apps/web/app/wifi/**`, `apps/web/components/consumer/**` | ✅ Done |
| B2 | Frontend: Admin console | `apps/web/app/admin/**`, `apps/web/components/admin/**` | ✅ Done |
| C | Lead + QA | Integration, e2e (Playwright), load test, review, README, GitHub | ⏳ |

---

## Epic E1: Venue administration (A1)

- **E1-S1 Locality and directory API** (BKG-01..04). AC: `GET /localities` is sorted by `sort_order`. `GET /venues?locality=slug` returns only `is_active` venues in that locality, sorted by rating. Each `VenueCard` includes `isOpenNow` (computed from shifts in the venue timezone using `clock.now()`), `acceptingBookings = !blackout`, and `todayHours`. An unknown locality returns `[]`.
- **E1-S2 Venue detail** (BKG-05). AC: `GET /venues/:slug` returns `VenueDetail` with shifts. Inactive venues return 404.
- **E1-S3 Venue settings** (ADM-10, ADM-11). AC: GET returns `VenueSettings`. PATCH is manager-only, validates input with `UpdateVenueInput` (turnaround must be a multiple of 15) and writes an audit log. A host gets 403, and staff from another venue get 403.
- **E1-S4 Blackout toggle** (ADM-04). AC: any staff member can toggle it, with an audit log. While in blackout, the directory shows `acceptingBookings=false`. Existing reservations are untouched.
- **E1-S5 Shifts** (ADM-01..03). AC: PUT replaces all shifts atomically. Overlapping shifts on the same day are rejected (400 `SHIFT_OVERLAP`). Times must be on 15-min boundaries.
- **E1-S6 Tables CRUD with guards** (ADM-05..09). AC: create validates max ≥ min, and duplicate table numbers get 409. PATCH that lowers `max_capacity` below the `party_size` of any active/future reservation, or raises `min_capacity` above it, gets 409 `TABLE_HAS_BOOKINGS`. DELETE with active/future reservations gets 409, otherwise it soft-deletes (`archived_at`). Every change writes an audit row and emits `table.changed`. `DiningTableDto.upcomingReservations` counts active reservations with `end_at > now`.
- **E1-S7 Menu and audit listing**. AC: menu list and create. Audit list shows the latest 100 entries (manager only).

## Epic E2: Booking engine (A2)

- **E2-S1 Availability** (BKG-05/06/11, CON-05/06, NFR-01). AC: returns every generated slot for the date with `available` and `tablesLeft`, where `tablesLeft` counts fitting, non-blocked tables with no overlapping active reservation. Slots before `now` are flagged `past` and unavailable. A closed day returns `closed:true`. Blackout returns every slot unavailable with `blackout:true`. Everything is computed with one reservations query per request, and p95 ≤ 200 ms at 50 concurrent requests.
- **E2-S2 Create booking with locking** (BKG-07/08/12, CON-01..04/07). AC: validates the slot (422 with `OUTSIDE_HOURS`/`OFF_GRID`, 400 `IN_PAST`), rejects blackout (422 `VENUE_BLACKOUT`), and returns 422 `NO_TABLE_FOR_PARTY` when no table fits the party. It resolves or creates the guest with `upsertGuest`. More than 2 active REQUESTED bookings for a phone returns 422 `TOO_MANY_REQUESTS_FOR_PHONE`. For each best-fit candidate it runs `SELECT … FOR UPDATE`, checks overlap and inserts REQUESTED, in its own READ COMMITTED transaction. Exhausting all candidates returns 409 `SLOT_UNAVAILABLE` with `details.alternatives` (the nearest available slot times within ±60 min). **Test:** 50 concurrent requests for the last table → exactly one 201 and no overlaps in the DB. A 2-top is preferred for a party of 2.
- **E2-S3 Public tracker and cancel** (BKG-09/10/13). AC: `GET /reservations/:token` reveals the table number only once confirmed. Cancel requires a matching phone last-4 (403 `PHONE_MISMATCH`) and is allowed from REQUESTED/CONFIRMED only. The guest notification goes out via the outbox.
- **E2-S4 Triage queue and approve/reject** (RES-01..03, NTF-01). AC: triage lists REQUESTED bookings oldest first. Approve sets CONFIRMED and enqueues SMS `Reservation Confirmed: Table for {n} at {venue} on {date} at {time}`. Reject sets CANCELLED and enqueues a declined SMS.
- **E2-S5 Host phone-in booking** (RES-04). AC: same engine as the public flow, with an optional explicit `tableId` (still locked and overlap-checked). Auto-confirms by default. Source is PHONE.
- **E2-S6 Seat / no-show / cancel / complete / reassign** (RES-05..08/10, C-18). AC: seat requires CONFIRMED and a physically AVAILABLE table (409 `TABLE_NOT_READY`). It sets the table OCCUPIED (`setTableStatus`), opens the order (`openOrder`) and updates `guest_profiles.last_visit_at`. Complete requires SEATED and the open order BILLED or with no items (409 `CHECK_OPEN`). It sets COMPLETED, moves the table OCCUPIED→BUSSING and updates visits and average party size. Reassign locks the new table, checks overlap and fit, and is allowed for REQUESTED/CONFIRMED.
- **E2-S7 Workers** (RES-06/09, C-08/09). AC: `triage-escalation`, `grace-no-show` and `notification-outbox` are registered via `registerJob` in `init`. Tests drive them with `clock.advanceMinutes` + `runJob`. Auto-confirm happens only when the guest is in Good Standing. Otherwise `escalated_at` is set and a `TRIAGE_ESCALATION` alert (critical) is raised. The no-show job increments `no_show_count`. The outbox job logs `[MOCK SMS]`/`[MOCK WHATSAPP]` lines and emits `notification.sent`.
- **E2-S8 Admin list and notifications log**. AC: filter by date and comma-separated statuses.

## Epic E3: Floor and orders (A3)

- **E3-S1 Floor snapshot** (FLR-01..04, ORD-04/06). AC: one query-efficient snapshot with the derived `floorStatus` (RESERVED rule in ARCHITECTURE §3), the current seated reservation plus guest tags and allergies, the open order summary, the next upcoming active reservation, dwell `{seatedAt, elapsedSecs, level}`, counts per status, covers, and `serverTime`.
- **E3-S2 Walk-in check and seating** (FLR-05, C-17). AC: the check returns conflicts using the walk-in window (turnaround + 15) and a message in the form `Collision Alert: Table T-4 reserved for {name} at {h:mm AM/PM}. Dwell time exceeds arrival threshold.`, plus best-fit suggestions for tables that are currently AVAILABLE and have no conflict. Seating inserts a SEATED/WALK_IN reservation (guest resolved by phone, or an anonymous "Walk-in" guest when there is no phone), sets the table OCCUPIED and opens the check. A collision without `override` returns 409 `WALK_IN_COLLISION`.
- **E3-S3 Table status actions** (FLR-03). AC: block, unblock, mark clean (BUSSING→AVAILABLE) using `setTableStatus`, with an audit row. You can't block an OCCUPIED table (409), and FSM violations return 409.
- **E3-S4 Order items and KDS progression** (ORD-01..03/07). AC: add item (from the menu or custom) recalculates totals. Delete is only allowed while PLACED. Status moves PLACED→RECEIVED→PREPARING→SERVED through `transitionOrder`, stamping timestamps. You can't add items to a BILLED/VOIDED order.
- **E3-S5 Dwell monitor** (ORD-05/08). AC: a job raises `DWELL_AMBER` / `DWELL_RED` alerts once per seating (dedupe key). At red, if the table's next booking starts within 15 min: auto-migrate it to a free best-fit table (`AUTO_MIGRATED` alert, reservation `table_id` updated inside a transaction with a lock), or when none is free, enqueue the "complimentary beverage" SMS.

## Epic E4: Guest intelligence and commerce (A4)

- **E4-S1 Guest CRM** (CRM-01..06). AC: search by name, phone or email. The profile has aggregates, tags (auto vs manual), devices, item affinities (top items from billed orders), loyalty and reservations. PATCH covers preferences and allergies. Tags can be added and removed.
- **E4-S2 Auto-tagging** (CRM-02, §8). AC: bus handlers on `order.billed`, `reservation.changed` (COMPLETED/CANCELLED) and `order.adjusted` apply the rules. Each rule has a unit test.
- **E4-S3 Captive Wi-Fi** (WIFI-01..06). AC: OTP is a 6-digit code, stored hashed, expires in 5 min, allows max 5 attempts, and is returned as `devCode` (mock SMS logged). Connect verifies the OTP, runs `upsertGuest`, upserts `guest_devices` (MAC) and inserts `wifi_sessions`. If today's CONFIRMED/REQUESTED reservation at the venue matches the guest, or the guest's tier ≥ REGULAR, it raises a `GUEST_ARRIVED` alert `Guest Connected: {name}, Tier: {label}, Table: {T}, Prefers {pref}` and emits `guest.arrived`.
- **E4-S4 POS webhooks** (POS-01..05, C-19). AC: HMAC verification on the raw body (401 on a bad signature). Idempotency key is `pos_{eventId}` or the `Idempotency-Key` header, and duplicates return `{status:'duplicate'}` without reprocessing. `ticket.updated` adds items. `order.item_voided` marks the item voided and writes a `pos_void_logs` VOID row. `order.comp_applied` writes a COMP row. `order.refunded` on a BILLED order writes a REFUND row with `post_settlement`. All of these recalculate totals, update the guest's void metrics and emit `order.adjusted`. Failures go to FAILED with `next_attempt_at` on the backoff schedule, and after 5 attempts become DEAD with a `WEBHOOK_DEAD` alert. The simulator endpoint signs and posts through the same pipeline and supports `failTimes`.
- **E4-S5 Loyalty accrual and clawback** (LOY-01..04, POS-03). AC: on `order.billed` with a guest, credit `pointsForSpend(net - redeemed-points value)`. If the balance is negative, the accrual repays the deficit first and the flag clears when the balance is ≥ 0. Update annual spend and the tier (`computeTier`). On a post-settlement `order.adjusted`, claw back `clawbackPoints`. If the balance goes below 0, add the `UNRESOLVED_LOYALTY_DEFICIT` flag and a `LOYALTY_DEFICIT` alert. Wallet preload writes a PRELOAD ledger row, updates `largest_preload_paise` and can upgrade the tier immediately.
- **E4-S6 Gift cards**. AC: issue returns a 16-digit number once and stores hash and last4. Authorize creates a 120 s hold (409 `INSUFFICIENT_FUNDS`, 404 unknown card). Reload is supported. The `hold-expiry` job releases expired holds.
- **E4-S7 Split-tender settlement** (LOY-06, ORD-07). AC: the order must be SERVED or PARTIALLY_PAID, and the tenders must add up to exactly the outstanding net amount (400 `TENDER_MISMATCH`). Phase 1 authorizes holds for gift card, points and wallet (a gift card `simulateTimeout` fails here). Phase 2 runs card/cash (`simulateDecline` fails the card), then captures all holds atomically, writing the gift card ledger REDEEM and loyalty REDEMPTION rows. The order becomes BILLED and `order.billed` is emitted. On any failure, all holds are released, the order becomes PARTIALLY_PAID with the outcome `PARTIALLY_PAID`, and the message is `Tender Failed: Gift Card Unreachable. Folio Remaining: ₹X`.

## Epic E5: Consumer portal (B1)

- **E5-S1 Header and locality selector** (BKG-01/02). AC: sticky header with the Nexora logo and a locality dropdown. The selection persists in a cookie and is available server-side on first render.
- **E5-S2 Discovery grid** (BKG-03/04). AC: responsive cards (1/2/3 columns) with image, name, cuisines, a rating chip, cost for one/two in ₹, and open/closed or "Not taking bookings" status. Skeletons while loading, and an empty state.
- **E5-S3 Venue page and slot picker** (BKG-05/11). AC: venue hero plus info. Date chips for the next 14 days, a party size segmented control (1–4), and a slot grid grouped by shift (lunch/dinner) that disables unavailable or past slots. Shows "Last seating {close − turnaround}". Blackout and closed-day states are handled.
- **E5-S4 Booking form** (BKG-07/08/12). AC: name, phone, optional email, dietary notes and seating preference, with inline validation. On 409 it shows the alternatives as clickable chips. On success it goes to the tracker.
- **E5-S5 Live tracker** (BKG-09/10/13). AC: status timeline (Requested → Confirmed), live updates via socket `booking:join` plus 10 s polling fallback, a confirmation state that shows the table, and a cancel dialog asking for the phone's last 4 digits. The cancelled/declined state offers "Pick another time".
- **E5-S6 Captive Wi-Fi portal page** (WIFI-01/03/06). AC: `/wifi/[slug]?mac=..&ap=..` shows a branded form with an OTP step (the dev code is shown), consent and marketing checkboxes, and a success screen.

## Epic E6: Admin console (B2)

- **E6-S1 Login and shell**. AC: `/admin/login`. Sidebar nav (Floor, Triage, Reservations, Guests, POS & Payments, Settings, Activity), a venue switcher for org-wide staff, an alerts bell with live `alert:new`, and logout. A proxy/redirect sends visitors without a session to login.
- **E6-S2 Floor view** (FLR-01..05, ORD-04..06). AC: tiles grouped by zone, coloured by `floorStatus`, with a live timer using the server-offset clock (amber flashing at 30 m, red at 45 m, `prefers-reduced-motion` respected). Next-booking chip. Actions: seat walk-in (with the collision dialog and suggestions), seat reservation, open the order drawer, mark clean, block/unblock. Updates arrive over the socket.
- **E6-S3 Order drawer**. AC: menu picker, custom item, qty/notes, running totals, KDS status buttons, void/comp via the POS simulator, and a settle dialog with split tender (cash/card/gift card/points/wallet plus the simulate toggles). Completing the reservation clears the table.
- **E6-S4 Triage queue** (RES-01/09). AC: cards with guest tags, allergies (red), notes, party and time, and a countdown to the triage deadline. Approve/reject, and escalated items highlighted.
- **E6-S5 Reservations list and phone booking**. AC: date picker, status filter, and a table with actions (seat, no-show, cancel, reassign). "New booking" dialog.
- **E6-S6 Guests CRM**. AC: search, profile page with tags (add/remove), allergies, preferences, metrics, loyalty (tier, points, wallet preload), ledger and history.
- **E6-S7 Settings**. AC: venue fields, turnaround, grace, upsize fallback, blackout toggle, a weekly shift editor, and table CRUD showing guard errors.
- **E6-S8 Activity and integrations**. AC: notifications log (mock SMS), webhook events (DLQ with replay), POS simulator form, and gift cards (issue/reload).

## Epic E7: Quality (C)

- Playwright e2e for the golden path, walk-in collision, Wi-Fi arrival, and POS void clawback.
- Load test script (autocannon) against availability. Report p95.
- Code review pass; README with setup and demo accounts.
