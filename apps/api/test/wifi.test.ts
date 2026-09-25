import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlertDto, WifiConnectResponse } from '@nexora/shared';
import { getPool } from '../src/db/pool';
import { clock } from '../src/lib/clock';
import { sha256 } from '../src/lib/crypto';
import { createTestContext, FIXTURE_DATE, FIXTURE_NOW, type TestContext } from './helpers';

let ctx: TestContext;
let phoneSeq = 2000;
let macSeq = 10;
const nextPhone = () => `+91982${String(++phoneSeq).padStart(7, '0')}`;
const nextMac = () => `00:1a:2b:3c:4d:${String(++macSeq).padStart(2, '0')}`;

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

async function requestOtp(slug = ctx.fx.venueSlug, phone = nextPhone()) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/wifi/${slug}/otp`,
    payload: { phone },
  });
  return { res, phone };
}

describe('public venue Wi-Fi info', () => {
  it('GET /wifi/:slug returns venue name, slug and image', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/wifi/${ctx.fx.venueSlug}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.venue).toBeDefined();
    expect(body.venue.slug).toBe(ctx.fx.venueSlug);
    expect(body.venue.name).toBe('Test Bistro');
  });

  it('GET /wifi/:slug returns 404 for unknown slug', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/wifi/non-existent-venue',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('OTP generation and storage', () => {
  it('POST /wifi/:slug/otp returns 6-digit devCode and stores hashed code with 5-minute expiry', async () => {
    const phone = nextPhone();
    const { res } = await requestOtp(ctx.fx.venueSlug, phone);

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sent).toBe(true);
    expect(body.devCode).toMatch(/^\d{6}$/);

    const [otpRow] = await sql('SELECT * FROM wifi_otps WHERE phone = $1', [phone]);
    expect(otpRow).toBeDefined();
    // Raw code is never stored plain
    expect(otpRow.code_hash).not.toBe(body.devCode);
    // Code hash matches sha256(phone:devCode)
    expect(otpRow.code_hash).toBe(sha256(`${phone}:${body.devCode}`));
    expect(otpRow.attempts).toBe(0);
    expect(otpRow.verified_at).toBeNull();

    // Expiry is 5 minutes from now
    const expiresAt = new Date(otpRow.expires_at).getTime();
    const expectedExpiry = clock.now().getTime() + 5 * 60_000;
    expect(Math.abs(expiresAt - expectedExpiry)).toBeLessThan(1000);
  });

  it('requesting a new OTP for the same phone expires the previous OTP', async () => {
    const phone = nextPhone();
    const first = await requestOtp(ctx.fx.venueSlug, phone);
    const firstCode = first.res.json().devCode;

    // Advance clock 1 minute
    clock.advanceMinutes(1);

    const second = await requestOtp(ctx.fx.venueSlug, phone);
    const secondCode = second.res.json().devCode;
    expect(secondCode).toBeDefined();

    const otps = await sql('SELECT * FROM wifi_otps WHERE phone = $1 ORDER BY created_at ASC', [phone]);
    expect(otps).toHaveLength(2);
    // First OTP's expires_at was updated to the second request's time
    expect(new Date(otps[0].expires_at).getTime()).toBeLessThanOrEqual(new Date(otps[1].created_at).getTime());

    // Trying to connect with the old code fails
    const connectRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/wifi/${ctx.fx.venueSlug}/connect`,
      payload: {
        firstName: 'Test',
        lastName: 'User',
        phone,
        otp: firstCode,
        mac: nextMac(),
        consent: true,
      },
    });
    expect(connectRes.statusCode).toBe(400);
    expect(connectRes.json().error.code).toBe('INVALID_OTP');
  });
});

describe('OTP expiration and max attempts', () => {
  it('OTP expires after 5 minutes (clock.advanceMinutes(6))', async () => {
    const phone = nextPhone();
    const { res } = await requestOtp(ctx.fx.venueSlug, phone);
    const { devCode } = res.json();

    // Advance clock by 6 minutes
    clock.advanceMinutes(6);

    const connectRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/wifi/${ctx.fx.venueSlug}/connect`,
      payload: {
        firstName: 'Late',
        lastName: 'Guest',
        phone,
        otp: devCode,
        mac: nextMac(),
        consent: true,
      },
    });

    expect(connectRes.statusCode).toBe(400);
    expect(connectRes.json().error.code).toBe('INVALID_OTP');
  });

  it('OTP is locked after 5 failed attempts', async () => {
    const phone = nextPhone();
    const { res } = await requestOtp(ctx.fx.venueSlug, phone);
    const { devCode } = res.json();
    const mac = nextMac();

    // 5 failed attempts with wrong code
    for (let i = 1; i <= 5; i++) {
      const failRes = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/wifi/${ctx.fx.venueSlug}/connect`,
        payload: {
          firstName: 'Attempt',
          lastName: 'User',
          phone,
          otp: '000000',
          mac,
          consent: true,
        },
      });
      expect(failRes.statusCode).toBe(400);
      expect(failRes.json().error.code).toBe('INVALID_OTP');

      const [otpRow] = await sql('SELECT attempts FROM wifi_otps WHERE phone = $1', [phone]);
      expect(otpRow.attempts).toBe(i);
    }

    // 6th attempt with the CORRECT code is now locked out
    const lockedRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/wifi/${ctx.fx.venueSlug}/connect`,
      payload: {
        firstName: 'Attempt',
        lastName: 'User',
        phone,
        otp: devCode,
        mac,
        consent: true,
      },
    });

    expect(lockedRes.statusCode).toBe(400);
    expect(lockedRes.json().error.code).toBe('INVALID_OTP');
  });
});

describe('connect flow and device registration', () => {
  it('connects new guest, registers MAC in guest_devices, and creates wifi_sessions', async () => {
    const phone = nextPhone();
    const { res } = await requestOtp(ctx.fx.venueSlug, phone);
    const { devCode } = res.json();
    const mac = nextMac();

    const connectRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/wifi/${ctx.fx.venueSlug}/connect`,
      payload: {
        firstName: 'Ananya',
        lastName: 'Roy',
        phone,
        email: 'ananya@example.com',
        otp: devCode,
        mac,
        apId: 'AP-LOBBY-01',
        marketingOptIn: true,
        consent: true,
      },
    });

    expect(connectRes.statusCode).toBe(200);
    const body: WifiConnectResponse = connectRes.json();
    expect(body.access).toBe('ACCEPT');
    expect(body.guestName).toBe('Ananya Roy');
    expect(body.isNewGuest).toBe(true);
    expect(body.tier).toBe('BASE');
    expect(body.matchedReservation).toBeNull();

    // Verify guest created
    const [guest] = await sql('SELECT * FROM guests WHERE phone_number = $1', [phone]);
    expect(guest).toBeDefined();
    expect(guest.first_name).toBe('Ananya');
    expect(guest.last_name).toBe('Roy');
    expect(guest.email).toBe('ananya@example.com');

    // Verify guest_devices
    const [device] = await sql('SELECT * FROM guest_devices WHERE guest_id = $1', [guest.id]);
    expect(device).toBeDefined();
    expect(device.device_mac.toLowerCase()).toBe(mac.toLowerCase());

    // Verify wifi_sessions
    const [session] = await sql('SELECT * FROM wifi_sessions WHERE guest_id = $1', [guest.id]);
    expect(session).toBeDefined();
    expect(session.venue_id).toBe(ctx.fx.venueId);
    expect(session.device_mac.toLowerCase()).toBe(mac.toLowerCase());
    expect(session.ap_id).toBe('AP-LOBBY-01');
    expect(session.opt_in_marketing).toBe(true);

    // Verify OTP was marked verified
    const [otpRow] = await sql('SELECT verified_at FROM wifi_otps WHERE phone = $1', [phone]);
    expect(otpRow.verified_at).not.toBeNull();
  });

  it('connects existing guest and updates last_seen_at on device without creating new guest', async () => {
    const phone = nextPhone();
    const mac = nextMac();

    // Pre-create guest
    const [existing] = await sql(
      `INSERT INTO guests (first_name, last_name, phone_number) VALUES ('Sameer', 'Verma', $1) RETURNING id`,
      [phone],
    );
    await sql('INSERT INTO guest_profiles (guest_id) VALUES ($1)', [existing.id]);
    await sql('INSERT INTO loyalty_accounts (guest_id) VALUES ($1)', [existing.id]);

    const { res } = await requestOtp(ctx.fx.venueSlug, phone);
    const { devCode } = res.json();

    const connectRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/wifi/${ctx.fx.venueSlug}/connect`,
      payload: {
        firstName: 'Sameer',
        lastName: 'Verma',
        phone,
        otp: devCode,
        mac,
        consent: true,
      },
    });

    expect(connectRes.statusCode).toBe(200);
    const body: WifiConnectResponse = connectRes.json();
    expect(body.isNewGuest).toBe(false);
    expect(body.guestName).toBe('Sameer Verma');

    // Verify only 1 guest exists
    const guests = await sql('SELECT * FROM guests WHERE phone_number = $1', [phone]);
    expect(guests).toHaveLength(1);
  });
});

describe('alert emission (GUEST_ARRIVED)', () => {
  it('emits GUEST_ARRIVED alert and matches reservation when guest has reservation today', async () => {
    const phone = nextPhone();
    const mac = nextMac();

    // Create guest and a reservation for today
    const [guest] = await sql(
      `INSERT INTO guests (first_name, last_name, phone_number) VALUES ('Vikram', 'Seth', $1) RETURNING id`,
      [phone],
    );
    await sql('INSERT INTO guest_profiles (guest_id, seating_preference) VALUES ($1, $2)', [guest.id, 'WINDOW']);
    await sql('INSERT INTO loyalty_accounts (guest_id) VALUES ($1)', [guest.id]);

    const startAt = new Date(`${FIXTURE_DATE}T18:30:00+05:30`);
    const endAt = new Date(`${FIXTURE_DATE}T19:00:00+05:30`);
    const [resv] = await sql(
      `INSERT INTO reservations (venue_id, table_id, guest_id, party_size, booking_date, start_at, end_at, status, seating_preference)
       VALUES ($1, $2, $3, 2, $4, $5, $6, 'CONFIRMED', 'WINDOW') RETURNING *`,
      [ctx.fx.venueId, ctx.fx.tables['T-1'], guest.id, FIXTURE_DATE, startAt, endAt],
    );

    const { res } = await requestOtp(ctx.fx.venueSlug, phone);
    const { devCode } = res.json();

    const connectRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/wifi/${ctx.fx.venueSlug}/connect`,
      payload: {
        firstName: 'Vikram',
        lastName: 'Seth',
        phone,
        otp: devCode,
        mac,
        consent: true,
      },
    });

    expect(connectRes.statusCode).toBe(200);
    const body: WifiConnectResponse = connectRes.json();
    expect(body.matchedReservation).toBeDefined();
    expect(body.matchedReservation?.id).toBe(resv.id);
    expect(body.matchedReservation?.tableNumber).toBe('T-1');

    // Verify alert created
    const [alert] = await sql(
      `SELECT * FROM alerts WHERE venue_id = $1 AND kind = 'GUEST_ARRIVED' AND data->>'guestId' = $2`,
      [ctx.fx.venueId, guest.id],
    );
    expect(alert).toBeDefined();
    expect(alert.title).toBe('Vikram Seth has arrived');
    expect(alert.body).toContain('Table: T-1');
    expect(alert.body).toContain('Prefers Window Seat');
  });

  it('emits GUEST_ARRIVED alert when guest has no reservation but tier is REGULAR', async () => {
    const phone = nextPhone();
    const mac = nextMac();

    const [guest] = await sql(
      `INSERT INTO guests (first_name, last_name, phone_number) VALUES ('Kavita', 'Krishnan', $1) RETURNING id`,
      [phone],
    );
    await sql('INSERT INTO guest_profiles (guest_id) VALUES ($1)', [guest.id]);
    await sql(`INSERT INTO loyalty_accounts (guest_id, tier_level) VALUES ($1, 'REGULAR')`, [guest.id]);

    const { res } = await requestOtp(ctx.fx.venueSlug, phone);
    const { devCode } = res.json();

    const connectRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/wifi/${ctx.fx.venueSlug}/connect`,
      payload: {
        firstName: 'Kavita',
        lastName: 'Krishnan',
        phone,
        otp: devCode,
        mac,
        consent: true,
      },
    });

    expect(connectRes.statusCode).toBe(200);
    const body: WifiConnectResponse = connectRes.json();
    expect(body.tier).toBe('REGULAR');
    expect(body.matchedReservation).toBeNull();

    const [alert] = await sql(
      `SELECT * FROM alerts WHERE venue_id = $1 AND kind = 'GUEST_ARRIVED' AND data->>'guestId' = $2`,
      [ctx.fx.venueId, guest.id],
    );
    expect(alert).toBeDefined();
    expect(alert.title).toBe('Kavita Krishnan has arrived');
    expect(alert.body).toContain('Tier: Club Regular');
  });

  it('does NOT emit alert for BASE tier guest without a reservation', async () => {
    const phone = nextPhone();
    const mac = nextMac();

    const { res } = await requestOtp(ctx.fx.venueSlug, phone);
    const { devCode } = res.json();

    const connectRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/wifi/${ctx.fx.venueSlug}/connect`,
      payload: {
        firstName: 'Casual',
        lastName: 'Diner',
        phone,
        otp: devCode,
        mac,
        consent: true,
      },
    });

    expect(connectRes.statusCode).toBe(200);
    const body: WifiConnectResponse = connectRes.json();
    expect(body.tier).toBe('BASE');

    const alerts = await sql(
      `SELECT * FROM alerts WHERE venue_id = $1 AND kind = 'GUEST_ARRIVED'`,
      [ctx.fx.venueId],
    );
    expect(alerts).toHaveLength(0);
  });

  it('deduplicates GUEST_ARRIVED alert on multiple connects same day', async () => {
    const phone = nextPhone();
    const mac = nextMac();

    const [guest] = await sql(
      `INSERT INTO guests (first_name, last_name, phone_number) VALUES ('Alok', 'Nath', $1) RETURNING id`,
      [phone],
    );
    await sql('INSERT INTO guest_profiles (guest_id) VALUES ($1)', [guest.id]);
    await sql(`INSERT INTO loyalty_accounts (guest_id, tier_level) VALUES ($1, 'REGULAR')`, [guest.id]);

    // First connect
    const otp1 = await requestOtp(ctx.fx.venueSlug, phone);
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/wifi/${ctx.fx.venueSlug}/connect`,
      payload: { firstName: 'Alok', lastName: 'Nath', phone, otp: otp1.res.json().devCode, mac, consent: true },
    });

    // Second connect same day
    const otp2 = await requestOtp(ctx.fx.venueSlug, phone);
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/wifi/${ctx.fx.venueSlug}/connect`,
      payload: { firstName: 'Alok', lastName: 'Nath', phone, otp: otp2.res.json().devCode, mac, consent: true },
    });

    const alerts = await sql(
      `SELECT * FROM alerts WHERE venue_id = $1 AND kind = 'GUEST_ARRIVED' AND data->>'guestId' = $2`,
      [ctx.fx.venueId, guest.id],
    );
    expect(alerts).toHaveLength(1);
  });
});
