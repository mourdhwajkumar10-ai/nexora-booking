/**
 * API contract: zod request schemas + response DTO types for /api/v1.
 * Money is always integer paise (INR). Timestamps are ISO-8601 UTC strings.
 * Venue-local dates are "YYYY-MM-DD", venue-local times are "HH:mm".
 */
import { z } from 'zod';
import {
  DINING_ZONES,
  MAX_PARTY_SIZE,
  MENU_CATEGORIES,
  MIN_PARTY_SIZE,
  ORDER_STATUSES,
  SEATING_PREFERENCES,
  VOID_REASONS,
  type FloorStatus,
  type OrderStatus,
  type ReservationSource,
  type ReservationStatus,
  type StaffRole,
  type TableStatus,
  type TierLevel,
} from './constants';
import type { DwellLevel } from './time';

// ---------- primitives ----------
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
export const zTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm');
export const zPhone = z
  .string()
  .trim()
  .transform((s) => s.replace(/[\s()-]/g, ''))
  .pipe(z.string().regex(/^\+?\d{10,15}$/, 'Enter a valid phone number'));
export const zPartySize = z.coerce.number().int().min(MIN_PARTY_SIZE).max(MAX_PARTY_SIZE);
export const zUuid = z.string().uuid();
export const zPaise = z.coerce.number().int().min(0);
export const zMac = z
  .string()
  .regex(/^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/, 'Invalid MAC address');

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

// ---------- public / consumer ----------
export interface Locality {
  id: string;
  slug: string;
  name: string; // "Cyber City"
  city: string; // "Gurgaon"
  label: string; // "Cyber City, Gurgaon"
}

export interface VenueCard {
  id: string;
  slug: string;
  name: string;
  localityId: string;
  localityLabel: string;
  address: string;
  cuisines: string[];
  rating: number;
  ratingCount: number;
  imageUrl: string;
  costForOnePaise: number;
  costForTwoPaise: number;
  isOpenNow: boolean;
  acceptingBookings: boolean; // false when in blackout mode
  todayHours: { openTime: string; closeTime: string }[];
}

export interface ShiftDto {
  dayOfWeek: number;
  openTime: string;
  closeTime: string;
}

export interface VenueDetail extends VenueCard {
  description: string;
  timezone: string;
  turnaroundMins: number;
  gracePeriodMins: number;
  shifts: ShiftDto[];
}

export const AvailabilityQuery = z.object({ date: zDate, partySize: zPartySize });
export type AvailabilityQuery = z.infer<typeof AvailabilityQuery>;

export interface SlotAvailability {
  time: string; // "HH:mm" venue-local
  startAt: string;
  endAt: string;
  available: boolean;
  tablesLeft: number;
  past: boolean;
}

export interface AvailabilityResponse {
  venueId: string;
  date: string;
  partySize: number;
  turnaroundMins: number;
  closed: boolean; // no shifts that day
  blackout: boolean;
  slots: SlotAvailability[];
  serverTime: string;
}

export const CreateBookingInput = z.object({
  date: zDate,
  time: zTime,
  partySize: zPartySize,
  fullName: z.string().trim().min(2).max(120),
  phone: zPhone,
  email: z.string().trim().email().max(255).optional().or(z.literal('').transform(() => undefined)),
  dietaryRequests: z.string().trim().max(500).optional(),
  seatingPreference: z.enum(SEATING_PREFERENCES).optional(),
  notes: z.string().trim().max(500).optional(),
});
export type CreateBookingInput = z.infer<typeof CreateBookingInput>;

export interface PublicReservation {
  token: string;
  status: ReservationStatus;
  venue: { slug: string; name: string; address: string; localityLabel: string; imageUrl: string };
  date: string;
  time: string;
  startAt: string;
  endAt: string;
  partySize: number;
  guestName: string;
  phoneMasked: string; // "••••••3210"
  tableNumber: string | null; // revealed once CONFIRMED
  createdAt: string;
  confirmedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
}

/** 409 body for SLOT_UNAVAILABLE: error.details = { alternatives: string[] } ("HH:mm" list). */
export interface SlotConflictDetails {
  alternatives: string[];
}

export const CancelBookingInput = z.object({ phoneLast4: z.string().regex(/^\d{4}$/) });

// ---------- auth ----------
export const LoginInput = z.object({ email: z.string().email(), password: z.string().min(6) });
export interface StaffUser {
  id: string;
  email: string;
  name: string;
  role: StaffRole;
  venueId: string | null; // null = org-wide access
}
export interface MeResponse {
  user: StaffUser;
  venues: { id: string; slug: string; name: string; localityLabel: string }[];
}

// ---------- venue admin (A1) ----------
export interface VenueSettings extends VenueDetail {
  isActive: boolean;
  blackout: boolean;
  blackoutReason: string | null;
  allowUpsizeFallback: boolean;
  triageTimeoutSecs: number;
}

export const UpdateVenueInput = z
  .object({
    name: z.string().trim().min(2).max(255),
    description: z.string().max(2000),
    turnaroundMins: z.coerce.number().int().min(15).max(240).multipleOf(15),
    gracePeriodMins: z.coerce.number().int().min(5).max(60),
    triageTimeoutSecs: z.coerce.number().int().min(60).max(3600),
    allowUpsizeFallback: z.boolean(),
    costForOnePaise: z.coerce.number().int().positive(),
    costForTwoPaise: z.coerce.number().int().positive(),
    isActive: z.boolean(),
  })
  .partial();
export type UpdateVenueInput = z.infer<typeof UpdateVenueInput>;

export const BlackoutInput = z.object({ enabled: z.boolean(), reason: z.string().max(200).optional() });

export const ShiftInput = z
  .object({ dayOfWeek: z.number().int().min(0).max(6), openTime: zTime, closeTime: zTime })
  .refine((s) => s.openTime !== s.closeTime, 'Open and close cannot be equal')
  .refine((s) => Number(s.openTime.slice(3)) % 15 === 0 && Number(s.closeTime.slice(3)) % 15 === 0, 'Times must be on 15-minute boundaries');
export const ReplaceShiftsInput = z.object({ shifts: z.array(ShiftInput).max(28) });

export interface DiningTableDto {
  id: string;
  venueId: string;
  tableNumber: string;
  diningZone: string;
  minCapacity: number;
  maxCapacity: number;
  status: TableStatus;
  statusChangedAt: string;
  upcomingReservations: number; // active reservations with end_at > now
}

const TableBase = z.object({
  tableNumber: z.string().trim().min(1).max(32).regex(/^[A-Za-z0-9-]+$/, 'Alphanumeric identifier'),
  diningZone: z.enum(DINING_ZONES).default('MAIN'),
  minCapacity: z.coerce.number().int().min(1).max(20),
  maxCapacity: z.coerce.number().int().min(1).max(20),
});
export const CreateTableInput = TableBase.refine((t) => t.maxCapacity >= t.minCapacity, {
  message: 'max_capacity must be >= min_capacity',
  path: ['maxCapacity'],
});
export const UpdateTableInput = TableBase.partial();

export interface MenuItemDto {
  id: string;
  venueId: string;
  name: string;
  category: string;
  pricePaise: number;
  isAvailable: boolean;
}
export const CreateMenuItemInput = z.object({
  name: z.string().trim().min(1).max(255),
  category: z.enum(MENU_CATEGORIES),
  pricePaise: z.coerce.number().int().positive(),
});

export interface AuditLogDto {
  id: string;
  actor: string;
  action: string;
  entity: string;
  entityId: string | null;
  data: unknown;
  createdAt: string;
}

// ---------- reservations (A2) ----------
export interface AdminReservation {
  id: string;
  token: string;
  venueId: string;
  status: ReservationStatus;
  source: ReservationSource;
  date: string;
  time: string;
  startAt: string;
  endAt: string;
  partySize: number;
  table: { id: string; tableNumber: string; maxCapacity: number } | null;
  guest: {
    id: string;
    name: string;
    phone: string;
    email: string | null;
    tags: string[];
    allergies: string | null;
    tier: TierLevel | null;
    noShowCount: number;
    totalVisits: number;
  };
  dietaryRequests: string | null;
  seatingPreference: string | null;
  notes: string | null;
  escalatedAt: string | null;
  triageDeadline: string | null; // created_at + triage timeout (REQUESTED only)
  createdAt: string;
  confirmedAt: string | null;
  seatedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
}

export const ListReservationsQuery = z.object({
  date: zDate.optional(),
  status: z.string().optional(), // comma separated statuses
});

export const HostBookingInput = CreateBookingInput.extend({
  tableId: zUuid.optional(),
  autoConfirm: z.boolean().default(true),
  source: z.enum(['PHONE', 'ONLINE']).default('PHONE'),
});
export type HostBookingInput = z.infer<typeof HostBookingInput>;

export const ReasonInput = z.object({ reason: z.string().trim().max(200).optional() });
export const ReassignInput = z.object({ tableId: zUuid });

export interface NotificationDto {
  id: string;
  channel: 'SMS' | 'WHATSAPP';
  template: string;
  to: string;
  body: string;
  status: 'PENDING' | 'SENT' | 'FAILED';
  reservationId: string | null;
  createdAt: string;
  sentAt: string | null;
}

// ---------- floor & orders (A3) ----------
export interface FloorTable {
  id: string;
  tableNumber: string;
  diningZone: string;
  minCapacity: number;
  maxCapacity: number;
  physicalStatus: TableStatus;
  floorStatus: FloorStatus;
  statusChangedAt: string;
  current: {
    reservationId: string;
    guestId: string;
    guestName: string;
    partySize: number;
    seatedAt: string;
    tags: string[];
    allergies: string | null;
    source: ReservationSource;
  } | null;
  order: {
    id: string;
    status: OrderStatus;
    placedAt: string;
    receivedAt: string | null;
    itemCount: number;
    netPaise: number;
  } | null;
  next: {
    reservationId: string;
    guestName: string;
    partySize: number;
    startAt: string;
    status: ReservationStatus;
  } | null;
  dwell: { seatedAt: string; elapsedSecs: number; level: DwellLevel } | null;
}

export interface FloorSnapshot {
  serverTime: string;
  venue: { id: string; name: string; turnaroundMins: number; gracePeriodMins: number; blackout: boolean; timezone: string };
  counts: Record<FloorStatus, number>;
  covers: { seated: number; capacity: number };
  tables: FloorTable[];
}

export const WalkInCheckInput = z.object({ partySize: zPartySize, tableId: zUuid.optional() });
export interface WalkInCheckResponse {
  ok: boolean;
  tableId: string | null;
  conflicts: { tableId: string; tableNumber: string; reservationId: string; guestName: string; startAt: string }[];
  message: string | null; // "Collision Alert: Table 4 reserved for John Doe at 7:15 PM…"
  suggestions: { tableId: string; tableNumber: string; maxCapacity: number }[];
}

export const WalkInInput = z.object({
  partySize: zPartySize,
  tableId: zUuid,
  guestName: z.string().trim().max(120).optional(),
  phone: zPhone.optional(),
  override: z.boolean().default(false),
});

export const TableStatusInput = z.object({
  status: z.enum(['AVAILABLE', 'BLOCKED', 'BUSSING']),
  reason: z.string().max(200).optional(),
});

export interface OrderItemDto {
  id: string;
  itemName: string;
  category: string;
  quantity: number;
  unitPricePaise: number;
  notes: string | null;
  isVoided: boolean;
  lineTotalPaise: number;
}

export interface OrderDetail {
  id: string;
  venueId: string;
  tableId: string;
  tableNumber: string;
  reservationId: string | null;
  guestId: string | null;
  guestName: string | null;
  posExternalId: string | null;
  status: OrderStatus;
  placedAt: string;
  receivedAt: string | null;
  preparingAt: string | null;
  servedAt: string | null;
  settledAt: string | null;
  grossPaise: number;
  discountPaise: number; // voids + comps
  netPaise: number;
  paidPaise: number;
  items: OrderItemDto[];
  voids: { id: string; kind: 'VOID' | 'COMP' | 'REFUND'; reason: string; authorizedBy: string; amountPaise: number; postSettlement: boolean; createdAt: string }[];
  serverTime: string;
}

export const AddOrderItemInput = z.object({
  menuItemId: zUuid.optional(),
  itemName: z.string().trim().min(1).max(255),
  category: z.enum(MENU_CATEGORIES),
  quantity: z.coerce.number().int().min(1).max(99),
  unitPricePaise: z.coerce.number().int().positive(),
  notes: z.string().max(300).optional(),
});

export const OrderStatusInput = z.object({ status: z.enum(ORDER_STATUSES) });

export const TenderInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('CASH'), amountPaise: z.number().int().positive() }),
  z.object({ type: z.literal('CARD'), amountPaise: z.number().int().positive(), simulateDecline: z.boolean().optional() }),
  z.object({ type: z.literal('GIFT_CARD'), amountPaise: z.number().int().positive(), cardNumber: z.string().min(8).max(32), simulateTimeout: z.boolean().optional() }),
  z.object({ type: z.literal('POINTS'), points: z.number().int().positive() }),
  z.object({ type: z.literal('WALLET'), amountPaise: z.number().int().positive() }),
]);
export type TenderInput = z.infer<typeof TenderInput>;
export const SettleOrderInput = z.object({ tenders: z.array(TenderInput).min(1).max(5) });

export interface SettleResult {
  order: OrderDetail;
  outcome: 'BILLED' | 'PARTIALLY_PAID';
  message: string | null; // "Tender Failed: Gift Card Unreachable. Folio Remaining: ₹1,000"
  pointsEarned: number;
}

export interface AlertDto {
  id: string;
  venueId: string;
  kind: 'TRIAGE_ESCALATION' | 'DWELL_AMBER' | 'DWELL_RED' | 'GUEST_ARRIVED' | 'LOYALTY_DEFICIT' | 'NO_SHOW' | 'AUTO_MIGRATED' | 'WEBHOOK_DEAD';
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  data: Record<string, unknown>;
  acknowledgedAt: string | null;
  createdAt: string;
}

// ---------- guests / CRM / wifi / POS / loyalty (A4) ----------
export interface GuestSummary {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  tags: string[];
  tier: TierLevel;
  totalVisits: number;
  lifetimeSpendPaise: number;
  lastVisitAt: string | null;
  hasAllergies: boolean;
}

export interface GuestProfileDto extends GuestSummary {
  firstName: string;
  lastName: string;
  avgPartySize: number;
  noShowCount: number;
  totalVoidsCount: number;
  totalVoidsValuePaise: number;
  seatingPreference: string;
  dietaryNotes: string | null;
  allergies: string | null;
  flags: string[];
  tagDetails: { tagName: string; isAutoGenerated: boolean; createdAt: string }[];
  devices: { mac: string; firstSeenAt: string; lastSeenAt: string }[];
  itemAffinities: { itemName: string; quantity: number }[];
  loyalty: {
    accountId: string;
    tier: TierLevel;
    pointsBalance: number;
    walletBalancePaise: number;
    annualSpendPaise: number;
    multiplier: number;
  };
  reservations: { id: string; venueName: string; startAt: string; partySize: number; status: ReservationStatus }[];
  createdAt: string;
}

export const UpdateGuestInput = z
  .object({
    firstName: z.string().trim().min(1).max(128),
    lastName: z.string().trim().max(128),
    email: z.string().email().nullable(),
    seatingPreference: z.enum(SEATING_PREFERENCES),
    dietaryNotes: z.string().max(1000).nullable(),
    allergies: z.string().max(500).nullable(),
  })
  .partial();

export const TagInput = z.object({ tagName: z.string().trim().min(2).max(64).transform((s) => s.toUpperCase().replace(/\s+/g, '_')) });

export const WalletPreloadInput = z.object({ amountPaise: z.number().int().positive().max(10_00_000_00) });

export interface LedgerEntryDto {
  id: string;
  eventType: string;
  state: string;
  pointsDelta: number;
  amountPaise: number;
  referenceType: string | null;
  referenceId: string | null;
  note: string | null;
  createdAt: string;
}

export const WifiOtpInput = z.object({ phone: zPhone });
export const WifiConnectInput = z.object({
  firstName: z.string().trim().min(1).max(128),
  lastName: z.string().trim().min(1).max(128),
  phone: zPhone,
  email: z.string().trim().email().optional().or(z.literal('').transform(() => undefined)),
  otp: z.string().regex(/^\d{6}$/),
  mac: zMac,
  apId: z.string().max(64).optional(),
  marketingOptIn: z.boolean().default(false),
  consent: z.literal(true, { error: 'Consent is required to connect' }),
});
export interface WifiConnectResponse {
  access: 'ACCEPT';
  guestName: string;
  tier: TierLevel;
  isNewGuest: boolean;
  matchedReservation: { id: string; time: string; tableNumber: string | null } | null;
}

export const POS_EVENT_TYPES = ['ticket.updated', 'order.item_voided', 'order.comp_applied', 'order.refunded'] as const;
export type PosEventType = (typeof POS_EVENT_TYPES)[number];

export const PosWebhookBody = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ticket.updated'),
    eventId: z.string().min(1),
    orderId: zUuid,
    posExternalId: z.string().max(128).optional(),
    items: z.array(AddOrderItemInput.omit({ menuItemId: true })).min(1),
  }),
  z.object({
    type: z.literal('order.item_voided'),
    eventId: z.string().min(1),
    orderId: zUuid,
    orderItemId: zUuid,
    reason: z.enum(VOID_REASONS),
    authorizedBy: z.string().min(1).max(128),
  }),
  z.object({
    type: z.literal('order.comp_applied'),
    eventId: z.string().min(1),
    orderId: zUuid,
    amountPaise: z.number().int().positive(),
    reason: z.enum(VOID_REASONS),
    authorizedBy: z.string().min(1).max(128),
  }),
  z.object({
    type: z.literal('order.refunded'),
    eventId: z.string().min(1),
    orderId: zUuid,
    orderItemId: zUuid,
    reason: z.enum(VOID_REASONS),
    authorizedBy: z.string().min(1).max(128),
  }),
]);
export type PosWebhookBody = z.infer<typeof PosWebhookBody>;

export interface WebhookEventDto {
  id: string;
  source: string;
  idempotencyKey: string;
  eventType: string;
  status: 'RECEIVED' | 'PROCESSED' | 'FAILED' | 'DEAD';
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  createdAt: string;
  processedAt: string | null;
}

export const PosSimulateInput = z.object({
  body: PosWebhookBody,
  /** Reuse an idempotency key to demonstrate duplicate suppression. */
  idempotencyKey: z.string().optional(),
  /** Force the handler to fail N times to demonstrate retry/DLQ. */
  failTimes: z.number().int().min(0).max(10).optional(),
});

export const IssueGiftCardInput = z.object({
  amountPaise: z.number().int().positive().max(1_00_000_00),
  purchasedByGuestId: zUuid.optional(),
});
export interface GiftCardDto {
  id: string;
  last4: string;
  balancePaise: number;
  purchasedBy: string | null;
  createdAt: string;
  cardNumber?: string; // only returned once on issue
}
export const GiftCardAuthorizeInput = z.object({
  cardNumber: z.string().min(8).max(32),
  amountPaise: z.number().int().positive(),
  orderId: zUuid,
});
export interface GiftCardAuthorizeResponse {
  approved: boolean;
  holdToken: string;
  expiresAt: string;
  availablePaise: number;
}
