/**
 * BR-08 Reservation state machine. Pure: returns the new status, a patch of fields to write
 * and a list of side effects for the service layer to perform in the same transaction
 * (or enqueue as jobs). Table release on terminal states is ALSO enforced by a DB trigger.
 */
import type { IsoDate } from './time';

export type ReservationStatus = 'requested' | 'confirmed' | 'arrived' | 'late' | 'seated' | 'completed' | 'cancelled' | 'no_show';

export type ReservationEvent =
  | 'confirm'
  | 'decline'
  | 'expire'
  | 'cancel_guest'
  | 'cancel_venue'
  | 'arrive'
  | 'mark_late'
  | 'seat'
  | 'complete'
  | 'mark_no_show'
  | 'reinstate';

export type Actor = 'guest' | 'staff' | 'system';

export const ACTIVE_STATUSES: ReadonlyArray<ReservationStatus> = ['requested', 'confirmed', 'arrived', 'late', 'seated'];
export const TERMINAL_STATUSES: ReadonlyArray<ReservationStatus> = ['completed', 'cancelled', 'no_show'];

export const TRANSITIONS: Readonly<Record<ReservationStatus, Partial<Record<ReservationEvent, ReservationStatus>>>> = {
  requested: { confirm: 'confirmed', decline: 'cancelled', expire: 'cancelled', cancel_guest: 'cancelled', cancel_venue: 'cancelled' },
  confirmed: { cancel_guest: 'cancelled', cancel_venue: 'cancelled', arrive: 'arrived', mark_late: 'late', seat: 'seated', mark_no_show: 'no_show' },
  arrived: { cancel_guest: 'cancelled', cancel_venue: 'cancelled', seat: 'seated' },
  late: { arrive: 'arrived', seat: 'seated', cancel_guest: 'cancelled', cancel_venue: 'cancelled', mark_no_show: 'no_show' },
  seated: { complete: 'completed' },
  completed: {},
  cancelled: {},
  no_show: { reinstate: 'arrived' },
};

/** Which actors may send which events. Staff may cancel on a guest's behalf (phone call). */
export const EVENT_ACTORS: Readonly<Record<ReservationEvent, ReadonlyArray<Actor>>> = {
  // 'system' confirms instant bookings once the card hold is secured (Stripe setup_intent.succeeded).
  confirm: ['staff', 'system'],
  decline: ['staff'],
  expire: ['system'],
  cancel_guest: ['guest', 'staff'],
  cancel_venue: ['staff'],
  arrive: ['staff', 'system'],
  mark_late: ['staff', 'system'],
  seat: ['staff'],
  complete: ['staff', 'system'],
  mark_no_show: ['staff', 'system'],
  reinstate: ['staff'],
};

export type Effect =
  | 'notify_confirmed'
  | 'notify_declined'
  | 'notify_cancelled'
  | 'notify_request_expired'
  | 'notify_late_prompt'
  | 'tables_occupied'
  | 'tables_bussing'
  | 'evaluate_late_cancel_fee'
  | 'recompute_guest_stats'
  | 'emit_floor_event';

export interface ReservationSnapshot {
  status: ReservationStatus;
  startsAtMs: number;
  serviceDate: IsoDate;
  arrivedAtMs: number | null;
  noShowConfirmedAtMs: number | null;
}

export interface TransitionContext {
  nowMs: number;
  actor: Actor;
  /** Service date "today" at the venue (BR-02 serviceDateFor(now)). */
  todayServiceDate: IsoDate;
  lateCancelWindowHours: number;
}

export interface ReservationPatch {
  status: ReservationStatus;
  arrivedAt?: number | null;
  seatedAt?: number;
  completedAt?: number;
  cancelledAt?: number;
  cancelledBy?: 'guest' | 'venue' | 'system';
  cancelReason?: string;
  lateCancel?: boolean;
  lateMarkedAt?: number;
  noShowAt?: number | null;
  noShowSource?: 'host' | 'system' | null;
}

export type TransitionError = 'INVALID_TRANSITION' | 'ACTOR_NOT_ALLOWED' | 'TOO_EARLY_FOR_NO_SHOW' | 'REINSTATE_NOT_ALLOWED';

export type TransitionResult =
  | { ok: true; to: ReservationStatus; patch: ReservationPatch; effects: Effect[] }
  | { ok: false; error: TransitionError };

export function nextStatus(from: ReservationStatus, event: ReservationEvent): ReservationStatus | null {
  return TRANSITIONS[from][event] ?? null;
}

export function applyEvent(r: ReservationSnapshot, event: ReservationEvent, ctx: TransitionContext): TransitionResult {
  if (!EVENT_ACTORS[event].includes(ctx.actor)) return { ok: false, error: 'ACTOR_NOT_ALLOWED' };
  const to = nextStatus(r.status, event);
  if (!to) return { ok: false, error: 'INVALID_TRANSITION' };
  const now = ctx.nowMs;
  const patch: ReservationPatch = { status: to };
  const effects: Effect[] = ['emit_floor_event'];

  switch (event) {
    case 'confirm':
      effects.push('notify_confirmed');
      break;
    case 'decline':
      Object.assign(patch, { cancelledAt: now, cancelledBy: 'venue', cancelReason: 'declined' });
      effects.push('notify_declined');
      break;
    case 'expire':
      Object.assign(patch, { cancelledAt: now, cancelledBy: 'system', cancelReason: 'request_expired' });
      effects.push('notify_request_expired');
      break;
    case 'cancel_guest': {
      const late = r.status !== 'requested' && now > r.startsAtMs - ctx.lateCancelWindowHours * 3_600_000;
      Object.assign(patch, { cancelledAt: now, cancelledBy: 'guest', cancelReason: 'guest_cancelled', lateCancel: late });
      effects.push('notify_cancelled');
      if (late) effects.push('evaluate_late_cancel_fee', 'recompute_guest_stats');
      break;
    }
    case 'cancel_venue':
      Object.assign(patch, { cancelledAt: now, cancelledBy: 'venue', cancelReason: 'venue_cancelled' });
      effects.push('notify_cancelled');
      break;
    case 'arrive':
      patch.arrivedAt = r.arrivedAtMs ?? now;
      break;
    case 'mark_late':
      patch.lateMarkedAt = now;
      effects.push('notify_late_prompt');
      break;
    case 'seat':
      patch.seatedAt = now;
      patch.arrivedAt = r.arrivedAtMs ?? now;
      effects.push('tables_occupied');
      break;
    case 'complete':
      patch.completedAt = now;
      effects.push('tables_bussing', 'recompute_guest_stats');
      break;
    case 'mark_no_show':
      if (now < r.startsAtMs) return { ok: false, error: 'TOO_EARLY_FOR_NO_SHOW' };
      patch.noShowAt = now;
      patch.noShowSource = ctx.actor === 'system' ? 'system' : 'host';
      break;
    case 'reinstate':
      if (r.noShowConfirmedAtMs !== null || ctx.todayServiceDate !== r.serviceDate) return { ok: false, error: 'REINSTATE_NOT_ALLOWED' };
      Object.assign(patch, { noShowAt: null, noShowSource: null, arrivedAt: now });
      break;
  }
  return { ok: true, to, patch, effects };
}

/**
 * Confirming a no-show is a separate staff action (not a status change). Only confirmed
 * no-shows count in guest stats and may trigger a no-show fee.
 */
export function confirmNoShow(r: ReservationSnapshot & { status: ReservationStatus }, actor: Actor):
  | { ok: true; effects: Array<'recompute_guest_stats' | 'evaluate_no_show_fee'> }
  | { ok: false; error: 'INVALID_TRANSITION' | 'ACTOR_NOT_ALLOWED' | 'ALREADY_CONFIRMED' } {
  if (actor !== 'staff') return { ok: false, error: 'ACTOR_NOT_ALLOWED' };
  if (r.status !== 'no_show') return { ok: false, error: 'INVALID_TRANSITION' };
  if (r.noShowConfirmedAtMs !== null) return { ok: false, error: 'ALREADY_CONFIRMED' };
  return { ok: true, effects: ['recompute_guest_stats', 'evaluate_no_show_fee'] };
}

/** System job timings (BR-08). All in epoch ms. */
export function lateMarkAt(startsAtMs: number, graceMinutes: number): number {
  return startsAtMs + graceMinutes * 60_000;
}

export function systemNoShowAt(startsAtMs: number, noShowCutoffMinutes: number): number {
  return startsAtMs + noShowCutoffMinutes * 60_000;
}

/** Request-to-book expiry: the earlier of created + slaHours and start - 2 hours. */
export function requestExpiresAt(createdAtMs: number, startsAtMs: number, slaHours = 24): number {
  return Math.min(createdAtMs + slaHours * 3_600_000, startsAtMs - 2 * 3_600_000);
}

/**
 * Instant bookings that require a card hold are created as status 'requested' with hold_status 'required'
 * and expire (event 'expire', reason 'card_not_provided') if the card is not secured within 15 minutes.
 */
export const HOLD_PENDING_MINUTES = 15;

export function holdExpiresAt(createdAtMs: number): number {
  return createdAtMs + HOLD_PENDING_MINUTES * 60_000;
}

/** Booking mode for a party (BR-06). */
export function bookingModeFor(
  partySize: number,
  settings: { defaultMode: 'instant' | 'request'; requestToBookMinParty: number | null; maxPartyOnline: number },
): 'instant' | 'request' | 'too_large' {
  if (partySize > settings.maxPartyOnline) return 'too_large';
  if (settings.defaultMode === 'request') return 'request';
  if (settings.requestToBookMinParty !== null && partySize >= settings.requestToBookMinParty) return 'request';
  return 'instant';
}

/* =========================================================================
 * Uppercase & Bidirectional Mapping Helpers
 * ========================================================================= */

export type ApiReservationStatus =
  | 'REQUESTED'
  | 'CONFIRMED'
  | 'ARRIVED'
  | 'SEATED'
  | 'LATE'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'NO_SHOW';

export function toUpperReservationStatus(status: string): ApiReservationStatus {
  return status.toUpperCase() as ApiReservationStatus;
}

export function toLowerReservationStatus(status: string): ReservationStatus {
  return status.toLowerCase() as ReservationStatus;
}

export const toDomainStatus = toLowerReservationStatus;
export const toApiStatus = toUpperReservationStatus;
export const toDomainReservationStatus = toLowerReservationStatus;
export const toDbReservationStatus = toUpperReservationStatus;

export function applyReservationEvent(
  snapshot: ReservationSnapshot,
  event: ReservationEvent,
  ctx: TransitionContext,
): TransitionResult {
  return applyEvent(snapshot, event, ctx);
}
