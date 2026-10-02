import {
  AddOrderItemInput,
  OrderStatusInput,
  TableStatusInput,
  WaitlistJoinInput,
  WaitlistSeatInput,
  WalkInCheckInput,
  WalkInInput,
  zUuid,
  type StaffUser,
} from '@nexora/shared';
import { query, queryOne } from '../../db/pool';
import { getVenueBySlug, type VenueRow } from '../../core/venues';
import { actorOf, assertVenueAccess, requireStaff } from '../../lib/auth';
import { clock } from '../../lib/clock';
import { badRequest, notFound } from '../../lib/errors';
import { parse } from '../../lib/http';
import { registerJob } from '../../lib/jobs';
import type { NexoraModule } from '../types';
import { DWELL_JOB, runDwellMonitor } from './dwell';
import { addOrderItem, changeTableStatus, deleteOrderItem, getOrder, getTableOrder, setOrderStatus } from './service';
import { buildFloorSnapshot } from './snapshot';
import { checkWalkIn, createWalkIn } from './walkins';
import { computeWaitlistQuotes, joinWaitlist, seatWaitlistEntry } from './waitlist';

/** Floor state, waitlist, combinations, walk-ins, table status actions, order items / KDS progression, dwell monitor (Pillar 5). */
export const floorModule: NexoraModule = {
  name: 'floor',
  init() {
    registerJob({ name: DWELL_JOB, intervalMs: 30_000, run: runDwellMonitor });
  },
  routes: async (app) => {
    app.addHook('preHandler', async (req, reply) => {
      const url = req.url.split('?')[0] || '';
      if (url.endsWith('/floor/tables')) {
        try {
          req.staff = await req.jwtVerify<StaffUser>();
        } catch {
          // optional staff
        }
        return;
      }
      return requireStaff(req, reply);
    });

    // Malformed ids are "not found" rather than a Postgres cast error (500).
    app.addHook('preHandler', async (req) => {
      for (const [k, v] of Object.entries((req.params ?? {}) as Record<string, string>)) {
        if (!zUuid.safeParse(v).success) throw notFound(k.replace(/Id$/, '').replace(/^./, (c) => c.toUpperCase()));
      }
    });

    app.get<{ Querystring: { venueId?: string; slug?: string } }>('/floor/tables', async (req) => {
      let venueId = req.query?.venueId;
      if (!venueId && req.query?.slug) {
        const v = await getVenueBySlug(req.query.slug);
        venueId = v.id;
      }
      if (!venueId && req.staff?.venueId) {
        venueId = req.staff.venueId;
      }
      if (!venueId) {
        const [v] = await query<VenueRow>('SELECT id FROM venues WHERE is_active = true ORDER BY created_at LIMIT 1');
        if (!v) throw notFound('Venue');
        venueId = v.id;
      }
      const snapshot = await buildFloorSnapshot(venueId);
      return {
        venueId,
        serverTime: snapshot.serverTime,
        tables: snapshot.tables.map((t) => ({
          id: t.id,
          tableNumber: t.tableNumber,
          diningZone: t.diningZone,
          minCapacity: t.minCapacity,
          maxCapacity: t.maxCapacity,
          status: t.floorStatus,
          isCombination: t.isCombination ?? false,
          combinedTableNumbers: t.combinedTableNumbers ?? [],
          current: t.current,
          order: t.order,
          next: t.next,
          dwell: t.dwell,
          dwellLevel: t.dwell?.level ?? 'normal',
          predictedTurnMinutes: t.dwell?.turnMinutes ?? (t.maxCapacity <= 2 ? 75 : t.maxCapacity <= 4 ? 90 : 120),
        })),
      };
    });

    app.get<{ Params: { venueId: string } }>('/admin/venues/:venueId/floor', async (req) => {
      assertVenueAccess(req.staff, req.params.venueId);
      return buildFloorSnapshot(req.params.venueId);
    });

    // ---------------------------------------------------------------- Waitlist (Pillar 5)
    app.get<{ Params: { venueId: string } }>('/admin/venues/:venueId/waitlist', async (req) => {
      assertVenueAccess(req.staff, req.params.venueId);
      const { entries } = await computeWaitlistQuotes(req.params.venueId);
      return entries;
    });

    app.post<{ Params: { venueId: string } }>('/admin/venues/:venueId/waitlist', async (req, reply) => {
      assertVenueAccess(req.staff, req.params.venueId);
      const input = parse(WaitlistJoinInput, req.body);
      const entry = await joinWaitlist(req.params.venueId, input);
      return reply.status(201).send(entry);
    });

    app.post<{ Params: { venueId: string; entryId: string } }>('/admin/venues/:venueId/waitlist/:entryId/seat', async (req) => {
      assertVenueAccess(req.staff, req.params.venueId);
      const input = parse(WaitlistSeatInput, req.body);
      return seatWaitlistEntry(req.params.venueId, req.params.entryId, input, actorOf(req));
    });

    app.delete<{ Params: { venueId: string; entryId: string } }>('/admin/venues/:venueId/waitlist/:entryId', async (req) => {
      assertVenueAccess(req.staff, req.params.venueId);
      await query(
        "UPDATE waitlist_entries SET status = 'CANCELLED', cancelled_at = $3 WHERE id = $1 AND venue_id = $2",
        [req.params.entryId, req.params.venueId, clock.now()],
      );
      return { success: true };
    });

    // ---------------------------------------------------------------- Combinations (Pillar 5)
    app.get<{ Params: { venueId: string } }>('/admin/venues/:venueId/combinations', async (req) => {
      assertVenueAccess(req.staff, req.params.venueId);
      const rows = await query('SELECT * FROM table_combinations WHERE venue_id = $1 AND is_active = true', [
        req.params.venueId,
      ]);
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        minCapacity: r.min_capacity,
        maxCapacity: r.max_capacity,
        tableIds: r.table_ids,
        isActive: r.is_active,
      }));
    });

    app.post<{
      Params: { venueId: string };
      Body: { name: string; minCapacity: number; maxCapacity: number; tableIds: string[] };
    }>('/admin/venues/:venueId/combinations', async (req, reply) => {
      assertVenueAccess(req.staff, req.params.venueId);
      const { name, minCapacity, maxCapacity, tableIds } = req.body ?? {};
      if (!name || !minCapacity || !maxCapacity || !Array.isArray(tableIds) || tableIds.length < 2) {
        throw badRequest('INVALID_COMBINATION', 'Combination requires a name, capacity range, and at least 2 tables');
      }
      const row = await queryOne(
        `INSERT INTO table_combinations (venue_id, name, min_capacity, max_capacity, table_ids, is_active)
         VALUES ($1, $2, $3, $4, $5, true) RETURNING *`,
        [req.params.venueId, name, minCapacity, maxCapacity, tableIds],
      );
      return reply.status(201).send({
        id: row.id,
        name: row.name,
        minCapacity: row.min_capacity,
        maxCapacity: row.max_capacity,
        tableIds: row.table_ids,
        isActive: row.is_active,
      });
    });

    // ---------------------------------------------------------------- Walk-ins & Tables
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
