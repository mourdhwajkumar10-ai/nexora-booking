/** Socket.IO contract. Staff sockets join `venue:<id>`; consumer tracker joins `booking:<token>`. */
import type { AdminReservation, AlertDto, NotificationDto } from './schemas';
import type { ReservationStatus } from './constants';

export const SOCKET_PATH = '/socket.io';

export interface ServerToClientEvents {
  'server:time': (p: { serverTime: string }) => void;
  'floor:changed': (p: { venueId: string; tableIds: string[]; serverTime: string }) => void;
  'reservation:changed': (p: { venueId: string; reservation: AdminReservation; serverTime: string }) => void;
  'order:changed': (p: { venueId: string; orderId: string; tableId: string; serverTime: string }) => void;
  'alert:new': (p: AlertDto) => void;
  'notification:sent': (p: NotificationDto & { venueId: string }) => void;
  'booking:status': (p: { token: string; status: ReservationStatus; tableNumber: string | null; serverTime: string }) => void;
}

export interface ClientToServerEvents {
  'venue:join': (venueId: string, ack?: (ok: boolean) => void) => void;
  'booking:join': (token: string) => void;
}
