import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  BlackoutInput,
  CreateMenuItemInput,
  CreateTableInput,
  ReplaceShiftsInput,
  UpdateTableInput,
  UpdateVenueInput,
  zUuid,
} from '@nexora/shared';
import { actorOf, assertVenueAccess, requireRole, requireStaff } from '../../lib/auth';
import { notFound } from '../../lib/errors';
import { parse } from '../../lib/http';
import * as svc from './service';

type VenueParams = { Params: { venueId: string } };
type TableParams = { Params: { tableId: string } };

const requireManager = requireRole('MANAGER');

/** Malformed ids are simply unknown entities (and must not reach Postgres as invalid uuids). */
function idParam(value: string, entity: string): string {
  if (!zUuid.safeParse(value).success) throw notFound(entity);
  return value;
}

/** Validated venue id from the path, after checking the caller's venue scope. */
function venueOf(req: FastifyRequest<VenueParams>): string {
  const venueId = idParam(req.params.venueId, 'Venue');
  assertVenueAccess(req.staff, venueId);
  return venueId;
}

export const venueRoutes: FastifyPluginAsync = async (app) => {
  // ---------- public directory
  app.get('/localities', async () => svc.listLocalities());

  app.get<{ Querystring: { locality?: string } }>('/venues', async (req) => svc.listVenueCards(req.query.locality || undefined));

  app.get<{ Params: { slug: string } }>('/venues/:slug', async (req) => svc.getVenueDetail(req.params.slug));

  // ---------- venue settings
  app.get<VenueParams>('/admin/venues/:venueId', { preHandler: requireStaff }, async (req) => svc.getVenueSettings(venueOf(req)));

  app.patch<VenueParams>('/admin/venues/:venueId', { preHandler: requireManager }, async (req) => {
    const venueId = venueOf(req);
    return svc.updateVenue(venueId, parse(UpdateVenueInput, req.body), actorOf(req));
  });

  app.post<VenueParams>('/admin/venues/:venueId/blackout', { preHandler: requireStaff }, async (req) => {
    const venueId = venueOf(req);
    return svc.setBlackout(venueId, parse(BlackoutInput, req.body), actorOf(req));
  });

  app.put<VenueParams>('/admin/venues/:venueId/shifts', { preHandler: requireManager }, async (req) => {
    const venueId = venueOf(req);
    return svc.replaceShifts(venueId, parse(ReplaceShiftsInput, req.body), actorOf(req));
  });

  // ---------- tables
  app.get<VenueParams>('/admin/venues/:venueId/tables', { preHandler: requireStaff }, async (req) => svc.listTables(venueOf(req)));

  app.post<VenueParams>('/admin/venues/:venueId/tables', { preHandler: requireManager }, async (req) => {
    const venueId = venueOf(req);
    return svc.createTable(venueId, parse(CreateTableInput, req.body), actorOf(req));
  });

  app.patch<TableParams>('/admin/tables/:tableId', { preHandler: requireManager }, async (req) => {
    const tableId = idParam(req.params.tableId, 'Table');
    return svc.updateTable(req.staff, tableId, parse(UpdateTableInput, req.body), actorOf(req));
  });

  app.delete<TableParams>('/admin/tables/:tableId', { preHandler: requireManager }, async (req, reply) => {
    await svc.archiveTable(req.staff, idParam(req.params.tableId, 'Table'), actorOf(req));
    return reply.status(204).send();
  });

  // ---------- menu & audit
  app.get<VenueParams>('/admin/venues/:venueId/menu', { preHandler: requireStaff }, async (req) => svc.listMenu(venueOf(req)));

  app.post<VenueParams>('/admin/venues/:venueId/menu', { preHandler: requireManager }, async (req) => {
    const venueId = venueOf(req);
    return svc.createMenuItem(venueId, parse(CreateMenuItemInput, req.body), actorOf(req));
  });

  app.get<VenueParams>('/admin/venues/:venueId/audit', { preHandler: requireManager }, async (req) => svc.listAudit(venueOf(req)));
};
