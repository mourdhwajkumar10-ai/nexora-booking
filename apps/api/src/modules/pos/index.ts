import { PosSimulateInput } from '@nexora/shared';
import { query, queryOne, withTx } from '../../db/pool';
import { audit } from '../../core/audit';
import { recalcOrderTotals } from '../../core/orders';
import { actorOf, assertVenueAccess, requireRole, requireStaff } from '../../lib/auth';
import { clock } from '../../lib/clock';
import { conflict, notFound } from '../../lib/errors';
import { iso, parse } from '../../lib/http';
import { registerJob } from '../../lib/jobs';
import type { NexoraModule } from '../types';
import {
  SIGNATURE_HEADER,
  ingestPosWebhook,
  linkCheckToReservation,
  processWebhookEvent,
  retryDueWebhooks,
  signPosPayload,
  toWebhookDto,
} from './service';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

/** POS integration (E4-S4): signed webhooks, simulator, webhook log / DLQ replay. */
export const posModule: NexoraModule = {
  name: 'pos',
  init: () => {
    registerJob({ name: 'webhook-retry', intervalMs: 1_000, run: retryDueWebhooks });
  },
  routes: async (app) => {
    // Encapsulated to this plugin: keep the exact bytes for HMAC verification.
    app.removeContentTypeParser('application/json');
    app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
      const raw = typeof body === 'string' ? body : body.toString('utf8');
      req.rawBody = raw;
      if (!raw.length) return done(null, {});
      try {
        done(null, JSON.parse(raw));
      } catch (err: any) {
        err.statusCode = 400;
        done(err, undefined);
      }
    });

    app.post('/webhooks/pos', async (req, reply) => {
      const header = req.headers[SIGNATURE_HEADER];
      const idem = req.headers['idempotency-key'];
      const result = await ingestPosWebhook({
        rawBody: req.rawBody ?? '',
        signature: Array.isArray(header) ? header[0] : header,
        idempotencyKey: Array.isArray(idem) ? idem[0] : idem,
      });
      return reply.status(result.status === 'queued' ? 202 : 200).send(result);
    });

    app.post<{ Params: { venueId: string } }>('/admin/venues/:venueId/pos/simulate', { preHandler: requireStaff }, async (req) => {
      assertVenueAccess(req.staff, req.params.venueId);
      const input = parse(PosSimulateInput, req.body);
      const order = await queryOne('SELECT venue_id FROM pos_orders WHERE id = $1', [input.body.orderId]);
      if (!order || order.venue_id !== req.params.venueId) throw notFound('Order');
      // Build + sign the raw payload like a real POS, then run the exact same verify/process pipeline.
      const rawBody = JSON.stringify(input.body);
      return ingestPosWebhook({
        rawBody,
        signature: signPosPayload(rawBody),
        idempotencyKey: input.idempotencyKey,
        failTimes: input.failTimes ?? 0,
      });
    });

    app.get<{ Params: { venueId: string } }>('/admin/venues/:venueId/webhooks', { preHandler: requireStaff }, async (req) => {
      assertVenueAccess(req.staff, req.params.venueId);
      const rows = await query('SELECT * FROM webhook_events WHERE venue_id = $1 ORDER BY created_at DESC, id LIMIT 100', [req.params.venueId]);
      return rows.map(toWebhookDto);
    });

    app.post<{ Params: { id: string } }>('/admin/webhooks/:id/replay', { preHandler: requireRole('MANAGER') }, async (req) => {
      await withTx(async (tx) => {
        const ev = await tx.one('SELECT * FROM webhook_events WHERE id = $1 FOR UPDATE', [req.params.id]);
        if (!ev) throw notFound('Webhook event');
        if (ev.venue_id) assertVenueAccess(req.staff, ev.venue_id);
        if (ev.status === 'PROCESSED') throw conflict('WEBHOOK_ALREADY_PROCESSED', 'This event was already processed');
        await tx.query(`UPDATE webhook_events SET status = 'FAILED', next_attempt_at = $2 WHERE id = $1`, [ev.id, clock.now()]);
        await audit(tx, { venueId: ev.venue_id, actor: actorOf(req), action: 'webhook.replay', entity: 'webhook_event', entityId: ev.id });
      });
      await processWebhookEvent(req.params.id);
      return toWebhookDto(await queryOne('SELECT * FROM webhook_events WHERE id = $1', [req.params.id]));
    });

    app.get<{ Params: { venueId: string } }>('/admin/venues/:venueId/pos/adjustments', { preHandler: requireStaff }, async (req) => {
      assertVenueAccess(req.staff, req.params.venueId);
      const rows = await query(
        `SELECT a.*, o.table_id, dt.table_number, g.first_name, g.last_name, i.item_name
         FROM pos_adjustments a
         JOIN pos_orders o ON o.id = a.order_id
         LEFT JOIN dining_tables dt ON dt.id = o.table_id
         LEFT JOIN guests g ON g.id = o.guest_id
         LEFT JOIN pos_order_items i ON i.id = a.order_item_id
         WHERE a.venue_id = $1
         ORDER BY a.created_at DESC LIMIT 50`,
        [req.params.venueId],
      );
      return rows.map((r: any) => ({
        id: r.id,
        orderId: r.order_id,
        tableNumber: r.table_number,
        guestName: r.first_name ? `${r.first_name} ${r.last_name}`.trim() : 'Guest',
        itemName: r.item_name || 'Order Item',
        kind: r.kind,
        reasonRef: r.reason_ref,
        attributionClass: r.attribution_class,
        countsAsGuestReturn: Boolean(r.counts_as_guest_return),
        amountPaise: Number(r.amount_paise),
        authorizedBy: r.authorized_by,
        createdAt: iso(r.created_at)!,
      }));
    });

    app.get<{ Params: { venueId: string } }>('/admin/venues/:venueId/orders', { preHandler: requireStaff }, async (req) => {
      assertVenueAccess(req.staff, req.params.venueId);
      const rows = await query(
        `SELECT o.*, dt.table_number, g.first_name, g.last_name, g.phone_number,
                COALESCE((SELECT SUM(i.quantity) FROM pos_order_items i WHERE i.order_id = o.id AND NOT i.is_voided), 0) AS item_count
         FROM pos_orders o
         LEFT JOIN dining_tables dt ON dt.id = o.table_id
         LEFT JOIN guests g ON g.id = o.guest_id
         WHERE o.venue_id = $1
         ORDER BY o.placed_at DESC LIMIT 50`,
        [req.params.venueId],
      );
      return rows.map((r: any) => ({
        id: r.id,
        tableId: r.table_id,
        tableNumber: r.table_number,
        guestId: r.guest_id,
        guestName: r.first_name ? `${r.first_name} ${r.last_name}`.trim() : null,
        guestPhone: r.phone_number,
        status: r.status,
        placedAt: iso(r.placed_at)!,
        itemCount: Number(r.item_count),
        grossPaise: Number(r.gross_paise),
        netPaise: Number(r.net_paise),
        discountPaise: Number(r.discount_paise),
        paidPaise: Number(r.paid_paise),
      }));
    });

    app.post<{ Params: { venueId: string } }>('/admin/venues/:venueId/pos/demo-check', { preHandler: requireStaff }, async (req) => {
      assertVenueAccess(req.staff, req.params.venueId);
      const venueId = req.params.venueId;
      const now = clock.now();

      return withTx(async (tx) => {
        const table = await tx.one<{ id: string; table_number: string }>(
          `SELECT id, table_number FROM dining_tables WHERE venue_id = $1 AND archived_at IS NULL ORDER BY table_number ASC LIMIT 1`,
          [venueId],
        );
        if (!table) throw notFound('Table');

        let guest = await tx.one<{ id: string }>('SELECT id FROM guests WHERE phone_number NOT LIKE \'walkin:%\' LIMIT 1');
        if (!guest) {
          guest = await tx.one<{ id: string }>(
            `INSERT INTO guests (first_name, last_name, phone_number, email) VALUES ('Alex', 'Rivers', '+15552345678', 'alex@example.com') RETURNING id`,
          );
        }

        let order = await tx.one<{ id: string }>(
          `SELECT id FROM pos_orders WHERE table_id = $1 AND status NOT IN ('BILLED', 'VOIDED') LIMIT 1`,
          [table.id],
        );

        if (!order) {
          order = (await tx.one<{ id: string }>(
            `INSERT INTO pos_orders (venue_id, table_id, guest_id, status, placed_at, preparing_at, created_at)
             VALUES ($1, $2, $3, 'PREPARING', $4, $4, $4) RETURNING id`,
            [venueId, table.id, guest!.id, now],
          ))!;

          await tx.query(
            `INSERT INTO pos_order_items (order_id, item_name, category, quantity, unit_price_paise, created_at)
             VALUES
               ($1, 'Dry Aged Prime Ribeye', 'ENTREE', 1, 650000, $2),
               ($1, 'Lobster Risotto', 'ENTREE', 1, 450000, $2),
               ($1, 'Burrata Salad', 'STARTER', 1, 220000, $2),
               ($1, 'Smoked Old Fashioned', 'BEVERAGE', 2, 180000, $2)`,
            [order.id, now],
          );
          await recalcOrderTotals(tx, order.id);
        }

        return { orderId: order.id, tableNumber: table.table_number };
      });
    });

    /** BR-14: Link order to reservation on the same table and assign guest credit */
    app.post<{ Params: { venueId: string; orderId: string }; Body?: { staffGuestId?: string } }>(
      '/admin/venues/:venueId/pos/orders/:orderId/link',
      { preHandler: requireStaff },
      async (req) => {
        assertVenueAccess(req.staff, req.params.venueId);
        return linkCheckToReservation(req.params.orderId, req.body?.staffGuestId);
      },
    );
  },
};
