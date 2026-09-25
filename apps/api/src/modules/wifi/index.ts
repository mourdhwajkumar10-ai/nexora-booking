import { timingSafeEqual } from 'node:crypto';
import {
  WifiConnectInput,
  WifiOtpInput,
  tierRule,
  utcToZonedParts,
  type WifiConnectResponse,
} from '@nexora/shared';
import { withTx } from '../../db/pool';
import { createAlert } from '../../core/alerts';
import { guestDisplayName, upsertGuest } from '../../core/guests';
import { getVenueBySlug } from '../../core/venues';
import { clock } from '../../lib/clock';
import { randomDigits, sha256 } from '../../lib/crypto';
import { badRequest } from '../../lib/errors';
import { parse } from '../../lib/http';
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

/** Captive Wi-Fi portal (E4-S3). Public; the RADIUS/controller side is simulated. */
export const wifiModule: NexoraModule = {
  name: 'wifi',
  routes: async (app) => {
    app.get<{ Params: { slug: string } }>('/wifi/:slug', async (req) => {
      const v = await getVenueBySlug(req.params.slug);
      return { venue: { name: v.name, slug: v.slug, imageUrl: v.image_url } };
    });

    app.post<{ Params: { slug: string } }>(
      '/wifi/:slug/otp',
      {
        config: {
          rateLimit: {
            max: 5,
            timeWindow: '1 minute',
            // Keyed per destination phone (protects the SMS recipient); runs after body parsing.
            hook: 'preHandler',
            keyGenerator: (req: any) => `wifi-otp:${String(req.body?.phone ?? '').replace(/\D/g, '') || req.ip}`,
          },
        },
      },
      async (req) => {
        const venue = await getVenueBySlug(req.params.slug);
        const { phone } = parse(WifiOtpInput, req.body);
        const code = randomDigits(6);
        const now = clock.now();
        await withTx(async (tx) => {
          // Only the newest code is valid.
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
      if (!(await verifyOtp(input.phone, input.otp))) throw badRequest('INVALID_OTP', 'The code is invalid or has expired');

      return withTx(async (tx): Promise<WifiConnectResponse> => {
        const now = clock.now();
        const { guest, isNew } = await upsertGuest(tx, {
          firstName: input.firstName,
          lastName: input.lastName,
          phone: input.phone,
          email: input.email ?? null,
        });
        await ensureGuestRows(tx, guest.id);
        const mac = input.mac.toLowerCase().replace(/-/g, ':');
        // MACs rotate: they are pointers to the canonical guest (phone + OTP), never identity.
        await tx.query(
          `INSERT INTO guest_devices (guest_id, device_mac, first_seen_at, last_seen_at) VALUES ($1,$2,$3,$3)
           ON CONFLICT (guest_id, device_mac) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at`,
          [guest.id, mac, now],
        );
        await tx.query(
          `INSERT INTO wifi_sessions (guest_id, venue_id, device_mac, ap_id, connected_at, opt_in_marketing) VALUES ($1,$2,$3,$4,$5,$6)`,
          [guest.id, venue.id, mac, input.apId ?? null, now, input.marketingOptIn],
        );

        const acct = (await tx.one('SELECT tier_level FROM loyalty_accounts WHERE guest_id = $1', [guest.id]))!;
        const profile = (await tx.one('SELECT seating_preference FROM guest_profiles WHERE guest_id = $1', [guest.id]))!;
        const today = utcToZonedParts(now, venue.timezone).date;
        const res = await tx.one(
          `SELECT r.id, r.start_at, r.seating_preference, t.table_number
           FROM reservations r LEFT JOIN dining_tables t ON t.id = r.table_id
           WHERE r.guest_id = $1 AND r.venue_id = $2 AND r.booking_date = $3 AND r.status IN ('REQUESTED','CONFIRMED')
           ORDER BY abs(extract(epoch FROM r.start_at - $4::timestamptz)) LIMIT 1`,
          [guest.id, venue.id, today, now],
        );
        const tier = acct.tier_level;
        const name = guestDisplayName(guest);
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
          access: 'ACCEPT', // simulated RADIUS Access-Accept
          guestName: name,
          tier,
          isNewGuest: isNew,
          matchedReservation: res
            ? { id: res.id, time: utcToZonedParts(new Date(res.start_at), venue.timezone).time, tableNumber: res.table_number ?? null }
            : null,
        };
      });
    });
  },
};
