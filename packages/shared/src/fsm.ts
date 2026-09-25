/** Deterministic finite-state machines (Architecture §Finite State Machine Models). */
import type { OrderStatus, ReservationStatus, TableStatus } from './constants';

export const RESERVATION_TRANSITIONS: Record<ReservationStatus, readonly ReservationStatus[]> = {
  REQUESTED: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['SEATED', 'CANCELLED', 'NO_SHOW'],
  SEATED: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
};

/** Physical table lifecycle. RESERVED is derived, not stored (CRITIQUE #3). */
export const TABLE_TRANSITIONS: Record<TableStatus, readonly TableStatus[]> = {
  AVAILABLE: ['OCCUPIED', 'BLOCKED'],
  OCCUPIED: ['BUSSING', 'BLOCKED'],
  BUSSING: ['AVAILABLE', 'BLOCKED'],
  BLOCKED: ['AVAILABLE'],
};

export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PLACED: ['RECEIVED', 'VOIDED'],
  RECEIVED: ['PREPARING', 'VOIDED'],
  PREPARING: ['SERVED', 'VOIDED'],
  SERVED: ['BILLED', 'PARTIALLY_PAID', 'VOIDED'],
  PARTIALLY_PAID: ['BILLED', 'VOIDED'],
  BILLED: [],
  VOIDED: [],
};

export function canTransition<S extends string>(map: Record<S, readonly S[]>, from: S, to: S): boolean {
  return map[from]?.includes(to) ?? false;
}

export class IllegalTransitionError extends Error {
  constructor(
    public readonly entity: string,
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Illegal ${entity} transition ${from} -> ${to}`);
  }
}

export function assertTransition<S extends string>(entity: string, map: Record<S, readonly S[]>, from: S, to: S): void {
  if (!canTransition(map, from, to)) throw new IllegalTransitionError(entity, from, to);
}
