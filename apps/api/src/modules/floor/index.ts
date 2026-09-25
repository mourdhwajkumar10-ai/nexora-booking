import { AddOrderItemInput, OrderStatusInput, TableStatusInput, WalkInCheckInput, WalkInInput, zUuid } from '@nexora/shared';
import { actorOf, assertVenueAccess, requireStaff } from '../../lib/auth';
import { notFound } from '../../lib/errors';
import { parse } from '../../lib/http';
import { registerJob } from '../../lib/jobs';
import type { NexoraModule } from '../types';
import { DWELL_JOB, runDwellMonitor } from './dwell';
import { addOrderItem, changeTableStatus, deleteOrderItem, getOrder, getTableOrder, setOrderStatus } from './service';
import { buildFloorSnapshot } from './snapshot';
import { checkWalkIn, createWalkIn } from './walkins';

/** Floor state, walk-ins, table status actions, order items / KDS progression, dwell monitor (A3). */
export const floorModule: NexoraModule = {
  name: 'floor',
  init() {
    registerJob({ name: DWELL_JOB, intervalMs: 30_000, run: runDwellMonitor });
  },
  routes: async (app) => {
    app.addHook('preHandler', requireStaff);
    // Malformed ids are "not found" rather than a Postgres cast error (500).
    app.addHook('preHandler', async (req) => {
      for (const [k, v] of Object.entries((req.params ?? {}) as Record<string, string>)) {
        if (!zUuid.safeParse(v).success) throw notFound(k.replace(/Id$/, '').replace(/^./, (c) => c.toUpperCase()));
      }
    });

    app.get<{ Params: { venueId: string } }>('/admin/venues/:venueId/floor', async (req) => {
      assertVenueAccess(req.staff, req.params.venueId);
      return buildFloorSnapshot(req.params.venueId);
    });

    app.post<{ Params: { venueId: string } }>('/admin/venues/:venueId/walk-ins/check', async (req) => {
      assertVenueAccess(req.staff, req.params.venueId);
      const input = parse(WalkInCheckInput, req.body);
      return checkWalkIn(req.params.venueId, input.partySize, input.tableId);
    });

    app.post<{ Params: { venueId: string } }>('/admin/venues/:venueId/walk-ins', async (req, reply) => {
      assertVenueAccess(req.staff, req.params.venueId);
      const res = await createWalkIn(req.params.venueId, parse(WalkInInput, req.body), actorOf(req));
      return reply.status(201).send(res);
    });

    app.post<{ Params: { tableId: string } }>('/admin/tables/:tableId/status', async (req) => {
      return changeTableStatus(req.staff, req.params.tableId, parse(TableStatusInput, req.body), actorOf(req));
    });

    app.get<{ Params: { tableId: string } }>('/admin/tables/:tableId/order', async (req) => getTableOrder(req.staff, req.params.tableId));

    app.get<{ Params: { orderId: string } }>('/admin/orders/:orderId', async (req) => getOrder(req.staff, req.params.orderId));

    app.post<{ Params: { orderId: string } }>('/admin/orders/:orderId/items', async (req) => {
      return addOrderItem(req.staff, req.params.orderId, parse(AddOrderItemInput, req.body));
    });

    app.delete<{ Params: { orderId: string; itemId: string } }>('/admin/orders/:orderId/items/:itemId', async (req) => {
      return deleteOrderItem(req.staff, req.params.orderId, req.params.itemId);
    });

    app.post<{ Params: { orderId: string } }>('/admin/orders/:orderId/status', async (req) => {
      return setOrderStatus(req.staff, req.params.orderId, parse(OrderStatusInput, req.body).status);
    });
  },
};
