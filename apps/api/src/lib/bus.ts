/**
 * In-process domain event bus. Events are collected inside a transaction (tx.emit) and
 * published after COMMIT. Handlers are awaited (keeps request flows and tests deterministic)
 * but a failing handler never fails the originating request.
 */
import type { AlertDto, NotificationDto, OrderStatus, ReservationStatus } from '@nexora/shared';

export type DomainEvent =
  | {
      type: 'reservation.changed';
      venueId: string;
      reservationId: string;
      guestId: string;
      tableId: string | null;
      from: ReservationStatus | null;
      to: ReservationStatus;
    }
  | { type: 'table.changed'; venueId: string; tableIds: string[] }
  | { type: 'order.changed'; venueId: string; orderId: string; tableId: string; status: OrderStatus }
  | {
      type: 'order.billed';
      venueId: string;
      orderId: string;
      tableId: string;
      guestId: string | null;
      reservationId: string | null;
      netPaise: number;
    }
  | {
      type: 'order.adjusted';
      venueId: string;
      orderId: string;
      guestId: string | null;
      kind: 'VOID' | 'COMP' | 'REFUND';
      amountPaise: number;
      postSettlement: boolean;
    }
  | { type: 'guest.arrived'; venueId: string; guestId: string; reservationId: string | null }
  | { type: 'alert.created'; alert: AlertDto }
  | { type: 'notification.sent'; venueId: string; notification: NotificationDto };

type EventOf<T extends DomainEvent['type']> = Extract<DomainEvent, { type: T }>;
type Handler<T extends DomainEvent['type']> = (e: EventOf<T>) => Promise<void> | void;

const handlers = new Map<string, Handler<any>[]>();

export function on<T extends DomainEvent['type']>(type: T, handler: Handler<T>): () => void {
  const list = handlers.get(type) ?? [];
  list.push(handler);
  handlers.set(type, list);
  return () => handlers.set(type, (handlers.get(type) ?? []).filter((h) => h !== handler));
}

export async function publish(events: DomainEvent[]): Promise<void> {
  for (const e of events) {
    for (const h of handlers.get(e.type) ?? []) {
      try {
        await h(e);
      } catch (err) {
        console.error(`[bus] handler for ${e.type} failed`, err);
      }
    }
  }
}

export function clearHandlers(): void {
  handlers.clear();
}
