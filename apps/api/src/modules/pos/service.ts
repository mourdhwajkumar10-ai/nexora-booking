/**
 * POS webhook pipeline (E4-S4): HMAC verify -> validate -> idempotent insert -> process in a
 * transaction -> PROCESSED, or FAILED with backoff -> DEAD (DLQ) + WEBHOOK_DEAD alert.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PosWebhookBody, WEBHOOK_RETRY_SCHEDULE_SECS, type WebhookEventDto } from '@nexora/shared';
import { config } from '../../config';
import { query, queryOne, withTx, type Tx } from '../../db/pool';
import { createAlert } from '../../core/alerts';
import { lockOrder, recalcOrderTotals, type OrderRow } from '../../core/orders';
import { clock } from '../../lib/clock';
import { AppError, conflict, notFound } from '../../lib/errors';
import { iso, parse } from '../../lib/http';

export const WEBHOOK_MAX_ATTEMPTS = 5;
export const SIGNATURE_HEADER = 'x-nexora-signature';

export function signPosPayload(rawBody: string, secret = config.posWebhookSecret): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

export function verifyPosSignature(rawBody: string, header: string | undefined): boolean {
  if (!header) return false;
  const expected = Buffer.from(signPosPayload(rawBody));
  const got = Buffer.from(header.trim());
  return expected.length === got.length && timingSafeEqual(expected, got);
}

export function toWebhookDto(r: any): WebhookEventDto {
  return {
    id: r.id,
    source: r.source,
    idempotencyKey: r.idempotency_key,
    eventType: r.event_type,
    status: r.status,
    attempts: r.attempts,
    nextAttemptAt: iso(r.next_attempt_at),
    lastError: r.last_error,
    createdAt: iso(r.created_at)!,
    processedAt: iso(r.processed_at),
  };
}

export type IngestStatus = 'processed' | 'duplicate' | 'queued';

/**
 * The single entry point used by both `POST /webhooks/pos` and the simulator: verify the HMAC
 * over the exact raw bytes, validate, dedupe on the idempotency key and process.
 */
export async function ingestPosWebhook(input: {
  rawBody: string;
  signature: string | undefined;
  idempotencyKey?: string;
  failTimes?: number;
}): Promise<{ status: IngestStatus; webhookEventId: string }> {
  if (!verifyPosSignature(input.rawBody, input.signature)) {
    throw new AppError(401, 'INVALID_SIGNATURE', 'Webhook signature verification failed');
  }
  let json: unknown;
  try {
    json = JSON.parse(input.rawBody);
  } catch {
    throw new AppError(400, 'BAD_REQUEST', 'Body is not valid JSON');
  }
  const body = parse(PosWebhookBody, json);
  // C-19: dedupe on {source}_{eventId}, never on a timestamp. A caller key wins when supplied.
  const key = input.idempotencyKey?.trim() || `pos_${body.eventId}`;
  const order = await queryOne<{ venue_id: string }>('SELECT venue_id FROM pos_orders WHERE id = $1', [body.orderId]);
  const inserted = await queryOne(
    `INSERT INTO webhook_events (venue_id, source, idempotency_key, event_type, payload, fail_times, created_at)
     VALUES ($1,'POS',$2,$3,$4,$5,$6) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [order?.venue_id ?? null, key, body.type, JSON.stringify(body), input.failTimes ?? 0, clock.now()],
  );
  if (!inserted) {
    const existing = await queryOne('SELECT id FROM webhook_events WHERE idempotency_key = $1', [key]);
    return { status: 'duplicate', webhookEventId: existing!.id };
  }
  const status = await processWebhookEvent(inserted.id);
  return { status: status === 'PROCESSED' ? 'processed' : 'queued', webhookEventId: inserted.id };
}

/** Apply one webhook's side effects inside `tx`. Throws to signal a (retryable) failure. */
async function applyPosEvent(tx: Tx, body: PosWebhookBody): Promise<void> {
  const order = await lockOrder(tx, body.orderId);
  const open = !['BILLED', 'VOIDED'].includes(order.status);
  let adjustment: { kind: 'VOID' | 'COMP' | 'REFUND'; amount: number; postSettlement: boolean } | null = null;
  const now = clock.now();

  switch (body.type) {
    case 'ticket.updated': {
      if (!open) throw conflict('ORDER_CLOSED', `Order is ${order.status}`);
      for (const it of body.items) {
        await tx.query(
          `INSERT INTO pos_order_items (order_id, item_name, category, quantity, unit_price_paise, notes, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [order.id, it.itemName, it.category, it.quantity, it.unitPricePaise, it.notes ?? null, now],
        );
      }
      if (body.posExternalId) await tx.query('UPDATE pos_orders SET pos_external_id = $2 WHERE id = $1', [order.id, body.posExternalId]);
      break;
    }
    case 'order.item_voided':
    case 'order.refunded': {
      const refund = body.type === 'order.refunded';
      if (refund && order.status !== 'BILLED') throw conflict('ORDER_NOT_BILLED', 'Refunds apply to billed orders only');
      if (!refund && !open) throw conflict('ORDER_CLOSED', `Order is ${order.status}; use a refund`);
      const item = await tx.one('SELECT * FROM pos_order_items WHERE id = $1 AND order_id = $2 FOR UPDATE', [body.orderItemId, order.id]);
      if (!item) throw notFound('Order item');
      if (item.is_voided) return; // already voided: acknowledged, no-op
      await tx.query('UPDATE pos_order_items SET is_voided = true WHERE id = $1', [item.id]);
      adjustment = { kind: refund ? 'REFUND' : 'VOID', amount: item.quantity * item.unit_price_paise, postSettlement: refund };
      await insertVoidLog(tx, order, item.id, adjustment, body.reason, body.authorizedBy);
      break;
    }
    case 'order.comp_applied': {
      if (!open) throw conflict('ORDER_CLOSED', `Order is ${order.status}`);
      const amount = Math.min(body.amountPaise, order.net_paise);
      if (amount <= 0) return;
      adjustment = { kind: 'COMP', amount, postSettlement: false };
      await insertVoidLog(tx, order, null, adjustment, body.reason, body.authorizedBy);
      break;
    }
  }

  await recalcOrderTotals(tx, order.id);
  if (!adjustment) return;
  if (order.guest_id && adjustment.kind !== 'COMP') {
    await tx.query('INSERT INTO guest_profiles (guest_id) VALUES ($1) ON CONFLICT DO NOTHING', [order.guest_id]);
    await tx.query(
      `UPDATE guest_profiles SET total_voids_count = total_voids_count + 1, total_voids_value_paise = total_voids_value_paise + $2
       WHERE guest_id = $1`,
      [order.guest_id, adjustment.amount],
    );
  }
  tx.emit({
    type: 'order.adjusted',
    venueId: order.venue_id,
    orderId: order.id,
    guestId: order.guest_id,
    kind: adjustment.kind,
    amountPaise: adjustment.amount,
    postSettlement: adjustment.postSettlement,
  });
}

async function insertVoidLog(
  tx: Tx,
  order: OrderRow,
  itemId: string | null,
  adj: { kind: string; amount: number; postSettlement: boolean },
  reason: string,
  authorizedBy: string,
): Promise<void> {
  await tx.query(
    `INSERT INTO pos_void_logs (order_id, order_item_id, kind, void_reason, authorized_by, amount_voided_paise, post_settlement, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [order.id, itemId, adj.kind, reason, authorizedBy, adj.amount, adj.postSettlement, clock.now()],
  );
}

/**
 * Process a RECEIVED/FAILED webhook event once. Returns the resulting status. Side effects and the
 * PROCESSED mark commit atomically; a failure rolls them back and records the attempt separately.
 */
export async function processWebhookEvent(id: string): Promise<WebhookEventDto['status']> {
  try {
    return await withTx(async (tx) => {
      const ev = await tx.one('SELECT * FROM webhook_events WHERE id = $1 FOR UPDATE', [id]);
      if (!ev) throw notFound('Webhook event');
      if (ev.status === 'PROCESSED' || ev.status === 'DEAD') return ev.status;
      if (ev.attempts < ev.fail_times) throw new Error(`Simulated handler failure (${ev.attempts + 1}/${ev.fail_times})`);
      await applyPosEvent(tx, PosWebhookBody.parse(ev.payload));
      await tx.query(
        `UPDATE webhook_events SET status = 'PROCESSED', attempts = attempts + 1, processed_at = $2, next_attempt_at = NULL, last_error = NULL
         WHERE id = $1`,
        [id, clock.now()],
      );
      return 'PROCESSED' as const;
    });
  } catch (err) {
    return recordFailure(id, err);
  }
}

async function recordFailure(id: string, err: unknown): Promise<WebhookEventDto['status']> {
  const message = err instanceof Error ? err.message : String(err);
  return withTx(async (tx) => {
    const ev = await tx.one('SELECT * FROM webhook_events WHERE id = $1 FOR UPDATE', [id]);
    if (!ev) return 'DEAD' as const;
    if (ev.status === 'PROCESSED') return 'PROCESSED' as const;
    const attempts = ev.attempts + 1;
    const now = clock.now();
    if (attempts >= WEBHOOK_MAX_ATTEMPTS) {
      await tx.query(`UPDATE webhook_events SET status = 'DEAD', attempts = $2, last_error = $3, next_attempt_at = NULL WHERE id = $1`, [
        id,
        attempts,
        message,
      ]);
      if (ev.venue_id) {
        await createAlert(tx, {
          venueId: ev.venue_id,
          kind: 'WEBHOOK_DEAD',
          severity: 'critical',
          title: 'POS webhook moved to dead-letter queue',
          body: `${ev.event_type} (${ev.idempotency_key}) failed ${attempts} times: ${message}`,
          data: { webhookEventId: id, eventType: ev.event_type },
          dedupeKey: `webhook-dead:${id}:${attempts}`,
        });
      }
      return 'DEAD' as const;
    }
    const delaySecs = WEBHOOK_RETRY_SCHEDULE_SECS[Math.min(attempts - 1, WEBHOOK_RETRY_SCHEDULE_SECS.length - 1)]!;
    await tx.query(`UPDATE webhook_events SET status = 'FAILED', attempts = $2, last_error = $3, next_attempt_at = $4 WHERE id = $1`, [
      id,
      attempts,
      message,
      new Date(now.getTime() + delaySecs * 1000),
    ]);
    return 'FAILED' as const;
  });
}

/** Job `webhook-retry`: reprocess FAILED events whose backoff has elapsed. */
export async function retryDueWebhooks(): Promise<void> {
  const due = await query<{ id: string }>(
    `SELECT id FROM webhook_events WHERE status = 'FAILED' AND next_attempt_at <= $1 ORDER BY next_attempt_at LIMIT 50`,
    [clock.now()],
  );
  for (const r of due) await processWebhookEvent(r.id);
}
