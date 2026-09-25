import { PosSimulateInput } from '@nexora/shared';
import { query, queryOne, withTx } from '../../db/pool';
import { audit } from '../../core/audit';
import { actorOf, assertVenueAccess, requireRole, requireStaff } from '../../lib/auth';
import { clock } from '../../lib/clock';
import { conflict, notFound } from '../../lib/errors';
import { parse } from '../../lib/http';
import { registerJob } from '../../lib/jobs';
import type { NexoraModule } from '../types';
import {
  SIGNATURE_HEADER,
  ingestPosWebhook,
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
  },
};
