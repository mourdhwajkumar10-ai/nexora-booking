/** Canonical enums shared by API, DB and UI. Values match the Postgres enum labels. */

export const TABLE_STATUSES = ['AVAILABLE', 'OCCUPIED', 'BUSSING', 'BLOCKED'] as const;
export type TableStatus = (typeof TABLE_STATUSES)[number];

/** Floor-view status: physical status plus the time-derived RESERVED state (see CRITIQUE #3). */
export const FLOOR_STATUSES = ['AVAILABLE', 'RESERVED', 'OCCUPIED', 'BUSSING', 'BLOCKED'] as const;
export type FloorStatus = (typeof FLOOR_STATUSES)[number];

export const RESERVATION_STATUSES = [
  'REQUESTED',
  'CONFIRMED',
  'SEATED',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

/** Statuses that hold table inventory (PRD: Requested, Confirmed, Seated). */
export const ACTIVE_RESERVATION_STATUSES: readonly ReservationStatus[] = ['REQUESTED', 'CONFIRMED', 'SEATED'];

export const RESERVATION_SOURCES = ['ONLINE', 'PHONE', 'WALK_IN'] as const;
export type ReservationSource = (typeof RESERVATION_SOURCES)[number];

export const ORDER_STATUSES = [
  'PLACED',
  'RECEIVED',
  'PREPARING',
  'SERVED',
  'BILLED',
  'VOIDED',
  'PARTIALLY_PAID',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const STAFF_ROLES = ['HOST', 'MANAGER'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const TIER_LEVELS = ['BASE', 'MEMBER', 'REGULAR', 'FRIENDS_AND_FAMILY'] as const;
export type TierLevel = (typeof TIER_LEVELS)[number];

export const LEDGER_EVENTS = ['ACCRUAL', 'REDEMPTION', 'PRELOAD', 'REVERSAL', 'EXPIRED'] as const;
export type LedgerEvent = (typeof LEDGER_EVENTS)[number];

export const LEDGER_STATES = ['PENDING', 'SETTLED', 'REVERSED', 'REDEEMED'] as const;
export type LedgerState = (typeof LEDGER_STATES)[number];

export const DINING_ZONES = ['MAIN', 'PATIO', 'BAR', 'PRIVATE'] as const;
export type DiningZone = (typeof DINING_ZONES)[number];

export const SEATING_PREFERENCES = ['ANY', 'BOOTH', 'WINDOW', 'QUIET', 'PATIO'] as const;
export type SeatingPreference = (typeof SEATING_PREFERENCES)[number];

export const VOID_REASONS = [
  'GUEST_REJECTED',
  'PREPARATION_DEFECT',
  'PROMOTIONAL_COMP',
  'SPILL',
  'KITCHEN_ERROR',
  'BILLING_ERROR',
] as const;
export type VoidReason = (typeof VOID_REASONS)[number];

export const MENU_CATEGORIES = ['STARTER', 'ENTREE', 'DESSERT', 'BEVERAGE', 'WINE', 'PREMIUM'] as const;
export type MenuCategory = (typeof MENU_CATEGORIES)[number];

/** Business constants (see docs/ARCHITECTURE.md §Formulas). */
export const SLOT_INTERVAL_MINS = 15;
export const DEFAULT_TURNAROUND_MINS = 30;
export const DEFAULT_GRACE_PERIOD_MINS = 15;
export const DEFAULT_TRIAGE_TIMEOUT_SECS = 300;
/** Dwell escalation: amber at turnaround (30m), red at turnaround + 15 (45m). */
export const DWELL_RED_EXTRA_MINS = 15;
/** Walk-ins realistically overstay: collision window = turnaround + this buffer (CRITIQUE #17). */
export const WALK_IN_BUFFER_MINS = 15;
export const MAX_PARTY_SIZE = 4;
export const MIN_PARTY_SIZE = 1;
export const GIFT_CARD_HOLD_SECS = 120;
export const POINTS_PER_RUPEE_UNIT = 100; // 100 points = ₹1
export const GOOD_STANDING_LOOKBACK_DAYS = 90;
export const MAX_ACTIVE_REQUESTS_PER_PHONE = 2;
export const WEBHOOK_RETRY_SCHEDULE_SECS = [1, 5, 30, 300, 3600] as const;
