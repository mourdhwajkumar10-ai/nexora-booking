import type { NotificationDto } from '@nexora/shared';
import type { Tx } from '../db/pool';
import { clock } from '../lib/clock';

export function toNotificationDto(r: any): NotificationDto {
  return {
    id: r.id,
    channel: r.channel,
    template: r.template,
    to: r.to_address,
    body: r.body,
    status: r.status,
    reservationId: r.reservation_id,
    createdAt: new Date(r.created_at).toISOString(),
    sentAt: r.sent_at ? new Date(r.sent_at).toISOString() : null,
  };
}

/**
 * Transactional outbox: the message is written in the same transaction as the state change and
 * dispatched asynchronously by the outbox worker (mock SMS/WhatsApp logger in the POC).
 */
export async function enqueueNotification(
  tx: Tx,
  n: {
    venueId: string;
    reservationId?: string | null;
    guestId?: string | null;
    channel?: 'SMS' | 'WHATSAPP';
    template: string;
    to: string;
    body: string;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO notifications_outbox (venue_id, reservation_id, guest_id, channel, template, to_address, body, payload, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [n.venueId, n.reservationId ?? null, n.guestId ?? null, n.channel ?? 'SMS', n.template, n.to, n.body, JSON.stringify(n.payload ?? {}), clock.now()],
  );
}
