# Nexora — Requirements Catalogue

Every requirement from the two source documents in [`docs/source/`](source/), numbered and traced.

- **PRD** = *Restaurant POC PRD Creation.pdf* (Product Requirement Document: Dual-Sided Restaurant Table Reservation and Floor Operations Platform)
- **ARCH** = *Restaurant Platform Architecture Design.pdf* (Enterprise Architecture Specification: Dual-Sided Restaurant Reservation, Floor Management, and Guest Intelligence Platform)

**Scope:** ✅ In scope (built for real) · 🧪 Mocked (built as a working simulation, no real hardware or gateways) · ⏭ Deferred (documented future phase)

Where a requirement was changed after review, the **Resolution** column links to the matching [CRITIQUE](CRITIQUE.md) item.

---

## 1. Merchant administration (`REQ-ADM`)

| ID | Requirement | Source | Scope | Resolution |
|---|---|---|---|---|
| ADM-01 | Venue managers set daily operating hours (opening/closing time) for service shifts. | PRD §Operating Schedules; ARCH `operating_shifts` | ✅ | Per-weekday shifts, several per day ([C-05](CRITIQUE.md#c-05)) |
| ADM-02 | Time is modelled in 15-minute operational intervals. | PRD §Operating Schedules | ✅ | |
| ADM-03 | Reject bookings whose arrival is before shift open or whose release (start + turnaround) is after shift close. | PRD §Operating Schedules; ARCH §Shift Discretization | ✅ | Last slot = close − turnaround ([C-13](CRITIQUE.md#c-13)) |
| ADM-04 | Global toggle between accepting bookings and **blackout** mode, without changing the schedule. | PRD §Operating Schedules; ARCH `venues.is_active` | ✅ | Separate `blackout` and `is_active` flags ([C-12](CRITIQUE.md#c-12)) |
| ADM-05 | Capacity is modelled as discrete, addressable tables, not one headcount for the venue. | PRD §Inventory Topology | ✅ | |
| ADM-06 | Each table has an alphanumeric identifier, a dining zone, and min/max capacity. | PRD §Inventory Topology; ARCH `tables` | ✅ | |
| ADM-07 | POC inventory has two table models: 2-seaters and 4-seaters. | PRD §Inventory Topology | ✅ | Capacities filled in ([C-06](CRITIQUE.md#c-06)) |
| ADM-08 | Admins can add, edit or remove tables at any time. | PRD §Inventory Topology | ✅ | |
| ADM-09 | Block deletion or downsizing of any table that has active or future confirmed reservations. | PRD §Inventory Topology | ✅ | Soft delete (`archived_at`) keeps history |
| ADM-10 | The turnaround duration is visible as a configuration element in settings. | PRD §Deterministic Turnaround | ✅ | Editable in 15-min steps ([C-16](CRITIQUE.md#c-16)) |
| ADM-11 | Staff access control (role-based) and audit logging. | PRD table (production target); ARCH table | ✅ | Roles HOST/MANAGER, audit_logs ([C-10](CRITIQUE.md#c-10)) |
| ADM-12 | Multi-tenant organisation hierarchy. | ARCH table (production target) | ⏭ | Org-wide vs venue-scoped staff only |

## 2. Consumer booking (`REQ-BKG`)

| ID | Requirement | Source | Scope | Resolution |
|---|---|---|---|---|
| BKG-01 | A persistent header dropdown lists pre-configured localities (e.g. Cyber City Gurgaon, Koramangala Bangalore, BKC Mumbai). | PRD §Static Locality Discovery | ✅ | |
| BKG-02 | Choosing a locality filters the directory to venues in that sector. The choice persists across views. | PRD §Static Locality; UI table | ✅ | Stored in a cookie |
| BKG-03 | Hide venues flagged globally inactive or outside the chosen locality. | PRD UI table; ARCH §Consumer Discovery | ✅ | |
| BKG-04 | Directory cards show name, image, cuisines, aggregate rating, operational status, **cost for one** and **cost for two**. | PRD §Directory Presentation | ✅ | INR ([C-11](CRITIQUE.md#c-11)) |
| BKG-05 | Clicking a card opens an inventory-aware booking page: date, party size (1–4), arrival time on a 15-minute slot selector. | PRD §Reservation Booking Funnel | ✅ | |
| BKG-06 | The availability query checks for an unreserved table that fits the party for the whole turnaround window. | PRD §Reservation Booking Funnel | ✅ | |
| BKG-07 | The form collects full name, phone and optional dietary requests. ARCH adds email and seating preference. | PRD; ARCH §Consumer Discovery | ✅ | Email optional ([C-05](CRITIQUE.md#c-05)) |
| BKG-08 | Submitting creates a reservation in status **Requested** that holds the table and goes to the restaurant's triage queue. | PRD §Reservation Booking Funnel | ✅ | Hold capped by triage timer ([C-08](CRITIQUE.md#c-08)) |
| BKG-09 | After submitting, a holding screen says the request is awaiting host approval. | PRD §Transactional Status Updates | ✅ | |
| BKG-10 | Booking tracker shows live status (Requested / Confirmed / Cancelled), a confirmation modal and a cancel trigger. It polls or listens for approval. | PRD UI table | ✅ | Socket.IO + polling fallback. Cancel needs the phone's last 4 digits ([C-10](CRITIQUE.md#c-10)) |
| BKG-11 | Block times outside operating hours and party sizes with no matching table. | PRD UI table | ✅ | |
| BKG-12 | On conflict, return HTTP 409 with alternative slots. | PRD §Concurrency; ARCH §Edge cases | ✅ | ±15/30/45/60 min alternatives |
| BKG-13 | Rejected diners are prompted to pick another dining window. | ARCH §Host Triage | ✅ | Tracker links back to the slot picker |

## 3. Concurrency and allocation (`REQ-CON`)

| ID | Requirement | Source | Scope | Resolution |
|---|---|---|---|---|
| CON-01 | Booking runs in a DB transaction that takes an exclusive row lock (`SELECT … FOR UPDATE`) on candidate tables. | PRD §Concurrency; ARCH §Concurrency | ✅ | READ COMMITTED ([C-02](CRITIQUE.md#c-02)) |
| CON-02 | Check the ledger for overlapping active bookings (Requested, Confirmed, Seated). If none, insert as Requested and commit. | PRD; ARCH | ✅ | |
| CON-03 | A concurrent transaction blocks, then sees the new booking, rolls back and returns 409. | PRD; ARCH | ✅ | Tries the next best-fit table first ([C-07](CRITIQUE.md#c-07)) |
| CON-04 | Zero double bookings under simultaneous conflicting requests. | PRD §Performance | ✅ | Plus an EXCLUDE constraint backstop ([C-02](CRITIQUE.md#c-02)) |
| CON-05 | Overlap rule: conflict iff `s_new < e_old AND s_old < e_new`. | PRD; ARCH | ✅ | Half-open `[start,end)` ranges |
| CON-06 | Best fit: tables with no overlap, not out of service, `min ≤ P ≤ max`, sorted by `D = max − P` ascending. Lowest D wins. | PRD; ARCH | ✅ | Doesn't filter on current status ([C-03](CRITIQUE.md#c-03)) |
| CON-07 | Optional fallback to larger tables when smaller ones are full. | PRD §Best-Fit | ✅ | `allow_upsize_fallback` setting |
| CON-08 | `N_max = floor((T_close − T_open) / T_turn)` intervals per table per shift. | PRD; ARCH | ✅ | Shown in settings |
| CON-09 | Distributed Redis key leases with TTL. | PRD/ARCH Phase 3 | ⏭ | `LockProvider` seam noted |

## 4. Turnaround and timing (`REQ-TRN`)

| ID | Requirement | Source | Scope | Resolution |
|---|---|---|---|---|
| TRN-01 | Hardcoded 30-min table turnaround: `T_end = T_start + 30`. | PRD §Deterministic Turnaround | ✅ | Per-venue value, default 30 ([C-16](CRITIQUE.md#c-16)) |
| TRN-02 | Requests overlapping `[T_start, T_end)` are left out of availability. | PRD | ✅ | |
| TRN-03 | Party-size-dependent durations (e.g. 45 min for 2-tops, 75 min for 4-tops). | PRD/ARCH Phase 2 | ⏭ | |
| TRN-04 | ML yield/pacing engine. | PRD/ARCH production target | ⏭ | |

## 5. Floor state (`REQ-FLR`)

| ID | Requirement | Source | Scope | Resolution |
|---|---|---|---|---|
| FLR-01 | Floor dashboard renders each table as a tile showing live state. | PRD §Real-Time Floor State | ✅ | |
| FLR-02 | States and colours: Available = green, Reserved = amber, Occupied = blue, Closed/Blocked = slate. ARCH adds **Bussing** = pulsing yellow. | PRD; ARCH | ✅ | RESERVED is derived ([C-03](CRITIQUE.md#c-03)) |
| FLR-03 | Table lifecycle: AVAILABLE→RESERVED→OCCUPIED→BUSSING→AVAILABLE, ANY→BLOCKED, RESERVED→AVAILABLE on cancel or no-show, AVAILABLE→OCCUPIED for walk-ins. | ARCH §Table FSM | ✅ | |
| FLR-04 | Tile shows active covers and next booking. The console shows guest tags and notes. | PRD; ARCH §Merchant Floor | ✅ | |
| FLR-05 | Walk-in collision check: block seating that overlaps an upcoming confirmed booking, show a *Collision Alert* dialog, suggest best-fit alternatives, and allow manual override or waitlist. | ARCH §Walk-In Collisions | ✅ | Walk-in buffer ([C-17](CRITIQUE.md#c-17)). Waitlist ⏭ |
| FLR-06 | 2D drag-and-drop floor-plan canvas. | PRD/ARCH Phase 3 | ⏭ | |
| FLR-07 | Bidirectional real-time sync across host terminals. | PRD Phase 2; ARCH | ✅ | Socket.IO from day 1 ([C-15](CRITIQUE.md#c-15)) |

## 6. Orders and timers (`REQ-ORD`)

| ID | Requirement | Source | Scope | Resolution |
|---|---|---|---|---|
| ORD-01 | When a table becomes occupied, open an order ticket linked to that table. | PRD §In-Service Order Tracking | ✅ | |
| ORD-02 | Record placed and acknowledged (received) timestamps. | PRD | ✅ | Plus preparing/served/settled |
| ORD-03 | Ticket view: items, quantities, prep notes, running total. | PRD | ✅ | |
| ORD-04 | Client-side ticking elapsed timer `Δt = t_now − t_seat` while occupied. | PRD; ARCH | ✅ | |
| ORD-05 | At ≥ turnaround (30 min) the timer flashes amber. ARCH adds red at 45 min with an audible alert and a floor-captain notice. | PRD; ARCH §Dwell Overruns | ✅ | Audible alert is optional on the console |
| ORD-06 | Timers sync to server timestamps on every ticket change, drift < 1 s. | PRD; ARCH §Drift | ✅ | Server-offset clock |
| ORD-07 | Order FSM: PLACED→RECEIVED→PREPARING→SERVED→BILLED, ANY→VOIDED. BILLED unlocks reservation completion. | PRD; ARCH §Kitchen FSM | ✅ | Unified FSM ([C-05](CRITIQUE.md#c-05)) |
| ORD-08 | Dwell overrun: if the next booking's table is still occupied, auto-migrate it to a free matching table, or send the "complimentary beverage" SMS when full. | ARCH §Dwell Overruns | ✅ | |

## 7. Reservation lifecycle and host ops (`REQ-RES`)

| ID | Requirement | Source | Scope | Resolution |
|---|---|---|---|---|
| RES-01 | Triage queue: host reviews party, time and notes, then approves or rejects. | PRD §Host Reservation Mgmt | ✅ | |
| RES-02 | Approve: REQUESTED→CONFIRMED, table reserved, confirmation notification sent. | PRD; ARCH | ✅ | |
| RES-03 | Reject or guest abort: REQUESTED→CANCELLED, hold released. | PRD; ARCH | ✅ | |
| RES-04 | Host manual booking for phone-ins, and instant walk-in seating. | PRD §Host Reservation Mgmt | ✅ | |
| RES-05 | Seat: CONFIRMED→SEATED, table OCCUPIED, order and timer started. | PRD; ARCH | ✅ | |
| RES-06 | No-show: CONFIRMED→NO_SHOW after a 15-min grace period (background worker), table available again, no-show counter incremented. | ARCH §Grace Period | ✅ | NO_SHOW rather than CANCELLED ([C-05](CRITIQUE.md#c-05)) |
| RES-07 | Guest cancels a confirmed booking: CONFIRMED→CANCELLED, with an audit log. | ARCH | ✅ | |
| RES-08 | Complete: SEATED→COMPLETED once the bill is settled. Table goes to BUSSING, timer stops, loyalty accrues. | PRD; ARCH | ✅ | |
| RES-09 | Triage auto-escalation: after 300 s with no action, auto-confirm if inventory is clear and the guest is in **Good Standing**, otherwise escalate to the manager. | ARCH §Host Queue Inaction | ✅ | "Good Standing" defined ([C-09](CRITIQUE.md#c-09)) |
| RES-10 | Hosts can revoke reservations or clear holds. | PRD | ✅ | |

## 8. Notifications (`REQ-NTF`)

| ID | Requirement | Source | Scope | Resolution |
|---|---|---|---|---|
| NTF-01 | On confirmation, update the on-screen badge and log a mock SMS/WhatsApp payload to the console, e.g. "Reservation Confirmed: Table for 2 at … on [Date] at [Time]". | PRD §Notification Pipeline | 🧪 | Transactional outbox + worker |
| NTF-02 | Real SMS/WhatsApp gateways. | PRD/ARCH Phase 2 | ⏭ | The outbox is the integration seam |

## 9. Guest intelligence and CRM (`REQ-CRM`)

| ID | Requirement | Source | Scope | Resolution |
|---|---|---|---|---|
| CRM-01 | Persistent guest profiles: visits, average party size, lifetime spend, preferences, restrictions. | ARCH §Guest Profile | ✅ | |
| CRM-02 | Auto-tags from transactions: premium wine or steak gives WINE_CONNOISSEUR / TOP_SPENDER; overstays give SLOW_PACING. Also VIP, REGULAR, LATE_CANCELLER. | ARCH §Auto-Tagging | ✅ | Rules in ARCHITECTURE §Auto-tags |
| CRM-03 | Health-critical allergies kept separate from soft preferences and shown prominently on host terminals and kitchen chits. | ARCH §Auto-Tagging | ✅ | |
| CRM-04 | Staff can add and remove manual tags (distinguished from auto tags). | ARCH `guest_tags.is_auto_generated` | ✅ | |
| CRM-05 | Void frequency tracking (`total_voids_count`, `total_voids_value`), flagging frequent complainers. | ARCH §POS | ✅ | |
| CRM-06 | Cross-venue profile sync. | ARCH | ✅ | Guests are global |

## 10. Captive Wi-Fi (`REQ-WIFI`)

| ID | Requirement | Source | Scope | Resolution |
|---|---|---|---|---|
| WIFI-01 | Captive portal page (branded) with first name, last name, mobile, email and marketing consent. | ARCH §Captive Wi-Fi | 🧪 | `/wifi/[venue]` page with simulated MAC/AP query params |
| WIFI-02 | Identity resolution: match by phone or email. Match → link MAC, add a visit. No match → create profile at BASE tier. | ARCH §Wi-Fi Onboarding | ✅ | |
| WIFI-03 | MAC randomisation: MAC is an ephemeral pointer in `guest_devices`, identity is verified by SMS OTP. | ARCH §Edge case | 🧪 | Mock OTP ([C-14](CRITIQUE.md#c-14)) |
| WIFI-04 | RADIUS Access-Accept. | ARCH | 🧪 | Simulated `access: 'ACCEPT'` |
| WIFI-05 | Arrival chit on the host console when a guest with a booking or an elite tier connects. | ARCH §Wi-Fi Onboarding | ✅ | |
| WIFI-06 | GDPR/CCPA consent. | ARCH | ✅ | Mandatory consent checkbox and retention note |

## 11. POS integration (`REQ-POS`)

| ID | Requirement | Source | Scope | Resolution |
|---|---|---|---|---|
| POS-01 | `ticket.updated` webhook streams line items into the active check. | ARCH §POS | 🧪 | Built-in POS simulator emits signed webhooks |
| POS-02 | `order.item_voided` / `order.comp_applied` webhooks: deduct from the check, write `pos_void_logs`, update the guest's void metrics, reduce the loyalty basis. | ARCH §POS | ✅ | |
| POS-03 | Post-settlement void or refund: claw back points. If the balance goes negative, set flag `UNRESOLVED_LOYALTY_DEFICIT`, and later accruals pay off the deficit first. | ARCH §Edge case | ✅ | |
| POS-04 | Idempotency keys `{source}_{event_id}_{timestamp}`: duplicates are acknowledged but not processed twice. | ARCH §Network Partitions | ✅ | |
| POS-05 | Dead-letter queue with exponential retry (1 s, 5 s, 30 s, 5 m, 1 h). | ARCH | ✅ | `webhook_events` table + worker |
| POS-06 | Nightly reconciliation polling of the POS sales report. | ARCH | ⏭ | Documented |
| POS-07 | Real POS integrations (Toast, Aloha, Micros). | ARCH | ⏭ | |

## 12. Loyalty, wallet and gift cards (`REQ-LOY`)

| ID | Requirement | Source | Scope | Resolution |
|---|---|---|---|---|
| LOY-01 | Tiers Base / Club Member / Club Regular / Friends & Family, unlocked by annual spend **or** a single wallet preload. | ARCH §Membership | ✅ | Tier table followed ([C-11](CRITIQUE.md#c-11)) |
| LOY-02 | Multipliers 3x / 4x / 5x / 7x on net F&B spend (excluding tips, tax, voids, comps). | ARCH | ✅ | |
| LOY-03 | 100 points = 1 currency unit. Apply points to a bill. | ARCH | ✅ | ₹ |
| LOY-04 | Ledger states PENDING→SETTLED→REVERSED/REDEEMED (double-entry, immutable). | ARCH §Loyalty FSM | ✅ | Settled immediately in the POC (no fraud window) |
| LOY-05 | Gift cards: issue, reload, redeem. Numbers stored as a salted SHA-256. `POST /api/v1/gift-cards/authorize` places a hold. | ARCH §Gift Cards | ✅ | |
| LOY-06 | Split tender with two-phase commit: 120 s holds on gift card and points → capture on card approval → release all if any tender fails, order marked PARTIALLY_PAID, "Tender Failed: …" message. | ARCH §Split-Tender | ✅ | Card gateway simulated |
| LOY-07 | Real payment gateway (Stripe/Razorpay), deposits and no-show fees. | PRD/ARCH Phase 3 | ⏭ | |

## 13. Non-functional (`REQ-NFR`)

| ID | Requirement | Source | Scope | Resolution |
|---|---|---|---|---|
| NFR-01 | Availability endpoint latency under 50 concurrent single-venue requests. | PRD §Performance | ✅ | Target p95 ≤ 200 ms, since the threshold in the doc is unreadable ([C-01](CRITIQUE.md#c-01)) |
| NFR-02 | Zero double-bookings under a conflicting-booking simulation. | PRD | ✅ | Concurrency test in CI |
| NFR-03 | Timer drift < 1 s. | PRD; ARCH | ✅ | |
| NFR-04 | ACID relational schema with referential integrity and no orphaned bookings. | PRD §Data Architecture | ✅ | |
| NFR-05 | Timestamps are ISO-8601 UTC. | ARCH §Drift | ✅ | Venue timezone for display ([C-04](CRITIQUE.md#c-04)) |
| NFR-06 | Responsive, accessible UI. | Implied | ✅ | Vercel/Geist design language, light theme |
