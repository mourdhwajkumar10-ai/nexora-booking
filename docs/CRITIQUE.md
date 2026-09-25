# Critique of the Requirement Documents

A review of the **PRD** (*Restaurant POC PRD Creation.pdf*) and **ARCH** (*Restaurant Platform Architecture Design.pdf*) before building. Each finding has a severity, the problem, and the resolution Nexora implements. Requirement IDs refer to [REQUIREMENTS.md](REQUIREMENTS.md).

Severity: 🔴 would cause incorrect behaviour or data corruption · 🟠 ambiguity or contradiction that blocks implementation · 🟡 quality or completeness gap

---

### C-01
**🟠 Formulas and thresholds are missing from the documents.**
Every equation is an image or equation object that doesn't survive text extraction: `T_end`, `N_max`, the overlap condition, best-fit `D`, the latency SLA, drift, and dwell thresholds. The text says things like "within an execution latency of: [blank]". The PRD's availability latency target can't be recovered at all.
**Resolution:** Every formula is restated in plain text in [ARCHITECTURE.md §Formulas](ARCHITECTURE.md#formulas). The missing SLA is set to **availability p95 ≤ 200 ms at 50 concurrent requests**. Drift < 1 s comes from ARCH's prose. Amber at 30 min and red at 45 min come from ARCH's edge-case table.

### C-02
**🔴 The prescribed locking still allows double bookings.**
ARCH says to run bookings "within transactions using **REPEATABLE READ** isolation" with `SELECT … FROM tables WHERE id = :candidate FOR UPDATE`, then check `reservations` for overlaps. In PostgreSQL, a REPEATABLE READ transaction keeps the snapshot taken at its first statement. Transaction B blocks on the `tables` row lock. When A commits, B gets the lock, but the locked `tables` row itself never changed, so no serialization error fires. B's overlap query on `reservations` still uses the old snapshot, doesn't see A's insert, and inserts a **second overlapping reservation**.
**Resolution:**
1. Booking transactions use **READ COMMITTED**, where every statement after the lock takes a fresh snapshot, so B sees A's committed row and backs off.
2. As defence in depth, a `btree_gist` **EXCLUDE constraint** on `reservations (table_id WITH =, tstzrange(start_at,end_at,'[)') WITH &&) WHERE status IN (REQUESTED, CONFIRMED, SEATED)`. Even a buggy code path can't double-allocate. A violation (`23P01`) maps to HTTP 409.
3. A concurrency test fires 50 simultaneous bookings for the last free slot and asserts exactly one 201.

### C-03
**🔴 One `current_status` column is mixed up with time-based reservations.**
The PRD and ARCH store `tables.current_status ∈ {Available, Reserved, Occupied, …}` and set it to *Reserved* when a booking is confirmed. But a table confirmed for 21:00 is free at 18:00. If the status flips to Reserved when the host approves the evening booking in the afternoon, the lunch floor is wrong. Best-fit also filters on "status is Available", which wrongly excludes a table that is *occupied now* when someone books it *for tonight*.
**Resolution:** The stored `dining_tables.status` holds only **physical** state (`AVAILABLE, OCCUPIED, BUSSING, BLOCKED`). **RESERVED is derived** on the floor view when the table is physically available and a CONFIRMED booking starts within the next turnaround window (or is inside its grace period). Availability and best-fit depend only on interval overlap and `status ≠ BLOCKED`.

### C-04
**🟠 `DATE` + `TIME` columns can't represent real service hours.**
`start_time TIME` and `end_time TIME` with a separate `booking_date` break for bars and late shifts that close after midnight (18:00–01:00). They also have no timezone, so the ISO-8601 UTC requirement (ARCH §Drift) can't be met.
**Resolution:** `reservations.start_at / end_at TIMESTAMPTZ` plus a venue-local `booking_date` for filtering, and a `venues.timezone` (Asia/Kolkata). Shifts where `close_time ≤ open_time` cross midnight. The demo seed includes one late-night venue.

### C-05
**🟠 The two documents disagree on the schema and state machines.**
| Topic | PRD | ARCH | Nexora |
|---|---|---|---|
| Hours | `restaurant.opening_time/closing_time` | `operating_shifts` per weekday | `operating_shifts`, several per day (lunch + dinner) |
| Diner entity | `Customer(full_name, phone, email)` | `guests(first, last, phone UNIQUE NOT NULL, email UNIQUE NOT NULL)` | `guests` with **email optional**, because the booking form doesn't ask for it |
| Out-of-service | Closed | Blocked | `BLOCKED` |
| No-show | CONFIRMED→CANCELLED | CONFIRMED→NO_SHOW | `NO_SHOW` (feeds the no-show counter and Good Standing) |
| Order states | Placed, Received, Served, Billed (Preparing listed in the enum but has no transition) | + PREPARING, VOIDED | Full FSM + `PARTIALLY_PAID` from the split-tender edge case |
| Table states | 4 states | + BUSSING | 4 physical + derived RESERVED |
| Order money | `total_amount` | `net_amount` | gross / discount / net / paid |

### C-06
**🟠 Table capacity values are blank.**
"two-seater tables configured with [min] and [max], and four-seater tables configured with [min] and [max]" has no values. The fallback rule ("fall back to four-seater tables if configured") also implies a party of 2 *can* sit at a 4-top.
**Resolution:** 2-tops are `min 1, max 2`. 4-tops are `min 2, max 4`. The `allow_upsize_fallback` venue setting (default on) lets a party of 2 use a 4-top only after every 2-top is taken, because best-fit sorts by seat differential.

### C-07
**🟠 Best-fit and locking are underspecified, with deadlock risk.**
"Acquires an exclusive row-level lock on candidate table records" could mean locking *all* candidates in one statement. Two transactions locking overlapping sets in different orders can deadlock. The docs also return 409 as soon as the *first* candidate conflicts, even when another suitable table is still free.
**Resolution:** Candidates are tried **one at a time in best-fit order**. For each, lock that single row, re-check overlap, then insert or move on. Only when all candidates fail does the API return `409 SLOT_UNAVAILABLE` with `alternatives` (the nearest available slots within ±60 min).

### C-08
**🔴 REQUESTED bookings can hold inventory indefinitely.**
A REQUESTED booking blocks the table (PRD), but nothing limits how long. A bot, or just a busy host, could leave the floor fully "held" by unreviewed requests.
**Resolution:** The ARCH 300-second triage timer is implemented as a worker: it auto-confirms guests in Good Standing and escalates everyone else to a manager alert. On top of that there is rate limiting on the public booking endpoint and a cap of **2 active REQUESTED bookings per phone number**.

### C-09
**🟠 "Good Standing" is never defined.**
ARCH's auto-confirm depends on a "Good Standing profile tag" that nothing defines.
**Resolution:** A guest is in Good Standing when they have **no NO_SHOW in the last 90 days** and no `UNRESOLVED_LOYALTY_DEFICIT` flag. It is computed, not a stored tag, so it can't go stale.

### C-10
**🔴 There is no authentication or authorization.**
Neither document mentions login for the administrative console. The PRD's booking tracker is keyed by `reservation_id`, so anyone who guesses or sees an ID can cancel someone else's dinner.
**Resolution:** Staff log in (scrypt-hashed passwords, httpOnly JWT cookie) with roles **HOST** and **MANAGER**. Settings, tables and shifts are manager-only. Staff can be scoped to one venue or have org-wide access. Consumers track bookings with an unguessable 128-bit `public_token`, and cancelling requires the phone number's **last 4 digits**. Login and booking endpoints are rate-limited.

### C-11
**🟠 Loyalty tier rules contradict each other, and the currency doesn't match the market.**
ARCH's prose says "depositing $250 … elevates a guest to **Club Regular**", while its tier table says $250 unlocks **Club Member** and $2,500 unlocks Club Regular. Tier names also drift ("Club Member" vs enum `Member`). All money is in USD while every locality is in India.
**Resolution:** The **tier table** is authoritative. Money is **INR stored as integer paise**, which avoids floating-point errors. Thresholds are converted at a round ₹100 = $1, and 100 points = ₹1. See `packages/shared/src/loyalty.ts`.

### C-12
**🟡 The effect of blackout mode on existing bookings is unspecified.**
The PRD also uses `is_active` both as "hide from directory" and as the "blackout toggle".
**Resolution:** There are two flags. `is_active` controls whether the venue is listed at all. `blackout` rejects new bookings, and the directory shows the venue as "Not taking bookings". Existing bookings are **kept** and flagged on the console so the host can call guests.

### C-13
**🟡 The end-of-shift boundary is implicit.**
Because `T_start + 30 ≤ T_close`, the last bookable slot is `close − 30` (22:30 for a 23:00 close), but the spec never says so, and a naive slot picker would offer 22:45.
**Resolution:** The slot generator emits only valid slots, the API validates them again, and the UI shows the last seating time.

### C-14
**🟠 Wi-Fi identity handling has privacy and modelling gaps.**
`wifi_sessions.device_mac NOT NULL` is still the lookup key even though ARCH itself says MACs rotate. Storing MAC addresses together with phone numbers is personal data under GDPR/DPDP, and the doc only says "adhere to GDPR/CCPA".
**Resolution:** MACs live in `guest_devices` as ephemeral pointers linked to a canonical `guest_id`. Identity comes from **phone + OTP** (mocked in the POC, and the dev response includes the code). The portal won't submit without an explicit consent checkbox. Marketing opt-in is a separate checkbox. A 90-day retention policy for devices and sessions is documented.

### C-15
**🟡 The phasing conflicts with the drift requirement.**
Phase 1 says "client polling", but the same phase requires timer drift under 1 s and a live triage queue.
**Resolution:** Socket.IO is used from day 1 with a polling fallback. Every API payload that feeds a timer includes `serverTime`, and clients keep a server-clock offset.

### C-16
**🟡 The turnaround is called both hardcoded and configurable.**
The PRD says the 30-min window is "globally hardcoded" and also that the settings interface "exposes this turnaround parameter as a visible configuration element". Thirty minutes is also far shorter than a real full-service meal (the PRD's own sources say 45–90 min), so tables will look free while guests are still eating.
**Resolution:** `venues.turnaround_mins` defaults to 30 and can be edited in 15-minute steps. Dwell alerts and ARCH's **auto-migration** of the next booking cover the mismatch between reality and the model.

### C-17
**🟡 The walk-in collision example contradicts the overlap formula.**
ARCH's example says a walk-in at 18:45 on Table 4 conflicts with a 19:15 booking. Under the doc's own strict overlap rule, `[18:45,19:15)` and `[19:15,19:45)` **don't** overlap. The intent ("dwell time exceeds arrival threshold") is that walk-ins usually overstay.
**Resolution:** The walk-in check uses a window of `turnaround + 15 min` buffer (45 min), which flags the doc's example. It still suggests best-fit alternatives and allows a manager-visible override.

### C-18
**🟡 The seat action has no guard against a still-occupied table.**
A CONFIRMED guest can be "seated" on a table whose previous party hasn't left (physical status OCCUPIED or BUSSING).
**Resolution:** Seating requires the physical table to be AVAILABLE. Otherwise it returns `409 TABLE_NOT_READY` and the console offers **reassign** to a free best-fit table.

### C-19
**🟡 Idempotency key design.**
ARCH's key `{source}_{event_id}_{timestamp}` includes a timestamp. If the POS retries the same event with a new timestamp, the key changes and it gets processed twice.
**Resolution:** Deduplicate on `{source}_{event_id}`. A caller-supplied `Idempotency-Key` header is also accepted and stored.

### C-20
**🟡 Weak sourcing.**
Many citations are marketing blogs, Scribd uploads or unrelated documents (e.g. an Apache Iceberg article cited for ACID). ARCH is partly written as a prompt for "code-generation environments".
**Resolution:** Treat the documents as product intent, not engineering truth. Every mechanism is backed by tests in this repo instead of by citation.
