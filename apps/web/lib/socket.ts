'use client';
import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@nexora/shared';

let socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;

/** Singleton Socket.IO client (connects directly to the API; cookies are shared on localhost). */
export function getSocket() {
  if (!socket) {
    socket = io(process.env.NEXT_PUBLIC_SOCKET_URL ?? 'http://localhost:4000', {
      withCredentials: true,
      transports: ['websocket', 'polling'],
    });
  }
  return socket;
}
