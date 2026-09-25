import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GiftCardDto, SettleResult } from '@nexora/shared';
import { getPool } from '../src/db/pool';
import { publish } from '../src/lib/bus';
import { createTestContext, FIXTURE_NOW, type TestContext } from './helpers';

let ctx: TestContext;
let phoneSeq = 3000;
const nextPhone = () => `+91984${String(++phoneSeq).padStart(7, '0')}`;

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

async function createGuest(opts: { firstName?: string; lastName?: string; phone?: string } = {}) {
  const phone = opts.phone ?? nextPhone();
  const [g] = await sql(
    `INSERT INTO guests (first_name, last_name, phone_number) VALUES ($1,$2,$3) RETURNING *`,
    [opts.firstName ?? 'Kabir', opts.lastName ?? 'Das', phone],
  );
  await sql('INSERT INTO guest_profiles (guest_id) VALUES ($1) ON CONFLICT DO NOTHING', [g.id]);
  await sql('INSERT INTO loyalty_accounts (guest_id) VALUES ($1) ON CONFLICT DO NOTHING', [g.id]);
  return g;
}

async function createOrder(opts: {
  status?: string;
  guestId?: string | null;
  grossPaise?: number;
  netPaise?: number;
  paidPaise?: number;
} = {}) {
  const [order] = await sql(
    `INSERT INTO pos_orders (venue_id, table_id, guest_id, status, gross_paise, discount_paise, net_paise, paid_paise)
     VALUES ($1, $2, $3, $4, $5, 0, $6, $7) RETURNING *`,
    [
      ctx.fx.venueId,
      ctx.fx.tables['T-1'],
      opts.guestId ?? null,
      opts.status ?? 'SERVED',
      opts.grossPaise ?? 100000,
      opts.netPaise ?? 100000,
      opts.paidPaise ?? 0,
    ],
  );
  return order;
}

describe('points accrual on order.billed', () => {
  it('calculates points based on net spend and tier multiplier (BASE = 3x)', async () => {
    const guest = await createGuest();
    // Order net spend = ₹1,000 (100,000 paise). At BASE tier (multiplier 3), points = 1,000 * 3 = 3,000
    const order = await createOrder({ status: 'BILLED', guestId: guest.id, netPaise: 100000, paidPaise: 100000 });

    await publish([
      {
        type: 'order.billed',
        venueId: ctx.fx.venueId,
        orderId: order.id,
        tableId: ctx.fx.tables['T-1'],
        guestId: guest.id,
        reservationId: null,
        netPaise: 100000,
      },
    ]);

    const [account] = await sql('SELECT points_balance, annual_spend_paise FROM loyalty_accounts WHERE guest_id = $1', [guest.id]);
    expect(account.points_balance).toBe(3000);
    expect(account.annual_spend_paise).toBe(100000);

    const [ledger] = await sql('SELECT * FROM loyalty_ledger WHERE account_id = (SELECT id FROM loyalty_accounts WHERE guest_id = $1)', [guest.id]);
    expect(ledger).toBeDefined();
    expect(ledger.event_type).toBe('ACCRUAL');
    expect(ledger.points_delta).toBe(3000);
    expect(ledger.amount_paise).toBe(100000);
    expect(ledger.reference_type).toBe('ORDER');
    expect(ledger.reference_id).toBe(order.id);
  });

  it('accrual is idempotent (does not double-credit on repeated events)', async () => {
    const guest = await createGuest();
    const order = await createOrder({ status: 'BILLED', guestId: guest.id, netPaise: 50000, paidPaise: 50000 });

    const event = {
      type: 'order.billed' as const,
      venueId: ctx.fx.venueId,
      orderId: order.id,
      tableId: ctx.fx.tables['T-1'],
      guestId: guest.id,
      reservationId: null,
      netPaise: 50000,
    };

    await publish([event]);
    await publish([event]);

    const [account] = await sql('SELECT points_balance FROM loyalty_accounts WHERE guest_id = $1', [guest.id]);
    // 500 * 3 = 1500 points (credited once)
    expect(account.points_balance).toBe(1500);
  });
});

describe('tier upgrade and tier progression', () => {
  it('annual spend threshold upgrades guest tier (BASE -> MEMBER -> REGULAR with VIP tag)', async () => {
    const guest = await createGuest();

    // 1. Spend ₹50,000 (50_000_00 paise) -> unlocks MEMBER tier (multiplier 4)
    const order1 = await createOrder({ status: 'BILLED', guestId: guest.id, netPaise: 50_000_00 });
    await publish([
      {
        type: 'order.billed',
        venueId: ctx.fx.venueId,
        orderId: order1.id,
        tableId: ctx.fx.tables['T-1'],
        guestId: guest.id,
        reservationId: null,
        netPaise: 50_000_00,
      },
    ]);

    let [account] = await sql('SELECT tier_level, points_balance, annual_spend_paise FROM loyalty_accounts WHERE guest_id = $1', [guest.id]);
    expect(account.tier_level).toBe('MEMBER');
    // First bill was at BASE (3x): 50,000 * 3 = 150,000 points
    expect(account.points_balance).toBe(150000);

    // 2. Additional spend to reach ₹5,00,000 (450_000_00 paise) -> unlocks REGULAR tier (multiplier 5) + VIP tag
    const order2 = await createOrder({ status: 'BILLED', guestId: guest.id, netPaise: 450_000_00 });
    await publish([
      {
        type: 'order.billed',
        venueId: ctx.fx.venueId,
        orderId: order2.id,
        tableId: ctx.fx.tables['T-1'],
        guestId: guest.id,
        reservationId: null,
        netPaise: 450_000_00,
      },
    ]);

    [account] = await sql('SELECT tier_level, annual_spend_paise FROM loyalty_accounts WHERE guest_id = $1', [guest.id]);
    expect(account.tier_level).toBe('REGULAR');
    expect(account.annual_spend_paise).toBe(500_000_00);

    // Guest should automatically have 'VIP' tag added
    const tags = await sql('SELECT tag_name FROM guest_tags WHERE guest_id = $1', [guest.id]);
    expect(tags.map((t) => t.tag_name)).toContain('VIP');
  });
});

describe('post-settlement clawback and deficit handling', () => {
  it('claws back points on post-settlement void/refund', async () => {
    const guest = await createGuest();
    // Guest starts with 3,000 points from ₹1,000 spend at BASE (3x)
    await sql(
      `UPDATE loyalty_accounts SET points_balance = 3000, annual_spend_paise = 100000 WHERE guest_id = $1`,
      [guest.id],
    );

    // Post-settlement refund of ₹400 (40,000 paise)
    await publish([
      {
        type: 'order.adjusted',
        venueId: ctx.fx.venueId,
        orderId: '00000000-0000-0000-0000-000000000010',
        guestId: guest.id,
        kind: 'REFUND',
        amountPaise: 40000,
        postSettlement: true,
      },
    ]);

    // Clawback points: 400 * 3 = 1200 points
    const [account] = await sql('SELECT points_balance, annual_spend_paise FROM loyalty_accounts WHERE guest_id = $1', [guest.id]);
    expect(account.points_balance).toBe(3000 - 1200); // 1800
    expect(account.annual_spend_paise).toBe(100000 - 40000); // 60000

    const [ledger] = await sql(
      `SELECT * FROM loyalty_ledger WHERE account_id = (SELECT id FROM loyalty_accounts WHERE guest_id = $1) AND event_type = 'REVERSAL'`,
      [guest.id],
    );
    expect(ledger).toBeDefined();
    expect(ledger.points_delta).toBe(-1200);
  });

  it('deficit handling: clawback causing negative balance sets UNRESOLVED_LOYALTY_DEFICIT and alert; future accrual clears deficit', async () => {
    const guest = await createGuest();
    // Guest had 1,000 points (spent previous points)
    await sql(
      `UPDATE loyalty_accounts SET points_balance = 500, annual_spend_paise = 100000 WHERE guest_id = $1`,
      [guest.id],
    );

    // Refund of ₹1,000 (100,000 paise) -> clawback 3,000 points! Balance becomes 500 - 3000 = -2500
    await publish([
      {
        type: 'order.adjusted',
        venueId: ctx.fx.venueId,
        orderId: '00000000-0000-0000-0000-000000000011',
        guestId: guest.id,
        kind: 'REFUND',
        amountPaise: 100000,
        postSettlement: true,
      },
    ]);

    const [account] = await sql('SELECT points_balance FROM loyalty_accounts WHERE guest_id = $1', [guest.id]);
    expect(account.points_balance).toBe(-2500);

    // Profile has UNRESOLVED_LOYALTY_DEFICIT flag
    const [profile] = await sql('SELECT flags FROM guest_profiles WHERE guest_id = $1', [guest.id]);
    expect(profile.flags).toContain('UNRESOLVED_LOYALTY_DEFICIT');

    // Alert was raised
    const [alert] = await sql(
      `SELECT * FROM alerts WHERE venue_id = $1 AND kind = 'LOYALTY_DEFICIT' AND data->>'guestId' = $2`,
      [ctx.fx.venueId, guest.id],
    );
    expect(alert).toBeDefined();
    expect(alert.severity).toBe('warning');
    expect(alert.title).toBe('Loyalty deficit');

    // Future order billed earns 3,600 points (₹1,200 bill at BASE 3x)
    // Repays deficit: -2500 + 3600 = +1100, and clears flag!
    const newOrder = await createOrder({ status: 'BILLED', guestId: guest.id, netPaise: 120000 });
    await publish([
      {
        type: 'order.billed',
        venueId: ctx.fx.venueId,
        orderId: newOrder.id,
        tableId: ctx.fx.tables['T-1'],
        guestId: guest.id,
        reservationId: null,
        netPaise: 120000,
      },
    ]);

    const [updatedAcct] = await sql('SELECT points_balance FROM loyalty_accounts WHERE guest_id = $1', [guest.id]);
    expect(updatedAcct.points_balance).toBe(1100);

    const [updatedProfile] = await sql('SELECT flags FROM guest_profiles WHERE guest_id = $1', [guest.id]);
    expect(updatedProfile.flags).not.toContain('UNRESOLVED_LOYALTY_DEFICIT');
  });
});

describe('gift card issuance and lifecycle', () => {
  it('POST /admin/gift-cards returns 16-digit card number once (manager only)', async () => {
    const managerCookie = await cookieFor('manager');
    const hostCookie = await cookieFor('host');

    // Host forbidden (403)
    const forbidRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/gift-cards',
      headers: { cookie: hostCookie },
      payload: { amountPaise: 500000 },
    });
    expect(forbidRes.statusCode).toBe(403);

    // Manager issues card
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/gift-cards',
      headers: { cookie: managerCookie },
      payload: { amountPaise: 500000 }, // ₹5,000
    });

    expect(res.statusCode).toBe(201);
    const body: GiftCardDto = res.json();
    expect(body.balancePaise).toBe(500000);
    expect(body.last4).toBeDefined();
    expect(body.cardNumber).toMatch(/^6011\d{12}$/);
    expect(body.cardNumber?.endsWith(body.last4)).toBe(true);

    // Ledger has PURCHASE entry
    const [gcLedger] = await sql('SELECT * FROM gift_card_ledger WHERE gift_card_id = $1', [body.id]);
    expect(gcLedger.kind).toBe('PURCHASE');
    expect(gcLedger.delta_paise).toBe(500000);

    // GET /admin/gift-cards lists card with last4 only (no full cardNumber)
    const listRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/gift-cards',
      headers: { cookie: hostCookie },
    });
    expect(listRes.statusCode).toBe(200);
    const cards: GiftCardDto[] = listRes.json();
    const found = cards.find((c) => c.id === body.id);
    expect(found).toBeDefined();
    expect(found?.last4).toBe(body.last4);
    expect(found?.cardNumber).toBeUndefined();

    // Reload gift card
    const reloadRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/admin/gift-cards/${body.id}/reload`,
      headers: { cookie: managerCookie },
      payload: { amountPaise: 200000 }, // reload ₹2,000
    });
    expect(reloadRes.statusCode).toBe(200);
    expect(reloadRes.json().balancePaise).toBe(700000);
  });
});

describe('split tender settlement', () => {
  it('settles order with split tender across cash, card, gift card, points, wallet', async () => {
    const staffCookie = await cookieFor('host');
    const guest = await createGuest();

    // Fund guest loyalty points and wallet
    await sql(
      `UPDATE loyalty_accounts SET points_balance = 20000, wallet_balance_paise = 30000 WHERE guest_id = $1`,
      [guest.id],
    );

    // Issue a gift card with ₹500 (50,000 paise)
    const managerCookie = await cookieFor('manager');
    const gcRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/gift-cards',
      headers: { cookie: managerCookie },
      payload: { amountPaise: 50000 },
    });
    const cardNumber = gcRes.json().cardNumber;

    // Order total = ₹2,000 (200,000 paise) in SERVED status
    // Split:
    // - POINTS: 20,000 points = ₹200 (20,000 paise)
    // - WALLET: ₹300 (30,000 paise)
    // - GIFT_CARD: ₹500 (50,000 paise)
    // - CARD: ₹600 (60,000 paise)
    // - CASH: ₹400 (40,000 paise)
    // Total = 20000 + 30000 + 50000 + 60000 + 40000 = 200,000 paise
    const order = await createOrder({
      status: 'SERVED',
      guestId: guest.id,
      grossPaise: 200000,
      netPaise: 200000,
      paidPaise: 0,
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${order.id}/settle`,
      headers: { cookie: staffCookie },
      payload: {
        tenders: [
          { type: 'POINTS', points: 20000 },
          { type: 'WALLET', amountPaise: 30000 },
          { type: 'GIFT_CARD', amountPaise: 50000, cardNumber },
          { type: 'CARD', amountPaise: 60000 },
          { type: 'CASH', amountPaise: 40000 },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body: SettleResult = res.json();
    expect(body.outcome).toBe('BILLED');
    expect(body.order.status).toBe('BILLED');
    expect(body.order.paidPaise).toBe(200000);

    // Verify hold captured in gift_card_holds
    const [gcHold] = await sql('SELECT status FROM gift_card_holds WHERE order_id = $1', [order.id]);
    expect(gcHold.status).toBe('CAPTURED');

    // Verify holds captured in loyalty_holds
    const loyaltyHolds = await sql('SELECT status FROM loyalty_holds WHERE order_id = $1', [order.id]);
    expect(loyaltyHolds.length).toBeGreaterThan(0);
    expect(loyaltyHolds.every((h) => h.status === 'CAPTURED')).toBe(true);

    // Check balances were debited
    const [acct] = await sql('SELECT points_balance, wallet_balance_paise FROM loyalty_accounts WHERE guest_id = $1', [guest.id]);
    expect(acct.wallet_balance_paise).toBe(0);

    const [gc] = await sql('SELECT current_balance_paise FROM gift_cards WHERE id = $1', [gcRes.json().id]);
    expect(gc.current_balance_paise).toBe(0);
  });

  it('handles simulated card decline: releases holds and sets order to PARTIALLY_PAID', async () => {
    const staffCookie = await cookieFor('host');
    const guest = await createGuest();
    await sql('UPDATE loyalty_accounts SET wallet_balance_paise = 50000 WHERE guest_id = $1', [guest.id]);

    const order = await createOrder({ status: 'SERVED', guestId: guest.id, netPaise: 100000 });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${order.id}/settle`,
      headers: { cookie: staffCookie },
      payload: {
        tenders: [
          { type: 'WALLET', amountPaise: 50000 },
          { type: 'CARD', amountPaise: 50000, simulateDecline: true },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body: SettleResult = res.json();
    expect(body.outcome).toBe('PARTIALLY_PAID');
    expect(body.message).toContain('Card Declined');
    expect(body.order.status).toBe('PARTIALLY_PAID');

    // Holds were released
    const [loyaltyHold] = await sql('SELECT status FROM loyalty_holds WHERE order_id = $1', [order.id]);
    expect(loyaltyHold.status).toBe('RELEASED');

    // Wallet balance was NOT deducted
    const [acct] = await sql('SELECT wallet_balance_paise FROM loyalty_accounts WHERE guest_id = $1', [guest.id]);
    expect(acct.wallet_balance_paise).toBe(50000);
  });

  it('handles simulated gift card timeout: releases holds and leaves order in PARTIALLY_PAID', async () => {
    const staffCookie = await cookieFor('host');
    const managerCookie = await cookieFor('manager');

    const gcRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/gift-cards',
      headers: { cookie: managerCookie },
      payload: { amountPaise: 100000 },
    });
    const cardNumber = gcRes.json().cardNumber;

    const order = await createOrder({ status: 'SERVED', netPaise: 100000 });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${order.id}/settle`,
      headers: { cookie: staffCookie },
      payload: {
        tenders: [
          { type: 'GIFT_CARD', amountPaise: 100000, cardNumber, simulateTimeout: true },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body: SettleResult = res.json();
    expect(body.outcome).toBe('PARTIALLY_PAID');
    expect(body.message).toContain('Gift Card Unreachable');
    expect(body.order.status).toBe('PARTIALLY_PAID');

    // Gift card balance was not debited
    const [card] = await sql('SELECT current_balance_paise FROM gift_cards WHERE id = $1', [gcRes.json().id]);
    expect(card.current_balance_paise).toBe(100000);
  });
});
