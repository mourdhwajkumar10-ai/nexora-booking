/**
 * @nexora/shared
 * Canonical export surface for API, Web, and Domain consumers.
 * Server-only crypto helpers are isolated in '@nexora/shared/node'.
 */

// Foundation & Contracts
export * from './constants';
export * from './schemas';
export * from './fsm';
export * from './allocation';
export * from './realtime';

// Domain Engines
export * from './money';
export * from './time';
export * from './turn';
export * from './claims';
export * from './identity';
export * from './consent';
export * from './stats';
export * from './codes';
export * from './contact';

// Availability (disambiguate AvailabilityQuery with schemas.AvailabilityQuery)
export {
  type ServicePeriod,
  slotMinutes,
  type TableInput,
  type CombinationInput,
  type Occupancy,
  type PacingBooking,
  type AvailabilityQuery as DomainAvailabilityQuery,
  type AllocatedUnit,
  type UnavailableReason,
  type SlotResult,
  allocateBestFit,
  computeAvailability,
  occupancyFor,
  nearestAlternatives,
} from './availability';

// Loyalty (reference + venue progression)
export {
  type Tier,
  type BoosterRule,
  type EarnInput,
  type EarnResult,
  computeEarn,
  type LedgerEntryType,
  type LedgerDelta,
  planEarnAdjustment,
  writeOffPoints,
  TIER_RULES,
  tierFor,
  effectiveTier,
  VOUCHER_DENOMINATIONS_CENTS,
  MAX_ACTIVE_VOUCHERS,
  VOUCHER_TTL_DAYS,
  type VoucherCheck,
  planVoucherHold,
  planVoucherCapture,
  planVoucherRelease,
  PENDING_HOURS,
  settleAt,
  earnAllowedForCheck,
  type TierRule,
  VENUE_TIER_RULES,
  TIER_RULES_LIST,
  tierRule,
  computeTier,
  pointsForSpend,
  pointsToPaise,
  paiseToPoints,
  clawbackPoints,
} from './loyalty';

// POS (avoid collision with constants.AttributionClass)
export {
  type AdjustmentKind,
  type ClassifyInput,
  type ClassifyResult,
  classifyAdjustment,
  type CalcItem,
  type CalcAdjustment,
  DEFAULT_EXCLUDED_CATEGORIES,
  eligibleSpendCents,
  type LinkCheck,
  type LinkReservation,
  findReservationForCheck,
  type CreditMethod,
  type CreditSignals,
  chooseGuestCredit,
} from './pos';

// Floor (avoid collision with constants.FloorStatus)
export {
  type FloorStatus as DomainFloorStatus,
  type FloorAction,
  floorTransition,
  type AlertLevel,
  timerState,
  type UpcomingCandidate,
  upcomingBadge,
  tableFreeAt,
  type WaitTable,
  type WaitParty,
  type WaitQuote,
  quoteWaitlist,
} from './floor';

// Reservation (avoid collision with constants.ReservationStatus)
export {
  type ReservationStatus as DomainReservationStatus,
  type ReservationEvent,
  type Actor,
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  TRANSITIONS,
  EVENT_ACTORS,
  type Effect,
  type ReservationSnapshot,
  type TransitionContext,
  type ReservationPatch,
  type TransitionError,
  type TransitionResult,
  nextStatus,
  applyEvent,
  applyReservationEvent,
  confirmNoShow,
  lateMarkAt,
  systemNoShowAt,
  requestExpiresAt,
  HOLD_PENDING_MINUTES,
  holdExpiresAt,
  bookingModeFor,
  type ApiReservationStatus,
  toDomainStatus,
  toApiStatus,
  toDomainReservationStatus,
  toDbReservationStatus,
} from './reservation';
