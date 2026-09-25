import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderStatus, WebhookEventDto } from '@nexora/shared';
import { getPool } from '../src/db/pool';
import { clock } from '../src/lib/clock';
import { retryDueWebhooks, SIGNATURE_HEADER, signPosPayload } from '../src/modules/pos/service';
import { createTestContext, type TestContext } from './helpers';

let ctx: TestContext;
let eventSeq = 0;
const nextEventId = () => `evt_pos_${++eventSeq}_${Date.now()}`;

beforeAll(async () => {
  ctx = await createTestContext();
});

beforeEach(async () => {
  await ctx.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await ctx.close();
});

const pool = () => getPool();
const sql = async (text: string, params: unknown[] = []) => (await pool().query(text, params)).rows;

async function cookieFor(role: 'manager' | 'host' = 'host'): Promise<string> {
  const email = role === 'manager' ? ctx.fx.managerEmail : ctx.fx.hostEmail;
  const [u] = await sql('SELECT id, email, name, role, venue_id FROM staff_users WHERE email = $1', [email]);
  return `nexora_session=${ctx.app.jwt.sign({ id: u.id, email: u.email, name: u.name, role: u.role, venueId: u.venue_id }, { expiresIn: '1h' })}`;
}

async function createOrder(status: OrderStatus = 'PLACED', guestId: string | null = null) {
  const [order] = await sql(
    `INSERT INTO pos_orders (venue_id, table_id, guest_id, status, gross_paise, discount_paise, net_paise, paid_paise)
     VALUES ($1, $2, $3, $4, 0, 0, 0, 0) RETURNING *`,
    [ctx.fx.venueId, ctx.fx.tables['T-1'], guestId, status],
  );
  return order;
}

async function postWebhook(body: Record<string, unknown>, opts: { signature?: string; idempotencyKey?: string } = {}) {
  const rawBody = JSON.stringify(body);
  const signature = opts.signature !== undefined ? opts.signature : signPosPayload(rawBody);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (signature) headers[SIGNATURE_HEADER] = signature;
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;

  return ctx.app.inject({
    method: 'POST',
    url: '/api/v1/webhooks/pos',
    headers,
    payload: rawBody,
  });
}

describe('POS webhook HMAC signature verification', () => {
  it('accepts webhook with valid HMAC signature (returns 200/202)', async () => {
    const order = await createOrder();
    const eventId = nextEventId();
    const payload = {
      type: 'ticket.updated',
      eventId,
      orderId: order.id,
      items: [{ itemName: 'Truffle Pasta', category: 'ENTREE', quantity: 1, unitPricePaise: 120000 }],
    };

    const res = await postWebhook(payload);
    expect([200, 202]).toContain(res.statusCode);
    const body = res.json();
    expect(body.status).toBe('processed');
    expect(body.webhookEventId).toBeDefined();

    const [ev] = await sql('SELECT * FROM webhook_events WHERE id = $1', [body.webhookEventId]);
    expect(ev.status).toBe('PROCESSED');
  });

  it('rejects webhook with missing signature (401 INVALID_SIGNATURE)', async () => {
    const order = await createOrder();
    const payload = {
      type: 'ticket.updated',
      eventId: nextEventId(),
      orderId: order.id,
      items: [{ itemName: 'Item', category: 'STARTER', quantity: 1, unitPricePaise: 50000 }],
    };

    const res = await postWebhook(payload, { signature: '' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_SIGNATURE');
  });

  it('rejects webhook with invalid signature (401 INVALID_SIGNATURE)', async () => {
    const order = await createOrder();
    const payload = {
      type: 'ticket.updated',
      eventId: nextEventId(),
      orderId: order.id,
      items: [{ itemName: 'Item', category: 'STARTER', quantity: 1, unitPricePaise: 50000 }],
    };

    const res = await postWebhook(payload, { signature: 'sha256=badsignature00000000000000000000000000000000000000000000000000000000' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_SIGNATURE');
  });
});

describe('idempotency and deduplication', () => {
  it('duplicate webhook returns { status: "duplicate" } without double-processing items', async () => {
    const order = await createOrder();
    const eventId = nextEventId();
    const payload = {
      type: 'ticket.updated',
      eventId,
      orderId: order.id,
      items: [{ itemName: 'Burrata', category: 'STARTER', quantity: 1, unitPricePaise: 65000 }],
    };

    // First attempt
    const res1 = await postWebhook(payload);
    expect([200, 202]).toContain(res1.statusCode);
    expect(res1.json().status).toBe('processed');

    // Second attempt with identical payload
    const res2 = await postWebhook(payload);
    expect(res2.statusCode).toBe(200);
    expect(res2.json().status).toBe('duplicate');
    expect(res2.json().webhookEventId).toBe(res1.json().webhookEventId);

    // Order items should only have 1 row, not 2
    const items = await sql('SELECT * FROM pos_order_items WHERE order_id = $1', [order.id]);
    expect(items).toHaveLength(1);

    const [updatedOrder] = await sql('SELECT gross_paise, net_paise FROM pos_orders WHERE id = $1', [order.id]);
    expect(updatedOrder.gross_paise).toBe(65000);
    expect(updatedOrder.net_paise).toBe(65000);
  });
});

describe('handling ticket.updated event', () => {
  it('adds items, updates totals and pos_external_id', async () => {
    const order = await createOrder();
    const eventId = nextEventId();
    const payload = {
      type: 'ticket.updated',
      eventId,
      orderId: order.id,
      posExternalId: 'POS-TICK-999',
      items: [
        { itemName: 'Margherita Pizza', category: 'ENTREE', quantity: 2, unitPricePaise: 80000, notes: 'Extra crispy' },
        { itemName: 'Tiramisu', category: 'DESSERT', quantity: 1, unitPricePaise: 45000 },
      ],
    };

    const res = await postWebhook(payload);
    expect(res.statusCode).toBe(200);

    const items = await sql('SELECT * FROM pos_order_items WHERE order_id = $1 ORDER BY unit_price_paise DESC', [order.id]);
    expect(items).toHaveLength(2);
    expect(items[0].item_name).toBe('Margherita Pizza');
    expect(items[0].quantity).toBe(2);
    expect(items[0].notes).toBe('Extra crispy');

    const [updated] = await sql('SELECT * FROM pos_orders WHERE id = $1', [order.id]);
    expect(updated.pos_external_id).toBe('POS-TICK-999');
    // gross: 2 * 80000 + 45000 = 205000
    expect(updated.gross_paise).toBe(205000);
    expect(updated.net_paise).toBe(205000);
    expect(updated.discount_paise).toBe(0);
  });

  it('fails if order is already BILLED', async () => {
    const order = await createOrder('BILLED');
    const payload = {
      type: 'ticket.updated',
      eventId: nextEventId(),
      orderId: order.id,
      items: [{ itemName: 'Item', category: 'STARTER', quantity: 1, unitPricePaise: 50000 }],
    };

    const res = await postWebhook(payload);
    // Ingest returns queued or 200 duplicate, but event processing fails
    const eventId = res.json().webhookEventId;
    const [ev] = await sql('SELECT status, last_error FROM webhook_events WHERE id = $1', [eventId]);
    expect(ev.status).toBe('FAILED');
    expect(ev.last_error).toContain('Order is BILLED');
  });
});

describe('handling order.item_voided event', () => {
  it('voids item, logs void, and recalculates totals and guest profile', async () => {
    // Create guest
    const [guest] = await sql(`INSERT INTO guests (first_name, last_name, phone_number) VALUES ('Dev', 'Shah', '+919830001122') RETURNING id`);
    await sql('INSERT INTO guest_profiles (guest_id) VALUES ($1)', [guest.id]);

    const order = await createOrder('SERVED', guest.id);
    const [item] = await sql(
      `INSERT INTO pos_order_items (order_id, item_name, category, quantity, unit_price_paise)
       VALUES ($1, 'Wine Bottle', 'WINE', 1, 500000) RETURNING *`,
      [order.id],
    );
    // Initial totals
    await sql('UPDATE pos_orders SET gross_paise = 500000, net_paise = 500000 WHERE id = $1', [order.id]);

    const payload = {
      type: 'order.item_voided',
      eventId: nextEventId(),
      orderId: order.id,
      orderItemId: item.id,
      reason: 'GUEST_REJECTED',
      authorizedBy: 'Manager Alice',
    };

    const res = await postWebhook(payload);
    expect(res.json().status).toBe('processed');

    // Check item is_voided
    const [voidedItem] = await sql('SELECT is_voided FROM pos_order_items WHERE id = $1', [item.id]);
    expect(voidedItem.is_voided).toBe(true);

    // Check void log
    const [voidLog] = await sql('SELECT * FROM pos_void_logs WHERE order_id = $1', [order.id]);
    expect(voidLog).toBeDefined();
    expect(voidLog.kind).toBe('VOID');
    expect(voidLog.amount_voided_paise).toBe(500000);
    expect(voidLog.void_reason).toBe('GUEST_REJECTED');
    expect(voidLog.authorized_by).toBe('Manager Alice');
    expect(voidLog.post_settlement).toBe(false);

    // Check order totals: discount 500000, net 0
    const [updatedOrder] = await sql('SELECT * FROM pos_orders WHERE id = $1', [order.id]);
    expect(updatedOrder.discount_paise).toBe(500000);
    expect(updatedOrder.net_paise).toBe(0);

    // Check guest profile void stats updated
    const [profile] = await sql('SELECT total_voids_count, total_voids_value_paise FROM guest_profiles WHERE guest_id = $1', [guest.id]);
    expect(profile.total_voids_count).toBe(1);
    expect(profile.total_voids_value_paise).toBe(500000);
  });
});

describe('handling order.comp_applied event', () => {
  it('logs comp in pos_void_logs and reduces net total', async () => {
    const order = await createOrder('SERVED');
    await sql(
      `INSERT INTO pos_order_items (order_id, item_name, category, quantity, unit_price_paise)
       VALUES ($1, 'Steak', 'ENTREE', 1, 200000)`,
      [order.id],
    );
    await sql('UPDATE pos_orders SET gross_paise = 200000, net_paise = 200000 WHERE id = $1', [order.id]);

    const payload = {
      type: 'order.comp_applied',
      eventId: nextEventId(),
      orderId: order.id,
      amountPaise: 50000, // ₹500 comp
      reason: 'PROMOTIONAL_COMP',
      authorizedBy: 'Manager Bob',
    };

    const res = await postWebhook(payload);
    expect(res.json().status).toBe('processed');

    const [compLog] = await sql('SELECT * FROM pos_void_logs WHERE order_id = $1', [order.id]);
    expect(compLog).toBeDefined();
    expect(compLog.kind).toBe('COMP');
    expect(compLog.amount_voided_paise).toBe(50000);
    expect(compLog.void_reason).toBe('PROMOTIONAL_COMP');

    const [updatedOrder] = await sql('SELECT gross_paise, discount_paise, net_paise FROM pos_orders WHERE id = $1', [order.id]);
    expect(updatedOrder.gross_paise).toBe(200000);
    expect(updatedOrder.discount_paise).toBe(50000);
    expect(updatedOrder.net_paise).toBe(150000);
  });
});

describe('handling order.refunded on BILLED order', () => {
  it('fails if order is not BILLED', async () => {
    const order = await createOrder('SERVED');
    const [item] = await sql(
      `INSERT INTO pos_order_items (order_id, item_name, category, quantity, unit_price_paise)
       VALUES ($1, 'Dish', 'ENTREE', 1, 100000) RETURNING id`,
      [order.id],
    );

    const payload = {
      type: 'order.refunded',
      eventId: nextEventId(),
      orderId: order.id,
      orderItemId: item.id,
      reason: 'BILLING_ERROR',
      authorizedBy: 'Manager Carol',
    };

    const res = await postWebhook(payload);
    const eventId = res.json().webhookEventId;
    const [ev] = await sql('SELECT status, last_error FROM webhook_events WHERE id = $1', [eventId]);
    expect(ev.status).toBe('FAILED');
    expect(ev.last_error).toContain('Refunds apply to billed orders only');
  });

  it('records REFUND with post_settlement = true and updates totals on BILLED order', async () => {
    const [guest] = await sql(`INSERT INTO guests (first_name, last_name, phone_number) VALUES ('Tara', 'Sen', '+919830003344') RETURNING id`);
    await sql('INSERT INTO guest_profiles (guest_id) VALUES ($1)', [guest.id]);

    const order = await createOrder('BILLED', guest.id);
    const [item] = await sql(
      `INSERT INTO pos_order_items (order_id, item_name, category, quantity, unit_price_paise)
       VALUES ($1, 'Tasting Menu', 'PREMIUM', 1, 350000) RETURNING *`,
      [order.id],
    );
    await sql('UPDATE pos_orders SET gross_paise = 350000, net_paise = 350000, paid_paise = 350000 WHERE id = $1', [order.id]);

    const payload = {
      type: 'order.refunded',
      eventId: nextEventId(),
      orderId: order.id,
      orderItemId: item.id,
      reason: 'BILLING_ERROR',
      authorizedBy: 'Manager Carol',
    };

    const res = await postWebhook(payload);
    expect(res.json().status).toBe('processed');

    // Verify refund log
    const [refundLog] = await sql('SELECT * FROM pos_void_logs WHERE order_id = $1', [order.id]);
    expect(refundLog).toBeDefined();
    expect(refundLog.kind).toBe('REFUND');
    expect(refundLog.post_settlement).toBe(true);
    expect(refundLog.amount_voided_paise).toBe(350000);

    // Verify order totals
    const [updatedOrder] = await sql('SELECT * FROM pos_orders WHERE id = $1', [order.id]);
    expect(updatedOrder.discount_paise).toBe(350000);
    expect(updatedOrder.net_paise).toBe(0);

    // Item marked is_voided
    const [refundedItem] = await sql('SELECT is_voided FROM pos_order_items WHERE id = $1', [item.id]);
    expect(refundedItem.is_voided).toBe(true);
  });
});

describe('failure and DLQ lifecycle', () => {
  it('retries with exponential backoff and moves to DEAD with WEBHOOK_DEAD alert after 5 failures', async () => {
    const order = await createOrder();
    const managerCookie = await cookieFor('manager');

    // Use simulator to force 5 failures
    const simRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/admin/venues/${ctx.fx.venueId}/pos/simulate`,
      headers: { cookie: managerCookie },
      payload: {
        body: {
          type: 'ticket.updated',
          eventId: nextEventId(),
          orderId: order.id,
          items: [{ itemName: 'Crab Cakes', category: 'STARTER', quantity: 1, unitPricePaise: 75000 }],
        },
        failTimes: 5,
      },
    });

    expect(simRes.statusCode).toBe(200);
    const { webhookEventId } = simRes.json();

    // 1st failure happened on ingest
    let [ev] = await sql('SELECT * FROM webhook_events WHERE id = $1', [webhookEventId]);
    expect(ev.status).toBe('FAILED');
    expect(ev.attempts).toBe(1);
    expect(ev.next_attempt_at).not.toBeNull();

    // Retry 2nd time: advance clock and run retry job
    clock.advanceMinutes(1);
    await retryDueWebhooks();
    [ev] = await sql('SELECT * FROM webhook_events WHERE id = $1', [webhookEventId]);
    expect(ev.status).toBe('FAILED');
    expect(ev.attempts).toBe(2);

    // Retry 3rd time
    clock.advanceMinutes(1);
    await retryDueWebhooks();
    [ev] = await sql('SELECT * FROM webhook_events WHERE id = $1', [webhookEventId]);
    expect(ev.status).toBe('FAILED');
    expect(ev.attempts).toBe(3);

    // Retry 4th time
    clock.advanceMinutes(10);
    await retryDueWebhooks();
    [ev] = await sql('SELECT * FROM webhook_events WHERE id = $1', [webhookEventId]);
    expect(ev.status).toBe('FAILED');
    expect(ev.attempts).toBe(4);

    // Retry 5th time -> moves to DEAD
    clock.advanceMinutes(70);
    await retryDueWebhooks();
    [ev] = await sql('SELECT * FROM webhook_events WHERE id = $1', [webhookEventId]);
    expect(ev.status).toBe('DEAD');
    expect(ev.attempts).toBe(5);
    expect(ev.next_attempt_at).toBeNull();

    // Verify WEBHOOK_DEAD alert created
    const [deadAlert] = await sql(
      `SELECT * FROM alerts WHERE venue_id = $1 AND kind = 'WEBHOOK_DEAD' AND data->>'webhookEventId' = $2`,
      [ctx.fx.venueId, webhookEventId],
    );
    expect(deadAlert).toBeDefined();
    expect(deadAlert.severity).toBe('critical');
    expect(deadAlert.title).toBe('POS webhook moved to dead-letter queue');
  });
});

describe('webhook replay endpoint', () => {
  it('POST /admin/webhooks/:id/replay allows manager to replay DEAD event', async () => {
    const order = await createOrder();
    const managerCookie = await cookieFor('manager');

    // Force failure to DEAD
    const simRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/admin/venues/${ctx.fx.venueId}/pos/simulate`,
      headers: { cookie: managerCookie },
      payload: {
        body: {
          type: 'ticket.updated',
          eventId: nextEventId(),
          orderId: order.id,
          items: [{ itemName: 'Soup', category: 'STARTER', quantity: 1, unitPricePaise: 40000 }],
        },
        failTimes: 5,
      },
    });

    const { webhookEventId } = simRes.json();
    // Simulate it reaching DEAD
    await sql(`UPDATE webhook_events SET status = 'DEAD', attempts = 5 WHERE id = $1`, [webhookEventId]);

    // Host cannot replay (requires MANAGER)
    const hostCookie = await cookieFor('host');
    const forbidRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/admin/webhooks/${webhookEventId}/replay`,
      headers: { cookie: hostCookie },
    });
    expect(forbidRes.statusCode).toBe(403);

    // Manager replays: since attempts was 5 and failTimes is 5, 5 < 5 is false, so next attempt succeeds!
    const replayRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/admin/webhooks/${webhookEventId}/replay`,
      headers: { cookie: managerCookie },
    });

    expect(replayRes.statusCode).toBe(200);
    const dto: WebhookEventDto = replayRes.json();
    expect(dto.status).toBe('PROCESSED');

    // Check items were processed
    const items = await sql('SELECT * FROM pos_order_items WHERE order_id = $1', [order.id]);
    expect(items).toHaveLength(1);
    expect(items[0].item_name).toBe('Soup');

    // Replaying already PROCESSED event returns 409
    const dupReplay = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/admin/webhooks/${webhookEventId}/replay`,
      headers: { cookie: managerCookie },
    });
    expect(dupReplay.statusCode).toBe(409);
    expect(dupReplay.json().error.code).toBe('WEBHOOK_ALREADY_PROCESSED');
  });
});
