import { TagInput, UpdateGuestInput, WalletPreloadInput, type GuestSummary } from '@nexora/shared';
import { query, withTx } from '../../db/pool';
import { audit } from '../../core/audit';
import { actorOf, requireRole, requireStaff } from '../../lib/auth';
import { on } from '../../lib/bus';
import { notFound } from '../../lib/errors';
import { iso, parse } from '../../lib/http';
import { applyTier, insertLedger, loadGuestProfile, loadLedger, lockAccount } from '../loyalty/service';
import type { NexoraModule } from '../types';
import { registerAutoTagHandlers } from './autotags';

async function assertGuest(guestId: string): Promise<void> {
  const rows = await query('SELECT 1 FROM guests WHERE id = $1', [guestId]);
  if (!rows.length) throw notFound('Guest');
}

/** CRM (E4-S1/S2). Guests are cross-venue: any staff member may view; edits require staff, preload a manager. */
export const guestsModule: NexoraModule = {
  name: 'guests',
  init: () => registerAutoTagHandlers(on),
  routes: async (app) => {
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
