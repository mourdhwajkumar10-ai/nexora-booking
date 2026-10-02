import {
  ConsentRecordInput,
  GuestMergeInput,
  TagInput,
  TCPA_QUIET_HOURS,
  UpdateGuestInput,
  WalletPreloadInput,
  classifyInboundSms,
  decideMerge,
  evaluateSend,
  mergeIdentities,
  pickSurvivor,
  type ConsentStatus,
  type ConsentType,
  type GuestIdentity,
  type GuestSummary,
  type SendInput,
} from '@nexora/shared';
import { query, queryOne, withTx } from '../../db/pool';
import { audit } from '../../core/audit';
import { actorOf, requireRole, requireStaff } from '../../lib/auth';
import { on } from '../../lib/bus';
import { clock } from '../../lib/clock';
import { badRequest, notFound } from '../../lib/errors';
import { iso, parse } from '../../lib/http';
import { applyTier, insertLedger, loadGuestProfile, loadLedger, lockAccount } from '../loyalty/service';
import type { NexoraModule } from '../types';
import { registerAutoTagHandlers } from './autotags';

async function assertGuest(guestId: string): Promise<void> {
  const rows = await query('SELECT 1 FROM guests WHERE id = $1', [guestId]);
  if (!rows.length) throw notFound('Guest');
}

async function loadGuestIdentity(guestId: string): Promise<GuestIdentity> {
  const guest = await queryOne('SELECT * FROM guests WHERE id = $1', [guestId]);
  if (!guest) throw notFound('Guest');
  const devices = await query<{ device_hash: string }>('SELECT device_hash FROM guest_devices WHERE guest_id = $1', [guestId]);

  return {
    id: guest.id,
    createdAtMs: new Date(guest.created_at).getTime(),
    firstName: guest.first_name || null,
    lastName: guest.last_name || null,
    phones: guest.phone_number ? [{ value: guest.phone_number, verified: !guest.phone_number.startsWith('walkin:') }] : [],
    emails: guest.email ? [{ value: guest.email, verified: true }] : [],
    cardFingerprints: devices.map((d) => d.device_hash).filter(Boolean),
  };
}

/** Pillar 2: Guest Profile, Identity & Consent (CCPA/CPRA, opt-in/opt-out, quiet hours, deterministic merge). */
export const guestsModule: NexoraModule = {
  name: 'guests',
  init: () => registerAutoTagHandlers(on),
  routes: async (app) => {
    // ---------------------------------------------------------------- Admin Guest Directory
    app.get<{ Querystring: { q?: string } }>('/admin/guests', { preHandler: requireStaff }, async (req) => {
      const q = (req.query.q ?? '').trim();
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const rows = await query(
        `SELECT g.*, p.total_visits, p.lifetime_spend_paise, p.last_visit_at, p.allergies,
                COALESCE(a.tier_level, 'BASE') AS tier_level,
                COALESCE((SELECT array_agg(t.tag_name ORDER BY t.created_at, t.tag_name) FROM guest_tags t WHERE t.guest_id = g.id), '{}') AS tags
         FROM guests g
         LEFT JOIN guest_profiles p ON p.guest_id = g.id
         LEFT JOIN loyalty_accounts a ON a.guest_id = g.id
         WHERE g.phone_number NOT LIKE 'walkin:%'
           AND ($1 = '' OR (g.first_name || ' ' || g.last_name) ILIKE $2 OR g.phone_number ILIKE $2 OR g.email ILIKE $2)
         ORDER BY p.last_visit_at DESC NULLS LAST, g.created_at DESC
         LIMIT 50`,
        [q, like],
      );
      return rows.map(
        (r): GuestSummary => ({
          id: r.id,
          name: `${r.first_name} ${r.last_name}`.trim(),
          phone: r.phone_number,
          email: r.email,
          tags: r.tags,
          tier: r.tier_level,
          totalVisits: r.total_visits ?? 0,
          lifetimeSpendPaise: r.lifetime_spend_paise ?? 0,
          lastVisitAt: iso(r.last_visit_at),
          hasAllergies: !!r.allergies?.trim(),
        }),
      );
    });

    app.get<{ Params: { guestId: string } }>('/admin/guests/:guestId', { preHandler: requireStaff }, async (req) =>
      loadGuestProfile(req.params.guestId),
    );

    app.patch<{ Params: { guestId: string } }>('/admin/guests/:guestId', { preHandler: requireStaff }, async (req) => {
      const input = parse(UpdateGuestInput, req.body);
      await withTx(async (tx) => {
        const g = await tx.one('SELECT id FROM guests WHERE id = $1 FOR UPDATE', [req.params.guestId]);
        if (!g) throw notFound('Guest');
        await tx.query('INSERT INTO guest_profiles (guest_id) VALUES ($1) ON CONFLICT DO NOTHING', [g.id]);
        await tx.query(
          `UPDATE guests SET
             first_name = COALESCE($2, first_name),
             last_name  = COALESCE($3, last_name),
             email      = CASE WHEN $4::boolean THEN $5 ELSE email END
           WHERE id = $1`,
          [g.id, input.firstName ?? null, input.lastName ?? null, input.email !== undefined, input.email?.trim().toLowerCase() ?? null],
        );
        await tx.query(
          `UPDATE guest_profiles SET
             seating_preference = COALESCE($2, seating_preference),
             dietary_notes      = CASE WHEN $3::boolean THEN $4 ELSE dietary_notes END,
             allergies          = CASE WHEN $5::boolean THEN $6 ELSE allergies END
           WHERE guest_id = $1`,
          [
            g.id,
            input.seatingPreference ?? null,
            input.dietaryNotes !== undefined,
            input.dietaryNotes?.trim() || null,
            input.allergies !== undefined,
            input.allergies?.trim() || null,
          ],
        );
        await audit(tx, { venueId: null, actor: actorOf(req), action: 'guest.update', entity: 'guest', entityId: g.id, data: input });
      });
      return loadGuestProfile(req.params.guestId);
    });

    // ---------------------------------------------------------------- Consent State & Logging (CCPA/CPRA)
    app.get<{ Params: { guestId: string } }>('/admin/guests/:guestId/consents', { preHandler: requireStaff }, async (req) => {
      await assertGuest(req.params.guestId);
      const states = await query('SELECT * FROM consent_state WHERE subject_key = $1 OR subject_key = $2', [
        `guest:${req.params.guestId}`,
        `phone:${(await queryOne('SELECT phone_number FROM guests WHERE id = $1', [req.params.guestId]))?.phone_number}`,
      ]);
      const events = await query(
        'SELECT * FROM consent_events WHERE guest_id = $1 ORDER BY occurred_at DESC LIMIT 20',
        [req.params.guestId],
      );
      return {
        guestId: req.params.guestId,
        states: states.map((s) => ({
          consentType: s.consent_type,
          status: s.status,
          grantedAt: iso(s.granted_at),
          revokedAt: iso(s.revoked_at),
          updatedAt: iso(s.updated_at),
        })),
        events: events.map((e) => ({
          id: e.id,
          consentType: e.consent_type,
          action: e.action,
          method: e.method,
          surface: e.surface,
          occurredAt: iso(e.occurred_at),
        })),
      };
    });

    app.post('/consent/events', async (req) => {
      const input = parse(ConsentRecordInput, req.body);
      const now = clock.now();

      return withTx(async (tx) => {
        const ev = await tx.one(
          `INSERT INTO consent_events (sender_key, consent_type, subject_key, action, method, surface, evidence, guest_id, occurred_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
          [
            input.senderKey,
            input.consentType,
            input.subjectKey,
            input.action,
            input.method,
            input.surface ?? null,
            JSON.stringify(input.evidence ?? {}),
            input.guestId ?? null,
            now,
          ],
        );

        const newStatus = input.action === 'grant' ? 'granted' : 'revoked';
        await tx.query(
          `INSERT INTO consent_state (sender_key, consent_type, subject_key, status, last_event_id, last_occurred_at, granted_at, revoked_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $6)
           ON CONFLICT (sender_key, consent_type, subject_key) DO UPDATE SET
             status = EXCLUDED.status,
             last_event_id = EXCLUDED.last_event_id,
             last_occurred_at = EXCLUDED.last_occurred_at,
             granted_at = CASE WHEN EXCLUDED.status = 'granted' THEN EXCLUDED.granted_at ELSE consent_state.granted_at END,
             revoked_at = CASE WHEN EXCLUDED.status = 'revoked' THEN EXCLUDED.revoked_at ELSE consent_state.revoked_at END,
             updated_at = EXCLUDED.updated_at`,
          [
            input.senderKey,
            input.consentType,
            input.subjectKey,
            newStatus,
            ev?.id,
            now,
            input.action === 'grant' ? now : null,
            input.action === 'revoke' ? now : null,
          ],
        );

        return { recorded: true, eventId: ev?.id, status: newStatus };
      });
    });

    /** Inbound SMS STOP/START/HELP opt-out logging and TCPA compliance */
    app.post<{ Body: { from: string; body: string; to?: string } }>('/consent/inbound-sms', async (req) => {
      const { from, body } = req.body ?? {};
      if (!from || !body) throw badRequest('MISSING_FIELDS', 'from and body are required');
      const intent = classifyInboundSms(body);
      const now = clock.now();
      const subjectKey = `phone:${from}`;
      const senderKey = req.body.to ? `sender:${req.body.to}` : 'platform';

      if (intent === 'stop' || intent === 'opt_out_natural_language') {
        await withTx(async (tx) => {
          await tx.query(
            `INSERT INTO consent_events (sender_key, consent_type, subject_key, action, method, surface, occurred_at)
             VALUES ($1, 'sms_all', $2, 'revoke', $3, 'sms', $4)`,
            [senderKey, subjectKey, intent === 'stop' ? 'sms_stop' : 'natural_language', now],
          );
          await tx.query(
            `INSERT INTO consent_state (sender_key, consent_type, subject_key, status, last_occurred_at, revoked_at)
             VALUES ($1, 'sms_all', $2, 'revoked', $3, $3)
             ON CONFLICT (sender_key, consent_type, subject_key) DO UPDATE SET status = 'revoked', revoked_at = EXCLUDED.revoked_at, last_occurred_at = EXCLUDED.last_occurred_at`,
            [senderKey, subjectKey, now],
          );
        });
        return { intent, action: 'revoked', response: 'You have unsubscribed. Reply START to resubscribe.' };
      }

      if (intent === 'start') {
        await withTx(async (tx) => {
          await tx.query(
            `INSERT INTO consent_events (sender_key, consent_type, subject_key, action, method, surface, occurred_at)
             VALUES ($1, 'sms_all', $2, 'grant', 'sms_start', 'sms', $3)`,
            [senderKey, subjectKey, now],
          );
          await tx.query(
            `INSERT INTO consent_state (sender_key, consent_type, subject_key, status, last_occurred_at, granted_at)
             VALUES ($1, 'sms_all', $2, 'granted', $3, $3)
             ON CONFLICT (sender_key, consent_type, subject_key) DO UPDATE SET status = 'granted', granted_at = EXCLUDED.granted_at, last_occurred_at = EXCLUDED.last_occurred_at`,
            [senderKey, subjectKey, now],
          );
        });
        return { intent, action: 'granted', response: 'You have been resubscribed.' };
      }

      if (intent === 'help') {
        return { intent, action: 'help', response: 'Nexora Dining: For support visit nexora.com. Reply STOP to opt out.' };
      }

      return { intent, action: 'ignored' };
    });

    /** Quiet hours & send-time gate evaluation (9 PM - 8 AM local time) */
    app.post<{
      Body: {
        channel: 'sms' | 'email';
        category: 'transactional' | 'marketing' | 'feedback';
        phone?: string;
        email?: string;
        timeZone?: string;
        venueId?: string;
        nowMs?: number;
      };
    }>('/admin/communications/evaluate-send', { preHandler: requireStaff }, async (req) => {
      const b = req.body;
      const nowMs = b.nowMs ?? clock.now().getTime();
      const subjectKey = b.channel === 'sms' ? `phone:${b.phone}` : `email:${b.email}`;

      const states = await query<{ consent_type: ConsentType; status: ConsentStatus }>(
        'SELECT consent_type, status FROM consent_state WHERE subject_key = $1',
        [subjectKey],
      );
      const consents: Partial<Record<ConsentType, ConsentStatus>> = {};
      for (const s of states) consents[s.consent_type] = s.status;

      const suppressed = !!(await queryOne('SELECT 1 FROM suppressions WHERE contact_hmac = $1', [subjectKey]));

      const input: SendInput = {
        channel: b.channel,
        category: b.category,
        consents,
        suppressed,
        nowMs,
        recipientTimeZone: b.timeZone ?? null,
        sentLast24h: 0,
        sentLast7d: 0,
        quietHours: TCPA_QUIET_HOURS, // 9 PM - 8 AM quiet hours (window 8:00 - 21:00)
      };

      return evaluateSend(input);
    });

    // ---------------------------------------------------------------- Deterministic Identity Merge (BR-19)
    app.post<{ Body: { guestIdA: string; guestIdB: string } }>(
      '/admin/guests/merge-check',
      { preHandler: requireStaff },
      async (req) => {
        const { guestIdA, guestIdB } = req.body ?? {};
        if (!guestIdA || !guestIdB) throw badRequest('MISSING_IDS', 'guestIdA and guestIdB are required');
        const [a, b] = await Promise.all([loadGuestIdentity(guestIdA), loadGuestIdentity(guestIdB)]);
        const result = decideMerge(a, b);
        const { survivor, loser } = pickSurvivor(a, b);
        const merged = mergeIdentities(survivor, loser);

        return {
          decision: result.decision,
          reason: result.reason,
          survivorId: survivor.id,
          loserId: loser.id,
          merged,
        };
      },
    );

    app.post(
      '/admin/guests/merge',
      { preHandler: requireRole('MANAGER') },
      async (req) => {
        const { survivorId, loserId } = parse(GuestMergeInput, req.body);
        if (survivorId === loserId) throw badRequest('SAME_GUEST', 'Cannot merge guest with themselves');

        return withTx(async (tx) => {
          const [a, b] = await Promise.all([loadGuestIdentity(survivorId), loadGuestIdentity(loserId)]);
          const result = decideMerge(a, b);
          if (result.decision === 'none') {
            throw badRequest('CANNOT_MERGE', `Guests cannot be merged: ${result.reason}`);
          }

          const { survivor, loser } = pickSurvivor(a, b);
          const merged = mergeIdentities(survivor, loser);

          // Update survivor record with merged fields
          await tx.query(
            `UPDATE guests SET
               first_name = $2,
               last_name  = $3,
               email      = COALESCE($4, email)
             WHERE id = $1`,
            [survivor.id, merged.firstName, merged.lastName, merged.emails[0]?.value ?? null],
          );

          // Re-link reservations, pos orders, devices, wifi sessions to survivor
          await tx.query('UPDATE reservations SET guest_id = $1 WHERE guest_id = $2', [survivor.id, loser.id]);
          await tx.query('UPDATE pos_orders SET guest_id = $1 WHERE guest_id = $2', [survivor.id, loser.id]);
          await tx.query(
            `UPDATE guest_devices SET guest_id = $1 WHERE guest_id = $2
             ON CONFLICT (guest_id, device_mac) DO NOTHING`,
            [survivor.id, loser.id],
          );
          await tx.query('UPDATE wifi_sessions SET guest_id = $1 WHERE guest_id = $2', [survivor.id, loser.id]);
          await tx.query(
            `UPDATE guest_tags SET guest_id = $1 WHERE guest_id = $2
             ON CONFLICT (guest_id, tag_name) DO NOTHING`,
            [survivor.id, loser.id],
          );
          await tx.query('UPDATE vouchers SET guest_id = $1 WHERE guest_id = $2', [survivor.id, loser.id]);

          // Combine visits and spend into survivor profile
          const loserProf = await tx.one('SELECT * FROM guest_profiles WHERE guest_id = $1', [loser.id]);
          if (loserProf) {
            await tx.query(
              `UPDATE guest_profiles SET
                 total_visits = total_visits + $2,
                 lifetime_spend_paise = lifetime_spend_paise + $3,
                 last_visit_at = GREATEST(last_visit_at, $4)
               WHERE guest_id = $1`,
              [survivor.id, loserProf.total_visits || 0, loserProf.lifetime_spend_paise || 0, loserProf.last_visit_at || null],
            );
          }

          // Clean up loser records
          await tx.query('DELETE FROM guest_tags WHERE guest_id = $1', [loser.id]);
          await tx.query('DELETE FROM guest_devices WHERE guest_id = $1', [loser.id]);
          await tx.query('DELETE FROM guest_profiles WHERE guest_id = $1', [loser.id]);
          await tx.query('DELETE FROM loyalty_accounts WHERE guest_id = $1', [loser.id]);
          await tx.query('DELETE FROM guests WHERE id = $1', [loser.id]);

          await audit(tx, {
            venueId: null,
            actor: actorOf(req),
            action: 'guest.merge',
            entity: 'guest',
            entityId: survivor.id,
            data: { survivorId: survivor.id, loserId: loser.id, reason: result.reason },
          });

          return loadGuestProfile(survivor.id);
        });
      },
    );

    // ---------------------------------------------------------------- Existing Tag & Wallet operations
    app.post<{ Params: { guestId: string } }>('/admin/guests/:guestId/tags', { preHandler: requireStaff }, async (req) => {
      const { tagName } = parse(TagInput, req.body);
      await assertGuest(req.params.guestId);
      await query(
        `INSERT INTO guest_tags (guest_id, tag_name, is_auto_generated) VALUES ($1,$2,false)
         ON CONFLICT (guest_id, tag_name) DO NOTHING`,
        [req.params.guestId, tagName],
      );
      return loadGuestProfile(req.params.guestId);
    });

    app.delete<{ Params: { guestId: string; tagName: string } }>(
      '/admin/guests/:guestId/tags/:tagName',
      { preHandler: requireStaff },
      async (req) => {
        await assertGuest(req.params.guestId);
        await query('DELETE FROM guest_tags WHERE guest_id = $1 AND tag_name = $2', [req.params.guestId, req.params.tagName.toUpperCase()]);
        return loadGuestProfile(req.params.guestId);
      },
    );

    app.get<{ Params: { guestId: string } }>('/admin/guests/:guestId/ledger', { preHandler: requireStaff }, async (req) => {
      await assertGuest(req.params.guestId);
      return loadLedger(req.params.guestId);
    });

    app.post<{ Params: { guestId: string } }>(
      '/admin/guests/:guestId/wallet/preload',
      { preHandler: requireRole('MANAGER') },
      async (req) => {
        const { amountPaise } = parse(WalletPreloadInput, req.body);
        await assertGuest(req.params.guestId);
        await withTx(async (tx) => {
          const acct = await lockAccount(tx, req.params.guestId);
          const largest = Math.max(acct.largest_preload_paise, amountPaise);
          await tx.query(
            'UPDATE loyalty_accounts SET wallet_balance_paise = wallet_balance_paise + $2, largest_preload_paise = $3 WHERE id = $1',
            [acct.id, amountPaise, largest],
          );
          await insertLedger(tx, { accountId: acct.id, eventType: 'PRELOAD', amountPaise, referenceType: 'WALLET', note: 'Wallet preload' });
          await applyTier(tx, acct, acct.annual_spend_paise, largest);
          await audit(tx, { venueId: null, actor: actorOf(req), action: 'wallet.preload', entity: 'guest', entityId: acct.guest_id, data: { amountPaise } });
        });
        return loadGuestProfile(req.params.guestId);
      },
    );
  },
};
