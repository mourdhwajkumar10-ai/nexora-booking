import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

describe('auth', () => {
  it('rejects bad credentials', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: ctx.fx.hostEmail, password: 'wrong-pass' } });
    expect(res.statusCode).toBe(401);
  });
  it('logs in and returns venues scoped to the user', async () => {
    const cookie = await ctx.login('host');
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().venues).toHaveLength(1);
    const mgr = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: await ctx.login('manager') } });
    expect(mgr.json().venues.length).toBe(2);
  });
  it('blocks alerts for other venue', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/api/v1/admin/venues/${ctx.fx.venueId}/alerts`, headers: { cookie: await ctx.login('other') } });
    expect(res.statusCode).toBe(403);
  });
  it('rejects unauthenticated admin access', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/api/v1/admin/venues/${ctx.fx.venueId}/alerts` });
    expect(res.statusCode).toBe(401);
  });
});

describe('exclusion constraint (defense in depth)', () => {
  it('rejects overlapping active reservations on the same table at the DB level', async () => {
    const { getPool } = await import('../src/db/pool');
    const pool = getPool();
    const g = (await pool.query(`INSERT INTO guests (first_name, phone_number) VALUES ('X','+910000000001') RETURNING id`)).rows[0];
    const ins = `INSERT INTO reservations (venue_id, table_id, guest_id, party_size, booking_date, start_at, end_at, status)
                 VALUES ($1,$2,$3,2,'2026-10-02',$4,$5,'CONFIRMED')`;
    await pool.query(ins, [ctx.fx.venueId, ctx.fx.tables['T-1'], g.id, '2026-10-02T13:30:00Z', '2026-10-02T14:00:00Z']);
    await expect(pool.query(ins, [ctx.fx.venueId, ctx.fx.tables['T-1'], g.id, '2026-10-02T13:45:00Z', '2026-10-02T14:15:00Z'])).rejects.toMatchObject({ code: '23P01' });
    // touching interval is fine
    await pool.query(ins, [ctx.fx.venueId, ctx.fx.tables['T-1'], g.id, '2026-10-02T14:00:00Z', '2026-10-02T14:30:00Z']);
  });
});
