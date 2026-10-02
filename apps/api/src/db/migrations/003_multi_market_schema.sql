-- Migration 003: Multi-market constraints, 8-state reservation lifecycle constraints,
-- fair void attribution table, and 64-bit BIGINT minor-unit spend safety.

-- 1. Venues: Check constraints and reset buffer
ALTER TABLE venues ADD COLUMN IF NOT EXISTS reset_buffer_mins INT NOT NULL DEFAULT 15 CHECK (reset_buffer_mins BETWEEN 0 AND 60);

DO $$ BEGIN
  ALTER TABLE venues ADD CONSTRAINT venues_currency_check CHECK (currency IN ('USD', 'INR'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE venues ADD CONSTRAINT venues_locale_check CHECK (locale IN ('en-US', 'en-IN'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 2. 64-bit BIGINT conversion for minor-unit spend safety
ALTER TABLE venues ALTER COLUMN cost_for_one_paise TYPE BIGINT;
ALTER TABLE venues ALTER COLUMN cost_for_two_paise TYPE BIGINT;
ALTER TABLE menu_items ALTER COLUMN price_paise TYPE BIGINT;
ALTER TABLE pos_order_items ALTER COLUMN unit_price_paise TYPE BIGINT;

-- 3. Reservations: lifecycle timestamps and snapshotted turn time
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS arrived_at TIMESTAMPTZ;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS late_marked_at TIMESTAMPTZ;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS turn_minutes INT NOT NULL DEFAULT 90 CHECK (turn_minutes BETWEEN 15 AND 480);

-- Update GiST exclusion constraint to include all 5 active states
-- ('REQUESTED', 'CONFIRMED', 'ARRIVED', 'SEATED', 'LATE')
ALTER TABLE reservations DROP CONSTRAINT IF EXISTS reservations_no_overlap;
ALTER TABLE reservations ADD CONSTRAINT reservations_no_overlap EXCLUDE USING gist (
  table_id WITH =,
  tstzrange(start_at, end_at, '[)') WITH &&
) WHERE (status IN ('REQUESTED', 'CONFIRMED', 'ARRIVED', 'SEATED', 'LATE') AND table_id IS NOT NULL);

-- Recreate index covering all active reservation states
DROP INDEX IF EXISTS reservations_table_time_idx;
CREATE INDEX reservations_table_time_idx ON reservations (table_id, start_at)
WHERE status IN ('REQUESTED', 'CONFIRMED', 'ARRIVED', 'SEATED', 'LATE');

-- 4. POS Adjustments & Fair Void Attribution
ALTER TABLE pos_void_logs ADD COLUMN IF NOT EXISTS attribution_class void_attribution NOT NULL DEFAULT 'UNMAPPED';
ALTER TABLE pos_void_logs ADD COLUMN IF NOT EXISTS counts_as_guest_return BOOLEAN NOT NULL DEFAULT FALSE;

-- Ensure existing rows sync attribution column
UPDATE pos_void_logs SET attribution_class = attribution WHERE attribution_class = 'UNMAPPED' AND attribution != 'UNMAPPED';

-- Create canonical pos_adjustments table
CREATE TABLE IF NOT EXISTS pos_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id UUID REFERENCES venues(id) ON DELETE CASCADE,
  order_id UUID NOT NULL REFERENCES pos_orders(id) ON DELETE CASCADE,
  order_item_id UUID REFERENCES pos_order_items(id) ON DELETE SET NULL,
  kind VARCHAR(16) NOT NULL CHECK (kind IN ('VOID', 'COMP', 'REFUND', 'DISCOUNT')),
  reason_ref VARCHAR(128),
  reason_label VARCHAR(255),
  attribution_class void_attribution NOT NULL DEFAULT 'UNMAPPED',
  fired_before BOOLEAN,
  counts_as_guest_return BOOLEAN NOT NULL DEFAULT FALSE,
  amount_paise BIGINT NOT NULL CHECK (amount_paise >= 0),
  authorized_by VARCHAR(128) NOT NULL DEFAULT '',
  post_settlement BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pos_adjustments_order ON pos_adjustments(order_id);
CREATE INDEX IF NOT EXISTS idx_pos_adjustments_attribution ON pos_adjustments(attribution_class, counts_as_guest_return);

-- 5. Turn time rules enhancement
ALTER TABLE turn_time_rules ADD COLUMN IF NOT EXISTS daypart VARCHAR(32);
ALTER TABLE turn_time_rules ADD COLUMN IF NOT EXISTS dining_area_id UUID;
