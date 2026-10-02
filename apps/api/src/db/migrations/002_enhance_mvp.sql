-- Migration 002: Multi-market, 8-state reservation lifecycle, fair void attribution, multi-table allocation, and waitlist

-- 1. Reservation statuses: add ARRIVED and LATE to enum
ALTER TYPE reservation_status ADD VALUE IF NOT EXISTS 'ARRIVED' AFTER 'CONFIRMED';
ALTER TYPE reservation_status ADD VALUE IF NOT EXISTS 'LATE' AFTER 'SEATED';

-- 2. Venues: currency and locale
ALTER TABLE venues ADD COLUMN IF NOT EXISTS currency VARCHAR(8) NOT NULL DEFAULT 'INR';
ALTER TABLE venues ADD COLUMN IF NOT EXISTS locale VARCHAR(16) NOT NULL DEFAULT 'en-IN';

-- 3. Fair void attribution: enum and column
DO $$ BEGIN
  CREATE TYPE void_attribution AS ENUM ('GUEST', 'KITCHEN', 'SERVER_ENTRY', 'PROMOTIONAL', 'SYSTEM', 'UNMAPPED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE pos_void_logs ADD COLUMN IF NOT EXISTS attribution void_attribution NOT NULL DEFAULT 'UNMAPPED';

-- 4. Multi-table combinations join table
CREATE TABLE IF NOT EXISTS reservation_tables (
  reservation_id UUID NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  table_id UUID NOT NULL REFERENCES dining_tables(id) ON DELETE RESTRICT,
  PRIMARY KEY (reservation_id, table_id)
);
CREATE INDEX IF NOT EXISTS idx_reservation_tables_table ON reservation_tables(table_id);

-- 5. Turn time rules table (configurable dynamic turn times per party size & daypart)
CREATE TABLE IF NOT EXISTS turn_time_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  min_covers INT NOT NULL,
  max_covers INT NOT NULL,
  turn_minutes INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_turn_time_rules_venue ON turn_time_rules(venue_id);

-- 6. Waitlist entries table
CREATE TABLE IF NOT EXISTS waitlist_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  guest_id UUID NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  party_size INT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'WAITING',
  quoted_minutes INT NOT NULL DEFAULT 15,
  notes TEXT,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  seated_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_waitlist_entries_venue_status ON waitlist_entries(venue_id, status);
