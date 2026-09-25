/**
 * Socket.IO gateway. Staff join `venue:<id>` (cookie JWT verified); consumers join `booking:<token>`.
 * Domain events from the bus are fanned out here, so modules never touch sockets directly.
 */
import type { FastifyInstance } from 'fastify';
import { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents, StaffUser } from '@nexora/shared';
import { config } from '../config';
import { on } from './bus';
import { clock } from './clock';
import { loadAdminReservation, loadPublicReservation } from '../core/reservations';

let io: Server<ClientToServerEvents, ServerToClientEvents> | null = null;

export function getIO() {
  return io;
}

function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function initRealtime(app: FastifyInstance): void {
  io = new Server<ClientToServerEvents, ServerToClientEvents>(app.server, {
    cors: { origin: config.webOrigin, credentials: true },
  });

  io.on('connection', (socket) => {
    socket.emit('server:time', { serverTime: clock.now().toISOString() });

    socket.on('venue:join', (venueId, ack) => {
      try {
        const token = parseCookie(socket.handshake.headers.cookie, config.cookieName) ?? (socket.handshake.auth?.token as string | undefined);
        if (!token) throw new Error('no token');
        const staff = app.jwt.verify<StaffUser>(token);
        if (staff.venueId && staff.venueId !== venueId) throw new Error('forbidden');
        socket.join(`venue:${venueId}`);
        ack?.(true);
      } catch {
        ack?.(false);
      }
    });

    socket.on('booking:join', (token) => {
      if (typeof token === 'string' && /^[a-f0-9]{32}$/.test(token)) socket.join(`booking:${token}`);
    });
  });

  // Heartbeat so every console re-syncs its server clock offset (drift < 1s).
  const hb = setInterval(() => io?.emit('server:time', { serverTime: clock.now().toISOString() }), 10_000);
  hb.unref();

  const now = () => clock.now().toISOString();

  on('reservation.changed', async (e) => {
    if (!io) return;
    const reservation = await loadAdminReservation(e.reservationId);
    io.to(`venue:${e.venueId}`).emit('reservation:changed', { venueId: e.venueId, reservation, serverTime: now() });
    const pub = await loadPublicReservation(reservation.token);
    io.to(`booking:${reservation.token}`).emit('booking:status', { token: pub.token, status: pub.status, tableNumber: pub.tableNumber, serverTime: now() });
    if (e.tableId) io.to(`venue:${e.venueId}`).emit('floor:changed', { venueId: e.venueId, tableIds: [e.tableId], serverTime: now() });
  });
  on('table.changed', (e) => {
    io?.to(`venue:${e.venueId}`).emit('floor:changed', { venueId: e.venueId, tableIds: e.tableIds, serverTime: now() });
  });
  on('order.changed', (e) => {
    io?.to(`venue:${e.venueId}`).emit('order:changed', { venueId: e.venueId, orderId: e.orderId, tableId: e.tableId, serverTime: now() });
    io?.to(`venue:${e.venueId}`).emit('floor:changed', { venueId: e.venueId, tableIds: [e.tableId], serverTime: now() });
  });
  on('alert.created', (e) => {
    io?.to(`venue:${e.alert.venueId}`).emit('alert:new', e.alert);
  });
  on('notification.sent', (e) => {
    io?.to(`venue:${e.venueId}`).emit('notification:sent', { ...e.notification, venueId: e.venueId });
  });
  on('guest.arrived', (e) => {
    io?.to(`venue:${e.venueId}`).emit('floor:changed', { venueId: e.venueId, tableIds: [], serverTime: now() });
  });
}

export async function closeRealtime(): Promise<void> {
  if (io) {
    await new Promise<void>((resolve) => io!.close(() => resolve()));
    io = null;
  }
}
