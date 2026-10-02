import {
  CreateCampaignInput,
  CreateSegmentInput,
  computeLift,
  evaluateSend,
  guestMatchesConditions,
  type ConsentStatus,
  type ConsentType,
  type GroupOutcome,
  type LiftResult,
  type SendInput,
} from '@nexora/shared';
import { holdoutBucket, isHoldout } from '@nexora/shared/node';
import { query, queryOne, withTx } from '../../db/pool';
import { audit } from '../../core/audit';
import { actorOf, assertVenueAccess, requireStaff } from '../../lib/auth';
import { clock } from '../../lib/clock';
import { badRequest, notFound } from '../../lib/errors';
import { iso, parse } from '../../lib/http';
import type { NexoraModule } from '../types';

export interface CampaignResultsDto {
  campaignId: string;
  treatment: { n: number; conversions: number; revenueCents: number };
  holdout: { n: number; conversions: number; revenueCents: number };
  lift: LiftResult;
  delivery: { sent: number; holdout: number; conversions: number };
}

/** CRM, Segments, Campaigns, Holdouts & Lift Calculation (Pillar 4). */
export const crmModule: NexoraModule = {
  name: 'crm',
  routes: async (app) => {
    // ---------------------------------------------------------------- Segments
    app.post<{ Params: { venueId: string } }>(
      '/admin/venues/:venueId/crm/segments',
      { preHandler: requireStaff },
      async (req) => {
        assertVenueAccess(req.staff, req.params.venueId);
        const input = parse(CreateSegmentInput, req.body);
        const segment = await queryOne(
          `INSERT INTO crm_segments (venue_id, name, definition) VALUES ($1, $2, $3) RETURNING *`,
          [req.params.venueId, input.name, JSON.stringify(input.definition)],
        );
        return {
          id: segment.id,
          venueId: segment.venue_id,
          name: segment.name,
          definition: segment.definition,
          createdAt: iso(segment.created_at),
        };
      },
    );

    app.get<{ Params: { venueId: string } }>(
      '/admin/venues/:venueId/crm/segments',
      { preHandler: requireStaff },
      async (req) => {
        assertVenueAccess(req.staff, req.params.venueId);
        const rows = await query('SELECT * FROM crm_segments WHERE venue_id = $1 ORDER BY created_at DESC', [
          req.params.venueId,
        ]);
        return rows.map((r) => ({
          id: r.id,
          venueId: r.venue_id,
          name: r.name,
          definition: r.definition,
          createdAt: iso(r.created_at),
        }));
      },
    );

    app.post<{ Params: { venueId: string; segmentId: string } }>(
      '/admin/venues/:venueId/crm/segments/:segmentId/preview',
      { preHandler: requireStaff },
      async (req) => {
        assertVenueAccess(req.staff, req.params.venueId);
        const segment = await queryOne('SELECT * FROM crm_segments WHERE id = $1 AND venue_id = $2', [
          req.params.segmentId,
          req.params.venueId,
        ]);
        if (!segment) throw notFound('Segment');

        const guests = await query(
          `SELECT g.id, g.phone_number, g.email, g.birthday_month,
                  p.total_visits, p.lifetime_spend_paise, p.last_visit_at,
                  p.typical_party_size, p.avg_check_per_cover_paise,
                  COALESCE((SELECT array_agg(t.tag_name) FROM guest_tags t WHERE t.guest_id = g.id), '{}') as tags
           FROM guests g
           LEFT JOIN guest_profiles p ON p.guest_id = g.id
           WHERE g.phone_number NOT LIKE 'walkin:%'`,
        );

        const nowMs = clock.now().getTime();
        const matched = guests.filter((g) => guestMatchesConditions(g, segment.definition?.all || [], nowMs));
        let reachableSms = 0;
        let reachableEmail = 0;

        for (const g of matched) {
          if (g.phone_number) reachableSms++;
          if (g.email) reachableEmail++;
        }

        return {
          total: matched.length,
          reachableSms,
          reachableEmail,
          excludedNoConsentSms: matched.length - reachableSms,
          excludedNoConsentEmail: matched.length - reachableEmail,
        };
      },
    );

    // ---------------------------------------------------------------- Campaigns
    app.post<{ Params: { venueId: string } }>(
      '/admin/venues/:venueId/crm/campaigns',
      { preHandler: requireStaff },
      async (req) => {
        assertVenueAccess(req.staff, req.params.venueId);
        const input = parse(CreateCampaignInput, req.body);
        const row = await queryOne(
          `INSERT INTO crm_campaigns (venue_id, name, channel, segment_id, subject, body_text, holdout_pct, attribution_window_days, cost_cents, gross_margin_bps)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
          [
            req.params.venueId,
            input.name,
            input.channel,
            input.segmentId ?? null,
            input.subject ?? null,
            input.bodyText,
            input.holdoutPct,
            input.attributionWindowDays,
            input.costCents,
            input.grossMarginBps,
          ],
        );
        return {
          id: row.id,
          venueId: row.venue_id,
          name: row.name,
          channel: row.channel,
          segmentId: row.segment_id,
          status: row.status,
          holdoutPct: row.holdout_pct,
          attributionWindowDays: row.attribution_window_days,
          costCents: row.cost_cents,
          grossMarginBps: row.gross_margin_bps,
          createdAt: iso(row.created_at),
        };
      },
    );

    app.get<{ Params: { venueId: string } }>(
      '/admin/venues/:venueId/crm/campaigns',
      { preHandler: requireStaff },
      async (req) => {
        assertVenueAccess(req.staff, req.params.venueId);
        const rows = await query('SELECT * FROM crm_campaigns WHERE venue_id = $1 ORDER BY created_at DESC', [
          req.params.venueId,
        ]);
        return rows.map((r) => ({
          id: r.id,
          venueId: r.venue_id,
          name: r.name,
          channel: r.channel,
          segmentId: r.segment_id,
          status: r.status,
          sentAt: iso(r.sent_at),
          holdoutPct: r.holdout_pct,
          costCents: r.cost_cents,
          createdAt: iso(r.created_at),
        }));
      },
    );

    /** Send campaign: deterministic holdout bucketing (BR-23) + send-time compliance gate (BR-20) */
    app.post<{ Params: { venueId: string; campaignId: string } }>(
      '/admin/venues/:venueId/crm/campaigns/:campaignId/send',
      { preHandler: requireStaff },
      async (req) => {
        assertVenueAccess(req.staff, req.params.venueId);
        const campaign = await queryOne('SELECT * FROM crm_campaigns WHERE id = $1 AND venue_id = $2', [
          req.params.campaignId,
          req.params.venueId,
        ]);
        if (!campaign) throw notFound('Campaign');
        if (campaign.status === 'sent') throw badRequest('ALREADY_SENT', 'Campaign has already been sent');

        const now = clock.now();
        const guests = await query(
          `SELECT g.id, g.phone_number, g.email, g.birthday_month,
                  p.total_visits, p.lifetime_spend_paise, p.last_visit_at,
                  p.typical_party_size, p.avg_check_per_cover_paise,
                  COALESCE((SELECT array_agg(t.tag_name) FROM guest_tags t WHERE t.guest_id = g.id), '{}') as tags
           FROM guests g
           LEFT JOIN guest_profiles p ON p.guest_id = g.id
           WHERE g.phone_number NOT LIKE 'walkin:%'`,
        );

        let candidateGuests = guests;
        if (campaign.segment_id) {
          const segment = await queryOne('SELECT * FROM crm_segments WHERE id = $1 AND venue_id = $2', [
            campaign.segment_id,
            req.params.venueId,
          ]);
          if (segment) {
            candidateGuests = guests.filter((g) =>
              guestMatchesConditions(g, segment.definition?.all || [], now.getTime()),
            );
          }
        }

        // Apply BR-20 send-time compliance gate: filter by contact availability, suppressions, and revoked consents
        const eligibleGuests: typeof candidateGuests = [];
        for (const g of candidateGuests) {
          const contact = campaign.channel === 'sms' ? g.phone_number : g.email;
          if (!contact) continue;

          const subjectKey = campaign.channel === 'sms' ? `phone:${g.phone_number}` : `email:${g.email}`;
          const isSuppressed = !!(await queryOne('SELECT 1 FROM suppressions WHERE contact_hmac = $1', [subjectKey]));
          if (isSuppressed) continue;

          // Check consent state
          const consentType = campaign.channel === 'sms' ? 'sms_marketing' : 'email_marketing';
          const consentRow = await queryOne<{ status: string }>(
            'SELECT status FROM consent_state WHERE subject_key = $1 AND consent_type = $2',
            [subjectKey, consentType],
          );
          if (consentRow?.status === 'revoked') continue;

          eligibleGuests.push(g);
        }

        let sentCount = 0;
        let holdoutCount = 0;

        await withTx(async (tx) => {
          for (const g of eligibleGuests) {
            // BR-23: Deterministic holdout bucketing
            const inHoldout = isHoldout(campaign.id, g.id, campaign.holdout_pct);
            if (inHoldout) {
              holdoutCount++;
              await tx.query(
                `INSERT INTO crm_campaign_deliveries (campaign_id, guest_id, is_holdout, sent_at)
                 VALUES ($1, $2, true, $3)`,
                [campaign.id, g.id, now],
              );
            } else {
              sentCount++;
              await tx.query(
                `INSERT INTO crm_campaign_deliveries (campaign_id, guest_id, is_holdout, sent_at)
                 VALUES ($1, $2, false, $3)`,
                [campaign.id, g.id, now],
              );
            }
          }

          await tx.query(`UPDATE crm_campaigns SET status = 'sent', sent_at = $2 WHERE id = $1`, [campaign.id, now]);
          await audit(tx, {
            venueId: req.params.venueId,
            actor: actorOf(req),
            action: 'campaign.send',
            entity: 'campaign',
            entityId: campaign.id,
            data: { sentCount, holdoutCount },
          });
        });

        return { success: true, sentCount, holdoutCount };
      },
    );

    /** Lift calculation (BR-24): treatment vs holdout conversions, incremental revenue, ROI, and statistical significance */
    app.get<{ Params: { venueId: string; campaignId: string } }>(
      '/admin/venues/:venueId/crm/campaigns/:campaignId/results',
      { preHandler: requireStaff },
      async (req) => {
        assertVenueAccess(req.staff, req.params.venueId);
        const campaign = await queryOne('SELECT * FROM crm_campaigns WHERE id = $1 AND venue_id = $2', [
          req.params.campaignId,
          req.params.venueId,
        ]);
        if (!campaign) throw notFound('Campaign');

        const deliveries = await query<{
          guest_id: string;
          is_holdout: boolean;
          converted: boolean;
          converted_revenue_cents: number;
        }>('SELECT * FROM crm_campaign_deliveries WHERE campaign_id = $1', [campaign.id]);

        const treatmentDeliveries = deliveries.filter((d) => !d.is_holdout);
        const holdoutDeliveries = deliveries.filter((d) => d.is_holdout);

        const treatment: GroupOutcome = {
          n: treatmentDeliveries.length,
          conversions: treatmentDeliveries.filter((d) => d.converted).length,
          revenueCents: treatmentDeliveries.reduce((sum, d) => sum + (d.converted_revenue_cents || 0), 0),
        };

        const holdout: GroupOutcome = {
          n: holdoutDeliveries.length,
          conversions: holdoutDeliveries.filter((d) => d.converted).length,
          revenueCents: holdoutDeliveries.reduce((sum, d) => sum + (d.converted_revenue_cents || 0), 0),
        };

        const lift = computeLift(
          treatment,
          holdout,
          campaign.gross_margin_bps || 7000,
          campaign.cost_cents || 0,
        );

        return {
          campaignId: campaign.id,
          treatment,
          holdout,
          lift,
          delivery: {
            sent: treatment.n,
            holdout: holdout.n,
            conversions: treatment.conversions + holdout.conversions,
          },
        };
      },
    );

    /** Record a simulated or real post-campaign visit conversion */
    app.post<{ Params: { venueId: string; campaignId: string }; Body: { guestId: string; revenueCents: number } }>(
      '/admin/venues/:venueId/crm/campaigns/:campaignId/convert',
      { preHandler: requireStaff },
      async (req) => {
        const { guestId, revenueCents } = req.body ?? {};
        if (!guestId) throw badRequest('MISSING_GUEST', 'guestId is required');

        await query(
          `UPDATE crm_campaign_deliveries
           SET converted = true, converted_revenue_cents = $3
           WHERE campaign_id = $1 AND guest_id = $2`,
          [req.params.campaignId, guestId, revenueCents || 0],
        );

        return { converted: true };
      },
    );
  },
};
