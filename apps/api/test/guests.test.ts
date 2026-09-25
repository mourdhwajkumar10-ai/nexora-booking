import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuestProfileDto, GuestSummary, LedgerEntryDto } from '@nexora/shared';
import { getPool } from '../src/db/pool';
import { publish } from '../src/lib/bus';
import { clock } from '../src/lib/clock';
import { createTestContext, FIXTURE_DATE, FIXTURE_NOW, type TestContext } from './helpers';

let ctx: TestContext;
let phoneSeq = 1000;
const nextPhone = () => `+91981${String(++phoneSeq).padStart(7, '0')}`;

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

async function cookieFor(role: 'manager' | 'host' | 'other' = 'host'): Promise<string> {
  const email = role === 'manager' ? ctx.fx.managerEmail : role === 'host' ? ctx.fx.hostEmail : ctx.fx.otherVenueHostEmail;
  const [u] = await sql('SELECT id, email, name, role, venue_id FROM staff_users WHERE email = $1', [email]);
  return `nexora_session=${ctx.app.jwt.sign({ id: u.id, email: u.email, name: u.name, role: u.role, venueId: u.venue_id }, { expiresIn: '1h' })}`;
}

async function createGuest(opts: {
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
} = {}) {
  const phone = opts.phone ?? nextPhone();
  const [g] = await sql(
    `INSERT INTO guests (first_name, last_name, phone_number, email) VALUES ($1,$2,$3,$4) RETURNING *`,
    [opts.firstName ?? 'Aarav', opts.lastName ?? 'Patel', phone, opts.email ?? null],
  );
  await sql('INSERT INTO guest_profiles (guest_id) VALUES ($1) ON CONFLICT DO NOTHING', [g.id]);
  await sql('INSERT INTO loyalty_accounts (guest_id) VALUES ($1) ON CONFLICT DO NOTHING', [g.id]);
  return g;
}

describe('guest profile & CRM', () => {
  it('GET /admin/guests/:guestId returns complete profile for staff', async () => {
    const hostCookie = await cookieFor('host');
    const guest = await createGuest({ firstName: 'Rohan', lastName: 'Mehta', email: 'rohan.mehta@example.com' });

    // Set some profile details
    await sql(
      `UPDATE guest_profiles
       SET seating_preference = 'WINDOW', dietary_notes = 'Vegetarian', allergies = 'Peanuts', total_visits = 3, lifetime_spend_paise = 450000
       WHERE guest_id = $1`,
      [guest.id],
    );

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/admin/guests/${guest.id}`,
      headers: { cookie: hostCookie },
    });

    expect(res.statusCode).toBe(200);
    const body: GuestProfileDto = res.json();
    expect(body.id).toBe(guest.id);
    expect(body.name).toBe('Rohan Mehta');
    expect(body.firstName).toBe('Rohan');
    expect(body.lastName).toBe('Mehta');
    expect(body.phone).toBe(guest.phone_number);
    expect(body.email).toBe('rohan.mehta@example.com');
    expect(body.seatingPreference).toBe('WINDOW');
    expect(body.dietaryNotes).toBe('Vegetarian');
    expect(body.allergies).toBe('Peanuts');
    expect(body.hasAllergies).toBe(true);
    expect(body.totalVisits).toBe(3);
    expect(body.lifetimeSpendPaise).toBe(450000);
    expect(body.loyalty).toMatchObject({
      tier: 'BASE',
      pointsBalance: 0,
      walletBalancePaise: 0,
      multiplier: 3,
    });
    expect(Array.isArray(body.tags)).toBe(true);
    expect(Array.isArray(body.reservations)).toBe(true);
    expect(Array.isArray(body.devices)).toBe(true);
    expect(Array.isArray(body.itemAffinities)).toBe(true);
  });

  it('GET /admin/guests/:guestId returns 404 for unknown guest', async () => {
    const hostCookie = await cookieFor('host');
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/admin/guests/00000000-0000-0000-0000-000000000000`,
      headers: { cookie: hostCookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('GET /admin/guests/:guestId requires staff auth (401 for anonymous)', async () => {
    const guest = await createGuest();
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/admin/guests/${guest.id}`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('GET /admin/guests searches by name, phone and email', async () => {
    const hostCookie = await cookieFor('host');
    const g1 = await createGuest({ firstName: 'Sunita', lastName: 'Kapoor', phone: '+919811112233', email: 'sunita@test.com' });
    const g2 = await createGuest({ firstName: 'Dev', lastName: 'Anand', phone: '+919811114455', email: 'dev@test.com' });

    // Search by name
    const resName = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/guests?q=Sunita',
      headers: { cookie: hostCookie },
    });
    expect(resName.statusCode).toBe(200);
    const listName: GuestSummary[] = resName.json();
    expect(listName.some((g) => g.id === g1.id)).toBe(true);
    expect(listName.some((g) => g.id === g2.id)).toBe(false);

    // Search by phone
    const resPhone = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/guests?q=114455',
      headers: { cookie: hostCookie },
    });
    expect(resPhone.statusCode).toBe(200);
    const listPhone: GuestSummary[] = resPhone.json();
    expect(listPhone.some((g) => g.id === g2.id)).toBe(true);
  });
});

describe('guest preferences update', () => {
  it('PATCH /admin/guests/:guestId updates profile fields and writes an audit log', async () => {
    const hostCookie = await cookieFor('host');
    const guest = await createGuest({ firstName: 'Original', lastName: 'User' });

    const patchPayload = {
      firstName: 'Updated',
      lastName: 'Guest',
      email: 'updated.guest@example.com',
      seatingPreference: 'BOOTH',
      dietaryNotes: 'Gluten free',
      allergies: 'Shellfish',
    };

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/guests/${guest.id}`,
      headers: { cookie: hostCookie },
      payload: patchPayload,
    });

    expect(res.statusCode).toBe(200);
    const body: GuestProfileDto = res.json();
    expect(body.firstName).toBe('Updated');
    expect(body.lastName).toBe('Guest');
    expect(body.name).toBe('Updated Guest');
    expect(body.email).toBe('updated.guest@example.com');
    expect(body.seatingPreference).toBe('BOOTH');
    expect(body.dietaryNotes).toBe('Gluten free');
    expect(body.allergies).toBe('Shellfish');
    expect(body.hasAllergies).toBe(true);

    // Verify audit log
    const [auditLog] = await sql(
      `SELECT * FROM audit_logs WHERE entity = 'guest' AND entity_id = $1 AND action = 'guest.update'`,
      [guest.id],
    );
    expect(auditLog).toBeDefined();
    expect(auditLog.actor).toBe(`staff:${ctx.fx.hostEmail}`);
    expect(auditLog.data).toMatchObject({ seatingPreference: 'BOOTH', dietaryNotes: 'Gluten free' });
  });

  it('PATCH /admin/guests/:guestId returns 404 for unknown guest id', async () => {
    const hostCookie = await cookieFor('host');
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/guests/00000000-0000-0000-0000-000000000000`,
      headers: { cookie: hostCookie },
      payload: { seatingPreference: 'BOOTH' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('PATCH /admin/guests/:guestId rejects invalid seating preference', async () => {
    const hostCookie = await cookieFor('host');
    const guest = await createGuest();
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/guests/${guest.id}`,
      headers: { cookie: hostCookie },
      payload: { seatingPreference: 'INVALID_PREFERENCE' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('adding and deleting tags', () => {
  it('POST /admin/guests/:guestId/tags formats tag name and marks non-auto-generated', async () => {
    const hostCookie = await cookieFor('host');
    const guest = await createGuest();

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/admin/guests/${guest.id}/tags`,
      headers: { cookie: hostCookie },
      payload: { tagName: 'high roller' },
    });

    expect(res.statusCode).toBe(200);
    const body: GuestProfileDto = res.json();
    expect(body.tags).toContain('HIGH_ROLLER');

    const [tagRow] = await sql('SELECT * FROM guest_tags WHERE guest_id = $1 AND tag_name = $2', [guest.id, 'HIGH_ROLLER']);
    expect(tagRow).toBeDefined();
    expect(tagRow.is_auto_generated).toBe(false);

    // Adding duplicate tag is idempotent
    const resDup = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/admin/guests/${guest.id}/tags`,
      headers: { cookie: hostCookie },
      payload: { tagName: 'high roller' },
    });
    expect(resDup.statusCode).toBe(200);
    const tags = await sql('SELECT tag_name FROM guest_tags WHERE guest_id = $1', [guest.id]);
    expect(tags.filter((t) => t.tag_name === 'HIGH_ROLLER')).toHaveLength(1);
  });

  it('DELETE /admin/guests/:guestId/tags/:tagName removes manual tag', async () => {
    const hostCookie = await cookieFor('host');
    const guest = await createGuest();

    // Add tag first
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/admin/guests/${guest.id}/tags`,
      headers: { cookie: hostCookie },
      payload: { tagName: 'CELEBRITY' },
    });

    // Delete tag (case-insensitive in path param)
    const delRes = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/guests/${guest.id}/tags/celebrity`,
      headers: { cookie: hostCookie },
    });
    expect(delRes.statusCode).toBe(200);
    const body: GuestProfileDto = delRes.json();
    expect(body.tags).not.toContain('CELEBRITY');

    const remaining = await sql('SELECT 1 FROM guest_tags WHERE guest_id = $1 AND tag_name = $2', [guest.id, 'CELEBRITY']);
    expect(remaining).toHaveLength(0);
  });

  it('POST /admin/guests/:guestId/tags returns 404 for unknown guest', async () => {
    const hostCookie = await cookieFor('host');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/admin/guests/00000000-0000-0000-0000-000000000000/tags`,
      headers: { cookie: hostCookie },
      payload: { tagName: 'TEST_TAG' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('auto-tagging rules evaluation', () => {
  it('WINE_CONNOISSEUR and TOP_SPENDER tags on order.billed', async () => {
    const guest = await createGuest();
    const [order] = await sql(
      `INSERT INTO pos_orders (venue_id, table_id, guest_id, status, net_paise, gross_paise)
       VALUES ($1, $2, $3, 'BILLED', 1600000, 1600000) RETURNING id`,
      [ctx.fx.venueId, ctx.fx.tables['T-1'], guest.id],
    );

    // Insert an expensive wine item (>= ₹5,000 = 500000 paise)
    await sql(
      `INSERT INTO pos_order_items (order_id, item_name, category, quantity, unit_price_paise, is_voided)
       VALUES ($1, 'Barolo 2018', 'WINE', 1, 950000, false)`,
      [order.id],
    );

    // Publish order.billed event
    await publish([
      {
        type: 'order.billed',
        venueId: ctx.fx.venueId,
        orderId: order.id,
        tableId: ctx.fx.tables['T-1'],
        guestId: guest.id,
        reservationId: null,
        netPaise: 1600000, // >= 15,000,00 paise (₹15,000) -> TOP_SPENDER
      },
    ]);

    const tags = await sql('SELECT tag_name, is_auto_generated FROM guest_tags WHERE guest_id = $1 ORDER BY tag_name', [guest.id]);
    const tagNames = tags.map((t) => t.tag_name);
    expect(tagNames).toContain('WINE_CONNOISSEUR');
    expect(tagNames).toContain('TOP_SPENDER');
    expect(tags.every((t) => t.is_auto_generated)).toBe(true);

    // Profile lifetime spend updated
    const [profile] = await sql('SELECT lifetime_spend_paise FROM guest_profiles WHERE guest_id = $1', [guest.id]);
    expect(profile.lifetime_spend_paise).toBe(1600000);
  });

  it('REGULAR tag on reservation.changed to COMPLETED when visits >= 5', async () => {
    const guest = await createGuest();
    await sql('UPDATE guest_profiles SET total_visits = 5 WHERE guest_id = $1', [guest.id]);

    await publish([
      {
        type: 'reservation.changed',
        venueId: ctx.fx.venueId,
        reservationId: '00000000-0000-0000-0000-000000000001',
        guestId: guest.id,
        tableId: ctx.fx.tables['T-1'],
        from: 'SEATED',
        to: 'COMPLETED',
      },
    ]);

    const tags = await sql('SELECT tag_name FROM guest_tags WHERE guest_id = $1', [guest.id]);
    expect(tags.map((t) => t.tag_name)).toContain('REGULAR');
  });

  it('SLOW_PACING tag on completed reservation when duration > turnaround + 15m twice', async () => {
    const guest = await createGuest();
    // Venue turnaround is 30m. SLOW_PACING_EXTRA_MINS = 15m. Pacing threshold = 45m.
    // Insert 2 completed reservations spanning 50 minutes
    for (let i = 0; i < 2; i++) {
      const seated = new Date('2026-10-02T12:00:00.000Z');
      const completed = new Date('2026-10-02T12:50:00.000Z'); // 50 mins > 45 mins
      await sql(
        `INSERT INTO reservations (venue_id, table_id, guest_id, party_size, booking_date, start_at, end_at, status, seated_at, completed_at)
         VALUES ($1, $2, $3, 2, $4, $5, $6, 'COMPLETED', $5, $6)`,
        [ctx.fx.venueId, ctx.fx.tables['T-1'], guest.id, FIXTURE_DATE, seated, completed],
      );
    }

    await publish([
      {
        type: 'reservation.changed',
        venueId: ctx.fx.venueId,
        reservationId: '00000000-0000-0000-0000-000000000002',
        guestId: guest.id,
        tableId: ctx.fx.tables['T-1'],
        from: 'SEATED',
        to: 'COMPLETED',
      },
    ]);

    const tags = await sql('SELECT tag_name FROM guest_tags WHERE guest_id = $1', [guest.id]);
    expect(tags.map((t) => t.tag_name)).toContain('SLOW_PACING');
  });

  it('LATE_CANCELLER tag on reservation.changed to CANCELLED within 2 hours twice', async () => {
    const guest = await createGuest();
    // Insert 2 reservations cancelled within 2 hours of start_at
    for (let i = 0; i < 2; i++) {
      const startAt = new Date('2026-10-02T14:00:00.000Z');
      const endAt = new Date('2026-10-02T15:00:00.000Z');
      const cancelledAt = new Date('2026-10-02T13:30:00.000Z'); // 30 mins before start (<= 2 hours)
      await sql(
        `INSERT INTO reservations (venue_id, table_id, guest_id, party_size, booking_date, start_at, end_at, status, cancelled_at)
         VALUES ($1, $2, $3, 2, $4, $5, $6, 'CANCELLED', $7)`,
        [ctx.fx.venueId, ctx.fx.tables['T-1'], guest.id, FIXTURE_DATE, startAt, endAt, cancelledAt],
      );
    }

    await publish([
      {
        type: 'reservation.changed',
        venueId: ctx.fx.venueId,
        reservationId: '00000000-0000-0000-0000-000000000003',
        guestId: guest.id,
        tableId: ctx.fx.tables['T-1'],
        from: 'CONFIRMED',
        to: 'CANCELLED',
      },
    ]);

    const tags = await sql('SELECT tag_name FROM guest_tags WHERE guest_id = $1', [guest.id]);
    expect(tags.map((t) => t.tag_name)).toContain('LATE_CANCELLER');
  });

  it('FREQUENT_COMPLAINTS tag on order.adjusted when total_voids_count >= 3', async () => {
    const guest = await createGuest();
    await sql('UPDATE guest_profiles SET total_voids_count = 3 WHERE guest_id = $1', [guest.id]);

    await publish([
      {
        type: 'order.adjusted',
        venueId: ctx.fx.venueId,
        orderId: '00000000-0000-0000-0000-000000000004',
        guestId: guest.id,
        kind: 'VOID',
        amountPaise: 50000,
        postSettlement: false,
      },
    ]);

    const tags = await sql('SELECT tag_name FROM guest_tags WHERE guest_id = $1', [guest.id]);
    expect(tags.map((t) => t.tag_name)).toContain('FREQUENT_COMPLAINTS');
  });
});

describe('wallet preloading and ledger', () => {
  it('POST /admin/guests/:guestId/wallet/preload requires manager role (403 for host)', async () => {
    const hostCookie = await cookieFor('host');
    const guest = await createGuest();

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/admin/guests/${guest.id}/wallet/preload`,
      headers: { cookie: hostCookie },
      payload: { amountPaise: 500000 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('manager preloads wallet, updates balance, creates ledger entry, audits and upgrades tier', async () => {
    const managerCookie = await cookieFor('manager');
    const guest = await createGuest();

    // Preload ₹2,500 (250000 paise)
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/admin/guests/${guest.id}/wallet/preload`,
      headers: { cookie: managerCookie },
      payload: { amountPaise: 250000 },
    });

    expect(res.statusCode).toBe(200);
    const body: GuestProfileDto = res.json();
    expect(body.loyalty.walletBalancePaise).toBe(250000);

    // Verify audit log
    const [audit] = await sql(
      `SELECT * FROM audit_logs WHERE entity = 'guest' AND entity_id = $1 AND action = 'wallet.preload'`,
      [guest.id],
    );
    expect(audit).toBeDefined();
    expect(audit.actor).toBe(`staff:${ctx.fx.managerEmail}`);
    expect(audit.data).toMatchObject({ amountPaise: 250000 });

    // Verify ledger entry via endpoint
    const hostCookie = await cookieFor('host');
    const ledgerRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/admin/guests/${guest.id}/ledger`,
      headers: { cookie: hostCookie },
    });
    expect(ledgerRes.statusCode).toBe(200);
    const ledger: LedgerEntryDto[] = ledgerRes.json();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      eventType: 'PRELOAD',
      amountPaise: 250000,
      pointsDelta: 0,
      referenceType: 'WALLET',
    });
  });

  it('large preload upgrades tier directly (e.g. ₹2,50,000 upgrades to REGULAR with VIP tag)', async () => {
    const managerCookie = await cookieFor('manager');
    const guest = await createGuest();

    // Single preload of ₹2,50,000 (250_000_00 paise) = REGULAR tier threshold
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/admin/guests/${guest.id}/wallet/preload`,
      headers: { cookie: managerCookie },
      payload: { amountPaise: 250_000_00 },
    });

    expect(res.statusCode).toBe(200);
    const body: GuestProfileDto = res.json();
    expect(body.loyalty.tier).toBe('REGULAR');
    expect(body.loyalty.multiplier).toBe(5);
    expect(body.tags).toContain('VIP');
  });
});
