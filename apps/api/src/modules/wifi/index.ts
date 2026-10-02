import { timingSafeEqual } from 'node:crypto';
import {
  WifiConnectInput,
  WifiHandshakeInput,
  WifiOtpInput,
  tierRule,
  utcToZonedParts,
  type WifiConnectResponse,
  type WifiHandshakeResponse,
} from '@nexora/shared';
import {
  createPortalHandshake,
  deviceHash,
  isRandomizedMac,
  normalizeMac,
  verifyPortalHandshake,
} from '@nexora/shared/node';
import { config } from '../../config';
import { query, queryOne, withTx } from '../../db/pool';
import { createAlert } from '../../core/alerts';
import { guestDisplayName, upsertGuest } from '../../core/guests';
import { getVenueBySlug } from '../../core/venues';
import { assertVenueAccess, requireStaff } from '../../lib/auth';
import { clock } from '../../lib/clock';
import { randomDigits, sha256 } from '../../lib/crypto';
import { badRequest } from '../../lib/errors';
import { iso, parse } from '../../lib/http';
import { SEATING_LABELS, ensureGuestRows, tierRank } from '../loyalty/service';
import type { NexoraModule } from '../types';

export const OTP_TTL_MINS = 5;
export const OTP_MAX_ATTEMPTS = 5;

const otpHash = (phone: string, code: string) => sha256(`${phone}:${code}`);

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Verify the latest live OTP for a phone. Attempts are committed even when verification fails. */
async function verifyOtp(phone: string, code: string): Promise<boolean> {
  return withTx(async (tx) => {
    const now = clock.now();
    const otp = await tx.one(
      `SELECT * FROM wifi_otps WHERE phone = $1 AND verified_at IS NULL AND expires_at > $2
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [phone, now],
    );
    if (!otp || otp.attempts >= OTP_MAX_ATTEMPTS) return false;
    if (!safeEq(otp.code_hash, otpHash(phone, code))) {
      await tx.query('UPDATE wifi_otps SET attempts = attempts + 1 WHERE id = $1', [otp.id]);
      return false;
    }
    await tx.query('UPDATE wifi_otps SET attempts = attempts + 1, verified_at = $2 WHERE id = $1', [otp.id, now]);
    return true;
  });
}

/** Captive Wi-Fi portal (Pillar 1). Salted device hashing, 15-minute portal handshake, and return detection. */
export const wifiModule: NexoraModule = {
  name: 'wifi',
  routes: async (app) => {
    app.get<{ Params: { slug: string } }>('/wifi/:slug', async (req) => {
      const v = await getVenueBySlug(req.params.slug);
      return { venue: { name: v.name, slug: v.slug, imageUrl: v.image_url, id: v.id } };
    });

    /**
     * 15-minute tokenized portal handshake (BR-25 / Pillar 1).
     * Binds client MAC in a tamper-proof signed handshake token with 15-minute expiration.
     */
    app.post<{ Params: { slug: string } }>('/wifi/:slug/handshake', async (req) => {
      const venue = await getVenueBySlug(req.params.slug);
      const input = parse(WifiHandshakeInput, req.body ?? {});
      const now = clock.now();
      const rawMac = input.mac ?? '02:00:00:00:00:01';
      const normalized = normalizeMac(rawMac) ?? rawMac.toLowerCase();
      const token = createPortalHandshake(config.wifiDeviceMasterKey, venue.id, normalized, 15 * 60_000, now.getTime());
      const devHash = deviceHash(config.wifiDeviceMasterKey, venue.id, normalized);

      const existing = await queryOne(
        'SELECT id, visit_count, last_seen_at FROM wifi_devices WHERE venue_id = $1 AND device_hash = $2',
        [venue.id, devHash],
      );

      const response: WifiHandshakeResponse = {
        handshakeToken: token,
        expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
        deviceHash: devHash,
        isReturningDevice: !!existing,
      };
      return response;
    });

    app.post<{ Params: { slug: string } }>(
      '/wifi/:slug/otp',
      {
        config: {
          rateLimit: {
            max: 5,
            timeWindow: '1 minute',
            hook: 'preHandler',
            keyGenerator: (req: any) => `wifi-otp:${String(req.body?.phone ?? '').replace(/\D/g, '') || req.ip}`,
          },
        },
      },
      async (req) => {
        await getVenueBySlug(req.params.slug);
        const { phone } = parse(WifiOtpInput, req.body);
        const code = randomDigits(6);
        const now = clock.now();
        await withTx(async (tx) => {
          await tx.query('UPDATE wifi_otps SET expires_at = $2 WHERE phone = $1 AND verified_at IS NULL AND expires_at > $2', [phone, now]);
          await tx.query('INSERT INTO wifi_otps (phone, code_hash, expires_at, created_at) VALUES ($1,$2,$3,$4)', [
            phone,
            otpHash(phone, code),
            new Date(now.getTime() + OTP_TTL_MINS * 60_000),
            now,
          ]);
        });
        console.log(`[MOCK SMS] to ${phone}: Your Nexora Wi-Fi code is ${code}`);
        return { sent: true as const, devCode: code };
      },
    );

    app.post<{ Params: { slug: string } }>('/wifi/:slug/connect', async (req) => {
      const venue = await getVenueBySlug(req.params.slug);
      const input = parse(WifiConnectInput, req.body);
      const now = clock.now();

      const normalizedMac = normalizeMac(input.mac);
      if (!normalizedMac) {
        throw badRequest('INVALID_MAC', 'Invalid MAC address');
      }

      // Validate 15-minute handshake token if provided
      if (input.handshakeToken) {
        const handshake = verifyPortalHandshake(config.wifiDeviceMasterKey, input.handshakeToken, now.getTime());
        if (!handshake || handshake.venueId !== venue.id || handshake.mac !== normalizedMac) {
          throw badRequest('HANDSHAKE_EXPIRED', 'Portal handshake has expired or is invalid for this venue and device.');
        }
      }

      if (!(await verifyOtp(input.phone, input.otp))) {
        throw badRequest('INVALID_OTP', 'The code is invalid or has expired');
      }

      // Salted HMAC-SHA256 device hash (BR-25)
      const devHash = deviceHash(config.wifiDeviceMasterKey, venue.id, normalizedMac);
      const isRandomized = isRandomizedMac(normalizedMac);

      return withTx(async (tx): Promise<WifiConnectResponse> => {
        const { guest, isNew } = await upsertGuest(tx, {
          firstName: input.firstName,
          lastName: input.lastName,
          phone: input.phone,
          email: input.email ?? null,
        });
        await ensureGuestRows(tx, guest.id);

        // Detect returning device / session
        const existingDevice = await tx.one(
          'SELECT id, visit_count FROM wifi_devices WHERE venue_id = $1 AND device_hash = $2 FOR UPDATE',
          [venue.id, devHash],
        );
        const isReturningGuest = !isNew || !!existingDevice;

        if (existingDevice) {
          await tx.query(
            'UPDATE wifi_devices SET last_seen_at = $2, visit_count = visit_count + 1, guest_id = COALESCE($3, guest_id) WHERE id = $1',
            [existingDevice.id, now, guest.id],
          );
        } else {
          await tx.query(
            `INSERT INTO wifi_devices (venue_id, device_hash, guest_id, randomized_mac, first_seen_at, last_seen_at, visit_count)
             VALUES ($1, $2, $3, $4, $5, $5, 1)
             ON CONFLICT (venue_id, device_hash) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at, visit_count = wifi_devices.visit_count + 1`,
            [venue.id, devHash, guest.id, isRandomized, now],
          );
        }

        // Maintain guest_devices with device_hash
        await tx.query(
          `INSERT INTO guest_devices (guest_id, device_mac, device_hash, first_seen_at, last_seen_at)
           VALUES ($1, $2, $3, $4, $4)
           ON CONFLICT (guest_id, device_mac) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at, device_hash = EXCLUDED.device_hash`,
          [guest.id, normalizedMac, devHash, now],
        );

        // Record wifi session with device_hash, return status, and marketing opt-in
        await tx.query(
          `INSERT INTO wifi_sessions (guest_id, venue_id, device_mac, device_hash, ap_id, connected_at, opt_in_marketing, is_returning_guest)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [guest.id, venue.id, normalizedMac, devHash, input.apId ?? null, now, input.marketingOptIn, isReturningGuest],
        );

        // Record consent events for Wi-Fi terms & marketing opt-in
        const senderKey = `venue:${venue.id}`;
        await tx.query(
          `INSERT INTO consent_events (sender_key, consent_type, subject_key, action, method, surface, guest_id, occurred_at)
           VALUES ($1, 'wifi_terms', $2, 'grant', 'checkbox', 'wifi_portal', $3, $4)`,
          [senderKey, `phone:${input.phone}`, guest.id, now],
        );
        await tx.query(
          `INSERT INTO consent_state (sender_key, consent_type, subject_key, status, last_occurred_at, granted_at)
           VALUES ($1, 'wifi_terms', $2, 'granted', $3, $3)
           ON CONFLICT (sender_key, consent_type, subject_key) DO UPDATE SET status = 'granted', last_occurred_at = EXCLUDED.last_occurred_at`,
          [senderKey, `phone:${input.phone}`, now],
        );

        if (input.marketingOptIn) {
          await tx.query(
            `INSERT INTO consent_events (sender_key, consent_type, subject_key, action, method, surface, guest_id, occurred_at)
             VALUES ($1, 'sms_marketing', $2, 'grant', 'checkbox', 'wifi_portal', $3, $4)`,
            [senderKey, `phone:${input.phone}`, guest.id, now],
          );
          await tx.query(
            `INSERT INTO consent_state (sender_key, consent_type, subject_key, status, last_occurred_at, granted_at)
             VALUES ($1, 'sms_marketing', $2, 'granted', $3, $3)
             ON CONFLICT (sender_key, consent_type, subject_key) DO UPDATE SET status = 'granted', last_occurred_at = EXCLUDED.last_occurred_at`,
            [senderKey, `phone:${input.phone}`, now],
          );
        }

        const acct = (await tx.one('SELECT tier_level FROM loyalty_accounts WHERE guest_id = $1', [guest.id]))!;
        const profile = (await tx.one('SELECT seating_preference FROM guest_profiles WHERE guest_id = $1', [guest.id]))!;
        const today = utcToZonedParts(now, venue.timezone).date;

        // Arrival matching (BR-27): match active reservations on the same date within [-45m, +60m]
        const windowStart = new Date(now.getTime() - 60 * 60_000);
        const windowEnd = new Date(now.getTime() + 45 * 60_000);

        const res = await tx.one<{
          id: string;
          status: string;
          start_at: Date;
          seating_preference: string | null;
          table_number: string | null;
        }>(
          `SELECT r.id, r.status, r.start_at, r.seating_preference, t.table_number
           FROM reservations r LEFT JOIN dining_tables t ON t.id = r.table_id
           WHERE r.guest_id = $1 AND r.venue_id = $2 AND r.booking_date = $3
             AND r.status IN ('CONFIRMED', 'LATE')
             AND r.start_at >= $4 AND r.start_at <= $5
           ORDER BY abs(extract(epoch FROM r.start_at - $6::timestamptz)) LIMIT 1`,
          [guest.id, venue.id, today, windowStart, windowEnd, now],
        );

        const tier = acct.tier_level;
        const name = guestDisplayName(guest);

        if (res) {
          // Transition matched reservation to ARRIVED
          await tx.query(
            `UPDATE reservations SET status = 'ARRIVED', arrived_at = $2 WHERE id = $1 AND status IN ('CONFIRMED', 'LATE')`,
            [res.id, now],
          );
          await tx.query(
            `INSERT INTO reservation_events (reservation_id, from_status, to_status, actor, reason, created_at)
             VALUES ($1, $2, 'ARRIVED', 'system', 'Wi-Fi arrival detection', $3)`,
            [res.id, res.status, now],
          );
        }

        if (res || tierRank(tier) >= tierRank('REGULAR')) {
          const pref = res?.seating_preference && res.seating_preference !== 'ANY' ? res.seating_preference : profile.seating_preference;
          const alert = await createAlert(tx, {
            venueId: venue.id,
            kind: 'GUEST_ARRIVED',
            severity: 'info',
            title: `${name} has arrived`,
            body: `Guest Connected: ${name}, Tier: ${tierRule(tier).label}, Table: ${res?.table_number ?? '—'}, Prefers ${SEATING_LABELS[pref] ?? pref}`,
            data: { guestId: guest.id, reservationId: res?.id ?? null, tier },
            dedupeKey: `arrived:${venue.id}:${guest.id}:${today}`,
          });
          if (alert) tx.emit({ type: 'guest.arrived', venueId: venue.id, guestId: guest.id, reservationId: res?.id ?? null });
        }

        return {
          access: 'ACCEPT',
          guestName: name,
          tier,
          isNewGuest: isNew,
          isReturningGuest,
          deviceHash: devHash,
          matchedReservation: res
            ? { id: res.id, time: utcToZonedParts(new Date(res.start_at), venue.timezone).time, tableNumber: res.table_number ?? null }
            : null,
        };
      });
    });

    app.get<{ Params: { venueId: string } }>(
      '/admin/venues/:venueId/wifi/sessions',
      { preHandler: requireStaff },
      async (req) => {
        assertVenueAccess(req.staff, req.params.venueId);
        const rows = await query(
          `SELECT s.id, s.device_hash, s.connected_at, s.opt_in_marketing, s.is_returning_guest, s.dwell_seconds,
                  g.first_name, g.last_name, g.phone_number
           FROM wifi_sessions s
           LEFT JOIN guests g ON g.id = s.guest_id
           WHERE s.venue_id = $1
           ORDER BY s.connected_at DESC LIMIT 50`,
          [req.params.venueId],
        );
        return rows.map((r) => ({
          id: r.id,
          deviceHash: r.device_hash,
          guestName: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || 'Guest',
          maskedPhone: r.phone_number ? `${r.phone_number.slice(0, 3)}••••${r.phone_number.slice(-4)}` : null,
          connectedAt: iso(r.connected_at),
          optInMarketing: r.opt_in_marketing,
          isReturningGuest: r.is_returning_guest,
          dwellSeconds: r.dwell_seconds,
        }));
      },
    );
  },
};
