import { dayOfWeekFor, utcToZonedParts } from '@nexora/shared';
import type { Tx } from '../../db/pool';
import { enqueueNotification } from '../../core/notifications';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-10-02" -> "Fri, 2 Oct" (built by hand so ICU spacing quirks never leak into SMS bodies). */
export function formatDateLabel(date: string): string {
  const [, m, d] = date.split('-').map(Number);
  return `${DOW[dayOfWeekFor(date)]}, ${d} ${MONTHS[m - 1]}`;
}

/** "19:30" -> "7:30 PM". */
export function formatTimeLabel(hm: string): string {
  const [h, m] = hm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

export type BookingTemplate =
  | 'RESERVATION_REQUESTED'
  | 'RESERVATION_CONFIRMED'
  | 'RESERVATION_DECLINED'
  | 'RESERVATION_CANCELLED'
  | 'NO_SHOW';

interface TemplateCtx {
  n: number;
  venue: string;
  date: string;
  time: string;
  reason?: string | null;
}

const BODIES: Record<BookingTemplate, (c: TemplateCtx) => string> = {
  RESERVATION_REQUESTED: (c) => `Request Received: Table for ${c.n} at ${c.venue} on ${c.date} at ${c.time}. We'll confirm shortly.`,
  RESERVATION_CONFIRMED: (c) => `Reservation Confirmed: Table for ${c.n} at ${c.venue} on ${c.date} at ${c.time}`,
  RESERVATION_DECLINED: (c) =>
    `Reservation Declined: ${c.venue} can't accommodate your table for ${c.n} on ${c.date} at ${c.time}${c.reason ? ` (${c.reason})` : ''}.`,
  RESERVATION_CANCELLED: (c) =>
    `Reservation Cancelled: Table for ${c.n} at ${c.venue} on ${c.date} at ${c.time}${c.reason ? ` (${c.reason})` : ''}.`,
  NO_SHOW: (c) => `We missed you at ${c.venue} on ${c.date} at ${c.time}. Your reservation has been released.`,
};

export function renderTemplate(template: BookingTemplate, c: TemplateCtx): string {
  return BODIES[template](c);
}

/**
 * Enqueue a guest notification for a reservation in the caller's transaction (transactional outbox).
 * Confirmations go out on WhatsApp, everything else by SMS.
 */
export async function notifyReservation(tx: Tx, reservationId: string, template: BookingTemplate, reason?: string | null): Promise<void> {
  const r = await tx.one(
    `SELECT r.id, r.venue_id, r.guest_id, r.party_size, r.start_at, v.name AS venue_name, v.timezone, g.phone_number
     FROM reservations r JOIN venues v ON v.id = r.venue_id JOIN guests g ON g.id = r.guest_id
     WHERE r.id = $1`,
    [reservationId],
  );
  if (!r) return;
  const local = utcToZonedParts(new Date(r.start_at), r.timezone);
  const body = renderTemplate(template, {
    n: r.party_size,
    venue: r.venue_name,
    date: formatDateLabel(local.date),
    time: formatTimeLabel(local.time),
    reason,
  });
  await enqueueNotification(tx, {
    venueId: r.venue_id,
    reservationId: r.id,
    guestId: r.guest_id,
    channel: template === 'RESERVATION_CONFIRMED' ? 'WHATSAPP' : 'SMS',
    template,
    to: r.phone_number,
    body,
    payload: { partySize: r.party_size, date: local.date, time: local.time },
  });
}
