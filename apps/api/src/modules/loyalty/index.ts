import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  GiftCardAuthorizeInput,
  IssueGiftCardInput,
  IssueVoucherInput,
  RedeemVoucherInput,
  SettleOrderInput,
  computeEarn,
  effectiveTier,
  formatVoucherCode,
  normalizeVoucherCode,
  planVoucherCapture,
  planVoucherHold,
  planVoucherRelease,
  tierFor,
  voucherCode,
  type BoosterRule,
  type GiftCardAuthorizeResponse,
  type VoucherDto,
} from '@nexora/shared';
import { query, queryOne, withTx } from '../../db/pool';
import { audit } from '../../core/audit';
import { actorOf, assertVenueAccess, requireRole, requireStaff } from '../../lib/auth';
import { on } from '../../lib/bus';
import { clock } from '../../lib/clock';
import { badRequest, notFound } from '../../lib/errors';
import { iso, parse } from '../../lib/http';
import { registerJob } from '../../lib/jobs';
import type { NexoraModule } from '../types';
import { accrueForOrder, clawbackForAdjustment } from './accrual';
import {
  GIFT_CARD_SELECT,
  createGiftCardHold,
  giftCardNotFound,
  issueGiftCard,
  lockCardByNumber,
  releaseExpiredHolds,
  toGiftCardDto,
} from './giftcards';
import { insertLedger, lockAccount } from './service';
import { settleOrder } from './settle';

const ReloadInput = z.object({ amountPaise: z.number().int().positive().max(1_00_000_00) });

const CalculateEarnInput = z.object({
  eligibleCents: z.number().int().min(0),
  venueId: z.string(),
  localDayOfWeek: z.number().int().min(0).max(6),
  localMinuteOfDay: z.number().int().min(0).max(1439),
  isFirstVisitAtVenue: z.boolean().default(false),
});

function toVoucherDto(v: any): VoucherDto {
  return {
    id: v.id,
    code: v.code,
    formattedCode: formatVoucherCode(v.code),
    valueCents: v.value_cents,
    points: v.points,
    status: v.status,
    expiresAt: iso(v.expires_at)!,
    redeemedAt: iso(v.redeemed_at),
    redeemedVenueId: v.redeemed_venue_id,
    redeemedBy: v.redeemed_by,
    createdAt: iso(v.created_at)!,
  };
}

/** Loyalty, stored value, voucher lifecycle, and settlement (Pillar 3). */
export const loyaltyModule: NexoraModule = {
  name: 'loyalty',
  init: () => {
    on('order.billed', accrueForOrder);
    on('order.adjusted', clawbackForAdjustment);
    registerJob({ name: 'hold-expiry', intervalMs: 10_000, run: releaseExpiredHolds });
  },
  routes: async (app) => {
    // ---------------------------------------------------------------- Order Settlement
    app.post<{ Params: { orderId: string } }>('/admin/orders/:orderId/settle', { preHandler: requireStaff }, async (req) => {
      const { tenders } = parse(SettleOrderInput, req.body);
      return settleOrder(req.params.orderId, tenders, req.staff, actorOf(req));
    });

    // ---------------------------------------------------------------- Vouchers (Pillar 3)
    app.post<{ Params: { guestId: string } }>(
      '/admin/guests/:guestId/vouchers',
      { preHandler: requireStaff },
      async (req) => {
        const { valueCents } = parse(IssueVoucherInput, req.body);
        const now = clock.now();

        return withTx(async (tx): Promise<VoucherDto> => {
          const account = await lockAccount(tx, req.params.guestId);
          const activeVouchers = await tx.query<{ count: string }>(
            "SELECT count(*)::text as count FROM vouchers WHERE account_id = $1 AND status = 'held'",
            [account.id],
          );
          const activeCount = Number(activeVouchers[0]?.count ?? '0');

          const holdCheck = planVoucherHold(valueCents, account.points_balance, activeCount, true);
          if (!holdCheck.ok) {
            throw badRequest(holdCheck.error, `Unable to hold voucher: ${holdCheck.error}`);
          }

          // Generate unique 9-symbol voucher code with Luhn mod 32 checksum
          const code = voucherCode((len) => randomBytes(len));
          const expiresAt = new Date(now.getTime() + 30 * 24 * 3600_000); // 30 days TTL

          const voucher = await tx.one(
            `INSERT INTO vouchers (guest_id, account_id, code, value_cents, points, status, expires_at, created_at)
             VALUES ($1, $2, $3, $4, $5, 'held', $6, $7) RETURNING *`,
            [req.params.guestId, account.id, code, valueCents, holdCheck.points, expiresAt, now],
          );

          // Update points balance and record ledger entry
          await tx.query('UPDATE loyalty_accounts SET points_balance = points_balance - $2 WHERE id = $1', [
            account.id,
            holdCheck.points,
          ]);
          await insertLedger(tx, {
            accountId: account.id,
            eventType: 'REDEEM_HOLD' as any,
            pointsDelta: -holdCheck.points,
            referenceType: 'VOUCHER',
            referenceId: voucher!.id,
            note: `Voucher hold: ${formatVoucherCode(code)}`,
          });

          await audit(tx, {
            venueId: null,
            actor: actorOf(req),
            action: 'voucher.hold',
            entity: 'voucher',
            entityId: voucher!.id,
            data: { code, valueCents, points: holdCheck.points },
          });

          return toVoucherDto(voucher);
        });
      },
    );

    app.get<{ Params: { guestId: string } }>(
      '/admin/guests/:guestId/vouchers',
      { preHandler: requireStaff },
      async (req) => {
        const rows = await query('SELECT * FROM vouchers WHERE guest_id = $1 ORDER BY created_at DESC', [req.params.guestId]);
        return rows.map(toVoucherDto);
      },
    );

    /** Staff capture/redemption of a voucher code ABCD-EFGH-J (BR-17) */
    app.post(
      '/admin/loyalty/vouchers/redeem',
      { preHandler: requireStaff },
      async (req) => {
        const { code } = parse(RedeemVoucherInput, req.body);
        const normalized = normalizeVoucherCode(code);
        if (!normalized) {
          throw badRequest('INVALID_CODE', 'Invalid voucher code or checksum failure');
        }

        return withTx(async (tx): Promise<VoucherDto> => {
          const now = clock.now();
          const v = await tx.one('SELECT * FROM vouchers WHERE code = $1 FOR UPDATE', [normalized]);
          if (!v) throw notFound('Voucher');

          if (v.status !== 'held') {
            throw badRequest('VOUCHER_NOT_ACTIVE', `Voucher is ${v.status} and cannot be redeemed`);
          }

          if (new Date(v.expires_at).getTime() < now.getTime()) {
            // Expired: release held points back to account
            await tx.query("UPDATE vouchers SET status = 'expired' WHERE id = $1", [v.id]);
            await tx.query('UPDATE loyalty_accounts SET points_balance = points_balance + $2 WHERE id = $1', [
              v.account_id,
              v.points,
            ]);
            await insertLedger(tx, {
              accountId: v.account_id,
              eventType: 'REDEEM_RELEASE' as any,
              pointsDelta: v.points,
              referenceType: 'VOUCHER',
              referenceId: v.id,
              note: `Voucher expired & released: ${formatVoucherCode(v.code)}`,
            });
            throw badRequest('VOUCHER_EXPIRED', 'Voucher has expired and points have been returned');
          }

          planVoucherCapture(v.points);
          const updated = await tx.one(
            `UPDATE vouchers SET status = 'redeemed', redeemed_at = $2, redeemed_venue_id = $3, redeemed_by = $4, updated_at = $2
             WHERE id = $1 RETURNING *`,
            [v.id, now, req.staff?.venueId ?? null, req.staff?.name ?? 'staff'],
          );

          await insertLedger(tx, {
            accountId: v.account_id,
            eventType: 'REDEEM_CAPTURE' as any,
            pointsDelta: 0,
            referenceType: 'VOUCHER',
            referenceId: v.id,
            note: `Voucher captured: ${formatVoucherCode(v.code)} ($${(v.value_cents / 100).toFixed(2)})`,
          });

          await audit(tx, {
            venueId: req.staff?.venueId ?? null,
            actor: actorOf(req),
            action: 'voucher.redeem',
            entity: 'voucher',
            entityId: v.id,
            data: { code: v.code, valueCents: v.value_cents },
          });

          return toVoucherDto(updated);
        });
      },
    );

    app.post<{ Params: { code: string } }>(
      '/admin/loyalty/vouchers/:code/release',
      { preHandler: requireStaff },
      async (req) => {
        const normalized = normalizeVoucherCode(req.params.code);
        if (!normalized) throw badRequest('INVALID_CODE', 'Invalid voucher code');

        return withTx(async (tx): Promise<VoucherDto> => {
          const v = await tx.one('SELECT * FROM vouchers WHERE code = $1 FOR UPDATE', [normalized]);
          if (!v) throw notFound('Voucher');
          if (v.status !== 'held') {
            throw badRequest('VOUCHER_NOT_HELD', `Voucher cannot be released (status is ${v.status})`);
          }

          const now = clock.now();
          planVoucherRelease(v.points);
          const updated = await tx.one("UPDATE vouchers SET status = 'cancelled', updated_at = $2 WHERE id = $1 RETURNING *", [
            v.id,
            now,
          ]);

          // Return held points to available balance
          await tx.query('UPDATE loyalty_accounts SET points_balance = points_balance + $2 WHERE id = $1', [
            v.account_id,
            v.points,
          ]);
          await insertLedger(tx, {
            accountId: v.account_id,
            eventType: 'REDEEM_RELEASE' as any,
            pointsDelta: v.points,
            referenceType: 'VOUCHER',
            referenceId: v.id,
            note: `Voucher cancelled & released: ${formatVoucherCode(v.code)}`,
          });

          return toVoucherDto(updated);
        });
      },
    );

    // ---------------------------------------------------------------- Earn & Booster Evaluation (BR-15)
    app.post('/admin/loyalty/earn/calculate', { preHandler: requireStaff }, async (req) => {
      const input = parse(CalculateEarnInput, req.body);
      const boosters = await query<any>(
        'SELECT * FROM booster_rules WHERE venue_id = $1 AND active = true',
        [input.venueId],
      );

      const boosterUsedThisMonth: Record<string, number> = {};
      for (const b of boosters) {
        boosterUsedThisMonth[b.id] = Number(b.used_this_month ?? b.usedThisMonth ?? 0);
      }

      const result = computeEarn({
        eligibleCents: input.eligibleCents,
        basePointsPerDollar: 1,
        venueId: input.venueId,
        localDayOfWeek: input.localDayOfWeek,
        localMinuteOfDay: input.localMinuteOfDay,
        isFirstVisitAtVenue: input.isFirstVisitAtVenue,
        boosters: boosters.map((b) => ({
          id: b.id,
          venueId: b.venue_id ?? b.venueId ?? null,
          pointsPerDollar: Number(b.points_per_dollar ?? b.pointsPerDollar ?? 1),
          daysOfWeek: b.days_of_week ?? b.daysOfWeek ?? [0, 1, 2, 3, 4, 5, 6],
          startMinute: Number(b.start_minute ?? b.startMinute ?? 0),
          endMinute: Number(b.end_minute ?? b.endMinute ?? 1440),
          firstVisitOnly: Boolean(b.first_visit_only ?? b.firstVisitOnly ?? false),
          monthlyBudgetPoints: Number(b.monthly_budget_points ?? b.monthlyBudgetPoints ?? 100000),
          createdAtMs: b.created_at ? new Date(b.created_at).getTime() : 0,
          active: Boolean(b.active ?? true),
        })),
        boosterUsedThisMonth,
      });

      return result;
    });

    // ---------------------------------------------------------------- Gift Cards
    app.post('/admin/gift-cards', { preHandler: requireRole('MANAGER') }, async (req, reply) => {
      const input = parse(IssueGiftCardInput, req.body);
      const dto = await withTx(async (tx) => {
        if (input.purchasedByGuestId && !(await tx.one('SELECT 1 FROM guests WHERE id = $1', [input.purchasedByGuestId]))) {
          throw notFound('Guest');
        }
        const card = await issueGiftCard(tx, input.amountPaise, input.purchasedByGuestId ?? null);
        await audit(tx, { venueId: null, actor: actorOf(req), action: 'giftcard.issue', entity: 'gift_card', entityId: card.id, data: { amountPaise: input.amountPaise, last4: card.last4 } });
        return card;
      });
      return reply.status(201).send(dto);
    });

    app.get('/admin/gift-cards', { preHandler: requireStaff }, async () => {
      const rows = await query(`${GIFT_CARD_SELECT} ORDER BY gc.created_at DESC, gc.id LIMIT 200`);
      return rows.map((r) => toGiftCardDto(r));
    });

    app.get<{ Params: { venueId: string } }>('/admin/venues/:venueId/gift-cards', { preHandler: requireStaff }, async (req) => {
      assertVenueAccess(req.staff, req.params.venueId);
      const rows = await query(`${GIFT_CARD_SELECT} ORDER BY gc.created_at DESC, gc.id LIMIT 200`);
      return rows.map((r) => toGiftCardDto(r));
    });

    app.post<{ Params: { id: string } }>('/admin/gift-cards/:id/reload', { preHandler: requireRole('MANAGER') }, async (req) => {
      const { amountPaise } = parse(ReloadInput, req.body);
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id);
      return withTx(async (tx) => {
        const card = isUuid
          ? await tx.one('SELECT * FROM gift_cards WHERE id = $1 FOR UPDATE', [req.params.id])
          : await tx.one('SELECT * FROM gift_cards WHERE last4 = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE', [req.params.id]);
        if (!card) throw giftCardNotFound();
        await tx.query('UPDATE gift_cards SET current_balance_paise = current_balance_paise + $2 WHERE id = $1', [card.id, amountPaise]);
        await tx.query(`INSERT INTO gift_card_ledger (gift_card_id, kind, delta_paise) VALUES ($1,'RELOAD',$2)`, [card.id, amountPaise]);
        await audit(tx, { venueId: null, actor: actorOf(req), action: 'giftcard.reload', entity: 'gift_card', entityId: card.id, data: { amountPaise } });
        return toGiftCardDto(await tx.one(`${GIFT_CARD_SELECT} WHERE gc.id = $1`, [card.id]));
      });
    });

    app.post('/gift-cards/authorize', { preHandler: requireStaff }, async (req) => {
      const input = parse(GiftCardAuthorizeInput, req.body);
      return withTx(async (tx): Promise<GiftCardAuthorizeResponse> => {
        const order = await tx.one('SELECT id, venue_id FROM pos_orders WHERE id = $1', [input.orderId]);
        if (!order) throw notFound('Order');
        assertVenueAccess(req.staff, order.venue_id);
        const card = await lockCardByNumber(tx, input.cardNumber);
        if (!card) throw giftCardNotFound();
        const hold = await createGiftCardHold(tx, card, input.amountPaise, order.id);
        return { approved: true, holdToken: hold.hold_token, expiresAt: iso(hold.expires_at)!, availablePaise: hold.available };
      });
    });
  },
};
