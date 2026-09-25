import { query, withTx } from '../../db/pool';
import { assertVenueAccess, requireStaff } from '../../lib/auth';
import { clock } from '../../lib/clock';
import { notFound } from '../../lib/errors';
import { toAlertDto } from '../../core/alerts';
import type { NexoraModule } from '../types';

/** Cross-cutting ops endpoints: server time + console alerts. */
export const opsModule: NexoraModule = {
  name: 'ops',
  routes: async (app) => {
    app.get('/time', async () => ({ serverTime: clock.now().toISOString() }));
    app.get('/health', async () => ({ ok: true }));

    app.get<{ Params: { venueId: string }; Querystring: { all?: string } }>(
      '/admin/venues/:venueId/alerts',
      { preHandler: requireStaff },
      async (req) => {
        assertVenueAccess(req.staff, req.params.venueId);
        const rows = await query(
          `SELECT * FROM alerts WHERE venue_id = $1 ${req.query.all === '1' ? '' : 'AND acknowledged_at IS NULL'}
           ORDER BY created_at DESC LIMIT 100`,
          [req.params.venueId],
        );
        return rows.map(toAlertDto);
      },
    );

    app.post<{ Params: { id: string } }>('/admin/alerts/:id/ack', { preHandler: requireStaff }, async (req) => {
      return withTx(async (tx) => {
        const a = await tx.one('SELECT * FROM alerts WHERE id = $1 FOR UPDATE', [req.params.id]);
        if (!a) throw notFound('Alert');
        assertVenueAccess(req.staff, a.venue_id);
        const row = await tx.one('UPDATE alerts SET acknowledged_at = $2 WHERE id = $1 RETURNING *', [a.id, clock.now()]);
        return toAlertDto(row);
      });
    });
  },
};
