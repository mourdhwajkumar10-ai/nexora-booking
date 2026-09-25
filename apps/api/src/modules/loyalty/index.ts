import { z } from 'zod';
import { GiftCardAuthorizeInput, IssueGiftCardInput, SettleOrderInput, type GiftCardAuthorizeResponse } from '@nexora/shared';
import { query, withTx } from '../../db/pool';
import { audit } from '../../core/audit';
import { actorOf, assertVenueAccess, requireRole, requireStaff } from '../../lib/auth';
import { on } from '../../lib/bus';
import { notFound } from '../../lib/errors';
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
import { settleOrder } from './settle';

const ReloadInput = z.object({ amountPaise: z.number().int().positive().max(1_00_000_00) });

/** Loyalty, stored value and settlement (E4-S5/S6/S7). */
export const loyaltyModule: NexoraModule = {
  name: 'loyalty',
  init: () => {
    on('order.billed', accrueForOrder);
    on('order.adjusted', clawbackForAdjustment);
    registerJob({ name: 'hold-expiry', intervalMs: 10_000, run: releaseExpiredHolds });
  },
  routes: async (app) => {
    app.post<{ Params: { orderId: string } }>('/admin/orders/:orderId/settle', { preHandler: requireStaff }, async (req) => {
      const { tenders } = parse(SettleOrderInput, req.body);
      return settleOrder(req.params.orderId, tenders, req.staff, actorOf(req));
    });

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
