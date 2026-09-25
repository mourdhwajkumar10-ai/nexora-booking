-- Nexora canonical schema (see docs/ARCHITECTURE.md). Money is integer paise (INR).
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE table_status AS ENUM ('AVAILABLE', 'OCCUPIED', 'BUSSING', 'BLOCKED');
CREATE TYPE reservation_status AS ENUM ('REQUESTED', 'CONFIRMED', 'SEATED', 'COMPLETED', 'CANCELLED', 'NO_SHOW');
CREATE TYPE reservation_source AS ENUM ('ONLINE', 'PHONE', 'WALK_IN');
CREATE TYPE order_status AS ENUM ('PLACED', 'RECEIVED', 'PREPARING', 'SERVED', 'BILLED', 'VOIDED', 'PARTIALLY_PAID');
CREATE TYPE staff_role AS ENUM ('HOST', 'MANAGER');
CREATE TYPE tier_level AS ENUM ('BASE', 'MEMBER', 'REGULAR', 'FRIENDS_AND_FAMILY');
CREATE TYPE ledger_event AS ENUM ('ACCRUAL', 'REDEMPTION', 'PRELOAD', 'REVERSAL', 'EXPIRED');
CREATE TYPE ledger_state AS ENUM ('PENDING', 'SETTLED', 'REVERSED', 'REDEEMED');

-- ---------------------------------------------------------------- venue & inventory
CREATE TABLE localities (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        VARCHAR(64) NOT NULL UNIQUE,
  name        VARCHAR(128) NOT NULL,
  city        VARCHAR(128) NOT NULL,
  sort_order  INT NOT NULL DEFAULT 0
);

CREATE TABLE venues (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                   VARCHAR(128) NOT NULL UNIQUE,
  name                   VARCHAR(255) NOT NULL,
  locality_id            UUID NOT NULL REFERENCES localities(id),
  address                VARCHAR(255) NOT NULL DEFAULT '',
  description            TEXT NOT NULL DEFAULT '',
  cuisines               TEXT[] NOT NULL DEFAULT '{}',
  rating                 NUMERIC(2,1) NOT NULL DEFAULT 4.0 CHECK (rating BETWEEN 0 AND 5),
  rating_count           INT NOT NULL DEFAULT 0,
  image_url              TEXT NOT NULL DEFAULT '',
  cost_for_one_paise     INT NOT NULL CHECK (cost_for_one_paise > 0),
  cost_for_two_paise     INT NOT NULL CHECK (cost_for_two_paise > 0),
  timezone               VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
  turnaround_mins        INT NOT NULL DEFAULT 30 CHECK (turnaround_mins BETWEEN 15 AND 240 AND turnaround_mins % 15 = 0),
  grace_period_mins      INT NOT NULL DEFAULT 15 CHECK (grace_period_mins BETWEEN 5 AND 60),
  triage_timeout_secs    INT NOT NULL DEFAULT 300 CHECK (triage_timeout_secs BETWEEN 60 AND 3600),
  allow_upsize_fallback  BOOLEAN NOT NULL DEFAULT TRUE,
  is_active              BOOLEAN NOT NULL DEFAULT TRUE,   -- listed in directory
  blackout               BOOLEAN NOT NULL DEFAULT FALSE,  -- global booking toggle (blackout mode)
  blackout_reason        VARCHAR(200),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX venues_locality_idx ON venues (locality_id) WHERE is_active;

CREATE TABLE operating_shifts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id     UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  day_of_week  INT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  open_time    TIME NOT NULL,
  close_time   TIME NOT NULL,
  CHECK (open_time <> close_time),
  UNIQUE (venue_id, day_of_week, open_time)
);

CREATE TABLE dining_tables (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id           UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  table_number       VARCHAR(32) NOT NULL,
  dining_zone        VARCHAR(64) NOT NULL DEFAULT 'MAIN',
  min_capacity       INT NOT NULL CHECK (min_capacity >= 1),
  max_capacity       INT NOT NULL,
  status             table_status NOT NULL DEFAULT 'AVAILABLE',
  status_changed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (max_capacity >= min_capacity)
);
CREATE UNIQUE INDEX dining_tables_number_uq ON dining_tables (venue_id, table_number) WHERE archived_at IS NULL;

CREATE TABLE menu_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id      UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  name          VARCHAR(255) NOT NULL,
  category      VARCHAR(64) NOT NULL,
  price_paise   INT NOT NULL CHECK (price_paise > 0),
  is_available  BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order    INT NOT NULL DEFAULT 0
);

CREATE TABLE staff_users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id       UUID REFERENCES venues(id) ON DELETE CASCADE, -- NULL = org-wide
  email          VARCHAR(255) NOT NULL UNIQUE,
  name           VARCHAR(128) NOT NULL,
  role           staff_role NOT NULL,
  password_hash  TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id    UUID REFERENCES venues(id) ON DELETE CASCADE,
  actor       VARCHAR(255) NOT NULL,
  action      VARCHAR(64) NOT NULL,
  entity      VARCHAR(64) NOT NULL,
  entity_id   UUID,
  data        JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_venue_idx ON audit_logs (venue_id, created_at DESC);

-- ---------------------------------------------------------------- guests / CRM
CREATE TABLE guests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name    VARCHAR(128) NOT NULL,
  last_name     VARCHAR(128) NOT NULL DEFAULT '',
  phone_number  VARCHAR(32) NOT NULL UNIQUE,
  email         VARCHAR(255) UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE guest_profiles (
  guest_id                  UUID PRIMARY KEY REFERENCES guests(id) ON DELETE CASCADE,
  lifetime_spend_paise      BIGINT NOT NULL DEFAULT 0,
  total_visits              INT NOT NULL DEFAULT 0,
  avg_party_size            NUMERIC(4,2) NOT NULL DEFAULT 1.00,
  total_voids_count         INT NOT NULL DEFAULT 0,
  total_voids_value_paise   BIGINT NOT NULL DEFAULT 0,
  no_show_count             INT NOT NULL DEFAULT 0,
  seating_preference        VARCHAR(64) NOT NULL DEFAULT 'ANY',
  dietary_notes             TEXT,
  allergies                 TEXT,                      -- health-critical, separated from soft prefs
  flags                     TEXT[] NOT NULL DEFAULT '{}', -- e.g. UNRESOLVED_LOYALTY_DEFICIT
  last_visit_at             TIMESTAMPTZ
);

CREATE TABLE guest_tags (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_id           UUID NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  tag_name           VARCHAR(64) NOT NULL,
  is_auto_generated  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (guest_id, tag_name)
);

-- MAC addresses are ephemeral transport pointers, never identity (CRITIQUE #14)
CREATE TABLE guest_devices (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_id       UUID NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  device_mac     MACADDR NOT NULL,
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (guest_id, device_mac)
);

-- ---------------------------------------------------------------- reservations
CREATE TABLE reservations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_token        VARCHAR(64) NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),
  venue_id            UUID NOT NULL REFERENCES venues(id),
  table_id            UUID REFERENCES dining_tables(id),
  guest_id            UUID NOT NULL REFERENCES guests(id),
  party_size          INT NOT NULL CHECK (party_size >= 1),
  booking_date        DATE NOT NULL,          -- venue-local date (display / filtering)
  start_at            TIMESTAMPTZ NOT NULL,
  end_at              TIMESTAMPTZ NOT NULL,
  source              reservation_source NOT NULL DEFAULT 'ONLINE',
  status              reservation_status NOT NULL DEFAULT 'REQUESTED',
  dietary_requests    TEXT,
  seating_preference  VARCHAR(64),
  notes               TEXT,
  escalated_at        TIMESTAMPTZ,
  confirmed_at        TIMESTAMPTZ,
  seated_at           TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  cancelled_at        TIMESTAMPTZ,
  cancel_reason       VARCHAR(200),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_at > start_at),
  -- Defense in depth against double allocation (CRITIQUE #2): conflict iff s1 < e2 AND s2 < e1.
  CONSTRAINT reservations_no_overlap EXCLUDE USING gist (
    table_id WITH =,
    tstzrange(start_at, end_at, '[)') WITH &&
  ) WHERE (status IN ('REQUESTED', 'CONFIRMED', 'SEATED') AND table_id IS NOT NULL)
);
CREATE INDEX reservations_venue_date_idx ON reservations (venue_id, booking_date);
CREATE INDEX reservations_table_time_idx ON reservations (table_id, start_at) WHERE status IN ('REQUESTED', 'CONFIRMED', 'SEATED');
CREATE INDEX reservations_status_idx ON reservations (status, created_at);
CREATE INDEX reservations_guest_idx ON reservations (guest_id, start_at DESC);

CREATE TABLE reservation_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id  UUID NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  from_status     reservation_status,
  to_status       reservation_status NOT NULL,
  actor           VARCHAR(255) NOT NULL,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX reservation_events_res_idx ON reservation_events (reservation_id, created_at);

-- ---------------------------------------------------------------- POS / orders
CREATE TABLE pos_orders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id          UUID NOT NULL REFERENCES venues(id),
  table_id          UUID NOT NULL REFERENCES dining_tables(id),
  reservation_id    UUID REFERENCES reservations(id),
  guest_id          UUID REFERENCES guests(id),
  pos_external_id   VARCHAR(128) UNIQUE,
  status            order_status NOT NULL DEFAULT 'PLACED',
  placed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  received_at       TIMESTAMPTZ,
  preparing_at      TIMESTAMPTZ,
  served_at         TIMESTAMPTZ,
  settled_at        TIMESTAMPTZ,
  gross_paise       BIGINT NOT NULL DEFAULT 0,
  discount_paise    BIGINT NOT NULL DEFAULT 0,
  net_paise         BIGINT NOT NULL DEFAULT 0,
  paid_paise        BIGINT NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- one open check per table
CREATE UNIQUE INDEX pos_orders_open_per_table ON pos_orders (table_id) WHERE status NOT IN ('BILLED', 'VOIDED');
CREATE INDEX pos_orders_reservation_idx ON pos_orders (reservation_id);
CREATE INDEX pos_orders_guest_idx ON pos_orders (guest_id);

CREATE TABLE pos_order_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          UUID NOT NULL REFERENCES pos_orders(id) ON DELETE CASCADE,
  item_name         VARCHAR(255) NOT NULL,
  category          VARCHAR(64) NOT NULL,
  quantity          INT NOT NULL CHECK (quantity > 0),
  unit_price_paise  INT NOT NULL CHECK (unit_price_paise >= 0),
  notes             TEXT,
  is_voided         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX pos_order_items_order_idx ON pos_order_items (order_id);

CREATE TABLE pos_void_logs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           UUID NOT NULL REFERENCES pos_orders(id) ON DELETE CASCADE,
  order_item_id      UUID REFERENCES pos_order_items(id) ON DELETE CASCADE,
  kind               VARCHAR(16) NOT NULL CHECK (kind IN ('VOID', 'COMP', 'REFUND')),
  void_reason        VARCHAR(128) NOT NULL,
  authorized_by      VARCHAR(128) NOT NULL,
  amount_voided_paise BIGINT NOT NULL CHECK (amount_voided_paise >= 0),
  post_settlement    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- loyalty & stored value
CREATE TABLE loyalty_accounts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_id              UUID NOT NULL UNIQUE REFERENCES guests(id) ON DELETE CASCADE,
  tier_level            tier_level NOT NULL DEFAULT 'BASE',
  points_balance        BIGINT NOT NULL DEFAULT 0,  -- may go negative (loyalty deficit)
  wallet_balance_paise  BIGINT NOT NULL DEFAULT 0 CHECK (wallet_balance_paise >= 0),
  annual_spend_paise    BIGINT NOT NULL DEFAULT 0,
  largest_preload_paise BIGINT NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE loyalty_ledger (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES loyalty_accounts(id) ON DELETE CASCADE,
  event_type      ledger_event NOT NULL,
  state           ledger_state NOT NULL DEFAULT 'SETTLED',
  points_delta    BIGINT NOT NULL DEFAULT 0,
  amount_paise    BIGINT NOT NULL DEFAULT 0,
  reference_type  VARCHAR(32),
  reference_id    UUID,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX loyalty_ledger_account_idx ON loyalty_ledger (account_id, created_at DESC);

CREATE TABLE loyalty_holds (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES loyalty_accounts(id) ON DELETE CASCADE,
  order_id    UUID NOT NULL REFERENCES pos_orders(id) ON DELETE CASCADE,
  kind        VARCHAR(16) NOT NULL CHECK (kind IN ('POINTS', 'WALLET')),
  amount      BIGINT NOT NULL CHECK (amount > 0),   -- points or paise
  status      VARCHAR(16) NOT NULL DEFAULT 'HELD' CHECK (status IN ('HELD', 'CAPTURED', 'RELEASED')),
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE gift_cards (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  card_number_hash      VARCHAR(255) NOT NULL UNIQUE, -- salted SHA-256
  last4                 VARCHAR(4) NOT NULL,
  current_balance_paise BIGINT NOT NULL CHECK (current_balance_paise >= 0),
  purchased_by          UUID REFERENCES guests(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE gift_card_holds (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gift_card_id  UUID NOT NULL REFERENCES gift_cards(id) ON DELETE CASCADE,
  order_id      UUID REFERENCES pos_orders(id) ON DELETE CASCADE,
  hold_token    VARCHAR(64) NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),
  amount_paise  BIGINT NOT NULL CHECK (amount_paise > 0),
  status        VARCHAR(16) NOT NULL DEFAULT 'HELD' CHECK (status IN ('HELD', 'CAPTURED', 'RELEASED')),
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE gift_card_ledger (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gift_card_id  UUID NOT NULL REFERENCES gift_cards(id) ON DELETE CASCADE,
  kind          VARCHAR(16) NOT NULL CHECK (kind IN ('PURCHASE', 'RELOAD', 'REDEEM', 'REFUND')),
  delta_paise   BIGINT NOT NULL,
  reference_id  UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- captive wifi
CREATE TABLE wifi_otps (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone        VARCHAR(32) NOT NULL,
  code_hash    VARCHAR(128) NOT NULL,
  attempts     INT NOT NULL DEFAULT 0,
  expires_at   TIMESTAMPTZ NOT NULL,
  verified_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX wifi_otps_phone_idx ON wifi_otps (phone, created_at DESC);

CREATE TABLE wifi_sessions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_id          UUID NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  venue_id          UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  device_mac        MACADDR NOT NULL,
  ap_id             VARCHAR(64),
  connected_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  opt_in_marketing  BOOLEAN NOT NULL DEFAULT FALSE
);

-- ---------------------------------------------------------------- ops: alerts, notifications, webhooks
CREATE TABLE alerts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id         UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  kind             VARCHAR(32) NOT NULL,
  severity         VARCHAR(16) NOT NULL DEFAULT 'info',
  title            VARCHAR(255) NOT NULL,
  body             TEXT NOT NULL DEFAULT '',
  data             JSONB NOT NULL DEFAULT '{}',
  dedupe_key       VARCHAR(255) UNIQUE,
  acknowledged_at  TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX alerts_venue_idx ON alerts (venue_id, created_at DESC);

CREATE TABLE notifications_outbox (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id        UUID REFERENCES venues(id) ON DELETE CASCADE,
  reservation_id  UUID REFERENCES reservations(id) ON DELETE CASCADE,
  guest_id        UUID REFERENCES guests(id) ON DELETE CASCADE,
  channel         VARCHAR(16) NOT NULL DEFAULT 'SMS' CHECK (channel IN ('SMS', 'WHATSAPP')),
  template        VARCHAR(64) NOT NULL,
  to_address      VARCHAR(64) NOT NULL,
  body            TEXT NOT NULL,
  payload         JSONB NOT NULL DEFAULT '{}',
  status          VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
  attempts        INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ
);
CREATE INDEX notifications_pending_idx ON notifications_outbox (created_at) WHERE status = 'PENDING';

CREATE TABLE webhook_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id         UUID REFERENCES venues(id) ON DELETE CASCADE,
  source           VARCHAR(32) NOT NULL,
  idempotency_key  VARCHAR(255) NOT NULL UNIQUE,
  event_type       VARCHAR(64) NOT NULL,
  payload          JSONB NOT NULL,
  status           VARCHAR(16) NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED', 'PROCESSED', 'FAILED', 'DEAD')),
  attempts         INT NOT NULL DEFAULT 0,
  fail_times       INT NOT NULL DEFAULT 0, -- simulator: force N failures
  next_attempt_at  TIMESTAMPTZ,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at     TIMESTAMPTZ
);
CREATE INDEX webhook_events_retry_idx ON webhook_events (next_attempt_at) WHERE status = 'FAILED';
