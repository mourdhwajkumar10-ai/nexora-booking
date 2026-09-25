import type { MeResponse, StaffUser } from '@nexora/shared';
import { LoginInput } from '@nexora/shared';
import { config } from '../../config';
import { query, queryOne } from '../../db/pool';
import { requireStaff, verifyPassword } from '../../lib/auth';
import { unauthorized } from '../../lib/errors';
import { parse } from '../../lib/http';
import type { NexoraModule } from '../types';

async function venuesFor(user: StaffUser): Promise<MeResponse['venues']> {
  const rows = await query(
    `SELECT v.id, v.slug, v.name, l.name || ', ' || l.city AS locality_label
     FROM venues v JOIN localities l ON l.id = v.locality_id
     WHERE ($1::uuid IS NULL OR v.id = $1) ORDER BY v.name`,
    [user.venueId],
  );
  return rows.map((r) => ({ id: r.id, slug: r.slug, name: r.name, localityLabel: r.locality_label }));
}

export const authModule: NexoraModule = {
  name: 'auth',
  routes: async (app) => {
    app.post('/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
      const input = parse(LoginInput, req.body);
      const row = await queryOne('SELECT * FROM staff_users WHERE email = $1', [input.email.toLowerCase()]);
      if (!row || !verifyPassword(input.password, row.password_hash)) throw unauthorized('Invalid email or password');
      const user: StaffUser = { id: row.id, email: row.email, name: row.name, role: row.role, venueId: row.venue_id };
      const token = app.jwt.sign(user, { expiresIn: '12h' });
      reply.setCookie(config.cookieName, token, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 12 * 3600,
      });
      const res: MeResponse = { user, venues: await venuesFor(user) };
      return res;
    });

    app.post('/auth/logout', async (_req, reply) => {
      reply.clearCookie(config.cookieName, { path: '/' });
      return { ok: true };
    });

    app.get('/auth/me', { preHandler: requireStaff }, async (req) => {
      const user = req.staff!;
      const res: MeResponse = { user, venues: await venuesFor(user) };
      return res;
    });
  },
};
