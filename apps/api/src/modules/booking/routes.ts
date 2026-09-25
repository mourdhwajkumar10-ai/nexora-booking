import type { FastifyPluginAsync } from 'fastify';
import {
  AvailabilityQuery,
  CancelBookingInput,
  CreateBookingInput,
  HostBookingInput,
  ListReservationsQuery,
  ReassignInput,
  ReasonInput,
} from '@nexora/shared';
import { query } from '../../db/pool';
import { toNotificationDto } from '../../core/notifications';
import { loadAdminReservation, loadAdminReservations, loadPublicReservation } from '../../core/reservations';
import { getVenueById, getVenueBySlug, type VenueRow } from '../../core/venues';
import { actorOf, assertVenueAccess, requireStaff } from '../../lib/auth';
import { notFound } from '../../lib/errors';
import { parse } from '../../lib/http';
import {
  approve,
  assertUuid,
  cancelByGuest,
  cancelByStaff,
  complete,
  computeAvailability,
  createBooking,
  noShow,
  parseStatuses,
  reassign,
  reject,
  seat,
} from './service';

async function publicVenue(slug: string): Promise<VenueRow> {
  const v = await getVenueBySlug(slug);
  if (!v.is_active) throw notFound('Venue');
  return v;
}

type IdParams = { Params: { id: string } };
type VenueParams = { Params: { venueId: string } };

export const bookingRoutes: FastifyPluginAsync = async (app) => {
  // ---------------------------------------------------------------- public
  app.get<{ Params: { slug: string } }>('/venues/:slug/availability', async (req) => {
    const q = parse(AvailabilityQuery, req.query);
    return computeAvailability(await publicVenue(req.params.slug), q.date, q.partySize);
  });

  app.post<{ Params: { slug: string } }>(
    '/venues/:slug/reservations',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const input = parse(CreateBookingInput, req.body);
      const venue = await publicVenue(req.params.slug);
      const r = await createBooking(venue, input, { source: 'ONLINE', status: 'REQUESTED', actor: 'guest' });
      return reply.status(201).send(await loadPublicReservation(r.public_token));
    },
  );

  app.get<{ Params: { token: string } }>('/reservations/:token', async (req) => loadPublicReservation(req.params.token));

  app.post<{ Params: { token: string } }>('/reservations/:token/cancel', async (req) => {
    const input = parse(CancelBookingInput, req.body);
    await cancelByGuest(req.params.token, input.phoneLast4);
    return loadPublicReservation(req.params.token);
  });

  // ---------------------------------------------------------------- admin
  app.get<VenueParams & { Querystring: { date?: string; status?: string } }>(
    '/admin/venues/:venueId/reservations',
    { preHandler: requireStaff },
    async (req) => {
      assertVenueAccess(req.staff, req.params.venueId);
      const q = parse(ListReservationsQuery, req.query);
      const statuses = parseStatuses(q.status);
      const where = ['r.venue_id = $1'];
      const params: unknown[] = [req.params.venueId];
      if (q.date) {
        params.push(q.date);
        where.push(`r.booking_date = $${params.length}`);
      }
      if (statuses) {
        params.push(statuses);
        where.push(`r.status = ANY($${params.length}::reservation_status[])`);
      }
      return loadAdminReservations(where.join(' AND '), params);
    },
  );

  app.get<VenueParams>('/admin/venues/:venueId/triage', { preHandler: requireStaff }, async (req) => {
    assertVenueAccess(req.staff, req.params.venueId);
    return loadAdminReservations(`r.venue_id = $1 AND r.status = 'REQUESTED'`, [req.params.venueId], undefined, 'r.created_at ASC, r.id');
  });

  app.post<VenueParams>('/admin/venues/:venueId/reservations', { preHandler: requireStaff }, async (req, reply) => {
    assertVenueAccess(req.staff, req.params.venueId);
    assertUuid(req.params.venueId, 'Venue');
    const input = parse(HostBookingInput, req.body);
    const venue = await getVenueById(req.params.venueId);
    const r = await createBooking(venue, input, {
      source: input.source,
      status: input.autoConfirm ? 'CONFIRMED' : 'REQUESTED',
      actor: actorOf(req),
      tableId: input.tableId,
    });
    return reply.status(201).send(await loadAdminReservation(r.id));
  });

  app.post<IdParams>('/admin/reservations/:id/approve', { preHandler: requireStaff }, async (req) =>
    approve(req.staff, req.params.id, actorOf(req)),
  );

  app.post<IdParams>('/admin/reservations/:id/reject', { preHandler: requireStaff }, async (req) => {
    const { reason } = parse(ReasonInput, req.body);
    return reject(req.staff, req.params.id, actorOf(req), reason);
  });

  app.post<IdParams>('/admin/reservations/:id/cancel', { preHandler: requireStaff }, async (req) => {
    const { reason } = parse(ReasonInput, req.body);
    return cancelByStaff(req.staff, req.params.id, actorOf(req), reason);
  });

  app.post<IdParams>('/admin/reservations/:id/seat', { preHandler: requireStaff }, async (req) => seat(req.staff, req.params.id, actorOf(req)));

  app.post<IdParams>('/admin/reservations/:id/no-show', { preHandler: requireStaff }, async (req) =>
    noShow(req.staff, req.params.id, actorOf(req)),
  );

  app.post<IdParams>('/admin/reservations/:id/complete', { preHandler: requireStaff }, async (req) =>
    complete(req.staff, req.params.id, actorOf(req)),
  );

  app.post<IdParams>('/admin/reservations/:id/reassign', { preHandler: requireStaff }, async (req) => {
    const { tableId } = parse(ReassignInput, req.body);
    return reassign(req.staff, req.params.id, actorOf(req), tableId);
  });

  app.get<VenueParams>('/admin/venues/:venueId/notifications', { preHandler: requireStaff }, async (req) => {
    assertVenueAccess(req.staff, req.params.venueId);
    const rows = await query(
      'SELECT * FROM notifications_outbox WHERE venue_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100',
      [req.params.venueId],
    );
    return rows.map(toNotificationDto);
  });
};
