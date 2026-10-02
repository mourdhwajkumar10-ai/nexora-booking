-- Migration 004: Core 5 Pillars Schema Extensions
-- Pillar 1: Captive Wi-Fi & Device Privacy (salted device hashing, return detection)
-- Pillar 2: Consent State Recording, Opt-In/Opt-Out, Suppressions
-- Pillar 3: Loyalty Vouchers & Boosters
-- Pillar 4: CRM Segments, Campaigns & Holdout Deliveries
-- Pillar 5: Table Combinations & Dining Areas

-- 1. Captive Wi-Fi & Device Privacy
ALTER TABLE guest_devices ADD COLUMN IF NOT EXISTS device_hash VARCHAR(64);
ALTER TABLE guest_devices ALTER COLUMN device_mac DROP NOT NULL;
ALTER TABLE wifi_sessions ADD COLUMN IF NOT EXISTS device_hash VARCHAR(64);
ALTER TABLE wifi_sessions ADD COLUMN IF NOT EXISTS login_method VARCHAR(32) DEFAULT 'sms_otp';
ALTER TABLE wifi_sessions ADD COLUMN IF NOT EXISTS dwell_seconds INT;
ALTER TABLE wifi_sessions ADD COLUMN IF NOT EXISTS is_returning_guest BOOLEAN DEFAULT FALSE;
ALTER TABLE wifi_sessions ALTER COLUMN device_mac DROP NOT NULL;

CREATE TABLE IF NOT EXISTS wifi_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  device_hash VARCHAR(64) NOT NULL,
  guest_id UUID REFERENCES guests(id) ON DELETE SET NULL,
  randomized_mac BOOLEAN NOT NULL DEFAULT FALSE,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  visit_count INT NOT NULL DEFAULT 1,
  UNIQUE (venue_id, device_hash)
);
CREATE INDEX IF NOT EXISTS idx_wifi_devices_hash ON wifi_devices(venue_id, device_hash);

-- 2. Consent State & Suppressions
CREATE TABLE IF NOT EXISTS consent_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_key VARCHAR(64) NOT NULL,
  consent_type VARCHAR(64) NOT NULL,
  subject_key VARCHAR(128) NOT NULL,
  action VARCHAR(16) NOT NULL CHECK (action IN ('grant', 'revoke')),
  method VARCHAR(64) NOT NULL,
  surface VARCHAR(64),
  evidence JSONB NOT NULL DEFAULT '{}',
  guest_id UUID REFERENCES guests(id) ON DELETE SET NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_consent_events_subject ON consent_events(sender_key, subject_key, occurred_at DESC);

CREATE TABLE IF NOT EXISTS consent_state (
  sender_key VARCHAR(64) NOT NULL,
  consent_type VARCHAR(64) NOT NULL,
  subject_key VARCHAR(128) NOT NULL,
  status VARCHAR(16) NOT NULL CHECK (status IN ('granted', 'revoked')),
  last_event_id UUID REFERENCES consent_events(id) ON DELETE SET NULL,
  last_occurred_at TIMESTAMPTZ NOT NULL,
  granted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (sender_key, consent_type, subject_key)
);

CREATE TABLE IF NOT EXISTS suppressions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_key VARCHAR(64) NOT NULL,
  channel VARCHAR(16) NOT NULL,
  contact_hmac VARCHAR(64) NOT NULL,
  reason VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sender_key, channel, contact_hmac)
);

-- 3. Loyalty Vouchers & Booster Rules
ALTER TYPE ledger_event ADD VALUE IF NOT EXISTS 'REDEEM_HOLD';
ALTER TYPE ledger_event ADD VALUE IF NOT EXISTS 'REDEEM_CAPTURE';
ALTER TYPE ledger_event ADD VALUE IF NOT EXISTS 'REDEEM_RELEASE';
ALTER TYPE ledger_event ADD VALUE IF NOT EXISTS 'EARN_PENDING';
ALTER TYPE ledger_event ADD VALUE IF NOT EXISTS 'EARN_SETTLE';
ALTER TYPE ledger_event ADD VALUE IF NOT EXISTS 'WRITEOFF';

CREATE TABLE IF NOT EXISTS vouchers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_id UUID REFERENCES guests(id) ON DELETE CASCADE,
  account_id UUID REFERENCES loyalty_accounts(id) ON DELETE CASCADE,
  code VARCHAR(16) NOT NULL UNIQUE,
  value_cents INT NOT NULL,
  points INT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'redeemed', 'expired', 'cancelled')),
  expires_at TIMESTAMPTZ NOT NULL,
  redeemed_at TIMESTAMPTZ,
  redeemed_venue_id UUID REFERENCES venues(id) ON DELETE SET NULL,
  redeemed_by VARCHAR(128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vouchers_account ON vouchers(account_id, status);

CREATE TABLE IF NOT EXISTS booster_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id UUID REFERENCES venues(id) ON DELETE CASCADE,
  name VARCHAR(128) NOT NULL,
  points_per_dollar SMALLINT NOT NULL DEFAULT 1,
  days_of_week INT[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',
  start_minute INT NOT NULL DEFAULT 0,
  end_minute INT NOT NULL DEFAULT 1440,
  first_visit_only BOOLEAN NOT NULL DEFAULT FALSE,
  monthly_budget_points INT NOT NULL DEFAULT 100000,
  used_this_month INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_booster_rules_venue ON booster_rules(venue_id);

-- 4. CRM Segments, Campaigns & Deliveries
CREATE TABLE IF NOT EXISTS crm_segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id UUID REFERENCES venues(id) ON DELETE CASCADE,
  name VARCHAR(128) NOT NULL,
  definition JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_crm_segments_venue ON crm_segments(venue_id);

CREATE TABLE IF NOT EXISTS crm_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id UUID REFERENCES venues(id) ON DELETE CASCADE,
  name VARCHAR(128) NOT NULL,
  channel VARCHAR(16) NOT NULL CHECK (channel IN ('sms', 'email')),
  segment_id UUID REFERENCES crm_segments(id) ON DELETE SET NULL,
  subject TEXT,
  body_text TEXT NOT NULL,
  holdout_pct INT NOT NULL DEFAULT 10,
  attribution_window_days INT NOT NULL DEFAULT 7,
  cost_cents INT NOT NULL DEFAULT 0,
  gross_margin_bps INT NOT NULL DEFAULT 7000,
  status VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'cancelled')),
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_crm_campaigns_venue ON crm_campaigns(venue_id);

CREATE TABLE IF NOT EXISTS crm_campaign_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES crm_campaigns(id) ON DELETE CASCADE,
  guest_id UUID NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  is_holdout BOOLEAN NOT NULL DEFAULT FALSE,
  sent_at TIMESTAMPTZ,
  converted BOOLEAN NOT NULL DEFAULT FALSE,
  converted_revenue_cents INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_crm_deliveries_campaign ON crm_campaign_deliveries(campaign_id);

-- 5. Dining Table Combinations & Floor Enhancements
CREATE TABLE IF NOT EXISTS table_combinations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  name VARCHAR(64) NOT NULL,
  min_capacity INT NOT NULL,
  max_capacity INT NOT NULL,
  table_ids UUID[] NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_table_combinations_venue ON table_combinations(venue_id);

ALTER TABLE dining_tables ADD COLUMN IF NOT EXISTS dining_area_id UUID;
ALTER TABLE dining_tables ADD COLUMN IF NOT EXISTS online_bookable BOOLEAN NOT NULL DEFAULT TRUE;
