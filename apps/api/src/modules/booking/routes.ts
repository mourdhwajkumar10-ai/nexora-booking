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
import { query, queryOne } from '../../db/pool';
import { toNotificationDto } from '../../core/notifications';
import { loadAdminReservation, loadAdminReservations, loadPublicReservation, type ReservationRow } from '../../core/reservations';
import { getVenueById, getVenueBySlug, type VenueRow } from '../../core/venues';
import { actorOf, assertVenueAccess, requireStaff } from '../../lib/auth';
import { badRequest, notFound } from '../../lib/errors';
import { parse } from '../../lib/http';
import {
  approve,
  arrive,
  arriveByGuest,
  assertUuid,
  cancelByGuest,
  cancelByStaff,
  complete,
  computeAvailability,
  createBooking,
  markLate,
  markLateByGuest,
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

  app.post(
    '/reservations',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = req.body as any;
      let venue: VenueRow;
      if (body?.venueId) {
        venue = await getVenueById(body.venueId);
      } else if (body?.venueSlug) {
        venue = await publicVenue(body.venueSlug);
      } else {
        const [v] = await query<VenueRow>('SELECT * FROM venues WHERE is_active = true ORDER BY created_at LIMIT 1');
        if (!v) throw notFound('Venue');
        venue = v;
      }
      const input = parse(CreateBookingInput, body);
      const r = await createBooking(venue, input, { source: 'ONLINE', status: 'CONFIRMED', actor: 'guest' });
      const pub = await loadPublicReservation(r.public_token);
      return reply.status(201).send({
        ...pub,
        id: r.id,
        publicToken: r.public_token,
        turnMinutes: r.turn_minutes,
      });
    },
  );

  app.get<{ Params: { token: string } }>('/reservations/:token', async (req) => loadPublicReservation(req.params.token));

  app.get<{ Params: { token: string } }>('/reservations/track/:token', async (req) => {
    const pub = await loadPublicReservation(req.params.token);
    const r = await queryOne<ReservationRow>('SELECT * FROM reservations WHERE public_token = $1', [req.params.token]);
    const events = await query<{ from_status: string | null; to_status: string; created_at: Date; actor: string }>(
      'SELECT * FROM reservation_events WHERE reservation_id = $1 ORDER BY created_at ASC',
      [r?.id],
    );
    return {
      ...pub,
      id: r?.id,
      publicToken: req.params.token,
      turnMinutes: r?.turn_minutes ?? pub.turnMinutes ?? 90,
      history: events.map((e) => ({
        from: e.from_status,
        to: e.to_status,
        status: e.to_status?.toLowerCase(),
        timestamp: e.created_at,
        timestampMs: new Date(e.created_at).getTime(),
        actor: e.actor,
      })),
    };
  });

  const handleStatusTransition = async (req: any) => {
    const id = req.params.id;
    const targetStatus = String(req.body?.status || '').toUpperCase();
    const reason = req.body?.reason;
    const actor = req.staff?.email ? `staff:${req.staff.email}` : (actorOf(req) || 'host');

    switch (targetStatus) {
      case 'ARRIVED':
        return arrive(req.staff, id, actor);
      case 'LATE':
        return markLate(req.staff, id, actor);
      case 'SEATED':
        return seat(req.staff, id, actor);
      case 'COMPLETED':
        return complete(req.staff, id, actor);
      case 'CANCELLED':
        return cancelByStaff(req.staff, id, actor, reason);
      case 'NO_SHOW':
        return noShow(req.staff, id, actor);
      case 'CONFIRMED':
        return approve(req.staff, id, actor);
      default:
        throw badRequest('INVALID_STATUS', `Unsupported target status ${targetStatus}`);
    }
  };

  app.patch<{ Params: { id: string }; Body: { status: string; reason?: string } }>(
    '/reservations/:id/status',
    async (req) => {
      if (req.staff) {
        return handleStatusTransition(req);
      }
      const target = String(req.body?.status || '').toUpperCase();
      if (target === 'ARRIVED') return arriveByGuest(req.params.id);
      if (target === 'LATE') return markLateByGuest(req.params.id);
      return handleStatusTransition(req);
    },
  );

  app.patch<{ Params: { id: string }; Body: { status: string; reason?: string } }>(
    '/admin/reservations/:id/status',
    { preHandler: requireStaff },
    handleStatusTransition,
  );

  app.post<{ Params: { token: string } }>('/reservations/:token/arrive', async (req) => {
    return arriveByGuest(req.params.token);
  });

  app.post<{ Params: { token: string } }>('/reservations/:token/late', async (req) => {
    return markLateByGuest(req.params.token);
  });

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

  app.post<IdParams>('/admin/reservations/:id/arrive', { preHandler: requireStaff }, async (req) =>
    arrive(req.staff, req.params.id, actorOf(req)),
  );

  app.post<IdParams>('/admin/reservations/:id/late', { preHandler: requireStaff }, async (req) =>
    markLate(req.staff, req.params.id, actorOf(req)),
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
